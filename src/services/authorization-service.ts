/**
 * Authorization Service
 *
 * Manages ERC20 and ERC1155 approvals required for trading on Polymarket.
 *
 * Required approvals for trading:
 * - ERC20 (pUSD): Approve spending for the two CLOB V2 exchanges.
 * - ERC1155 (Conditional Tokens): Approve operators for conditional token transfers
 *
 * @see https://docs.polymarket.com/
 */

import { ethers } from 'ethers';
import { getContractConfig, COLLATERAL_TOKEN_DECIMALS } from '@polymarket/clob-client-v2';
import { resolvePolygonRpcUrl } from '../utils/rpc.js';
import { protectWallet } from '../core/write-barrier.js';
import {
  CTF_CONTRACT,
  USDC_CONTRACT,
  CTF_COLLATERAL_ADAPTER,
  NEG_RISK_CTF_COLLATERAL_ADAPTER,
  resolveLifecycleAdapter,
  sendPusdApproveTx,
  sendCtfOperatorApprovalTx,
  type LifecycleRouting,
  type ApprovalTxResult,
} from '../clients/ctf-client.js';

// Contract addresses
const { collateral: PUSD, exchangeV2: CTF_EXCHANGE, negRiskExchangeV2: NEG_RISK_CTF_EXCHANGE } = getContractConfig(137);
const CONDITIONAL_TOKENS = CTF_CONTRACT;

export { CTF_COLLATERAL_ADAPTER, NEG_RISK_CTF_COLLATERAL_ADAPTER };
export type { ApprovalTxResult };

// ABIs
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

// Types
export interface AllowanceInfo {
  contract: string;
  address: string;
  approved: boolean;
  allowance?: string;
}

export interface AllowancesResult {
  wallet: string;
  pUsdBalance: string;
  erc20Allowances: AllowanceInfo[];
  erc1155Approvals: AllowanceInfo[];
  tradingReady: boolean;
  issues: string[];
}

export interface ApprovalsResult {
  wallet: string;
  erc20Approvals: ApprovalTxResult[];
  erc1155Approvals: ApprovalTxResult[];
  allApproved: boolean;
  summary: string;
}

/** V2.3B: approval status for one lifecycle collateral adapter. */
export interface LifecycleAdapterStatus {
  adapter: string;
  /** Human-readable adapter name (standard / neg-risk). */
  adapterName: string;
  /** pUSD ERC20 allowance for the adapter. */
  pusdAllowance: AllowanceInfo;
  /** ERC1155 operator approval on Conditional Tokens for the adapter. */
  erc1155Approval: AllowanceInfo;
  /** True when both approvals are sufficient for lifecycle operations. */
  ready: boolean;
  issues: string[];
}

/** V2.3B: outcome of lifecycle adapter approval setup for one adapter. */
export interface LifecycleApprovalsResult {
  wallet: string;
  adapter: string;
  erc20Approval: ApprovalTxResult;
  erc1155Approval: ApprovalTxResult;
  allApproved: boolean;
  summary: string;
}

export interface AuthorizationServiceConfig {
  provider?: ethers.providers.Provider;
}

// Contracts that need ERC20 approval
const ERC20_SPENDERS = [
  { name: 'CTF Exchange', address: CTF_EXCHANGE },
  { name: 'Neg Risk CTF Exchange', address: NEG_RISK_CTF_EXCHANGE },
];

// Operators that need ERC1155 approval
const ERC1155_OPERATORS = [
  { name: 'CTF Exchange', address: CTF_EXCHANGE },
  { name: 'Neg Risk CTF Exchange', address: NEG_RISK_CTF_EXCHANGE },
];

/**
 * Service for managing trading authorizations on Polymarket
 *
 * @example
 * ```typescript
 * const authService = new AuthorizationService(signer);
 *
 * // Check all allowances
 * const status = await authService.checkAllowances();
 * console.log(`Trading ready: ${status.tradingReady}`);
 * if (!status.tradingReady) {
 *   console.log('Issues:', status.issues);
 * }
 *
 * // Set up all approvals
 * const result = await authService.approveAll();
 * console.log(result.summary);
 * ```
 */
