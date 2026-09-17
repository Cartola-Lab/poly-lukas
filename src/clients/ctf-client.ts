/**
 * Legacy CTF (Conditional Token Framework) Client
 * CLOB V2 collateral uses the separate getPusdBalance() read.
 *
 * V2.3C1a: STANDARD split migrated to CtfCollateralAdapter with pUSD.
 * Merge / mergeByTokenIds / redeem / redeemByTokenIds remain on the legacy
 * CTF/USDC.e path until their own migration steps land.
 *
 * Provides on-chain operations for Polymarket's conditional tokens:
 * - Split: pUSD → YES + NO token pair (via CtfCollateralAdapter)
 * - Merge: YES + NO → USDC.e (legacy CTF; not yet migrated)
 * - Redeem: Winning tokens → USDC.e (legacy CTF; not yet migrated)
 *
 * ⚠️ CRITICAL: Polymarket CTF uses USDC.e (bridged), NOT native USDC!
 *
 * | Token         | Address                                    | CTF Compatible |
 * |---------------|--------------------------------------------|-----------------
 * | USDC.e        | 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 | ✅ Yes          |
 * | Native USDC   | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | ❌ No           |
 *
 * Common Mistake:
 * - Your wallet has native USDC but CTF operations fail
 * - Solution: Use SwapService.transferUsdcE() or swap native USDC to USDC.e
 *
 * Based on: docs/01-product-research/06-poly-sdk/05-ctf-integration-plan.md
 *
 * Contract: Gnosis Conditional Tokens on Polygon
 * https://docs.polymarket.com/developers/CTF/overview
 */

import { ethers, Contract, Wallet, BigNumber } from 'ethers';
import { getContractConfig, COLLATERAL_TOKEN_DECIMALS } from '@polymarket/clob-client-v2';
import { resolvePolygonRpcUrl } from '../utils/rpc.js';
import { protectWallet } from '../core/write-barrier.js';
import { WriteBlockedError } from '../core/execution-mode.js';

// ===== Contract Addresses (Polygon Mainnet) =====

export const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/**
 * USDC.e (Bridged USDC) - The ONLY USDC accepted by Polymarket CTF
 *
 * ⚠️ WARNING: This is NOT native USDC (0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359)
 *
 * If your wallet has native USDC but CTF operations fail with "Insufficient USDC balance",
 * you need to swap your native USDC to USDC.e first using:
 * - SwapService.swap('USDC', 'USDC_E', amount)
 * - Or transfer USDC.e using SwapService.transferUsdcE()
 */
export const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** Native USDC on Polygon - NOT compatible with CTF */
export const NATIVE_USDC_CONTRACT = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

export const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
export const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

/**
 * V2.3C: current CLOB V2 CTF collateral adapters, verified against the
 * authoritative Polymarket ctf-exchange-v2 deployment list (Polygon).
 * Standard markets use CtfCollateralAdapter; neg-risk markets use
 * NegRiskCtfCollateralAdapter.
 */
export const CTF_COLLATERAL_ADAPTER = '0xADa100874d00e3331D00F2007a9c336a65009718';
export const NEG_RISK_CTF_COLLATERAL_ADAPTER = '0xAdA200001000ef00D07553cEE7006808F895c6F1';

// USDC.e uses 6 decimals
export const USDC_DECIMALS = 6;

/** pUSD (Polymarket Collateral Token proxy) on Polygon, from the V2 SDK config. */
export const PUSD = getContractConfig(137).collateral;

// ===== ABIs =====

const CTF_ABI = [
  // Split: USDC → YES + NO
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  // Merge: YES + NO → USDC
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  // Redeem: Winning tokens → USDC
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  // Balance query
  'function balanceOf(address account, uint256 positionId) view returns (uint256)',
  // Check if condition is resolved
  'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

/**
 * V2.3C: Standard CtfCollateralAdapter. The external signatures mirror the
 * legacy CTF signatures for compatibility; the adapter ignores the
 * collateralToken, parentCollectionId and partition parameters and only
 * acts on conditionId + amount (verified from ctf-exchange-v2 source).
 */
const STANDARD_CTF_ADAPTER_ABI = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const PUSD_TRANSFER = new ethers.utils.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
]);

/** Receipt-scoped credit only; absence or ambiguity is never a zero payout. */
export type RedeemPayoutLookup =
  | { state: 'PAYOUT_KNOWN'; transactionHash: string; pusdReceived: string }
  | { state: 'PAYOUT_UNKNOWN'; transactionHash: string; pusdReceived: undefined; cause: unknown };

function redeemPusdReceived(receipt: ethers.providers.TransactionReceipt, wallet: string): string {
  if (!Array.isArray(receipt.logs)) throw new Error('Redeem receipt logs unavailable');
  const topic = PUSD_TRANSFER.getEventTopic('Transfer').toLowerCase();
  // A logIndex identifies one fact, including logs excluded by the payout filter.
  const seen = new Map<number, string>();
  const unique: ethers.providers.Log[] = [];
  const hex = (value: unknown, bytes?: number): string => {
    if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
        (bytes !== undefined && value.length !== 2 + bytes * 2)) {
      throw new Error('Malformed receipt log identity');
    }
    return value.toLowerCase();
  };
  for (const log of receipt.logs) {
    if (!log || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 ||
        !Array.isArray(log.topics) || log.removed) throw new Error('Invalid receipt log identity');
    const transactionHash = log.transactionHash === undefined ? null : hex(log.transactionHash, 32);
    if (transactionHash !== null && transactionHash !== receipt.transactionHash.toLowerCase()) {
      throw new Error('Receipt log transaction mismatch');
    }
    const fingerprint = JSON.stringify([hex(log.address, 20), log.topics.map(t => hex(t, 32)),
      hex(log.data), log.logIndex, transactionHash]);
    if (seen.has(log.logIndex)) {
      if (seen.get(log.logIndex) !== fingerprint) throw new Error('Conflicting receipt log identity');
      continue;
    }
    seen.set(log.logIndex, fingerprint);
    unique.push(log);
  }
  let total = ethers.BigNumber.from(0);
  let found = false;
  for (const log of unique) {
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== PUSD.toLowerCase()) continue;
    if (!Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== topic) continue;
    if (log.topics.length !== 3 || log.topics.slice(1).some(t =>
      typeof t !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(t))) {
      throw new Error('Malformed pUSD Transfer topics');
    }
    const from = ethers.utils.getAddress('0x' + log.topics[1].slice(-40));
    const to = ethers.utils.getAddress('0x' + log.topics[2].slice(-40));
    if (from !== ethers.constants.AddressZero || to.toLowerCase() !== wallet.toLowerCase()) continue;
    if (typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(log.data) ||
        !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || log.removed ||
        (log.transactionHash !== undefined && log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase())) {
      throw new Error('Malformed or inconsistent pUSD mint log');
    }
    const amount: ethers.BigNumber = PUSD_TRANSFER.parseLog(log).args.amount;
    found = true;
    total = total.add(amount);
  }
  if (!found) throw new Error('Confirmed redeem receipt has no identifiable pUSD mint');
  return ethers.utils.formatUnits(total, USDC_DECIMALS);
}