export class AuthorizationService {
  private signer: ethers.Wallet;
  private provider: ethers.providers.Provider;

  constructor(signer: ethers.Wallet, config: AuthorizationServiceConfig = {}) {
    this.signer = protectWallet(signer);
    this.provider = config.provider || signer.provider || new ethers.providers.JsonRpcProvider(resolvePolygonRpcUrl());
  }

  /**
   * Get the wallet address
   */
  get walletAddress(): string {
    return this.signer.address;
  }

  /**
   * Check all ERC20 and ERC1155 allowances required for trading
   *
   * @returns Status of all allowances and whether trading is ready
   */
  async checkAllowances(amount = '1'): Promise<AllowancesResult> {
    const required = ethers.utils.parseUnits(amount, COLLATERAL_TOKEN_DECIMALS);
    if (required.lte(0)) throw new Error('Trading collateral amount must be positive');
    const walletAddress = this.signer.address;

    const pusd = new ethers.Contract(PUSD, ERC20_ABI, this.provider);
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.provider);

    // Check operational pUSD balance
    const balance = await pusd.balanceOf(walletAddress);
    const balanceFormatted = ethers.utils.formatUnits(balance, COLLATERAL_TOKEN_DECIMALS);

    // Check ERC20 allowances
    const erc20Allowances: AllowanceInfo[] = [];
    for (const spender of ERC20_SPENDERS) {
      const allowance = await pusd.allowance(walletAddress, spender.address);
      const allowanceNum = parseFloat(ethers.utils.formatUnits(allowance, COLLATERAL_TOKEN_DECIMALS));
      const isUnlimited = allowanceNum > 1e12;

      erc20Allowances.push({
        contract: spender.name,
        address: spender.address,
        approved: allowance.gte(required),
        allowance: isUnlimited ? 'unlimited' : ethers.utils.formatUnits(allowance, COLLATERAL_TOKEN_DECIMALS),
      });
    }

    // Check ERC1155 approvals
    const erc1155Approvals: AllowanceInfo[] = [];
    for (const operator of ERC1155_OPERATORS) {
      const isApproved = await conditionalTokens.isApprovedForAll(walletAddress, operator.address);

      erc1155Approvals.push({
        contract: operator.name,
        address: operator.address,
        approved: isApproved,
      });
    }

    // Determine issues
    const issues: string[] = [];
    if (balance.lt(required)) issues.push(`Insufficient pUSD: need ${amount}`);
    for (const a of erc20Allowances) {
      if (!a.approved) {
        issues.push(`ERC20: ${a.contract} needs pUSD approval`);
      }
    }
    for (const a of erc1155Approvals) {
      if (!a.approved) {
        issues.push(`ERC1155: ${a.contract} needs approval for Conditional Tokens`);
      }
    }

    const tradingReady = issues.length === 0;

    return {
      wallet: walletAddress,
      pUsdBalance: balanceFormatted,
      erc20Allowances,
      erc1155Approvals,
      tradingReady,
      issues,
    };
  }

  /**
   * Set up all required approvals for trading
   *
   * @returns Results of all approval transactions
   */
  async approveAll(): Promise<ApprovalsResult> {
    const walletAddress = this.signer.address;

    const pusd = new ethers.Contract(PUSD, ERC20_ABI, this.signer);
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.signer);

    // Get gas price with buffer
    const gasPrice = await this.provider.getGasPrice();
    const adjustedGasPrice = gasPrice.mul(150).div(100); // 1.5x

    // Process ERC20 approvals
    const erc20Results: ApprovalTxResult[] = [];
    for (const spender of ERC20_SPENDERS) {
      // Check current allowance
      const allowance = await pusd.allowance(walletAddress, spender.address);
      const allowanceNum = parseFloat(ethers.utils.formatUnits(allowance, COLLATERAL_TOKEN_DECIMALS));

      if (allowanceNum > 1e12) {
        // Already approved
        erc20Results.push({
          contract: spender.name,
          success: true,
        });
        continue;
      }

      try {
        const tx = await pusd.approve(spender.address, ethers.constants.MaxUint256, {
          gasPrice: adjustedGasPrice,
        });
        await tx.wait();
        erc20Results.push({
          contract: spender.name,
          txHash: tx.hash,
          success: true,
        });
      } catch (err) {
        erc20Results.push({
          contract: spender.name,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    // Process ERC1155 approvals
    const erc1155Results: ApprovalTxResult[] = [];
    for (const operator of ERC1155_OPERATORS) {
      // Check current approval
      const isApproved = await conditionalTokens.isApprovedForAll(walletAddress, operator.address);

      if (isApproved) {
        // Already approved
        erc1155Results.push({
          contract: operator.name,
          success: true,
        });
        continue;
      }

      try {
        const tx = await conditionalTokens.setApprovalForAll(operator.address, true, {
          gasPrice: adjustedGasPrice,
          gasLimit: 100000,
        });
        await tx.wait();
        erc1155Results.push({
          contract: operator.name,
          txHash: tx.hash,
          success: true,
        });
      } catch (err) {
        erc1155Results.push({
          contract: operator.name,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const allApproved =
      erc20Results.every((r) => r.success) && erc1155Results.every((r) => r.success);

    const newApprovals = [...erc20Results, ...erc1155Results].filter((r) => r.txHash).length;

    return {
      wallet: walletAddress,
      erc20Approvals: erc20Results,
      erc1155Approvals: erc1155Results,
      allApproved,
      summary: allApproved
        ? newApprovals > 0
          ? `All approvals set. ${newApprovals} new approval(s) submitted.`
          : 'All trading approvals already set.'
        : 'Some approvals failed. Check the results for details.',
    };
  }

  /** Approve operational pUSD only for a CLOB V2 exchange. */
  async approvePusd(spenderAddress: string, amount: ethers.BigNumber = ethers.constants.MaxUint256): Promise<ApprovalTxResult> {
    if (!ERC20_SPENDERS.some(s => s.address.toLowerCase() === spenderAddress.toLowerCase())) {
      throw new Error('Not a CLOB V2 spender');
    }
    const token = new ethers.Contract(PUSD, ERC20_ABI, this.signer);
    try {
      const tx = await token.approve(spenderAddress, amount);
      await tx.wait();
      return { contract: spenderAddress, txHash: tx.hash, success: true };
    } catch (err) {
      return { contract: spenderAddress, success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * V2.3B: resolve exactly one lifecycle collateral adapter from market
   * routing. Fails closed when routing is unknown — never defaults to
   * the standard adapter. Canonical implementation in ctf-client.
   */
  private resolveLifecycleAdapter(routing: LifecycleRouting | undefined): { name: string; address: string } {
    return resolveLifecycleAdapter(routing);
  }

  /**
   * V2.3B: check pUSD ERC20 allowance and ERC1155 operator approval for the
   * lifecycle collateral adapter selected by market routing.
   */
  async checkLifecycleAdapterApprovals(routing: LifecycleRouting | undefined, amount = '1'): Promise<LifecycleAdapterStatus> {
    const adapter = this.resolveLifecycleAdapter(routing);
    const required = ethers.utils.parseUnits(amount, COLLATERAL_TOKEN_DECIMALS);
    if (required.lte(0)) throw new Error('Lifecycle collateral amount must be positive');
    const walletAddress = this.signer.address;

    const pusd = new ethers.Contract(PUSD, ERC20_ABI, this.provider);
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.provider);

    const allowance = await pusd.allowance(walletAddress, adapter.address);
    const allowanceNum = parseFloat(ethers.utils.formatUnits(allowance, COLLATERAL_TOKEN_DECIMALS));
    const isUnlimited = allowanceNum > 1e12;
    const pusdAllowance: AllowanceInfo = {
      contract: adapter.name,
      address: adapter.address,
      approved: allowance.gte(required),
      allowance: isUnlimited ? 'unlimited' : ethers.utils.formatUnits(allowance, COLLATERAL_TOKEN_DECIMALS),
    };

    const isOperator = await conditionalTokens.isApprovedForAll(walletAddress, adapter.address);
    const erc1155Approval: AllowanceInfo = {
      contract: adapter.name,
      address: adapter.address,
      approved: isOperator,
    };

    const issues: string[] = [];
    if (!pusdAllowance.approved) issues.push(`ERC20: ${adapter.name} needs pUSD approval`);
    if (!erc1155Approval.approved) issues.push(`ERC1155: ${adapter.name} needs approval for Conditional Tokens`);

    return {
      adapter: adapter.address,
      adapterName: adapter.name,
      pusdAllowance,
      erc1155Approval,
      ready: issues.length === 0,
      issues,
    };
  }

  /**
   * V2.3B: set the pUSD ERC20 allowance and ERC1155 operator approval for the
   * lifecycle collateral adapter selected by market routing. Only the two
   * verified adapter addresses are eligible; unknown routing fails closed.
   *
   * This is lifecycle-specific and must NOT be used for CLOB trading
   * approvals (and vice versa).
   */
  async approveLifecycleAdapter(routing: LifecycleRouting | undefined): Promise<LifecycleApprovalsResult> {
    const adapter = this.resolveLifecycleAdapter(routing);
    const walletAddress = this.signer.address;

    const pusd = new ethers.Contract(PUSD, ERC20_ABI, this.signer);
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.signer);

    let erc20Approval: ApprovalTxResult;
    const allowance = await pusd.allowance(walletAddress, adapter.address);
    const allowanceNum = parseFloat(ethers.utils.formatUnits(allowance, COLLATERAL_TOKEN_DECIMALS));
    if (allowanceNum > 1e12) {
      erc20Approval = { contract: adapter.name, success: true };
    } else {
      erc20Approval = await sendPusdApproveTx(this.signer, this.provider, adapter.address, ethers.constants.MaxUint256);
    }

    let erc1155Approval: ApprovalTxResult;
    const isOperator = await conditionalTokens.isApprovedForAll(walletAddress, adapter.address);
    if (isOperator) {
      erc1155Approval = { contract: adapter.name, success: true };
    } else {
      erc1155Approval = await sendCtfOperatorApprovalTx(this.signer, this.provider, adapter.address);
    }

    const allApproved = erc20Approval.success && erc1155Approval.success;
    return {
      wallet: walletAddress,
      adapter: adapter.address,
      erc20Approval,
      erc1155Approval,
      allApproved,
      summary: allApproved
        ? `${adapter.name} lifecycle approvals ready.`
        : `Some ${adapter.name} lifecycle approvals failed. Check the results for details.`,
    };
  }

  /** Utility approval for legacy USDC.e; not a CLOB V2 trading approval. */
  async approveUsdc(
    spenderAddress: string,
    amount: ethers.BigNumber = ethers.constants.MaxUint256
  ): Promise<ApprovalTxResult> {
    const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, this.signer);
    const gasPrice = await this.provider.getGasPrice();

    try {
      const tx = await usdc.approve(spenderAddress, amount, {
        gasPrice: gasPrice.mul(150).div(100),
      });
      await tx.wait();
      return {
        contract: spenderAddress,
        txHash: tx.hash,
        success: true,
      };
    } catch (err) {
      return {
        contract: spenderAddress,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Set approval for an ERC1155 operator
   *
   * @param operatorAddress - The operator address to approve
   * @param approved - Whether to approve or revoke
   */
  async setErc1155Approval(
    operatorAddress: string,
    approved: boolean = true
  ): Promise<ApprovalTxResult> {
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.signer);
    const gasPrice = await this.provider.getGasPrice();

    try {
      const tx = await conditionalTokens.setApprovalForAll(operatorAddress, approved, {
        gasPrice: gasPrice.mul(150).div(100),
        gasLimit: 100000,
      });
      await tx.wait();
      return {
        contract: operatorAddress,
        txHash: tx.hash,
        success: true,
      };
    } catch (err) {
      return {
        contract: operatorAddress,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }
}