// ===== Types =====

export interface CTFConfig {
  /** Private key for signing transactions */
  privateKey: string;
  /** RPC URL (default: Polygon mainnet) */
  rpcUrl?: string;
  /** Chain ID (default: 137 for Polygon) */
  chainId?: number;
  /** Gas price multiplier (default: 1.2) */
  gasPriceMultiplier?: number;
  /** Transaction confirmation blocks (default: 1) */
  confirmations?: number;
  /** Transaction timeout in ms (default: 60000) */
  txTimeout?: number;
}

export interface GasEstimate {
  /** Estimated gas units */
  gasUnits: string;
  /** Gas price in gwei */
  gasPriceGwei: string;
  /** Estimated cost in MATIC */
  costMatic: string;
  /** Estimated cost in USDC (at current MATIC price) */
  costUsdc: string;
  /** MATIC/USDC price used */
  maticPrice: number;
}

export interface TransactionStatus {
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed' | 'reverted';
  confirmations: number;
  blockNumber?: number;
  gasUsed?: string;
  effectiveGasPrice?: string;
  errorReason?: string;
}

/** Common revert reasons */
export enum RevertReason {
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INSUFFICIENT_ALLOWANCE = 'INSUFFICIENT_ALLOWANCE',
  CONDITION_NOT_RESOLVED = 'CONDITION_NOT_RESOLVED',
  INVALID_PARTITION = 'INVALID_PARTITION',
  INVALID_CONDITION = 'INVALID_CONDITION',
  EXECUTION_REVERTED = 'EXECUTION_REVERTED',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export interface SplitResult {
  success: boolean;
  txHash: string;
  amount: string;
  yesTokens: string;
  noTokens: string;
  gasUsed?: string;
}

export type MergeProvenance = Readonly<{
  state: 'NOT_SUBMITTED' | 'SUBMITTED' | 'CONFIRMED' | 'UNCERTAIN';
  transactionHash?: string;
}>;

export type MergeProvenanceObserver = (snapshot: MergeProvenance) => void;

export class MergeProvenanceError extends Error {
  readonly provenance: MergeProvenance;
  constructor(cause: unknown, provenance: MergeProvenance) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'MergeProvenanceError';
    this.provenance = Object.freeze({ ...provenance });
  }
}

export interface MergeResult {
  provenance?: MergeProvenance;
  success: boolean;
  txHash: string;
  amount: string;
  /**
   * Collateral received after merging. Standard-market adapter merges return
   * pUSD (V2.3C1b); legacy merges historically returned USDC.e. Field name
   * retained for compatibility.
   */
  usdcReceived: string;
  gasUsed?: string;
}

export type RedeemProvenance = Readonly<{
  state: 'NOT_SUBMITTED' | 'SUBMITTED' | 'CONFIRMED' | 'UNCERTAIN';
  transactionHash?: string;
}>;

/** Classification concerns the redeem transaction only, never its approval. */
export class RedeemProvenanceError extends Error {
  readonly provenance: RedeemProvenance;
  readonly usdcReceived?: RedeemResult['usdcReceived'];
  constructor(cause: unknown, provenance: RedeemProvenance, usdcReceived?: RedeemResult['usdcReceived']) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RedeemProvenanceError';
    this.provenance = Object.freeze({ ...provenance });
    Object.defineProperty(this, 'usdcReceived', {
      value: usdcReceived, enumerable: true, writable: false, configurable: false,
    });
  }
}

/** Synchronous diagnostic observer; observer failures cannot interrupt redemption. */
export type RedeemProvenanceObserver = (snapshot: RedeemProvenance) => void;

export interface RedeemResult {
  provenance?: RedeemProvenance;
  success: boolean;
  txHash: string;
  /** Winning outcome (e.g., 'YES', 'NO', 'Up', 'Down', 'Team1', 'Team2') */
  outcome: string;
  /** Full winning-side balance consumed by the redemption (reporting). */
  tokensRedeemed: string;
  /**
   * Collateral received after redemption. Standard-market adapter redeems
   * return pUSD (V2.3C1c); legacy redeems historically returned USDC.e.
   * Field name retained for compatibility.
   */
  usdcReceived: string;
  /**
   * V2.3C1c full-balance accounting: the adapter consumes the caller's FULL
   * balances of BOTH outcome positions (snapshot taken before the redeem).
   */
  yesTokensConsumed: string;
  noTokensConsumed: string;
  gasUsed?: string;
}

export interface PositionBalance {
  conditionId: string;
  yesBalance: string;
  noBalance: string;
  yesPositionId: string;
  noPositionId: string;
}

export interface TokenIds {
  yesTokenId: string;
  noTokenId: string;
}

/**
 * Market identity used to route lifecycle operations in CLOB V2.
 *
 * Standard markets must eventually use `CtfCollateralAdapter` and neg-risk
 * markets `NegRiskCtfCollateralAdapter`; position IDs differ between the two.
 * V2.3A only propagates this value to the lifecycle boundary — transactions
 * still target the legacy CTF contracts until adapter routing lands.
 */
export interface LifecycleRouting {
  /** Whether the market is a neg-risk market (from CLOB metadata). */
  negRisk: boolean;
}

/** Result of a single approval transaction attempt. */
export interface ApprovalTxResult {
  contract: string;
  txHash?: string;
  success: boolean;
  error?: string;
}

/**
 * Resolve exactly one lifecycle collateral adapter from market routing.
 * Fails closed on unknown routing — never defaults to the standard adapter.
 * Canonical single implementation shared by AuthorizationService and
 * CTFClient (kept here to avoid a clients→services dependency).
 */
export function resolveLifecycleAdapter(routing: LifecycleRouting | undefined): { name: string; address: string } {
  if (!routing || typeof routing.negRisk !== 'boolean') {
    throw new Error('Cannot select a lifecycle collateral adapter: market negRisk routing is unknown');
  }
  return routing.negRisk
    ? { name: 'Neg Risk CTF Collateral Adapter', address: NEG_RISK_CTF_COLLATERAL_ADAPTER }
    : { name: 'CTF Collateral Adapter', address: CTF_COLLATERAL_ADAPTER };
}

/**
 * Send a pUSD ERC20 approval to a lifecycle collateral adapter using the
 * caller's protected wallet. Canonical single implementation shared by
 * AuthorizationService.approveLifecycleAdapter and CTFClient standard split.
 */
export async function sendPusdApproveTx(
  signer: Wallet,
  provider: ethers.providers.Provider,
  spenderAddress: string,
  amount: ethers.BigNumber
): Promise<ApprovalTxResult> {
  const pusd = new Contract(PUSD, ERC20_ABI, signer);
  const gasPrice = await provider.getGasPrice();
  const adjustedGasPrice = gasPrice.mul(150).div(100);
  try {
    const tx = await pusd.approve(spenderAddress, amount, { gasPrice: adjustedGasPrice });
    await tx.wait();
    return { contract: spenderAddress, txHash: tx.hash, success: true };
  } catch (err) {
    return {
      contract: spenderAddress,
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Send an ERC1155 setApprovalForAll(operator, true) on Conditional Tokens
 * using the caller's protected wallet. Canonical single implementation shared
 * by AuthorizationService.approveLifecycleAdapter and CTFClient standard merge.
 */
export async function sendCtfOperatorApprovalTx(
  signer: Wallet,
  provider: ethers.providers.Provider,
  operatorAddress: string,
  propagateFailure = false
): Promise<ApprovalTxResult> {
  const conditionalTokens = new Contract(CTF_CONTRACT, ERC1155_ABI, signer);
  const gasPrice = await provider.getGasPrice();
  const adjustedGasPrice = gasPrice.mul(150).div(100);
  try {
    const tx = await conditionalTokens.setApprovalForAll(operatorAddress, true, {
      gasPrice: adjustedGasPrice,
      gasLimit: 100000,
    });
    await tx.wait();
    return { contract: operatorAddress, txHash: tx.hash, success: true };
  } catch (err) {
    if (propagateFailure) throw err;
    return {
      contract: operatorAddress,
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export interface MarketResolution {
  conditionId: string;
  isResolved: boolean;
  /** Winning outcome (e.g., 'YES', 'NO') - determined by payout numerators */
  winningOutcome?: string;
  payoutNumerators: [number, number];
  payoutDenominator: number;
}

// ===== CTF Client =====

const DEFAULT_MATIC_PRICE = 0.50;

export class CTFClient {
  private provider: ethers.providers.BaseProvider;
  private wallet: Wallet;
  private ctfContract: Contract;
  private usdcContract: Contract;
  private gasPriceMultiplier: number;
  private confirmations: number;
  private txTimeout: number;
  private cachedMaticPrice: number = DEFAULT_MATIC_PRICE;
  private maticPriceLastUpdated: number = 0;

  constructor(config: CTFConfig) {
    const rpcUrl = resolvePolygonRpcUrl(config.rpcUrl);
    const network = {
      chainId: config.chainId || 137,
      name: 'matic',
    };

    // StaticJsonRpcProvider évite le check async eth_chainId qui provoque l'erreur "noNetwork"
    this.provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, network);
    this.wallet = protectWallet(new Wallet(config.privateKey, this.provider));
    this.ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, this.wallet);
    this.usdcContract = new Contract(USDC_CONTRACT, ERC20_ABI, this.wallet);
    this.gasPriceMultiplier = config.gasPriceMultiplier || 1.2;
    this.confirmations = config.confirmations || 1;
    this.txTimeout = config.txTimeout || 60000;
  }

  getAddress(): string {
    return this.wallet.address;
  }

  /** Read historical payout evidence only; never changes submission provenance. */
  async getRedeemPayout(transactionHash: string, expectedWallet: string): Promise<RedeemPayoutLookup> {
    try {
      if (typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
        throw new Error('Invalid redeem transaction hash');
      }
      if (typeof expectedWallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(expectedWallet)) {
        throw new Error('Invalid expected redeem wallet');
      }
      const wallet = ethers.utils.getAddress(expectedWallet.toLowerCase());
      const receipt = await this.provider.getTransactionReceipt(transactionHash);
      if (!receipt) throw new Error('Redeem receipt unavailable');
      if (receipt.status !== 1) throw new Error('Redeem receipt lacks successful status');
      if (typeof receipt.transactionHash !== 'string' ||
          !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash) ||
          receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
        throw new Error('Redeem receipt transaction mismatch');
      }
      return { state: 'PAYOUT_KNOWN', transactionHash,
        pusdReceived: redeemPusdReceived(receipt, wallet) };
    } catch (cause) {
      return { state: 'PAYOUT_UNKNOWN', transactionHash, pusdReceived: undefined, cause };
    }
  }

  /** CLOB V2 collateral only; legacy CTF lifecycle retains USDC.e. */
  async getPusdBalance(): Promise<string> {
    const { collateral } = getContractConfig(this.provider.network.chainId);
    const token = new Contract(collateral, ERC20_ABI, this.provider);
    return ethers.utils.formatUnits(await token.balanceOf(this.wallet.address), COLLATERAL_TOKEN_DECIMALS);
  }

  async getUsdcBalance(): Promise<string> {
    const balance = await this.usdcContract.balanceOf(this.wallet.address);
    return ethers.utils.formatUnits(balance, USDC_DECIMALS);
  }

  async getNativeUsdcBalance(): Promise<string> {
    const nativeUsdcContract = new Contract(NATIVE_USDC_CONTRACT, ERC20_ABI, this.provider);
    const balance = await nativeUsdcContract.balanceOf(this.wallet.address);
    return ethers.utils.formatUnits(balance, USDC_DECIMALS);
  }

  /**
   * Check if wallet is ready for CTF trading operations
   *
   * Verifies:
   * - Has sufficient USDC.e (not native USDC)
   * - Has MATIC for gas fees
   *
   * @param amount - Minimum USDC.e amount needed (e.g., "100" for 100 USDC.e)
   * @param minMatic - Minimum MATIC for gas (default: 0.01). Pass the bot's
   * configured floor (e.g. CONFIG.onchain.minMatic) so the check matches policy.
   * @returns Ready status with balances and suggestions
   *
   * @example
   * ```typescript
   * const status = await ctf.checkReadyForCTF('100');
   * if (!status.ready) {
   *   console.log(status.suggestion);
   *   // "You have 50 native USDC but 0 USDC.e. Swap native USDC to USDC.e first."
   * }
   * ```
   */
  async checkReadyForCTF(amount: string, minMatic = 0.01): Promise<{
    ready: boolean;
    usdcEBalance: string;
    nativeUsdcBalance: string;
    maticBalance: string;
    suggestion?: string;
  }> {
    const [usdcE, nativeUsdc, matic] = await Promise.all([
      this.getUsdcBalance(),
      this.getNativeUsdcBalance(),
      this.provider.getBalance(this.wallet.address),
    ]);

    const usdcEBalance = parseFloat(usdcE);
    const nativeUsdcBalance = parseFloat(nativeUsdc);
    const maticBalance = parseFloat(ethers.utils.formatEther(matic));
    const amountNeeded = parseFloat(amount);

    const result = {
      ready: false,
      usdcEBalance: usdcE,
      nativeUsdcBalance: nativeUsdc,
      maticBalance: ethers.utils.formatEther(matic),
      suggestion: undefined as string | undefined,
    };

    // Check MATIC for gas
    if (maticBalance < minMatic) {
      result.suggestion = `Insufficient MATIC for gas fees. Have: ${maticBalance.toFixed(4)} MATIC, need at least ${minMatic} MATIC.`;
      return result;
    }

    if (usdcEBalance < amountNeeded) {
      if (nativeUsdcBalance >= amountNeeded) {
        result.suggestion = `You have ${nativeUsdcBalance.toFixed(2)} native USDC but only ${usdcEBalance.toFixed(2)} USDC.e. ` +
          `Polymarket CTF requires USDC.e. Use SwapService.swap('USDC', 'USDC_E', '${amount}') to convert.`;
      } else if (nativeUsdcBalance > 0) {
        result.suggestion = `Insufficient USDC.e. Have: ${usdcEBalance.toFixed(2)} USDC.e + ${nativeUsdcBalance.toFixed(2)} native USDC, need: ${amount} USDC.e. ` +
          `Swap all native USDC to USDC.e, then add more funds.`;
      } else {
        result.suggestion = `Insufficient USDC.e. Have: ${usdcEBalance.toFixed(2)} USDC.e, need: ${amount} USDC.e.`;
      }
      return result;
    }

    result.ready = true;
    return result;
  }

  async split(conditionId: string, amount: string, routing?: LifecycleRouting): Promise<SplitResult> {
    // V2.3C1a/C2b: both market types must split through a V2 collateral
    // adapter with pUSD. Standard uses CtfCollateralAdapter; neg-risk uses
    // NegRiskCtfCollateralAdapter. Unknown routing fails closed; there is
    // no legacy fallback.
    if (!routing) {
      throw new Error('Split requires lifecycle routing: market negRisk routing is unknown');
    }
    const adapter = resolveLifecycleAdapter(routing); // fails closed on non-boolean routing

    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

    const pusd = new Contract(PUSD, ERC20_ABI, this.provider);
    const balance = await pusd.balanceOf(this.wallet.address);
    if (balance.lt(amountWei)) {
      throw new Error(`Insufficient pUSD balance. Have: ${ethers.utils.formatUnits(balance, USDC_DECIMALS)}, Need: ${amount}`);
    }

    // V2.3B lifecycle approval path (pUSD → selected lifecycle adapter).
    const allowance = await pusd.allowance(this.wallet.address, adapter.address);
    if (allowance.lt(amountWei)) {
      await sendPusdApproveTx(this.wallet, this.provider, adapter.address, ethers.constants.MaxUint256);
    }

    const lifecycleAdapter = new Contract(adapter.address, STANDARD_CTF_ADAPTER_ABI, this.wallet);
    const tx = await lifecycleAdapter.splitPosition(
      USDC_CONTRACT,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
      amountWei,
      await this.getGasOptions()
    );

    const receipt = await tx.wait();

    return {
      success: true,
      txHash: receipt.transactionHash,
      amount,
      yesTokens: amount,
      noTokens: amount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * V2.3C1b: routing guard for standard merge. Fails closed before any
   * balance read for neg-risk or unknown routing.
   */
  private resolveStandardMergeAdapter(routing: LifecycleRouting | undefined): { name: string; address: string } {
    if (!routing) {
      throw new Error('Standard merge requires lifecycle routing: market negRisk routing is unknown');
    }
    if (routing.negRisk === true) {
      throw new Error('Neg-risk merge is not implemented yet (V2.3C1b covers standard markets only)');
    }
    return resolveLifecycleAdapter(routing); // fails closed on non-boolean routing
  }

  /**
   * V2.3C1b/C2c: canonical merge through the selected collateral adapter.
   * Balance validation is performed by the caller (merge vs mergeByTokenIds);
   * this method executes the adapter transaction and the required ERC1155
   * operator approval.
   */
  private async standardMergePositions(
    conditionId: string,
    amountWei: ethers.BigNumber,
    adapter: { name: string; address: string },
    onProvenance?: MergeProvenanceObserver
  ): Promise<MergeResult> {
    let attempted = false;
    let submissionReturned = false;
    let confirmed = false;
    let transactionHash: string | undefined;
    const notify = (state: MergeProvenance['state']): MergeProvenance => {
      const snapshot = Object.freeze({ state, ...(transactionHash ? { transactionHash } : {}) });
      try { onProvenance?.(snapshot); } catch { /* diagnostic only */ }
      return snapshot;
    };
    try {
      const conditionalTokens = new Contract(CTF_CONTRACT, ERC1155_ABI, this.provider);
      const isOperator = await conditionalTokens.isApprovedForAll(this.wallet.address, adapter.address);
      if (!isOperator) {
        const approval = await sendCtfOperatorApprovalTx(this.wallet, this.provider, adapter.address, true);
        if (!approval.success) throw new Error(approval.error || 'Merge operator approval failed');
      }
      const lifecycleAdapter = new Contract(adapter.address, STANDARD_CTF_ADAPTER_ABI, this.wallet);
      const gasOptions = await this.getGasOptions();
      // Exceptions beyond this boundary cannot generally exclude a broadcast.
      attempted = true;
      const tx = await lifecycleAdapter.mergePositions(
        USDC_CONTRACT, ethers.constants.HashZero, conditionId, [1, 2], amountWei, gasOptions
      );
      submissionReturned = true;
      if (typeof tx?.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx.hash)) {
        transactionHash = tx.hash;
        notify('SUBMITTED');
      }
      const receipt = await tx.wait();
      if (receipt?.status !== 1 || !transactionHash || typeof receipt.transactionHash !== 'string' ||
          !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash) ||
          receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
        throw new Error('Merge receipt does not prove confirmation');
      }
      confirmed = true;
      const provenance = notify('CONFIRMED');
      return {
        success: true, provenance,
        txHash: receipt.transactionHash,
        amount: ethers.utils.formatUnits(amountWei, USDC_DECIMALS),
        usdcReceived: ethers.utils.formatUnits(amountWei, USDC_DECIMALS),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (cause) {
      const state = confirmed ? 'CONFIRMED'
        : !attempted || (!submissionReturned && cause instanceof WriteBlockedError)
          ? 'NOT_SUBMITTED' : 'UNCERTAIN';
      throw new MergeProvenanceError(cause, notify(state));
    }
  }

  async merge(conditionId: string, amount: string, routing?: LifecycleRouting, onProvenance?: MergeProvenanceObserver): Promise<MergeResult> {
    try {
      const adapter = this.resolveStandardMergeAdapter(routing);
      const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

      const balances = await this.getPositionBalance(conditionId);
      const yesBalance = ethers.utils.parseUnits(balances.yesBalance, USDC_DECIMALS);
      const noBalance = ethers.utils.parseUnits(balances.noBalance, USDC_DECIMALS);

      if (yesBalance.lt(amountWei) || noBalance.lt(amountWei)) {
        throw new Error(
          `Insufficient token balance. Need ${amount} of each. Have: YES=${balances.yesBalance}, NO=${balances.noBalance}`
        );
      }

      return await this.standardMergePositions(conditionId, amountWei, adapter, onProvenance);
    } catch (cause) {
      if (cause instanceof MergeProvenanceError) throw cause;
      const error = new MergeProvenanceError(cause, { state: 'NOT_SUBMITTED' });
      try { onProvenance?.(error.provenance); } catch { /* diagnostic only */ }
      throw error;
    }
  }

  async mergeByTokenIds(conditionId: string, tokenIds: TokenIds, amount: string, routing?: LifecycleRouting, onProvenance?: MergeProvenanceObserver): Promise<MergeResult> {
    try {
      // V2.3C1b/C2c: both market types must merge through a V2 collateral
      // adapter via mergeByTokenIds. Standard uses CtfCollateralAdapter; neg-risk
      // uses NegRiskCtfCollateralAdapter. Unknown routing fails closed.
      // Generic merge() for neg-risk remains blocked.
      const adapter = resolveLifecycleAdapter(routing); // fails closed on non-boolean routing
      const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

      const balances = await this.getPositionBalanceByTokenIds(conditionId, tokenIds);
      const yesBalance = ethers.utils.parseUnits(balances.yesBalance, USDC_DECIMALS);
      const noBalance = ethers.utils.parseUnits(balances.noBalance, USDC_DECIMALS);

      if (yesBalance.lt(amountWei) || noBalance.lt(amountWei)) {
        throw new Error(
          `Insufficient token balance. Need ${amount} of each. Have: YES=${balances.yesBalance}, NO=${balances.noBalance}`
        );
      }

      return await this.standardMergePositions(conditionId, amountWei, adapter, onProvenance);
    } catch (cause) {
      if (cause instanceof MergeProvenanceError) throw cause;
      const error = new MergeProvenanceError(cause, { state: 'NOT_SUBMITTED' });
      try { onProvenance?.(error.provenance); } catch { /* diagnostic only */ }
      throw error;
    }
  }

  /**
   * V2.3C1c: routing guard for standard redeem. Fails closed before any
   * balance read for neg-risk or unknown routing.
   */
  private resolveStandardRedeemAdapter(routing: LifecycleRouting | undefined): { name: string; address: string } {
    if (!routing) {
      throw new Error('Standard redeem requires lifecycle routing: market negRisk routing is unknown');
    }
    if (routing.negRisk === true) {
      throw new Error('Neg-risk redeem is not implemented yet (V2.3C1c covers standard markets only)');
    }
    return resolveLifecycleAdapter(routing); // fails closed on non-boolean routing
  }

  /**
   * V2.3C1c/C2d: canonical redeem through the selected collateral adapter.
   * The adapter pulls the caller's FULL balances of BOTH outcome positions
   * (no amount parameter). Balances are snapshot before the transaction and
   * reported in the result for truthful accounting.
   */
  private async standardRedeemPositions(
    conditionId: string,
    yesBalanceWei: ethers.BigNumber,
    noBalanceWei: ethers.BigNumber,
    winningOutcome: string,
    adapter: { name: string; address: string },
    onProvenance?: RedeemProvenanceObserver
  ): Promise<RedeemResult> {
    let attempted = false;
    let confirmed = false;
    let submissionReturned = false;
    let transactionHash: string | undefined;
    let usdcReceived: RedeemResult['usdcReceived'] | undefined;
    const notify = (state: RedeemProvenance['state']): RedeemProvenance => {
      const snapshot = Object.freeze({ state, ...(transactionHash ? { transactionHash } : {}) });
      try { onProvenance?.(snapshot); } catch { /* diagnostic only */ }
      return snapshot;
    };
    try {
      // ERC1155 operator approval: the adapter pulls YES + NO from the EOA.
      const conditionalTokens = new Contract(CTF_CONTRACT, ERC1155_ABI, this.provider);
      const isOperator = await conditionalTokens.isApprovedForAll(this.wallet.address, adapter.address);
      if (!isOperator) {
        const approval = await sendCtfOperatorApprovalTx(this.wallet, this.provider, adapter.address);
        if (!approval.success) throw new Error(approval.error || 'Redeem operator approval failed');
      }

      const lifecycleAdapter = new Contract(adapter.address, STANDARD_CTF_ADAPTER_ABI, this.wallet);
      const gasOptions = await this.getGasOptions();
      // From this boundary onwards, arbitrary exceptions cannot exclude broadcast.
      attempted = true;
      const tx = await lifecycleAdapter.redeemPositions(
        USDC_CONTRACT,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        gasOptions
      );

      submissionReturned = true;
      if (typeof tx?.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx.hash)) {
        transactionHash = tx.hash;
        notify('SUBMITTED');
      }
      const receipt = await tx.wait();
      if (receipt?.status !== 1 || typeof receipt.transactionHash !== 'string' ||
          !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash) ||
          (transactionHash && receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase())) {
        throw new Error('Redeem receipt does not prove confirmation');
      }
      transactionHash = receipt.transactionHash;
      confirmed = true;
      const provenance = notify('CONFIRMED');

      usdcReceived = redeemPusdReceived(receipt, this.wallet.address);
      // Preserve legacy position reporting separately from the receipt-scoped payout.
      const winningBalanceWei = winningOutcome === 'YES' ? yesBalanceWei : noBalanceWei;
      const winningBalance = ethers.utils.formatUnits(winningBalanceWei, USDC_DECIMALS);

      return {
        success: true,
        provenance,
        txHash: receipt.transactionHash,
        outcome: winningOutcome,
        tokensRedeemed: winningBalance,
        usdcReceived,
        yesTokensConsumed: ethers.utils.formatUnits(yesBalanceWei, USDC_DECIMALS),
        noTokensConsumed: ethers.utils.formatUnits(noBalanceWei, USDC_DECIMALS),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (cause) {
      // This internal typed barrier proves no redeem send occurred. Never infer
      // non-submission from arbitrary RPC messages or textual error codes.
      const state = confirmed ? 'CONFIRMED'
        : !attempted || (!submissionReturned && cause instanceof WriteBlockedError)
          ? 'NOT_SUBMITTED' : 'UNCERTAIN';
      throw new RedeemProvenanceError(cause, notify(state), usdcReceived);
    }
  }

  async redeem(conditionId: string, outcome?: string, routing?: LifecycleRouting): Promise<RedeemResult> {
    const adapter = this.resolveStandardRedeemAdapter(routing);
    const resolution = await this.getMarketResolution(conditionId);
    if (!resolution.isResolved) {
      throw new Error('Market is not resolved yet');
    }

    const winningOutcome = outcome || resolution.winningOutcome;
    if (!winningOutcome) {
      throw new Error('Could not determine winning outcome');
    }
    if (outcome && resolution.winningOutcome && outcome !== resolution.winningOutcome) {
      throw new Error(`Outcome mismatch: requested ${outcome}, but market resolved to ${resolution.winningOutcome}`);
    }

    const balances = await this.getPositionBalance(conditionId);
    const yesBalanceWei = ethers.utils.parseUnits(balances.yesBalance, USDC_DECIMALS);
    const noBalanceWei = ethers.utils.parseUnits(balances.noBalance, USDC_DECIMALS);

    const winningBalance = winningOutcome === 'YES' ? balances.yesBalance : balances.noBalance;
    if (parseFloat(winningBalance) === 0) {
      throw new Error(`No ${winningOutcome} tokens to redeem`);
    }

    return this.standardRedeemPositions(conditionId, yesBalanceWei, noBalanceWei, winningOutcome, adapter);
  }

  async redeemByTokenIds(
    conditionId: string,
    tokenIds: TokenIds,
    outcome?: string,
    routing?: LifecycleRouting,
    onProvenance?: RedeemProvenanceObserver
  ): Promise<RedeemResult> {
    try {
      // V2.3C1c/C2d: both market types must redeem through a V2 collateral
      // adapter via redeemByTokenIds. Standard uses CtfCollateralAdapter; neg-risk
      // uses NegRiskCtfCollateralAdapter. Unknown routing fails closed.
      // Generic redeem() for neg-risk remains blocked.
      const adapter = resolveLifecycleAdapter(routing); // fails closed on non-boolean routing
      const resolution = await this.getMarketResolution(conditionId);
      if (!resolution.isResolved) {
        throw new Error('Market is not resolved yet');
      }

      const winningOutcome = outcome || resolution.winningOutcome;
      if (!winningOutcome) {
        throw new Error('Could not determine winning outcome');
      }
      if (outcome && resolution.winningOutcome && outcome !== resolution.winningOutcome) {
        throw new Error(`Outcome mismatch: requested ${outcome}, but market resolved to ${resolution.winningOutcome}`);
      }

      const balances = await this.getPositionBalanceByTokenIds(conditionId, tokenIds);
      const yesBalanceWei = ethers.utils.parseUnits(balances.yesBalance, USDC_DECIMALS);
      const noBalanceWei = ethers.utils.parseUnits(balances.noBalance, USDC_DECIMALS);

      const winningBalance = winningOutcome === 'YES' ? balances.yesBalance : balances.noBalance;
      if (parseFloat(winningBalance) === 0) {
        throw new Error(`No ${winningOutcome} tokens to redeem`);
      }

      return await this.standardRedeemPositions(conditionId, yesBalanceWei, noBalanceWei, winningOutcome, adapter, onProvenance);
    } catch (cause) {
      if (cause instanceof RedeemProvenanceError) throw cause;
      const error = new RedeemProvenanceError(cause, { state: 'NOT_SUBMITTED' });
      try { onProvenance?.(error.provenance); } catch { /* diagnostic only */ }
      throw error;
    }
  }

  async getPositionBalance(conditionId: string): Promise<PositionBalance> {
    const yesPositionId = this.calculatePositionId(conditionId, 1);
    const noPositionId = this.calculatePositionId(conditionId, 2);

    const [yesBalance, noBalance] = await Promise.all([
      this.ctfContract.balanceOf(this.wallet.address, yesPositionId),
      this.ctfContract.balanceOf(this.wallet.address, noPositionId),
    ]);

    return {
      conditionId,
      yesBalance: ethers.utils.formatUnits(yesBalance, USDC_DECIMALS),
      noBalance: ethers.utils.formatUnits(noBalance, USDC_DECIMALS),
      yesPositionId,
      noPositionId,
    };
  }

  async getPositionBalanceByTokenIds(
    conditionId: string,
    tokenIds: TokenIds
  ): Promise<PositionBalance> {
    const [yesBalance, noBalance] = await Promise.all([
      this.ctfContract.balanceOf(this.wallet.address, tokenIds.yesTokenId),
      this.ctfContract.balanceOf(this.wallet.address, tokenIds.noTokenId),
    ]);

    return {
      conditionId,
      yesBalance: ethers.utils.formatUnits(yesBalance, USDC_DECIMALS),
      noBalance: ethers.utils.formatUnits(noBalance, USDC_DECIMALS),
      yesPositionId: tokenIds.yesTokenId,
      noPositionId: tokenIds.noTokenId,
    };
  }

  async getMarketResolution(conditionId: string, routing?: LifecycleRouting): Promise<MarketResolution> {
    void routing; // V2.3A: plumbing only; resolution reads still hit the legacy CTF.
    const [yesNumerator, noNumerator, denominator] = await Promise.all([
      this.ctfContract.payoutNumerators(conditionId, 0),
      this.ctfContract.payoutNumerators(conditionId, 1),
      this.ctfContract.payoutDenominator(conditionId),
    ]);

    const isResolved = denominator.gt(0);
    let winningOutcome: 'YES' | 'NO' | undefined;

    if (isResolved) {
      if (yesNumerator.gt(0) && noNumerator.eq(0)) {
        winningOutcome = 'YES';
      } else if (noNumerator.gt(0) && yesNumerator.eq(0)) {
        winningOutcome = 'NO';
      }
    }

    return {
      conditionId,
      isResolved,
      winningOutcome,
      payoutNumerators: [yesNumerator.toNumber(), noNumerator.toNumber()],
      payoutDenominator: denominator.toNumber(),
    };
  }

  async estimateSplitGas(conditionId: string, amount: string): Promise<string> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
    try {
      const gas = await this.ctfContract.estimateGas.splitPosition(
        USDC_CONTRACT,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        amountWei
      );
      return gas.toString();
    } catch {
      return '250000';
    }
  }

  async estimateMergeGas(conditionId: string, amount: string): Promise<string> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
    try {
      const gas = await this.ctfContract.estimateGas.mergePositions(
        USDC_CONTRACT,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        amountWei
      );
      return gas.toString();
    } catch {
      return '200000';
    }
  }

  async getDetailedSplitGasEstimate(conditionId: string, amount: string): Promise<GasEstimate> {
    const gasUnits = await this.estimateSplitGas(conditionId, amount);
    return this.calculateGasCost(gasUnits);
  }

  async getDetailedMergeGasEstimate(conditionId: string, amount: string): Promise<GasEstimate> {
    const gasUnits = await this.estimateMergeGas(conditionId, amount);
    return this.calculateGasCost(gasUnits);
  }

  async getGasPrice(): Promise<{ gwei: string; wei: string }> {
    const gasPrice = await this.provider.getGasPrice();
    return {
      gwei: ethers.utils.formatUnits(gasPrice, 'gwei'),
      wei: gasPrice.toString(),
    };
  }

  async getMaticPrice(): Promise<number> {
    const now = Date.now();
    const cacheAge = now - this.maticPriceLastUpdated;

    if (cacheAge < 5 * 60 * 1000 && this.maticPriceLastUpdated > 0) {
      return this.cachedMaticPrice;
    }

    this.cachedMaticPrice = DEFAULT_MATIC_PRICE;
    this.maticPriceLastUpdated = now;

    return this.cachedMaticPrice;
  }

  setMaticPrice(price: number): void {
    this.cachedMaticPrice = price;
    this.maticPriceLastUpdated = Date.now();
  }

  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (!receipt) {
        const tx = await this.provider.getTransaction(txHash);
        if (!tx) {
          return {
            txHash,
            status: 'failed',
            confirmations: 0,
            errorReason: 'Transaction not found',
          };
        }
        return {
          txHash,
          status: 'pending',
          confirmations: 0,
        };
      }

      const currentBlock = await this.provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber + 1;

      if (receipt.status === 0) {
        const reason = await this.getRevertReason(txHash);
        return {
          txHash,
          status: 'reverted',
          confirmations,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice?.toString(),
          errorReason: reason,
        };
      }

      return {
        txHash,
        status: 'confirmed',
        confirmations,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice?.toString(),
      };
    } catch (error) {
      return {
        txHash,
        status: 'failed',
        confirmations: 0,
        errorReason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async waitForTransaction(txHash: string, confirmations?: number): Promise<TransactionStatus> {
    const targetConfirmations = confirmations ?? this.confirmations;
    const startTime = Date.now();

    while (Date.now() - startTime < this.txTimeout) {
      const status = await this.getTransactionStatus(txHash);

      if (status.status === 'reverted' || status.status === 'failed') {
        return status;
      }

      if (status.status === 'confirmed' && status.confirmations >= targetConfirmations) {
        return status;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return {
      txHash,
      status: 'pending',
      confirmations: 0,
      errorReason: `Timeout after ${this.txTimeout}ms`,
    };
  }

  async getRevertReason(txHash: string): Promise<string> {
    try {
      const tx = await this.provider.getTransaction(txHash);
      if (!tx) return RevertReason.UNKNOWN;

      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 0) return RevertReason.UNKNOWN;

      try {
        await this.provider.call(tx as ethers.providers.TransactionRequest, tx.blockNumber);
        return RevertReason.UNKNOWN;
      } catch (error: unknown) {
        const err = error as { reason?: string; message?: string; data?: string };
        if (err.reason) return err.reason;
        if (err.message) {
          if (err.message.includes('insufficient balance')) {
            return RevertReason.INSUFFICIENT_BALANCE;
          }
          if (err.message.includes('allowance')) {
            return RevertReason.INSUFFICIENT_ALLOWANCE;
          }
          if (err.message.includes('condition not resolved')) {
            return RevertReason.CONDITION_NOT_RESOLVED;
          }
          return err.message;
        }
        return RevertReason.EXECUTION_REVERTED;
      }
    } catch {
      return RevertReason.UNKNOWN;
    }
  }

  async getAllPositions(conditionIds: string[]): Promise<PositionBalance[]> {
    const positions: PositionBalance[] = [];

    for (const conditionId of conditionIds) {
      try {
        const balance = await this.getPositionBalance(conditionId);
        if (parseFloat(balance.yesBalance) > 0 || parseFloat(balance.noBalance) > 0) {
          positions.push(balance);
        }
      } catch {
        // Skip errors
      }
    }

    return positions;
  }

  async canMerge(conditionId: string, amount: string): Promise<{ canMerge: boolean; reason?: string }> {
    try {
      const balances = await this.getPositionBalance(conditionId);
      return this.checkMergeBalance(balances, amount);
    } catch (error) {
      return {
        canMerge: false,
        reason: error instanceof Error ? error.message : 'Failed to check balances'
      };
    }
  }

  async canMergeWithTokenIds(
    conditionId: string,
    tokenIds: TokenIds,
    amount: string
  ): Promise<{ canMerge: boolean; reason?: string }> {
    try {
      const balances = await this.getPositionBalanceByTokenIds(conditionId, tokenIds);
      return this.checkMergeBalance(balances, amount);
    } catch (error) {
      return {
        canMerge: false,
        reason: error instanceof Error ? error.message : 'Failed to check balances'
      };
    }
  }

  private checkMergeBalance(
    balances: PositionBalance,
    amount: string
  ): { canMerge: boolean; reason?: string } {
    const amountNum = parseFloat(amount);
    const yesBalance = parseFloat(balances.yesBalance);
    const noBalance = parseFloat(balances.noBalance);

    if (yesBalance < amountNum) {
      return {
        canMerge: false,
        reason: `Insufficient YES tokens. Have: ${yesBalance}, Need: ${amountNum}`
      };
    }
    if (noBalance < amountNum) {
      return {
        canMerge: false,
        reason: `Insufficient NO tokens. Have: ${noBalance}, Need: ${amountNum}`
      };
    }

    return { canMerge: true };
  }

  async canSplit(amount: string): Promise<{ canSplit: boolean; reason?: string }> {
    try {
      const balance = await this.getUsdcBalance();
      const balanceNum = parseFloat(balance);
      const amountNum = parseFloat(amount);

      if (balanceNum < amountNum) {
        return {
          canSplit: false,
          reason: `Insufficient USDC. Have: ${balance}, Need: ${amount}`
        };
      }

      return { canSplit: true };
    } catch (error) {
      return {
        canSplit: false,
        reason: error instanceof Error ? error.message : 'Failed to check balance'
      };
    }
  }

  async getPortfolioValue(positions: PositionBalance[], prices: Map<string, { yes: number; no: number }>): Promise<{
    totalValue: number;
    breakdown: Array<{
      conditionId: string;
      yesValue: number;
      noValue: number;
      totalValue: number;
    }>;
  }> {
    let totalValue = 0;
    const breakdown: Array<{
      conditionId: string;
      yesValue: number;
      noValue: number;
      totalValue: number;
    }> = [];

    for (const position of positions) {
      const price = prices.get(position.conditionId);
      if (!price) continue;

      const yesValue = parseFloat(position.yesBalance) * price.yes;
      const noValue = parseFloat(position.noBalance) * price.no;
      const positionValue = yesValue + noValue;

      totalValue += positionValue;
      breakdown.push({
        conditionId: position.conditionId,
        yesValue,
        noValue,
        totalValue: positionValue,
      });
    }

    return { totalValue, breakdown };
  }

  private calculatePositionId(conditionId: string, indexSet: number): string {
    const collectionId = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['bytes32', 'bytes32', 'uint256'],
        [ethers.constants.HashZero, conditionId, indexSet]
      )
    );

    const positionId = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['address', 'bytes32'],
        [USDC_CONTRACT, collectionId]
      )
    );

    return positionId;
  }

  private async getGasOptions(): Promise<{
    maxPriorityFeePerGas: BigNumber;
    maxFeePerGas: BigNumber;
  }> {
    const feeData = await this.provider.getFeeData();
    const baseFee = feeData.lastBaseFeePerGas || feeData.gasPrice || ethers.utils.parseUnits('100', 'gwei');

    const minPriorityFee = ethers.utils.parseUnits('30', 'gwei');
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minPriorityFee)
      ? feeData.maxPriorityFeePerGas
      : minPriorityFee;

    const adjustedBaseFee = baseFee.mul(Math.floor(this.gasPriceMultiplier * 100)).div(100);
    const maxFeePerGas = adjustedBaseFee.add(maxPriorityFeePerGas);

    return { maxPriorityFeePerGas, maxFeePerGas };
  }

  private async calculateGasCost(gasUnits: string): Promise<GasEstimate> {
    const gasOptions = await this.getGasOptions();
    const effectiveGasPrice = gasOptions.maxFeePerGas;

    const gasUnitsNum = BigNumber.from(gasUnits);
    const costWei = gasUnitsNum.mul(effectiveGasPrice);
    const costMatic = parseFloat(ethers.utils.formatEther(costWei));

    const maticPrice = await this.getMaticPrice();
    const costUsdc = costMatic * maticPrice;

    return {
      gasUnits,
      gasPriceGwei: ethers.utils.formatUnits(effectiveGasPrice, 'gwei'),
      costMatic: costMatic.toFixed(6),
      costUsdc: costUsdc.toFixed(4),
      maticPrice,
    };
  }
}

// ===== Utility Functions =====

export function calculateConditionId(
  oracle: string,
  questionId: string,
  outcomeSlotCount: number = 2
): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['address', 'bytes32', 'uint256'],
      [oracle, questionId, outcomeSlotCount]
    )
  );
}

export function parseUsdc(amount: string): BigNumber {
  return ethers.utils.parseUnits(amount, USDC_DECIMALS);
}

export function formatUsdc(amount: BigNumber): string {
  return ethers.utils.formatUnits(amount, USDC_DECIMALS);
}
