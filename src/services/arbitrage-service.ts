/**
 * ArbitrageService - Real-time Arbitrage Detection and Execution
 *
 * Uses WebSocket for real-time orderbook monitoring and automatically
 * detects arbitrage opportunities in Polymarket binary markets.
 *
 * Strategy:
 * - Long Arb: Buy YES + NO (effective cost < $1) → Merge → $1 USDC
 * - Short Arb: Sell pre-held YES + NO tokens (effective revenue > $1)
 *
 * Features:
 * - Real-time orderbook monitoring via WebSocket
 * - Automatic arbitrage detection using effective prices
 * - Configurable profit threshold and trade sizes
 * - Auto-execute mode or event-based manual mode
 * - Balance tracking and position management
 *
 * Based on: scripts/arb/faze-bo3-arb.ts
 * Docs: docs/arbitrage.md
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import {
  RealtimeServiceV2,
  type MarketSubscription,
  type OrderbookSnapshot,
} from './realtime-service-v2.js';
import { TradingService } from './trading-service.js';
import { MarketService } from './market-service.js';
import { CTFClient, MergeProvenanceError, type TokenIds, type LifecycleRouting, type MergeResult, type RedeemResult, type TransactionStatus } from '../clients/ctf-client.js';
import { GammaApiClient } from '../clients/gamma-api.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { createUnifiedCache } from '../core/unified-cache.js';
import {
  getEffectivePrices,
  calculateExecutableSize,
  calculateNetLongArbProfit,
  calculateNetShortArbProfit,
  estimateTakerFee,
} from '../utils/price-utils.js';
import { resolvePolygonRpcUrl } from '../utils/rpc.js';
import type { BookUpdate } from '../core/types.js';
import type { PreExecutionGuard } from '../utils/risk.js';

// ===== Types =====

export interface ArbitrageMarketConfig {
  /** Market name for logging */
  name: string;
  /** Condition ID */
  conditionId: string;
  /** YES token ID from CLOB API */
  yesTokenId: string;
  /** NO token ID from CLOB API */
  noTokenId: string;
  /** Outcome names [YES, NO] */
  outcomes?: [string, string];
  /** Whether this is a neg-risk market (from CLOB metadata) */
  negRisk?: boolean;
}

export interface ArbitrageServiceConfig {
  /** Private key for trading (optional for monitor-only mode) */
  privateKey?: string;
  /** RPC URL for CTF operations */
  rpcUrl?: string;
  /** Minimum profit threshold (default: 0.005 = 0.5%) */
  profitThreshold?: number;
  /** Minimum trade size in USDC (default: 5) */
  minTradeSize?: number;
  /** Maximum single trade size in USDC (default: 100) */
  maxTradeSize?: number;
  /** Minimum token reserve for short arb (default: 10) */
  minTokenReserve?: number;
  /** Auto-execute mode (default: false) */
  autoExecute?: boolean;
  /** Enable logging (default: true) */
  enableLogging?: boolean;
  /** Cooldown between executions in ms (default: 5000) */
  executionCooldown?: number;

  // ===== Rebalancer Config =====
  /** Enable auto-rebalancing (default: false) */
  enableRebalancer?: boolean;
  /** Minimum USDC ratio 0-1 (default: 0.2 = 20%) - Split if below */
  minUsdcRatio?: number;
  /** Maximum USDC ratio 0-1 (default: 0.8 = 80%) - Merge if above */
  maxUsdcRatio?: number;
  /** Target USDC ratio when rebalancing (default: 0.5 = 50%) */
  targetUsdcRatio?: number;
  /** Max YES/NO imbalance before auto-fix (default: 5 tokens) */
  imbalanceThreshold?: number;
  /** Rebalance check interval in ms (default: 10000) */
  rebalanceInterval?: number;
  /** Minimum cooldown between rebalance actions in ms (default: 30000) */
  rebalanceCooldown?: number;
  /** Size safety factor 0-1 (default: 0.8) - use only 80% of orderbook depth to prevent partial fills */
  sizeSafetyFactor?: number;
  /** Auto-fix imbalance after failed execution (default: true) */
  autoFixImbalance?: boolean;
  /** Taker fee in basis points applied to arb notional (default: 0) */
  feeRateBps?: number;
  /** Estimated gas cost per arb cycle in USDC (default: 0) */
  estimatedGasCostUsd?: number;
  /** Minimum net profit in USDC after fees + gas (default: 0) */
  minNetProfitUsd?: number;
  /** Max acceptable slippage vs effective price for order price caps (default: 0.01 = 1%) */
  maxSlippagePct?: number;
  /** Orderbook levels consumed for depth sizing (default: 5) */
  maxDepthLevels?: number;
  /** Execute YES/NO legs sequentially instead of Promise.all (default: true) */
  sequentialExecution?: boolean;
  /**
   * App-layer risk gate (audit #4): consulted before any order is placed.
   * Return null to allow, or a reason to block. Only exposure-opening fills
   * are gated — closes/exits bypass it inside the callees.
   */
  preExecutionGuard?: PreExecutionGuard;
  shortInventoryAdmission?: (query: Readonly<{ walletAddress: string; tokenIds: readonly string[] }>) => string | undefined;
}

export interface RebalanceAction {
  type: 'split' | 'merge' | 'sell_yes' | 'sell_no' | 'none';
  amount: number;
  reason: string;
  priority: number;
}

/** Factual SELL execution attributable to one rebalance order. */
export interface RebalanceSellFacts {
  orderId: string;
  tokenId: string;
  requestedShares: number;
  soldShares: number;
  weightedPrice?: number;
  txHashes: string[];
}

export interface RebalanceResult {
  success: boolean;
  action: RebalanceAction;
  txHash?: string;
  error?: string;
  /** SELL rebalance operation identity when the result belongs to a reconcilable order. */
  operationId?: string;
  /** SELL submitted but not factually reconciled: no completion claim, no event. */
  pending?: boolean;
  /** Present for terminal SELL rebalances; `success` requires the full requested quantity. */
  facts?: RebalanceSellFacts;
}

export interface SettleResult {
  market: ArbitrageMarketConfig;
  /** Balances read by this call; 0 placeholders when it read nothing (withheld, or an unresolved-merge reconciliation call). */
  yesBalance: number;
  noBalance: number;
  pairedTokens: number;
  unpairedYes: number;
  unpairedNo: number;
  merged: boolean;
  mergeAmount?: number;
  mergeTxHash?: string;
  usdcRecovered?: number;
  error?: string;
  /**
   * Another `clearPositions(market, true)` or `settlePosition(market, true)` for this market was
   * still active, so this call performed no balance read and no write.
   */
  withheld?: true;
  /**
   * A merge transaction that may have been broadcast has no confirmed or reverted receipt yet.
   * No recovery is claimed; the record blocks every merge on the market until it resolves.
   */
  pending?: true;
  /** Identity of the unresolved or reconciled merge record this result refers to. */
  operationId?: string;
}

export interface ClearPositionResult {
  market: ArbitrageMarketConfig;
  marketStatus: 'active' | 'resolved' | 'unknown';
  /** Balances read by this call; 0 placeholders when it read nothing (withheld, or an unresolved-merge reconciliation call). */
  yesBalance: number;
  noBalance: number;
  actions: ClearAction[];
  totalUsdcRecovered: number;
  success: boolean;
  error?: string;
  /**
   * Another `clearPositions(market, true)` for this market was still active, so this call
   * performed no balance read and no write; `yesBalance`/`noBalance` are 0 placeholders.
   */
  withheld?: true;
}

/** Factual SELL execution attributable to one clearPositions order. */
export interface ClearSellFacts extends RebalanceSellFacts {
  /** Sum of confirmed fill quantity × fill price; the only source of `usdcResult`. */
  proceedsUsd: number;
}

export interface ClearAction {
  type: 'merge' | 'sell_yes' | 'sell_no' | 'redeem';
  /** For terminal SELL actions: factually sold shares (see `facts.requestedShares` for the order size). */
  amount: number;
  usdcResult: number;
  txHash?: string;
  success: boolean;
  error?: string;
  /** Identity of a reconcilable local operation: a clear SELL order or a clear merge attempt. */
  operationId?: string;
  /**
   * A real economic operation whose outcome is not factually known: a SELL order awaiting
   * fills, or a merge transaction that may have been broadcast but has no confirmed or
   * reverted receipt yet. Zero proceeds, no success claim. Distinct from a `withheld` result,
   * which owns no venue or on-chain action at all.
   */
  pending?: boolean;
  /** Present for terminal SELL actions; `usdcResult` equals `facts.proceedsUsd`. */
  facts?: ClearSellFacts;
}

// ===== Market Scanning Types =====

export interface ScanCriteria {
  /** Minimum 24h volume in USDC (default: 1000) */
  minVolume24h?: number;
  /** Maximum 24h volume (optional) */
  maxVolume24h?: number;
  /** Keywords to filter markets (optional) */
  keywords?: string[];
  /** Maximum number of markets to scan (default: 100) */
  limit?: number;
}

export interface ScanResult {
  /** Market config ready to use with start() */
  market: ArbitrageMarketConfig;
  /** Best arbitrage type */
  arbType: 'long' | 'short' | 'none';
  /** Profit rate (e.g., 0.01 = 1%) */
  profitRate: number;
  /** Profit percentage */
  profitPercent: number;
  /** Effective prices */
  effectivePrices: {
    buyYes: number;
    buyNo: number;
    sellYes: number;
    sellNo: number;
    longCost: number;
    shortRevenue: number;
  };
  /** 24h volume */
  volume24h: number;
  /** Available size on orderbook */
  availableSize: number;
  /** Score 0-100 */
  score: number;
  /** Description */
  description: string;
}

export interface OrderbookState {
  yesBids: Array<{ price: number; size: number }>;
  yesAsks: Array<{ price: number; size: number }>;
  noBids: Array<{ price: number; size: number }>;
  noAsks: Array<{ price: number; size: number }>;
  lastUpdate: number;
}

export interface BalanceState {
  /** @deprecated Use pUsdBalance; this alias is CLOB collateral, not USDC.e. */
  usdc: number;
  pUsdBalance: number;
  yesTokens: number;
  noTokens: number;
  lastUpdate: number;
}

export interface ArbitrageOpportunity {
  type: 'long' | 'short';
  /** Profit rate (0.01 = 1%) */
  profitRate: number;
  /** Profit in percentage */
  profitPercent: number;
  /** Effective buy/sell prices */
  effectivePrices: {
    buyYes: number;
    buyNo: number;
    sellYes: number;
    sellNo: number;
  };
  /** Maximum executable size based on orderbook depth */
  maxOrderbookSize: number;
  /** Maximum executable size based on balance */
  maxBalanceSize: number;
  /** Recommended trade size */
  recommendedSize: number;
  /** Estimated profit in USDC */
  estimatedProfit: number;
  /** Net profit in USDC after fees + gas (when configured) */
  netProfit?: number;
  /** Worst-price caps sent with market orders (price protection) */
  priceCaps?: {
    buyYes: number;
    buyNo: number;
    sellYes: number;
    sellNo: number;
  };
  /** Description */
  description: string;
  /** Timestamp */
  timestamp: number;
}

/** Factual long-arb economics. Every quantity is derived from confirmed child
 * trades of this operation's own BUY orders and a receipt-confirmed merge. */
export interface LongArbFacts {
  yesOrderId: string;
  noOrderId: string;
  yesShares: number;
  yesCost: number;
  noShares: number;
  noCost: number;
  mergedShares: number;
  mergeValue: number;
  feeUsd: number;
  fillTxHashes: string[];
}

export interface ArbitrageExecutionResult {
  success: boolean;
  type: 'long' | 'short';
  size: number;
  profit: number;
  txHashes: string[];
  error?: string;
  executionTimeMs: number;
  /** Long-arb operation identity when the result belongs to a reconcilable operation. */
  operationId?: string;
  /** BUY reconciliation is incomplete: no terminal claim, no economics, no execution event. */
  pending?: boolean;
  /** Present only when `success` was proven from factual fills and a confirmed merge. */
  facts?: LongArbFacts;
}

export interface ShortArbSubmissionAck {
  type: 'SHORT_SUBMISSION';
  status: 'SUBMITTED_PENDING' | 'SUBMISSION_REJECTED' | 'SUBMISSION_UNCERTAIN';
  operationId: string;
}

type SellLegSettlement =
  | { state: 'PENDING' }
  | { state: 'TERMINAL_FAILED' }
  | { state: 'TERMINAL_SUCCESS'; successShares: number; weightedPrice: number; txHashes: string[]; successUnits?: bigint };

type PendingShortLeg = {
  tokenId: string;
  requestedShares?: number | string;
  tradeIds?: Set<string>;
  facts?: Map<string, string>;
  orderId?: string;
  submission: 'NOT_SUBMITTED' | 'REJECTED' | 'SUBMITTED' | 'UNCERTAIN';
  settlement?: SellLegSettlement;
};
type TerminalShortLeg = Exclude<SellLegSettlement, { state: 'PENDING' }> | { state: 'REJECTED' };
type PendingShortArb = {
  id: string;
  conditionId: string;
  legA: PendingShortLeg;
  legB: PendingShortLeg;
  terminalResult?: {
    state: 'BALANCED_SUCCESS' | 'IMBALANCED' | 'NO_FILL' | 'SUBMISSION_REJECTED';
    legA: TerminalShortLeg;
    legB: TerminalShortLeg;
  };
  consumed: boolean;
  finalized?: boolean;
  inventoryReconciled?: boolean;
};

/** Terminal fill facts for one local order (BUY cost or SELL proceeds in `cost`). */
type FillLegSettlement =
  | { state: 'PENDING' }
  | { state: 'TERMINAL'; units: bigint; shares: number; cost: number; weightedPrice?: number;
      /** All confirmed fills share one price, so any sub-quantity has an exact cost. */
      uniformPrice: boolean; txHashes: string[] };

type PendingFillLeg = {
  tokenId: string;
  requestedShares: number;
  orderId?: string;
  submission: 'NOT_SUBMITTED' | 'REJECTED' | 'SUBMITTED' | 'UNCERTAIN';
  tradeIds?: Set<string>;
  facts?: Map<string, string>;
  settlement?: FillLegSettlement;
};
type BuyLegSettlement = FillLegSettlement;
type PendingLongLeg = PendingFillLeg;

type PendingRebalanceSell = {
  id: string;
  /** `rebalance` publishes a `rebalance` event and pacing; `corrective` only logs (fixImbalanceIfNeeded). */
  kind: 'rebalance' | 'corrective';
  action: RebalanceAction;
  market: Pick<ArbitrageMarketConfig, 'conditionId' | 'yesTokenId' | 'noTokenId'>;
  label: string;
  leg: PendingFillLeg;
  submittedAt: number;
  flight?: Promise<RebalanceResult | undefined>;
  terminal?: RebalanceResult;
  published?: boolean;
};

/** One clearPositions SELL: retained until its terminal facts are reported by exactly one call. */
type PendingClearSell = {
  id: string;
  type: 'sell_yes' | 'sell_no';
  market: Pick<ArbitrageMarketConfig, 'conditionId' | 'yesTokenId' | 'noTokenId'>;
  label: string;
  leg: PendingFillLeg;
  submittedAt: number;
  flight?: Promise<ClearAction | undefined>;
  terminal?: ClearAction;
  /** Terminal outcome logged (inline or by the periodic flush). */
  logged?: boolean;
  /** Terminal outcome returned in a ClearPositionResult; the record is released with it. */
  reported?: boolean;
};

/**
 * One clearPositions merge whose on-chain outcome is not factually known: the transaction may
 * have been broadcast (SUBMITTED/UNCERTAIN provenance, or an unclassified throw). While the
 * record exists no merge or SELL may be authorized for the market; only the recorded
 * transaction's own receipt resolves it, never a balance read. At most one per conditionId.
 */
type PendingClearMerge = {
  id: string;
  market: Pick<ArbitrageMarketConfig, 'name' | 'conditionId' | 'yesTokenId' | 'noTokenId'>;
  /** Pairs requested in the merge transaction; collateral received if and only if it confirmed. */
  pairs: number;
  /** Well-formed transaction hash when the client exposed one; without it the record cannot be resolved. */
  txHash?: string;
  /** Client classification at throw time; UNKNOWN for an exception the client did not classify. */
  provenance: 'SUBMITTED' | 'UNCERTAIN' | 'UNKNOWN';
  error: string;
  submittedAt: number;
};

/** How a thrown clear merge is treated; only a proven non-broadcast may reuse the pre-merge snapshot. */
type ClearMergeThrow =
  | { state: 'NOT_SUBMITTED' }
  | { state: 'CONFIRMED'; txHash: string }
  | { state: 'UNRESOLVED'; provenance: PendingClearMerge['provenance']; txHash?: string };

/**
 * What the recorded transaction's own receipt proves about an unresolved merge. Shared by every
 * merge-writing entrypoint; only CONFIRMED and REVERTED release the record.
 */
type PendingMergeResolution =
  | { state: 'CONFIRMED' }
  | { state: 'REVERTED'; reason: string }
  | { state: 'UNRESOLVED'; reason: string };

type LongArbMerge =
  | { state: 'NOT_STARTED' }
  | { state: 'IN_FLIGHT' }
  | { state: 'UNCERTAIN'; txHash?: string }
  | { state: 'CONFIRMED'; shares: number; value: number; txHash: string };

type PendingLongArb = {
  id: string;
  market: ArbitrageMarketConfig;
  size: number;
  startedAt: number;
  legYes: PendingLongLeg;
  legNo: PendingLongLeg;
  merge: LongArbMerge;
  flight?: Promise<ArbitrageExecutionResult | undefined>;
  result?: ArbitrageExecutionResult;
  published?: boolean;
};

const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

/** CLOB share strings carry at most two decimals; 100 units = 1 share. */
function parseShareUnits(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error(`Invalid factual ${label} shares`);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function formatShareUnits(units: bigint): string {
  const whole = units / 100n, fraction = units % 100n;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(2, '0')}`.replace(/0$/, '');
}

/**
 * Receipt-scoped payout of a confirmed redeem, or undefined when the client
 * result does not prove one (unsuccessful, provenance other than CONFIRMED, or
 * a missing/invalid `usdcReceived`). The client resolves only after the receipt
 * is verified, so a present provenance must agree with that contract.
 */
/**
 * Classifies a thrown clear merge. Only the client's typed NOT_SUBMITTED proves no broadcast;
 * a typed CONFIRMED with a well-formed hash proves the merge landed. Everything else, including
 * an exception the client did not classify, may have been broadcast and stays unresolved.
 */
function classifyClearMergeThrow(error: unknown): ClearMergeThrow {
  if (!(error instanceof MergeProvenanceError)) return { state: 'UNRESOLVED', provenance: 'UNKNOWN' };
  const { state, transactionHash } = error.provenance;
  const txHash = typeof transactionHash === 'string' && TX_HASH_PATTERN.test(transactionHash) ? transactionHash : undefined;
  if (state === 'NOT_SUBMITTED') return { state: 'NOT_SUBMITTED' };
  if (state === 'CONFIRMED' && txHash) return { state: 'CONFIRMED', txHash };
  return { state: 'UNRESOLVED', provenance: state === 'SUBMITTED' ? 'SUBMITTED' : 'UNCERTAIN', ...(txHash ? { txHash } : {}) };
}

function factualRedeemPayout(result: RedeemResult): number | undefined {
  if (!result || result.success !== true) return undefined;
  if (result.provenance !== undefined && result.provenance.state !== 'CONFIRMED') return undefined;
  const raw = result.usdcReceived;
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const payout = Number(raw);
  return Number.isFinite(payout) && payout >= 0 ? payout : undefined;
}

/** Factual notification only; no realized-profit contract. */
export type ShortArbSettledLeg = Readonly<{
  tokenId: string; orderId?: string; submission: 'SUBMITTED' | 'REJECTED';
}> & (
  | Readonly<{ state: 'REJECTED' | 'TERMINAL_FAILED' }>
  | Readonly<{ state: 'TERMINAL_SUCCESS'; successShares: number;
      /** Decimal integer string: 100 successUnits = 1 share. */
      successUnits: string; weightedPrice: number; txHashes: readonly string[] }>
);
export interface ShortArbSettledEvent {
  readonly operationId: string;
  readonly conditionId: string;
  readonly classification: NonNullable<PendingShortArb['terminalResult']>['state'];
  readonly legA: ShortArbSettledLeg;
  readonly legB: ShortArbSettledLeg;
  readonly inventoryReconciled: boolean;
}

export interface ArbitrageServiceEvents {
  opportunity: (opportunity: ArbitrageOpportunity) => void;
  execution: (result: ArbitrageExecutionResult) => void;
  shortArbSettled: (result: ShortArbSettledEvent) => void;
  balanceUpdate: (balance: BalanceState) => void;
  orderbookUpdate: (orderbook: OrderbookState) => void;
  rebalance: (result: RebalanceResult) => void;
  settle: (result: SettleResult) => void;
  error: (error: Error) => void;
  started: (market: ArbitrageMarketConfig) => void;
  stopped: () => void;
}

// ===== ArbitrageService =====

export class ArbitrageService extends EventEmitter {
  private realtimeService: RealtimeServiceV2;
  private marketSubscription: MarketSubscription | null = null;
  private ctf: CTFClient | null = null;
  private tradingService: TradingService | null = null;
  private rateLimiter: RateLimiter;

  private market: ArbitrageMarketConfig | null = null;
  private config: Omit<Required<ArbitrageServiceConfig>, 'privateKey' | 'rpcUrl' | 'rebalanceInterval' | 'preExecutionGuard' | 'shortInventoryAdmission'> & {
    privateKey?: string;
    rpcUrl?: string;
    rebalanceIntervalMs: number;
    preExecutionGuard?: PreExecutionGuard;
    shortInventoryAdmission?: ArbitrageServiceConfig['shortInventoryAdmission'];
  };

  private orderbook: OrderbookState = {
    yesBids: [],
    yesAsks: [],
    noBids: [],
    noAsks: [],
    lastUpdate: 0,
  };

  private balance: BalanceState = {
    usdc: 0,
    pUsdBalance: 0,
    yesTokens: 0,
    noTokens: 0,
    lastUpdate: 0,
  };

  private isExecuting = false;
  private rebalancerInventoryWrites = new Set<Pick<ArbitrageMarketConfig, 'conditionId' | 'yesTokenId' | 'noTokenId'>>();
  private pendingShortArbs = new Map<string, PendingShortArb>();
  private nextShortArbId = 0;
  private shortArbConsuming = false;
  private shortArbFlushPromise: Promise<void> | null = null;
  private pendingLongArbs = new Map<string, PendingLongArb>();
  private nextLongArbId = 0;
  private longArbFlushPromise: Promise<void> | null = null;
  private pendingRebalanceSells = new Map<string, PendingRebalanceSell>();
  private nextRebalanceSellId = 0;
  private rebalanceSellFlushPromise: Promise<void> | null = null;
  /** Publication claims keyed by the shared terminal result object, which outlives the pending record. */
  private publishedRebalanceSells = new WeakSet<RebalanceResult>();
  private pendingClearSells = new Map<string, PendingClearSell>();
  /** Clear SELL submissions per `${conditionId}:${tokenId}`; guards sizing against a stale balance read. */
  private clearSellSubmissions = new Map<string, number>();
  /**
   * Condition IDs with a `clearPositions(market, true)` or `settlePosition(market, true)`
   * economic phase in flight. Held from before the balance read until the call settles, so no
   * second call can merge or sell the same inventory from a snapshot another call's merge may
   * have invalidated. One interlock for every merge-writing entrypoint.
   */
  private activeClearMarkets = new Set<string>();
  /**
   * Unresolved merges keyed by conditionId, installed by either merge-writing entrypoint and
   * checked by both under the interlock before any balance read.
   */
  private pendingClearMerges = new Map<string, PendingClearMerge>();
  private nextClearMergeId = 0;
  private nextClearSellId = 0;
  private clearSellFlushPromise: Promise<void> | null = null;
  private balanceRefreshVersion = 0;
  private lastExecutionTime = 0;
  private lastRebalanceTime = 0;
  private balanceUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private rebalanceInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private totalCapital = 0;

  // Statistics
  private stats = {
    opportunitiesDetected: 0,
    executionsAttempted: 0,
    executionsSucceeded: 0,
    totalProfit: 0,
    shortArbTerminals: { BALANCED_SUCCESS: 0, IMBALANCED: 0, NO_FILL: 0, SUBMISSION_REJECTED: 0 },
    startTime: 0,
  };

  constructor(config: ArbitrageServiceConfig = {}) {
    super();

    this.config = {
      privateKey: config.privateKey,
      rpcUrl: resolvePolygonRpcUrl(config.rpcUrl),
      profitThreshold: config.profitThreshold ?? 0.005,
      minTradeSize: config.minTradeSize ?? 5,
      maxTradeSize: config.maxTradeSize ?? 100,
      minTokenReserve: config.minTokenReserve ?? 10,
      autoExecute: config.autoExecute ?? false,
      enableLogging: config.enableLogging ?? true,
      executionCooldown: config.executionCooldown ?? 5000,
      // Rebalancer config
      enableRebalancer: config.enableRebalancer ?? false,
      minUsdcRatio: config.minUsdcRatio ?? 0.2,
      maxUsdcRatio: config.maxUsdcRatio ?? 0.8,
      targetUsdcRatio: config.targetUsdcRatio ?? 0.5,
      imbalanceThreshold: config.imbalanceThreshold ?? 5,
      rebalanceIntervalMs: config.rebalanceInterval ?? 10000,
      rebalanceCooldown: config.rebalanceCooldown ?? 30000,
      // Execution safety
      sizeSafetyFactor: config.sizeSafetyFactor ?? 0.8,
      autoFixImbalance: config.autoFixImbalance ?? true,
      // Fee-aware + price-protected execution (PROBLEMS.md #1/#2)
      feeRateBps: config.feeRateBps ?? 0,
      estimatedGasCostUsd: config.estimatedGasCostUsd ?? 0,
      minNetProfitUsd: config.minNetProfitUsd ?? 0,
      maxSlippagePct: config.maxSlippagePct ?? 0.01,
      maxDepthLevels: config.maxDepthLevels ?? 5,
      sequentialExecution: config.sequentialExecution ?? true,
      // Audit #4: risk gate passes straight through (no default — unset = unguarded, caller's choice)
      preExecutionGuard: config.preExecutionGuard,
      shortInventoryAdmission: config.shortInventoryAdmission,
    };

    this.rateLimiter = new RateLimiter();
    this.realtimeService = new RealtimeServiceV2({ debug: false });

    // Initialize trading clients if private key provided
    if (this.config.privateKey) {
      this.ctf = new CTFClient({
        privateKey: this.config.privateKey,
        rpcUrl: this.config.rpcUrl,
      });

      const cache = createUnifiedCache();
      this.tradingService = new TradingService(this.rateLimiter, cache, {
        privateKey: this.config.privateKey,
        chainId: 137,
      });
    }

    // RealtimeServiceV2 event handlers are set up during subscription
  }

  // ===== Public API =====

  updateConfig(config: Partial<ArbitrageServiceConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
    if (config.profitThreshold !== undefined) {
      this.log(`Config updated: profitThreshold=${config.profitThreshold}`);
    }
  }

  /**
   * Start monitoring a market for arbitrage opportunities
   */
  async start(market: ArbitrageMarketConfig): Promise<void> {
    if (this.isRunning) {
      throw new Error('ArbitrageService is already running. Call stop() first.');
    }

    this.market = market;
    this.isRunning = true;
    this.stats.startTime = Date.now();

    this.log(`Starting arbitrage monitor for: ${market.name}`);
    this.log(`Condition ID: ${market.conditionId.slice(0, 20)}...`);
    this.log(`Profit Threshold: ${(this.config.profitThreshold * 100).toFixed(2)}%`);
    this.log(`Auto Execute: ${this.config.autoExecute ? 'YES' : 'NO'}`);

    // Initialize trading service
    if (this.tradingService) {
      await this.tradingService.initialize();
      this.log(`Wallet: ${this.ctf?.getAddress()}`);
      await this.updateBalance();
      this.log(`pUSD Balance: ${this.balance.pUsdBalance.toFixed(2)}`);
      this.log(`YES Tokens: ${this.balance.yesTokens.toFixed(2)}`);
      this.log(`NO Tokens: ${this.balance.noTokens.toFixed(2)}`);

      // Calculate total capital (USDC + paired tokens)
      const pairedTokens = Math.min(this.balance.yesTokens, this.balance.noTokens);
      this.totalCapital = this.balance.pUsdBalance + pairedTokens;
      this.log(`Total Capital: ${this.totalCapital.toFixed(2)}`);

      // Start balance update interval
      this.balanceUpdateInterval = setInterval(async () => {
        try {
          await this.flushPendingShortArbs();
        } catch (error) {
          try { this.log(`Short-arb flush: ${String(error)}`); } catch { /* preserve future cycles */ }
        }
        try {
          await this.flushPendingLongArbs();
        } catch (error) {
          try { this.log(`Long-arb flush: ${String(error)}`); } catch { /* preserve future cycles */ }
        }
        try {
          await this.flushPendingRebalanceSells();
        } catch (error) {
          try { this.log(`Rebalance SELL flush: ${String(error)}`); } catch { /* preserve future cycles */ }
        }
        try {
          await this.flushPendingClearSells();
        } catch (error) {
          try { this.log(`Clear SELL flush: ${String(error)}`); } catch { /* preserve future cycles */ }
        }
        try {
          await this.updateBalance();
        } catch (error) {
          try { this.log(`Balance refresh: ${String(error)}`); } catch { /* preserve future cycles */ }
        }
        try {
          this.consumeTerminalShortArbs();
        } catch (error) {
          try { this.log(`Short-arb consumption: ${String(error)}`); } catch { /* preserve future cycles */ }
        }
      }, 30000);

      // Start rebalancer if enabled
      if (this.config.enableRebalancer) {
        this.log(`Rebalancer: ENABLED (USDC range: ${(this.config.minUsdcRatio * 100).toFixed(0)}%-${(this.config.maxUsdcRatio * 100).toFixed(0)}%, target: ${(this.config.targetUsdcRatio * 100).toFixed(0)}%)`);
        this.rebalanceInterval = setInterval(
          () => this.checkAndRebalance(),
          this.config.rebalanceIntervalMs
        );
      }
    } else {
      this.log('No wallet configured - monitoring only');
    }

    // Connect and subscribe to WebSocket
    this.realtimeService.connect();
    this.marketSubscription = this.realtimeService.subscribeMarkets(
      [market.yesTokenId, market.noTokenId],
      {
        onOrderbook: (book: OrderbookSnapshot) => {
          // Convert OrderbookSnapshot to BookUpdate format
          const bookUpdate: BookUpdate = {
            assetId: book.assetId,
            bids: book.bids,
            asks: book.asks,
            timestamp: book.timestamp,
          };
          this.handleBookUpdate(bookUpdate);
        },
        onError: (error: Error) => this.emit('error', error),
      }
    );

    this.emit('started', market);
    this.log('Monitoring for arbitrage opportunities...');
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.balanceUpdateInterval) {
      clearInterval(this.balanceUpdateInterval);
      this.balanceUpdateInterval = null;
    }

    if (this.rebalanceInterval) {
      clearInterval(this.rebalanceInterval);
      this.rebalanceInterval = null;
    }

    // Unsubscribe and disconnect
    if (this.marketSubscription) {
      this.marketSubscription.unsubscribe();
      this.marketSubscription = null;
    }
    this.realtimeService.disconnect();

    this.log('Stopped');
    this.log(`Total opportunities: ${this.stats.opportunitiesDetected}`);
    this.log(`Executions: ${this.stats.executionsSucceeded}/${this.stats.executionsAttempted}`);
    this.log(`Total profit: $${this.stats.totalProfit.toFixed(2)}`);

    this.emit('stopped');
  }

  /**
   * Check if service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get current orderbook state
   */
  getOrderbook(): OrderbookState {
    return { ...this.orderbook };
  }

  /**
   * Get current balance state
   */
  getBalance(): BalanceState {
    return { ...this.balance };
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      shortArbTerminals: { ...this.stats.shortArbTerminals },
      runningTimeMs: this.isRunning ? Date.now() - this.stats.startTime : 0,
    };
  }

  /**
   * Check for arbitrage opportunity based on current orderbook
   */
  checkOpportunity(): ArbitrageOpportunity | null {
    if (!this.market) return null;

    const { yesBids, yesAsks, noBids, noAsks } = this.orderbook;
    if (yesBids.length === 0 || yesAsks.length === 0 || noBids.length === 0 || noAsks.length === 0) {
      return null;
    }

    const yesBestBid = yesBids[0]?.price || 0;
    const yesBestAsk = yesAsks[0]?.price || 1;
    const noBestBid = noBids[0]?.price || 0;
    const noBestAsk = noAsks[0]?.price || 1;

    // Calculate effective prices
    const effective = getEffectivePrices(yesBestAsk, yesBestBid, noBestAsk, noBestBid);

    // Check for arbitrage
    const longCost = effective.effectiveBuyYes + effective.effectiveBuyNo;
    const longProfit = 1 - longCost;
    const shortRevenue = effective.effectiveSellYes + effective.effectiveSellNo;
    const shortProfit = shortRevenue - 1;

    // Calculate sizes with safety factor to prevent partial fills.
    // Aggregate across top orderbook levels (not just level 0) so a thin
    // best quote cannot justify the full size (PROBLEMS.md #2).
    const safetyFactor = this.config.sizeSafetyFactor;
    const maxLevels = this.config.maxDepthLevels;
    const slippage = this.config.maxSlippagePct;
    const feeRateBps = this.config.feeRateBps;
    const gasCostUsd = this.config.estimatedGasCostUsd;
    const minNetProfitUsd = this.config.minNetProfitUsd;

    // Worst-price caps sent with market orders (price protection).
    const buyYesCap = effective.effectiveBuyYes * (1 + slippage);
    const buyNoCap = effective.effectiveBuyNo * (1 + slippage);
    const sellYesFloor = effective.effectiveSellYes * (1 - slippage);
    const sellNoFloor = effective.effectiveSellNo * (1 - slippage);
    const priceCaps = { buyYes: buyYesCap, buyNo: buyNoCap, sellYes: sellYesFloor, sellNo: sellNoFloor };

    const yesAskDepth = calculateExecutableSize(yesAsks, safetyFactor, buyYesCap, true, maxLevels);
    const noAskDepth = calculateExecutableSize(noAsks, safetyFactor, buyNoCap, true, maxLevels);
    const yesBidDepth = calculateExecutableSize(yesBids, safetyFactor, sellYesFloor, false, maxLevels);
    const noBidDepth = calculateExecutableSize(noBids, safetyFactor, sellNoFloor, false, maxLevels);
    const orderbookLongSize = Math.min(yesAskDepth.size, noAskDepth.size);
    const orderbookShortSize = Math.min(yesBidDepth.size, noBidDepth.size);
    const heldPairs = Math.min(this.balance.yesTokens, this.balance.noTokens);
    const balanceLongSize = longCost > 0 ? this.balance.pUsdBalance / longCost : 0;

    // Check long arb (fee-aware: gross edge must survive fees + gas)
    if (longProfit > this.config.profitThreshold) {
      const maxSize = Math.min(orderbookLongSize, balanceLongSize * safetyFactor, this.config.maxTradeSize);
      if (maxSize >= this.config.minTradeSize) {
        const net = calculateNetLongArbProfit(longCost, maxSize, feeRateBps, gasCostUsd);
        if (net.net < minNetProfitUsd) return null;
        return {
          type: 'long',
          profitRate: longProfit,
          profitPercent: longProfit * 100,
          effectivePrices: {
            buyYes: effective.effectiveBuyYes,
            buyNo: effective.effectiveBuyNo,
            sellYes: effective.effectiveSellYes,
            sellNo: effective.effectiveSellNo,
          },
          maxOrderbookSize: orderbookLongSize,
          maxBalanceSize: balanceLongSize,
          recommendedSize: maxSize,
          estimatedProfit: longProfit * maxSize,
          netProfit: net.net,
          priceCaps,
          description: `Buy YES @ ${effective.effectiveBuyYes.toFixed(4)} + NO @ ${effective.effectiveBuyNo.toFixed(4)}, Merge for $1`,
          timestamp: Date.now(),
        };
      }
    }

    // Check short arb (fee-aware)
    if (shortProfit > this.config.profitThreshold) {
      const maxSize = Math.min(orderbookShortSize, heldPairs, this.config.maxTradeSize);
      if (maxSize >= this.config.minTradeSize && heldPairs >= this.config.minTokenReserve) {
        const net = calculateNetShortArbProfit(shortRevenue, maxSize, feeRateBps, gasCostUsd);
        if (net.net < minNetProfitUsd) return null;
        return {
          type: 'short',
          profitRate: shortProfit,
          profitPercent: shortProfit * 100,
          effectivePrices: {
            buyYes: effective.effectiveBuyYes,
            buyNo: effective.effectiveBuyNo,
            sellYes: effective.effectiveSellYes,
            sellNo: effective.effectiveSellNo,
          },
          maxOrderbookSize: orderbookShortSize,
          maxBalanceSize: heldPairs,
          recommendedSize: maxSize,
          estimatedProfit: shortProfit * maxSize,
          netProfit: net.net,
          priceCaps,
          description: `Sell YES @ ${effective.effectiveSellYes.toFixed(4)} + NO @ ${effective.effectiveSellNo.toFixed(4)}`,
          timestamp: Date.now(),
        };
      }
    }

    return null;
  }

  /**
   * Manually execute an arbitrage opportunity
   */
  async execute(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult | ShortArbSubmissionAck> {
    // Audit #4: risk gate first — cheapest check, no state touched.
    // recommendedSize is a PAIR COUNT, not USDC — convert to notional so the
    // per-trade USD cap compares like with like (long: pair cost; short:
    // pair sale proceeds).
    const ep = opportunity.effectivePrices;
    const intentUsd = opportunity.type === 'long'
      ? opportunity.recommendedSize * (ep.buyYes + ep.buyNo)
      : opportunity.recommendedSize * (ep.sellYes + ep.sellNo);
    const blockReason = this.config.preExecutionGuard?.({
      strategy: 'arbitrage',
      side: opportunity.type === 'long' ? 'BUY' : 'SELL',
      usdcAmount: intentUsd,
      marketKey: this.market?.conditionId ?? 'unknown',
    });
    if (blockReason) {
      return {
        success: false,
        type: opportunity.type,
        size: 0,
        profit: 0,
        txHashes: [],
        error: `Blocked by risk guard: ${blockReason}`,
        executionTimeMs: 0,
      };
    }

    if (!this.ctf || !this.tradingService || !this.market) {
      return {
        success: false,
        type: opportunity.type,
        size: 0,
        profit: 0,
        txHashes: [],
        error: 'Trading not configured (no private key)',
        executionTimeMs: 0,
      };
    }

    // Repeated requests for the same unresolved short are acknowledgements,
    // not new attempts. Keep this ahead of both the lock and attempt counter.
    if (opportunity.type === 'short') {
      for (const pending of this.pendingShortArbs.values()) {
        if ((!pending.finalized || pending.inventoryReconciled !== true) && pending.conditionId === this.market.conditionId &&
            pending.legA.tokenId === this.market.yesTokenId && pending.legB.tokenId === this.market.noTokenId) {
          return { type: 'SHORT_SUBMISSION', operationId: pending.id,
            status: [pending.legA, pending.legB].some(leg => leg.submission === 'UNCERTAIN')
              ? 'SUBMISSION_UNCERTAIN' : 'SUBMITTED_PENDING' };
        }
      }
    }

    // An unresolved long on this market is neither retried nor resubmitted:
    // its BUY facts are still being reconciled. No attempt, no event.
    if (opportunity.type === 'long') {
      const unresolved = this.findPendingLongArb(this.market);
      if (unresolved) {
        return { success: false, type: 'long', size: 0, profit: 0, txHashes: [],
          error: `Long arb ${unresolved.id} pending factual reconciliation`, executionTimeMs: 0,
          operationId: unresolved.id, pending: true };
      }
    }

    // Admission refusal, not an economic execution result. No attempts or events.
    // A rebalance writer (SELL / split / merge) changes both collateral and YES/NO inventory,
    // so it excludes LONG and SHORT alike.
    const protectedShort = opportunity.type === 'long' ? this.getShortInventoryBlock(this.market) : undefined;
    if (protectedShort) throw new Error(`Inventory write blocked by short ${protectedShort}`);
    if (this.isRebalancerWriting(this.market)) throw new Error('Inventory write blocked by active rebalancer');

    if (this.isExecuting) {
      return {
        success: false,
        type: opportunity.type,
        size: 0,
        profit: 0,
        txHashes: [],
        error: 'Another execution in progress',
        executionTimeMs: 0,
      };
    }

    if (opportunity.type === 'short' && this.config.shortInventoryAdmission) {
      const reason = this.config.shortInventoryAdmission(Object.freeze({
        walletAddress: this.getInventoryWalletAddress(),
        tokenIds: Object.freeze([this.market.yesTokenId, this.market.noTokenId]),
      }));
      if (reason) throw new Error(`Inventory admission refused: ${reason}`);
    }

    // Claim synchronously, before the first await: a second execute() arriving during the
    // fresh balance read must see the claim and perform neither its own read nor a write.
    this.isExecuting = true;
    const startTime = Date.now();
    let attempted = false;

    try {
      // The opportunity was sized from the cached balance, which is telemetry, not authority.
      // Only a fresh, complete read may back the collateral / held-pair checks inside the
      // executors; a failed refresh withholds the whole opportunity, never resizes it.
      if (!(await this.updateBalance())) {
        this.log('⏸️ Execution withheld: fresh balance refresh failed');
        return {
          success: false, type: opportunity.type, size: 0, profit: 0, txHashes: [],
          error: 'Fresh balance refresh failed; execution withheld', executionTimeMs: Date.now() - startTime,
        };
      }
      // Ownership may have changed while awaiting the read (its notification runs listeners
      // synchronously). Same admission refusals as above: no attempt, no event.
      const shortAfterRead = opportunity.type === 'long' ? this.getShortInventoryBlock(this.market) : undefined;
      if (shortAfterRead) throw new Error(`Inventory write blocked by short ${shortAfterRead}`);
      if (this.isRebalancerWriting(this.market)) throw new Error('Inventory write blocked by active rebalancer');

      attempted = true;
      this.stats.executionsAttempted++;
      const result = opportunity.type === 'long'
        ? await this.executeLongArb(opportunity)
        : await this.executeShortArb(opportunity);

      if (result.type === 'SHORT_SUBMISSION') {
        // Preserve submission pacing without claiming economic success.
        if (result.status !== 'SUBMISSION_REJECTED') this.lastExecutionTime = Date.now();
        return result;
      }

      if (result.pending) {
        // BUY legs submitted but not factually reconciled: pace, never claim.
        this.lastExecutionTime = Date.now();
        return result;
      }

      this.publishLongArbResult(result);
      return result;
    } finally {
      this.isExecuting = false;
      // Refresh after an economic attempt; a call withheld before any write changed nothing.
      if (attempted) await this.updateBalance();
    }
  }

  // ===== Rebalancer Methods =====

  /**
   * Calculate recommended rebalance action based on current state
   */
  calculateRebalanceAction(): RebalanceAction {
    if (!this.market || this.totalCapital === 0) {
      return { type: 'none', amount: 0, reason: 'No market or capital', priority: 0 };
    }

    const { usdc, yesTokens, noTokens } = this.balance;
    const pairedTokens = Math.min(yesTokens, noTokens);
    const currentTotal = usdc + pairedTokens;
    const usdcRatio = usdc / currentTotal;
    const tokenImbalance = yesTokens - noTokens;

    // Priority 1: Fix YES/NO imbalance (highest priority - risk control)
    if (Math.abs(tokenImbalance) > this.config.imbalanceThreshold) {
      if (tokenImbalance > 0) {
        const sellAmount = Math.min(tokenImbalance, yesTokens * 0.5);
        if (sellAmount >= this.config.minTradeSize) {
          return {
            type: 'sell_yes',
            amount: Math.floor(sellAmount * 1e6) / 1e6,
            reason: `Risk: YES > NO by ${tokenImbalance.toFixed(2)}`,
            priority: 100,
          };
        }
      } else {
        const sellAmount = Math.min(-tokenImbalance, noTokens * 0.5);
        if (sellAmount >= this.config.minTradeSize) {
          return {
            type: 'sell_no',
            amount: Math.floor(sellAmount * 1e6) / 1e6,
            reason: `Risk: NO > YES by ${(-tokenImbalance).toFixed(2)}`,
            priority: 100,
          };
        }
      }
    }

    // Priority 2: USDC ratio too high (> maxUsdcRatio) → Split to create tokens
    if (usdcRatio > this.config.maxUsdcRatio) {
      const targetUsdc = this.totalCapital * this.config.targetUsdcRatio;
      const excessUsdc = usdc - targetUsdc;
      const splitAmount = Math.min(excessUsdc * 0.5, usdc * 0.3);
      if (splitAmount >= this.config.minTradeSize) {
        return {
          type: 'split',
          amount: Math.floor(splitAmount * 100) / 100,
          reason: `USDC ${(usdcRatio * 100).toFixed(0)}% > ${(this.config.maxUsdcRatio * 100).toFixed(0)}% max`,
          priority: 50,
        };
      }
    }

    // Priority 3: USDC ratio too low (< minUsdcRatio) → Merge tokens to recover USDC
    if (usdcRatio < this.config.minUsdcRatio && pairedTokens >= this.config.minTradeSize) {
      const targetUsdc = this.totalCapital * this.config.targetUsdcRatio;
      const neededUsdc = targetUsdc - usdc;
      const mergeAmount = Math.min(neededUsdc * 0.5, pairedTokens * 0.5);
      if (mergeAmount >= this.config.minTradeSize) {
        return {
          type: 'merge',
          amount: Math.floor(mergeAmount * 100) / 100,
          reason: `USDC ${(usdcRatio * 100).toFixed(0)}% < ${(this.config.minUsdcRatio * 100).toFixed(0)}% min`,
          priority: 50,
        };
      }
    }

    return { type: 'none', amount: 0, reason: 'Balanced', priority: 0 };
  }

  /**
   * Execute a rebalance action
   */
  async rebalance(action?: RebalanceAction): Promise<RebalanceResult> {
    if (!this.ctf || !this.tradingService || !this.market) {
      return {
        success: false,
        action: action || { type: 'none', amount: 0, reason: 'No trading config', priority: 0 },
        error: 'Trading not configured',
      };
    }

    // Ownership admission before any read or write: an arbitrage execution, an unresolved short,
    // or another rebalance already owns this market's inventory. Refusals here are not economic
    // attempts: no balance read, no write, no event.
    const market = this.market;
    const withheld = (error: string): RebalanceResult => ({
      success: false, action: action || { type: 'none', amount: 0, reason: 'Rebalance withheld', priority: 0 }, error,
    });
    // An unresolved SELL (rebalancer or corrective) still owns this market's inventory until its
    // fills are factual and published: they may settle after any balance read taken here. An
    // explicit SELL repeat gets the same acknowledgement the SELL path returns; every other
    // request is a pre-write refusal. Nothing here reads, reconciles, or releases the record.
    const unresolvedSell = this.findPendingRebalanceSell(market);
    if (unresolvedSell) {
      if (action && (action.type === 'sell_yes' || action.type === 'sell_no')) {
        return { success: false, action, operationId: unresolvedSell.id, pending: true,
          error: `Rebalance SELL ${unresolvedSell.id} pending factual reconciliation` };
      }
      return withheld(`Rebalance withheld: SELL ${unresolvedSell.id} pending factual reconciliation`);
    }
    if (this.isExecuting) return withheld('Rebalance withheld: arbitrage execution in progress');
    const protectedShort = this.getShortInventoryBlock(market);
    if (protectedShort) return withheld(`Rebalance withheld: inventory owned by short ${protectedShort}`);
    if (this.isRebalancerWriting(market)) return withheld('Rebalance withheld: another rebalance owns this market');
    // An unresolved long still owns uncertain BUY inventory / collateral: its fills may settle after
    // any balance read taken here, so a fresh read is not authority over that inventory. Refuse
    // without reading; only the long's own reconciliation releases it.
    const pendingLong = this.findPendingLongArb(market);
    if (pendingLong) return withheld(`Rebalance withheld: long arb ${pendingLong.id} pending factual reconciliation`);

    // Claim synchronously, before the first await, so every caller (scheduled or direct) gets the
    // same exclusion against execute() and against a concurrent rebalance of this market.
    const writer = { conditionId: market.conditionId, yesTokenId: market.yesTokenId, noTokenId: market.noTokenId };
    this.rebalancerInventoryWrites.add(writer);
    try {
      // Cached balance is telemetry. Only a fresh, complete read may derive an action or
      // authorize a caller-supplied amount.
      if (!(await this.updateBalance())) {
        this.log('⏸️ Rebalance withheld: fresh balance refresh failed');
        return withheld('Fresh balance refresh failed; rebalance withheld');
      }
      // Ownership may have moved while awaiting the read (its notification runs listeners synchronously).
      if (this.isExecuting) return withheld('Rebalance withheld: arbitrage execution in progress');
      const shortAfterRead = this.getShortInventoryBlock(market);
      if (shortAfterRead) return withheld(`Rebalance withheld: inventory owned by short ${shortAfterRead}`);

      const rebalanceAction = action || this.calculateRebalanceAction();
      if (rebalanceAction.type === 'none') {
        return { success: true, action: rebalanceAction };
      }
      // The requested amount is authorized against fresh inventory as-is: never shrunk, never
      // replaced by a recalculated action. Non-finite / non-positive amounts keep their existing paths.
      const shortfall = this.rebalanceAuthorityShortfall(rebalanceAction);
      if (shortfall) {
        this.log(`⏸️ Rebalance withheld: ${shortfall}`);
        return { success: false, action: rebalanceAction, error: `Rebalance withheld: ${shortfall}` };
      }

      this.log(`\n🔄 Rebalance: ${rebalanceAction.type.toUpperCase()} ${rebalanceAction.amount.toFixed(2)}`);
      this.log(`   Reason: ${rebalanceAction.reason}`);

      // Acceptance is not execution: a SELL completes only from factual fills.
      if (rebalanceAction.type === 'sell_yes' || rebalanceAction.type === 'sell_no') {
        return await this.rebalanceSellAction(rebalanceAction);
      }

      try {
        let txHash: string | undefined;

        switch (rebalanceAction.type) {
          case 'split': {
            const result = await this.ctf.split(this.market.conditionId, rebalanceAction.amount.toString(), this.toLifecycleRouting(this.market));
            txHash = result.txHash;
            this.log(`   ✅ Split TX: ${txHash}`);
            break;
          }
          case 'merge': {
            const tokenIds: TokenIds = {
              yesTokenId: this.market.yesTokenId,
              noTokenId: this.market.noTokenId,
            };
            const result = await this.ctf.mergeByTokenIds(
              this.market.conditionId,
              tokenIds,
              rebalanceAction.amount.toString(),
              this.toLifecycleRouting(this.market)
            );
            txHash = result.txHash;
            this.log(`   ✅ Merge TX: ${txHash}`);
            break;
          }
        }

        await this.updateBalance();
        const rebalanceResult: RebalanceResult = { success: true, action: rebalanceAction, txHash };
        this.emit('rebalance', rebalanceResult);
        return rebalanceResult;
      } catch (error: any) {
        this.log(`   ❌ Failed: ${error.message}`);
        const rebalanceResult: RebalanceResult = {
          success: false,
          action: rebalanceAction,
          error: error.message,
        };
        this.emit('rebalance', rebalanceResult);
        return rebalanceResult;
      }
    } finally {
      this.rebalancerInventoryWrites.delete(writer);
    }
  }

  /** Amount the action needs beyond the freshly applied inventory, as a message; undefined when authorized. */
  private rebalanceAuthorityShortfall(action: RebalanceAction): string | undefined {
    const { pUsdBalance, yesTokens, noTokens } = this.balance;
    const available = action.type === 'sell_yes' ? yesTokens : action.type === 'sell_no' ? noTokens
      : action.type === 'split' ? pUsdBalance : Math.min(yesTokens, noTokens);
    const label = action.type === 'sell_yes' ? 'YES' : action.type === 'sell_no' ? 'NO'
      : action.type === 'split' ? 'pUSD' : 'paired tokens';
    if (action.amount > available) return `${action.type} ${action.amount} exceeds fresh ${label} ${available}`;
  }

  // ===== Settle Position Methods =====

  /**
   * Settle a market position - merge paired tokens to recover USDC
   * @param market Market to settle (defaults to current market)
   * @param execute If true, execute the merge. If false, just return info.
   */
  async settlePosition(market?: ArbitrageMarketConfig, execute = false): Promise<SettleResult> {
    const targetMarket = market || this.market;
    if (!targetMarket) {
      throw new Error('No market specified');
    }

    // Dry runs never write, so they neither take nor disturb the economic-write interlock.
    if (!execute) return this.runSettlePosition(targetMarket, false);

    // Same per-market interlock as clearPositions, acquired before the balance read: a merge
    // from either entrypoint would otherwise invalidate this call's snapshot before it merges.
    // The loser withholds rather than waits, because after waiting its snapshot would be stale.
    const key = targetMarket.conditionId;
    if (this.activeClearMarkets.has(key)) {
      this.log(`⏸️ settlePosition withheld for ${targetMarket.name}: another clear or settle operation is active for this market`);
      return {
        market: targetMarket,
        yesBalance: 0,
        noBalance: 0,
        pairedTokens: 0,
        unpairedYes: 0,
        unpairedNo: 0,
        merged: false,
        withheld: true,
        error: 'settlePosition withheld: another clear or settle operation is active for this market; re-run after it settles',
      };
    }
    this.activeClearMarkets.add(key);
    try {
      return await this.runSettlePosition(targetMarket, true);
    } finally {
      this.activeClearMarkets.delete(key);
    }
  }

  /** Body of {@link settlePosition}; for `execute=true` the caller holds the market's interlock. */
  private async runSettlePosition(targetMarket: ArbitrageMarketConfig, execute: boolean): Promise<SettleResult> {
    if (!this.ctf) {
      return {
        market: targetMarket,
        yesBalance: 0,
        noBalance: 0,
        pairedTokens: 0,
        unpairedYes: 0,
        unpairedNo: 0,
        merged: false,
        error: 'CTF client not configured',
      };
    }

    // Under the interlock and before any balance read: an earlier merge whose outcome is
    // unknown owns this market's inventory decision until its own transaction resolves.
    if (execute) {
      const unresolved = this.pendingClearMerges.get(targetMarket.conditionId);
      if (unresolved) return this.reconcileSettleMergeCall(unresolved, targetMarket);
    }

    const tokenIds: TokenIds = {
      yesTokenId: targetMarket.yesTokenId,
      noTokenId: targetMarket.noTokenId,
    };

    // Get token balances
    const positions = await this.ctf.getPositionBalanceByTokenIds(targetMarket.conditionId, tokenIds);
    const yesBalance = parseFloat(positions.yesBalance);
    const noBalance = parseFloat(positions.noBalance);

    const pairedTokens = Math.min(yesBalance, noBalance);
    const unpairedYes = yesBalance - pairedTokens;
    const unpairedNo = noBalance - pairedTokens;

    this.log(`\n📊 Position: ${targetMarket.name}`);
    this.log(`   YES: ${yesBalance.toFixed(6)}`);
    this.log(`   NO: ${noBalance.toFixed(6)}`);
    this.log(`   Paired: ${pairedTokens.toFixed(6)} (can merge → $${pairedTokens.toFixed(2)} USDC)`);

    if (unpairedYes > 0.001) {
      this.log(`   ⚠️ Unpaired YES: ${unpairedYes.toFixed(6)}`);
    }
    if (unpairedNo > 0.001) {
      this.log(`   ⚠️ Unpaired NO: ${unpairedNo.toFixed(6)}`);
    }

    const result: SettleResult = {
      market: targetMarket,
      yesBalance,
      noBalance,
      pairedTokens,
      unpairedYes,
      unpairedNo,
      merged: false,
    };

    // Execute merge if requested and we have enough pairs
    if (execute && pairedTokens >= 1) {
      const mergeAmount = Math.floor(pairedTokens * 1e6) / 1e6;
      this.log(`\n🔄 Merging ${mergeAmount.toFixed(6)} token pairs...`);

      try {
        const mergeResult = await this.ctf.mergeByTokenIds(
          targetMarket.conditionId,
          tokenIds,
          mergeAmount.toString(),
          this.toLifecycleRouting(targetMarket)
        );
        result.merged = true;
        result.mergeAmount = mergeAmount;
        result.mergeTxHash = mergeResult.txHash;
        result.usdcRecovered = mergeAmount;
        this.log(`   ✅ Merge TX: ${mergeResult.txHash}`);
        this.log(`   ✅ Recovered: $${mergeAmount.toFixed(2)} USDC`);
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        const outcome = classifyClearMergeThrow(error);
        if (outcome.state === 'NOT_SUBMITTED') {
          // Proven non-broadcast: the pairs are still held; a later call reads fresh and may retry.
          result.error = message;
          this.log(`   ❌ Merge failed: ${message}`);
        } else if (outcome.state === 'CONFIRMED') {
          // The client proved confirmation before failing; the pairs are gone and collateral is held.
          result.merged = true;
          result.mergeAmount = mergeAmount;
          result.mergeTxHash = outcome.txHash;
          result.usdcRecovered = mergeAmount;
          this.log(`   ✅ Merge TX: ${outcome.txHash} (confirmed; client error after receipt: ${message})`);
          this.log(`   ✅ Recovered: $${mergeAmount.toFixed(2)} USDC`);
        } else {
          // May have been broadcast: block every merge on this market until the transaction
          // itself confirms or reverts. Installed before the guard releases.
          const record = this.installPendingClearMerge(targetMarket, mergeAmount, outcome, message);
          result.pending = true;
          result.operationId = record.id;
          if (record.txHash) result.mergeTxHash = record.txHash;
          result.error = `MERGE_PENDING: ${record.pairs} pairs unresolved (merge outcome ${outcome.provenance.toLowerCase()}: ${message})`;
          this.log(`   ⏳ Merge outcome uncertain (${record.id}${record.txHash ? `, tx ${record.txHash}` : ', no tx hash'}): ${message}; no new merge until resolved`);
        }
      }
    } else if (pairedTokens >= 1) {
      this.log(`   💡 Run settlePosition(market, true) to recover $${pairedTokens.toFixed(2)} USDC`);
    }

    this.emit('settle', result);
    return result;
  }

  /**
   * Settle multiple markets at once
   */
  async settleMultiple(markets: ArbitrageMarketConfig[], execute = false): Promise<SettleResult[]> {
    const results: SettleResult[] = [];
    let totalMerged = 0;
    let totalUnpairedYes = 0;
    let totalUnpairedNo = 0;

    for (const market of markets) {
      const result = await this.settlePosition(market, execute);
      results.push(result);
      if (result.usdcRecovered) totalMerged += result.usdcRecovered;
      totalUnpairedYes += result.unpairedYes;
      totalUnpairedNo += result.unpairedNo;
    }

    this.log(`\n═══════════════════════════════════════`);
    this.log(`SUMMARY: ${markets.length} markets`);
    if (execute) {
      this.log(`Total Merged: $${totalMerged.toFixed(2)} USDC`);
    }
    if (totalUnpairedYes > 0.001 || totalUnpairedNo > 0.001) {
      this.log(`Unpaired YES: ${totalUnpairedYes.toFixed(6)}`);
      this.log(`Unpaired NO: ${totalUnpairedNo.toFixed(6)}`);
    }

    return results;
  }

  /**
   * Clear all positions in a market using the best strategy
   *
   * Strategy:
   * - Active market: Merge paired tokens → Sell remaining unpaired tokens
   * - Resolved market: Redeem winning tokens
   *
   * @param market Market to clear positions from
   * @param execute If true, execute the clearing. If false, just return info.
   * @returns Result with all actions taken
   *
   * @example
   * ```typescript
   * const service = new ArbitrageService({ privateKey: '0x...' });
   *
   * // View clearing plan
   * const plan = await service.clearPositions(market, false);
   * console.log(`Will recover: $${plan.totalUsdcRecovered}`);
   *
   * // Execute clearing
   * const result = await service.clearPositions(market, true);
   * ```
   */
  async clearPositions(market: ArbitrageMarketConfig, execute = false): Promise<ClearPositionResult> {
    // Dry runs never write, so they neither take nor disturb the economic-write interlock.
    if (!execute) return this.runClearPositions(market, false);

    // Per-market interlock, acquired before the balance read: a concurrent caller's merge
    // would otherwise invalidate this call's snapshot before it merges or sells from it. The
    // loser withholds rather than waits, because after waiting its snapshot would be stale.
    const key = market.conditionId;
    if (this.activeClearMarkets.has(key)) {
      this.log(`⏸️ clearPositions withheld for ${market.name}: another clear operation is active for this market`);
      return {
        market,
        marketStatus: 'unknown',
        yesBalance: 0,
        noBalance: 0,
        actions: [],
        totalUsdcRecovered: 0,
        success: false,
        withheld: true,
        error: 'clearPositions withheld: another clear operation is active for this market; re-run after it settles',
      };
    }
    this.activeClearMarkets.add(key);
    try {
      return await this.runClearPositions(market, true);
    } finally {
      this.activeClearMarkets.delete(key);
    }
  }

  /** Body of {@link clearPositions}; for `execute=true` the caller holds the market's interlock. */
  private async runClearPositions(market: ArbitrageMarketConfig, execute: boolean): Promise<ClearPositionResult> {
    if (!this.ctf) {
      return {
        market,
        marketStatus: 'unknown',
        yesBalance: 0,
        noBalance: 0,
        actions: [],
        totalUsdcRecovered: 0,
        success: false,
        error: 'CTF client not configured',
      };
    }

    // Under the interlock and before any balance read: an earlier merge whose outcome is
    // unknown owns this market's inventory decision until its own transaction resolves.
    if (execute) {
      const unresolved = this.pendingClearMerges.get(market.conditionId);
      if (unresolved) return this.reconcileClearMergeCall(unresolved, market);
    }

    const tokenIds: TokenIds = {
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
    };

    // Get token balances. SELL sizing below is only valid while no clear SELL on the
    // token has been submitted since this read (its fills would not be in it).
    const submissionsAtRead = {
      sell_yes: this.clearSellSubmissions.get(`${market.conditionId}:${market.yesTokenId}`) ?? 0,
      sell_no: this.clearSellSubmissions.get(`${market.conditionId}:${market.noTokenId}`) ?? 0,
    };
    const positions = await this.ctf.getPositionBalanceByTokenIds(market.conditionId, tokenIds);
    const yesBalance = parseFloat(positions.yesBalance);
    const noBalance = parseFloat(positions.noBalance);

    if (yesBalance < 0.001 && noBalance < 0.001) {
      this.log(`No positions to clear for ${market.name}`);
      return {
        market,
        marketStatus: 'unknown',
        yesBalance,
        noBalance,
        actions: [],
        totalUsdcRecovered: 0,
        success: true,
      };
    }

    this.log(`\n🧹 Clearing positions: ${market.name}`);
    this.log(`   YES: ${yesBalance.toFixed(6)}, NO: ${noBalance.toFixed(6)}`);

    // Check if market is resolved
    let marketStatus: 'active' | 'resolved' | 'unknown' = 'unknown';
    // winningOutcome can be any outcome name (YES/NO, Up/Down, Team1/Team2, etc.)
    let winningOutcome: string | undefined;

    try {
      const resolution = await this.ctf.getMarketResolution(market.conditionId, this.toLifecycleRouting(market));
      marketStatus = resolution.isResolved ? 'resolved' : 'active';
      winningOutcome = resolution.winningOutcome;
      this.log(`   Status: ${marketStatus}${resolution.isResolved ? ` (Winner: ${winningOutcome})` : ''}`);
    } catch {
      // If we can't determine resolution, try to get market status from MarketService
      try {
        const cache = createUnifiedCache();
        const tempMarketService = new MarketService(undefined, undefined, this.rateLimiter, cache);
        const clobMarket = await tempMarketService.getClobMarket(market.conditionId);
        if (clobMarket) {
          marketStatus = clobMarket.closed ? 'resolved' : 'active';
          this.log(`   Status: ${marketStatus} (from MarketService)`);
        } else {
          this.log(`   Status: unknown (market not found, assuming active)`);
          marketStatus = 'active';
        }
      } catch {
        this.log(`   Status: unknown (assuming active)`);
        marketStatus = 'active';
      }
    }

    const actions: ClearAction[] = [];
    let totalUsdcRecovered = 0;

    if (!execute) {
      // Dry run - calculate expected actions
      if (marketStatus === 'resolved' && winningOutcome) {
        // Resolved market: redeem winning tokens
        const winningBalance = winningOutcome === 'YES' ? yesBalance : noBalance;
        if (winningBalance >= 0.001) {
          actions.push({
            type: 'redeem',
            amount: winningBalance,
            usdcResult: winningBalance, // 1 USDC per winning token
            success: true,
          });
          totalUsdcRecovered = winningBalance;
        }
      } else {
        // Active market: merge + sell
        const pairedTokens = Math.min(yesBalance, noBalance);
        const unpairedYes = yesBalance - pairedTokens;
        const unpairedNo = noBalance - pairedTokens;

        if (pairedTokens >= 1) {
          actions.push({
            type: 'merge',
            amount: pairedTokens,
            usdcResult: pairedTokens,
            success: true,
          });
          totalUsdcRecovered += pairedTokens;
        }

        // For unpaired tokens, estimate sell price (assume ~0.5 if unknown)
        if (unpairedYes >= this.config.minTradeSize) {
          const estimatedPrice = 0.5; // Conservative estimate
          actions.push({
            type: 'sell_yes',
            amount: unpairedYes,
            usdcResult: unpairedYes * estimatedPrice,
            success: true,
          });
          totalUsdcRecovered += unpairedYes * estimatedPrice;
        }

        if (unpairedNo >= this.config.minTradeSize) {
          const estimatedPrice = 0.5;
          actions.push({
            type: 'sell_no',
            amount: unpairedNo,
            usdcResult: unpairedNo * estimatedPrice,
            success: true,
          });
          totalUsdcRecovered += unpairedNo * estimatedPrice;
        }
      }

      this.log(`   📋 Plan: ${actions.length} actions, ~$${totalUsdcRecovered.toFixed(2)} pUSD`);
      for (const action of actions) {
        this.log(`      - ${action.type}: ${action.amount.toFixed(4)} → ~$${action.usdcResult.toFixed(2)}`);
      }

      return {
        market,
        marketStatus,
        yesBalance,
        noBalance,
        actions,
        totalUsdcRecovered,
        success: true,
      };
    }

    // Execute clearing
    this.log(`   🔄 Executing...`);

    if (marketStatus === 'resolved' && winningOutcome) {
      // Resolved market: redeem
      const winningBalance = winningOutcome === 'YES' ? yesBalance : noBalance;
      if (winningBalance >= 0.001) {
        try {
          const redeemResult = await this.ctf.redeemByTokenIds(market.conditionId, tokenIds, undefined, this.toLifecycleRouting(market));
          // Recovered USDC is the receipt-scoped payout of the confirmed transaction,
          // never the pre-transaction token balance or an assumed 1:1 redemption.
          const payout = factualRedeemPayout(redeemResult);
          if (payout === undefined) {
            actions.push({
              type: 'redeem',
              amount: winningBalance,
              usdcResult: 0,
              ...(typeof redeemResult.txHash === 'string' && redeemResult.txHash ? { txHash: redeemResult.txHash } : {}),
              success: false,
              error: 'Redeem payout not factually confirmed',
            });
            this.log(`   ❌ Redeem not booked: payout not factually confirmed`);
          } else {
            actions.push({
              type: 'redeem',
              amount: winningBalance,
              usdcResult: payout,
              txHash: redeemResult.txHash,
              success: true,
            });
            totalUsdcRecovered += payout;
            this.log(`   ✅ Redeemed: ${winningBalance.toFixed(4)} tokens → $${payout.toFixed(2)} USDC (factual payout)`);
          }
        } catch (error: any) {
          actions.push({
            type: 'redeem',
            amount: winningBalance,
            usdcResult: 0,
            success: false,
            error: error.message,
          });
          this.log(`   ❌ Redeem failed: ${error.message}`);
        }
      }
    } else {
      // Active market: merge + sell
      const pairedTokens = Math.min(yesBalance, noBalance);
      let unpairedYes = yesBalance - pairedTokens;
      let unpairedNo = noBalance - pairedTokens;

      // Step 1: Merge paired tokens. Residual SELLs are sized from the balance read above,
      // which is only valid if the merge provably did not consume inventory.
      let residualsAuthorized = true;
      if (pairedTokens >= 1) {
        const mergeAmount = Math.floor(pairedTokens * 1e6) / 1e6;
        try {
          const mergeResult = await this.ctf.mergeByTokenIds(
            market.conditionId,
            tokenIds,
            mergeAmount.toString(),
            this.toLifecycleRouting(market)
          );
          actions.push({
            type: 'merge',
            amount: mergeAmount,
            usdcResult: mergeAmount,
            txHash: mergeResult.txHash,
            success: true,
          });
          totalUsdcRecovered += mergeAmount;
          this.log(`   ✅ Merged: ${mergeAmount.toFixed(4)} pairs → $${mergeAmount.toFixed(2)} USDC`);
        } catch (error: any) {
          const message = error instanceof Error ? error.message : String(error);
          const outcome = classifyClearMergeThrow(error);
          if (outcome.state === 'NOT_SUBMITTED') {
            // Proven non-broadcast: the pairs are still held, so the read above still sizes them.
            actions.push({
              type: 'merge',
              amount: mergeAmount,
              usdcResult: 0,
              success: false,
              error: message,
            });
            this.log(`   ❌ Merge failed: ${message}`);
            // Update unpaired amounts since merge failed
            unpairedYes = yesBalance;
            unpairedNo = noBalance;
          } else if (outcome.state === 'CONFIRMED') {
            // The client proved confirmation before failing; the pairs are gone and the
            // read above no longer describes inventory, so nothing is sold this call.
            actions.push({
              type: 'merge',
              amount: mergeAmount,
              usdcResult: mergeAmount,
              txHash: outcome.txHash,
              success: true,
            });
            totalUsdcRecovered += mergeAmount;
            residualsAuthorized = false;
            this.log(`   ✅ Merged: ${mergeAmount.toFixed(4)} pairs → $${mergeAmount.toFixed(2)} USDC (confirmed; client error after receipt: ${message}); residuals need a fresh read`);
          } else {
            // May have been broadcast: block every write on this market until the
            // transaction itself confirms or reverts. Installed before the guard releases.
            const record = this.installPendingClearMerge(market, mergeAmount, outcome, message);
            actions.push(this.pendingClearMergeAction(record, `merge outcome ${outcome.provenance.toLowerCase()}: ${message}`));
            residualsAuthorized = false;
            this.log(`   ⏳ Merge outcome uncertain (${record.id}${record.txHash ? `, tx ${record.txHash}` : ', no tx hash'}): ${message}; no SELL until resolved`);
          }
        }
      }

      // Step 2: Sell unpaired tokens. Acceptance is not execution: sold shares and
      // proceeds come only from confirmed fills attributed to our own order.
      const sellSide = async (type: 'sell_yes' | 'sell_no', unpaired: number): Promise<void> => {
        if (!this.tradingService) return;
        const label = type === 'sell_yes' ? 'YES' : 'NO';
        const tokenId = type === 'sell_yes' ? market.yesTokenId : market.noTokenId;

        // An earlier SELL on this token owns the inventory until its facts are known and
        // reported; the balance read above predates them, so it sizes nothing this call.
        const prior = this.findPendingClearSell(market, tokenId);
        if (prior) {
          const terminal = await this.reconcileClearSell(prior);
          if (!terminal) {
            actions.push(this.pendingClearAction(prior));
            this.log(`   ⏳ Sell ${label} ${prior.id} still awaiting factual fills; no new order`);
            return;
          }
          const reported = this.reportClearSell(prior, terminal);
          if (reported) {
            actions.push(reported);
            totalUsdcRecovered += reported.usdcResult;
          }
          return;
        }

        if (unpaired < this.config.minTradeSize) return;
        const submissionKey = `${market.conditionId}:${tokenId}`;
        if ((this.clearSellSubmissions.get(submissionKey) ?? 0) !== submissionsAtRead[type]) {
          actions.push({ type, amount: 0, usdcResult: 0, success: false,
            error: `SELL ${label} withheld: a clear SELL was submitted after this balance read; re-run clearPositions` });
          this.log(`   ⏸️ Sell ${label} withheld: inventory changed since balance read`);
          return;
        }
        const sellAmount = Math.floor(unpaired * 1e6) / 1e6;
        this.clearSellSubmissions.set(submissionKey, submissionsAtRead[type] + 1);
        const record: PendingClearSell = {
          id: `clear-sell-${++this.nextClearSellId}`, type, label, submittedAt: Date.now(),
          market: { conditionId: market.conditionId, yesTokenId: market.yesTokenId, noTokenId: market.noTokenId },
          leg: { tokenId, requestedShares: sellAmount, submission: 'UNCERTAIN' },
        };
        this.pendingClearSells.set(record.id, record);
        const { rejected } = await this.submitSellLeg(record.leg, label, { tokenId, side: 'SELL', amount: sellAmount, orderType: 'FOK' });
        if (rejected !== undefined) {
          // Known non-submission: nothing to reconcile.
          this.pendingClearSells.delete(record.id);
          actions.push({ type, amount: 0, usdcResult: 0, success: false, error: rejected });
          this.log(`   ❌ Sell ${label} failed: ${rejected}`);
          return;
        }
        const terminal = await this.reconcileClearSell(record);
        if (!terminal) {
          actions.push(this.pendingClearAction(record));
          this.log(`   ⏳ Sell ${label} submitted; awaiting factual fills (${record.id})`);
          return;
        }
        const reported = this.reportClearSell(record, terminal);
        if (reported) {
          actions.push(reported);
          totalUsdcRecovered += reported.usdcResult;
        }
      };
      if (residualsAuthorized) {
        await sellSide('sell_yes', unpairedYes);
        await sellSide('sell_no', unpairedNo);
      }
    }

    const allSuccess = actions.every((a) => a.success);
    this.log(`   📊 Result: ${actions.filter((a) => a.success).length}/${actions.length} succeeded, $${totalUsdcRecovered.toFixed(2)} pUSD recovered`);

    const result: ClearPositionResult = {
      market,
      marketStatus,
      yesBalance,
      noBalance,
      actions,
      totalUsdcRecovered,
      success: allSuccess,
    };

    this.emit('settle', result);
    return result;
  }

  /**
   * Clear positions from multiple markets
   *
   * @param markets Markets to clear
   * @param execute If true, execute clearing
   * @returns Results for all markets
   */
  async clearAllPositions(markets: ArbitrageMarketConfig[], execute = false): Promise<ClearPositionResult[]> {
    const results: ClearPositionResult[] = [];
    let totalRecovered = 0;

    this.log(`\n🧹 Clearing positions from ${markets.length} markets...`);

    for (const market of markets) {
      const result = await this.clearPositions(market, execute);
      results.push(result);
      totalRecovered += result.totalUsdcRecovered;
    }

    this.log(`\n═══════════════════════════════════════`);
    this.log(`TOTAL: $${totalRecovered.toFixed(2)} USDC ${execute ? 'recovered' : 'expected'}`);

    return results;
  }

  // ===== Private Methods =====

  private handleBookUpdate(update: BookUpdate): void {
    if (!this.market) return;

    const { assetId, bids, asks } = update;

    type PriceLevel = { price: number; size: number };
    if (assetId === this.market.yesTokenId) {
      this.orderbook.yesBids = bids.sort((a: PriceLevel, b: PriceLevel) => b.price - a.price);
      this.orderbook.yesAsks = asks.sort((a: PriceLevel, b: PriceLevel) => a.price - b.price);
    } else if (assetId === this.market.noTokenId) {
      this.orderbook.noBids = bids.sort((a: PriceLevel, b: PriceLevel) => b.price - a.price);
      this.orderbook.noAsks = asks.sort((a: PriceLevel, b: PriceLevel) => a.price - b.price);
    }

    this.orderbook.lastUpdate = Date.now();
    this.emit('orderbookUpdate', this.orderbook);

    // Check for arbitrage opportunity
    this.checkAndHandleOpportunity();
  }

  private checkAndHandleOpportunity(): void {
    const opportunity = this.checkOpportunity();

    if (opportunity) {
      this.stats.opportunitiesDetected++;
      this.emit('opportunity', opportunity);

      this.log(`\n${'!'.repeat(60)}`);
      this.log(`${opportunity.type.toUpperCase()} ARB: ${opportunity.description}`);
      this.log(`Profit: ${opportunity.profitPercent.toFixed(2)}%, Size: ${opportunity.recommendedSize.toFixed(2)}, Est: $${opportunity.estimatedProfit.toFixed(2)}`);
      this.log('!'.repeat(60));

      // Auto-execute if enabled and cooldown has passed
      if (this.config.autoExecute && !this.isExecuting) {
        const timeSinceLastExecution = Date.now() - this.lastExecutionTime;
        if (timeSinceLastExecution >= this.config.executionCooldown) {
          this.execute(opportunity).catch((error) => {
            this.emit('error', error);
          });
        }
      }
    }
  }

  /** Signer identity, verified against the CTF inventory owner. */
  getInventoryWalletAddress(): string {
    const trading = this.tradingService?.getAddress();
    const ctf = this.ctf?.getAddress();
    if (!trading || !ctf || !ethers.utils.isAddress(trading) || !ethers.utils.isAddress(ctf) ||
        trading.toLowerCase() !== ctf.toLowerCase()) throw new Error('Invalid inventory wallet identity');
    return ethers.utils.getAddress(trading).toLowerCase();
  }

  /** Cross-caller read-only query; any shared outcome token conflicts. */
  getShortInventoryProtection(query: { walletAddress: string; tokenIds: readonly string[] }):
    Readonly<{ operationId: string; reason: string }> | undefined {
    if (!ethers.utils.isAddress(query.walletAddress)) throw new Error('Invalid inventory wallet identity');
    const wallet = this.getInventoryWalletAddress();
    if (ethers.utils.getAddress(query.walletAddress).toLowerCase() !== wallet) return;
    if (!query.tokenIds.length || query.tokenIds.some(token => typeof token !== 'string' || !token.trim())) {
      throw new Error('Invalid inventory token identity');
    }
    for (const pending of this.pendingShortArbs.values()) {
      if (query.tokenIds.includes(pending.legA.tokenId) || query.tokenIds.includes(pending.legB.tokenId)) {
        if (pending.finalized !== true) return Object.freeze({ operationId: pending.id, reason: 'SHORT_UNRESOLVED' });
        if (pending.inventoryReconciled !== true &&
            (pending.terminalResult?.legA.state === 'TERMINAL_SUCCESS' || pending.terminalResult?.legB.state === 'TERMINAL_SUCCESS')) {
          return Object.freeze({ operationId: pending.id, reason: 'SHORT_INVENTORY_PENDING' });
        }
      }
    }
  }

  private getShortInventoryBlock(market: ArbitrageMarketConfig | null): string | undefined {
    if (!market) return;
    for (const pending of this.pendingShortArbs.values()) {
      if (pending.conditionId === market.conditionId && pending.legA.tokenId === market.yesTokenId &&
          pending.legB.tokenId === market.noTokenId &&
          (pending.finalized !== true || (pending.inventoryReconciled !== true &&
            (pending.terminalResult?.legA.state === 'TERMINAL_SUCCESS' ||
             pending.terminalResult?.legB.state === 'TERMINAL_SUCCESS')))) return pending.id;
    }
  }

  private isRebalancerWriting(market: ArbitrageMarketConfig | null): boolean {
    return !!market && [...this.rebalancerInventoryWrites].some(writer =>
      writer.conditionId === market.conditionId && writer.yesTokenId === market.yesTokenId &&
      writer.noTokenId === market.noTokenId);
  }

  private async checkAndRebalance(): Promise<void> {
    if (!this.isRunning || this.isExecuting) return;
    // Complete earlier SELLs from facts before reading balances; an unresolved
    // SELL on this market means the imbalance is unknown, so no new corrective order.
    if (this.pendingRebalanceSells.size) await this.flushPendingRebalanceSells();
    if (this.findPendingRebalanceSell(this.market)) return;
    if (this.getShortInventoryBlock(this.market) || this.isRebalancerWriting(this.market)) return;

    // Check cooldown
    const timeSinceLastRebalance = Date.now() - this.lastRebalanceTime;
    if (timeSinceLastRebalance < this.config.rebalanceCooldown) {
      return;
    }

    // Only a fresh, complete balance read may size a split/merge/SELL; the cached
    // balance is telemetry, not execution authority, after a failed refresh.
    if (!(await this.updateBalance())) {
      this.log('⏸️ Rebalance cycle skipped: fresh balance refresh failed');
      return;
    }
    // A short may start during the balance read or its synchronous notification.
    if (this.getShortInventoryBlock(this.market) || this.isRebalancerWriting(this.market)) return;
    const action = this.calculateRebalanceAction();

    if (action.type !== 'none' && action.amount >= this.config.minTradeSize && this.market) {
      // rebalance() claims the market writer itself and re-authorizes this planned action
      // against its own fresh read; an action the newest inventory no longer supports is withheld.
      await this.rebalance(action);
      this.lastRebalanceTime = Date.now();
    }
  }

  /**
   * Fix YES/NO imbalance immediately after partial execution
   * This is critical when one side of a parallel order fails
   */
  private async fixImbalanceIfNeeded(): Promise<void> {
    if (!this.config.autoFixImbalance || !this.ctf || !this.tradingService || !this.market) return;

    // A corrective SELL is sized from the imbalance; a cached imbalance after a
    // failed refresh is not authority to sell anything.
    if (!(await this.updateBalance())) {
      this.log('   ⏸️ Imbalance correction withheld: fresh balance refresh failed');
      return;
    }
    const imbalance = this.balance.yesTokens - this.balance.noTokens;

    if (Math.abs(imbalance) <= this.config.imbalanceThreshold) return;

    this.log(`\n⚠️ Imbalance detected after execution: ${imbalance > 0 ? 'YES' : 'NO'} excess = ${Math.abs(imbalance).toFixed(2)}`);

    // Sell the excess tokens to restore balance
    const sellAmount = Math.floor(Math.abs(imbalance) * 0.9 * 1e6) / 1e6; // Sell 90% to be safe
    if (sellAmount < this.config.minTradeSize) return;

    // An unresolved SELL on this market (corrective or rebalancer) means the true
    // imbalance is unknown; never stack another corrective order on it.
    const unresolved = this.findPendingRebalanceSell(this.market);
    if (unresolved) {
      this.log(`   ⏳ Corrective SELL withheld: ${unresolved.id} pending factual reconciliation`);
      return;
    }

    const market = this.market;
    const outcomes = market.outcomes || ['YES', 'NO'];
    const sellYes = imbalance > 0;
    // Floor derived from the live best bid so the remediation itself cannot
    // sweep the book (PROBLEMS.md #2).
    const bestBid = (sellYes ? this.orderbook.yesBids : this.orderbook.noBids)[0]?.price;
    const floor = bestBid !== undefined ? bestBid * (1 - this.config.maxSlippagePct) : undefined;
    const tokenId = sellYes ? market.yesTokenId : market.noTokenId;
    const record: PendingRebalanceSell = {
      id: `corrective-sell-${++this.nextRebalanceSellId}`, kind: 'corrective', submittedAt: Date.now(),
      action: { type: sellYes ? 'sell_yes' : 'sell_no', amount: sellAmount, reason: 'Imbalance correction', priority: 100 },
      label: sellYes ? outcomes[0] : outcomes[1],
      market: { conditionId: market.conditionId, yesTokenId: market.yesTokenId, noTokenId: market.noTokenId },
      leg: { tokenId, requestedShares: sellAmount, submission: 'UNCERTAIN' },
    };

    try {
      // Acceptance is not execution: the corrective SELL completes only from factual fills.
      const result = await this.submitFactualSell(record, {
        tokenId, side: 'SELL', amount: sellAmount, ...(floor !== undefined ? { price: floor } : {}), orderType: 'FOK',
      });
      if (result.pending) {
        this.log(`   ⏳ Corrective SELL submitted; awaiting factual fills (${result.operationId})`);
        return;
      }
      this.publishRebalanceSell(result);
    } catch (error: any) {
      this.log(`   ❌ Failed to fix imbalance: ${error.message}`);
    }
  }

  /**
   * Refresh pUSD and YES/NO balances from the chain.
   *
   * Returns true only when every value needed for an inventory decision was
   * freshly and validly read and applied to `this.balance` for the still-active
   * market. On failure the previous cached balance is left untouched (telemetry
   * only) and the error is emitted; callers that size or direct a NEW economic
   * write must treat a `false` result as "no fresh authority" and abort.
   */
  private async updateBalance(): Promise<boolean> {
    if (!this.ctf || !this.market) return false;

    const version = ++this.balanceRefreshVersion;
    const conditionId = this.market.conditionId;
    const tokenIds: TokenIds = {
      yesTokenId: this.market.yesTokenId,
      noTokenId: this.market.noTokenId,
    };
    // Only terminal operations known before this read can be released by it.
    const awaitingInventory = [...this.pendingShortArbs.values()].filter(pending =>
      pending.finalized && pending.inventoryReconciled !== true && pending.conditionId === conditionId &&
      pending.legA.tokenId === tokenIds.yesTokenId && pending.legB.tokenId === tokenIds.noTokenId);
    try {
      const [pUsdBalance, positions] = await Promise.all([
        this.ctf.getPusdBalance(),
        this.ctf.getPositionBalanceByTokenIds(conditionId, tokenIds),
      ]);

      const balances = [pUsdBalance, positions.yesBalance, positions.noBalance].map(value =>
        typeof value === 'number' && Number.isFinite(value) ? value
          : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN);
      if (!balances.every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid factual balances');
      // Discard stale overlapping reads and responses for a market no longer active.
      if (version !== this.balanceRefreshVersion || this.market?.conditionId !== conditionId ||
          this.market.yesTokenId !== tokenIds.yesTokenId || this.market.noTokenId !== tokenIds.noTokenId) return false;
      const balance = {
        usdc: balances[0],
        pUsdBalance: balances[0],
        yesTokens: balances[1],
        noTokens: balances[2],
        lastUpdate: Date.now(),
      };
      this.balance = balance;
      this.emit('balanceUpdate', this.balance);
      if (version !== this.balanceRefreshVersion || this.balance !== balance || this.market?.conditionId !== conditionId ||
          this.market.yesTokenId !== tokenIds.yesTokenId || this.market.noTokenId !== tokenIds.noTokenId) return true;
      for (const pending of awaitingInventory) pending.inventoryReconciled = true;
      return true;
    } catch (error) {
      this.emit('error', error as Error);
      return false;
    }
  }

  private findPendingLongArb(market: ArbitrageMarketConfig | null): PendingLongArb | undefined {
    if (!market) return;
    for (const op of this.pendingLongArbs.values()) {
      if (!op.published && op.market.conditionId === market.conditionId &&
          op.market.yesTokenId === market.yesTokenId && op.market.noTokenId === market.noTokenId) return op;
    }
  }

  /** Session-local effects exactly once per long-arb operation; failure results without
   * an operation (guard/config/rejection) are published directly. */
  private publishLongArbResult(result: ArbitrageExecutionResult): void {
    const op = result.operationId ? this.pendingLongArbs.get(result.operationId) : undefined;
    if (op) {
      if (op.published) return;
      op.published = true;
    }
    if (result.success) {
      this.stats.executionsSucceeded++;
      this.stats.totalProfit += result.profit;
      this.lastExecutionTime = Date.now();
    }
    try {
      this.emit('execution', result);
    } finally {
      if (op && this.pendingLongArbs.get(op.id) === op) this.pendingLongArbs.delete(op.id);
    }
  }

  private async executeLongArb(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult> {
    const startTime = Date.now();
    const size = opportunity.recommendedSize;
    const market = this.market!;
    const trading = this.tradingService!;
    const failure = (error: string): ArbitrageExecutionResult => ({
      success: false, type: 'long', size, profit: 0, txHashes: [], error, executionTimeMs: Date.now() - startTime,
    });

    this.log(`\nExecuting Long Arb (Buy → Merge)...`);

    const { buyYes, buyNo } = opportunity.effectivePrices;
    const requiredUsdc = (buyYes + buyNo) * size;
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(requiredUsdc)) return failure('Invalid long arb size');
    if (this.balance.pUsdBalance < requiredUsdc) {
      return failure(`Insufficient pUSD: have ${this.balance.pUsdBalance.toFixed(2)}, need ${requiredUsdc.toFixed(2)}`);
    }

    const op: PendingLongArb = {
      id: `long-${++this.nextLongArbId}`, market: { ...market }, size, startedAt: startTime,
      legYes: { tokenId: market.yesTokenId, requestedShares: size, submission: 'NOT_SUBMITTED' },
      legNo: { tokenId: market.noTokenId, requestedShares: size, submission: 'NOT_SUBMITTED' },
      merge: { state: 'NOT_STARTED' },
    };
    this.pendingLongArbs.set(op.id, op);
    const pendingResult = (error: string): ArbitrageExecutionResult => ({
      ...failure(error), operationId: op.id, pending: true,
    });
    const outcomes = market.outcomes || ['YES', 'NO'];

    // Submission provenance only. Acceptance never becomes a fill; an exception
    // after the attempt started cannot prove non-submission.
    const submitLeg = async (leg: PendingLongLeg, amount: number, price: number): Promise<string | undefined> => {
      leg.submission = 'UNCERTAIN';
      try {
        const result = await trading.createMarketOrder({ tokenId: leg.tokenId, side: 'BUY', amount, price, orderType: 'FOK' });
        const orderId = typeof result.orderId === 'string' ? result.orderId.trim() : '';
        if (orderId) {
          leg.orderId = orderId;
          leg.tradeIds = new Set(result.tradeIds ?? []);
        }
        if (result.submissionState === 'REJECTED') {
          leg.submission = 'REJECTED';
          return result.errorMsg || 'venue rejection';
        }
        if (result.submissionState === 'ACCEPTED' && orderId) leg.submission = 'SUBMITTED';
        return result.errorMsg;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    // Buy both legs sequentially with worst-price caps (PROBLEMS.md #2/#3).
    // Caps are passed as `price` so the venue rejects fills beyond max slippage.
    const buyYesCap = opportunity.priceCaps?.buyYes ?? buyYes * (1 + this.config.maxSlippagePct);
    const buyNoCap = opportunity.priceCaps?.buyNo ?? buyNo * (1 + this.config.maxSlippagePct);
    this.log(`  1. Buying legs sequentially (caps YES=${buyYesCap.toFixed(4)}, NO=${buyNoCap.toFixed(4)})...`);

    const yesError = await submitLeg(op.legYes, size * buyYes, buyYesCap);
    if (op.legYes.submission === 'REJECTED') {
      // Known non-submission: nothing to reconcile, no economic effects.
      this.pendingLongArbs.delete(op.id);
      return failure(`Leg 1 (${outcomes[0]}) failed: ${yesError}`);
    }
    if (op.legYes.submission !== 'SUBMITTED') {
      // The YES order may or may not exist. Never open the second side on an
      // unknown first side; reconcile the first side if it has an identity.
      this.log(`  ⚠️ Leg 1 (${outcomes[0]}) submission uncertain${op.legYes.orderId ? '' : ' (no order identity)'} - ${outcomes[1]} leg withheld`);
      const terminal = op.legYes.orderId ? await this.reconcileLongArb(op) : undefined;
      return terminal ?? pendingResult(`Leg 1 (${outcomes[0]}) submission uncertain: ${yesError ?? 'no acceptance'}`);
    }

    const noError = await submitLeg(op.legNo, size * buyNo, buyNoCap);
    this.log(`     ${outcomes[0]}: ✓, ${outcomes[1]}: ${op.legNo.submission === 'REJECTED' ? '✗' : '✓'}`);

    if (op.legNo.submission === 'REJECTED') {
      // Known non-submission of leg 2: the YES side may be filled. Existing
      // remediation runs unchanged; the YES facts stay reconcilable.
      this.log(`  ⚠️ Leg 2 (${outcomes[1]}) rejected after ${outcomes[0]} submission - unwinding single-sided position...`);
      await this.fixImbalanceIfNeeded();
    } else if (op.legNo.submission !== 'SUBMITTED') {
      this.log(`  ⚠️ Leg 2 (${outcomes[1]}) submission uncertain${op.legNo.orderId ? '' : ' (no order identity)'}`);
    }

    const terminal = await this.reconcileLongArb(op);
    if (terminal) return terminal;
    const state = [op.legYes, op.legNo].map((leg, i) =>
      `${outcomes[i]}=${leg.submission === 'REJECTED' ? 'rejected' : leg.submission === 'NOT_SUBMITTED' ? 'not submitted'
        : leg.settlement?.state === 'TERMINAL' ? 'terminal' : leg.orderId ? 'pending' : 'unknown'}`).join(', ');
    const detail = op.legNo.submission === 'REJECTED' ? `Leg 2 (${outcomes[1]}) failed: ${noError}; ` : '';
    return pendingResult(`${detail}BUY_PENDING: factual reconciliation incomplete (${state})`);
  }

  /** Single flight per operation; concurrent callers share one reconciliation. */
  private reconcileLongArb(op: PendingLongArb): Promise<ArbitrageExecutionResult | undefined> {
    if (op.result) return Promise.resolve(op.result);
    if (op.flight) return op.flight;
    const flight = this.reconcileLongArbOnce(op).finally(() => { if (op.flight === flight) op.flight = undefined; });
    op.flight = flight;
    return flight;
  }

  private async reconcileLongArbOnce(op: PendingLongArb): Promise<ArbitrageExecutionResult | undefined> {
    const size = op.size;
    const legs = [op.legYes, op.legNo];
    const finalize = (result: Omit<ArbitrageExecutionResult, 'type' | 'operationId' | 'executionTimeMs'>): ArbitrageExecutionResult => {
      if (!op.result) op.result = { ...result, type: 'long', operationId: op.id, executionTimeMs: Date.now() - op.startedAt };
      return op.result;
    };
    const failure = (error: string) => finalize({ success: false, size, profit: 0, txHashes: [], error });

    // Known non-orders (rejected or never attempted) carry no fills to prove.
    const resolved = (leg: PendingLongLeg) => leg.submission === 'REJECTED' || leg.submission === 'NOT_SUBMITTED' ||
      leg.settlement?.state === 'TERMINAL';
    for (const leg of legs) {
      if (resolved(leg) || !leg.orderId) continue;
      try {
        leg.settlement = await this.reconcileBuyLeg(leg);
      } catch (error) {
        try { this.log(`Long-arb ${op.id} BUY reconciliation: ${String(error)}`); } catch { /* remain pending */ }
      }
    }
    // An UNCERTAIN leg without order identity can never be proven; it stays unresolved.
    if (!legs.every(resolved)) return undefined;

    const settled = (leg: PendingLongLeg) => leg.settlement?.state === 'TERMINAL' ? leg.settlement : undefined;
    const yes = settled(op.legYes), no = settled(op.legNo);
    const yesUnits = yes?.units ?? 0n, noUnits = no?.units ?? 0n;
    const yesShares = Number(yesUnits) / 100, noShares = Number(noUnits) / 100;
    const pairedUnits = yesUnits < noUnits ? yesUnits : noUnits;
    const pairedShares = Number(pairedUnits) / 100;
    const describe = `YES ${yesShares} / NO ${noShares} attributable shares`;

    if (pairedUnits === 0n) return failure(`No paired factual fills (${describe})`);
    if (pairedShares < this.config.minTradeSize) return failure(`Insufficient attributable pairs for merge: ${describe}`);

    if (op.merge.state === 'NOT_STARTED') {
      if (!this.ctf) return undefined;
      const amount = formatShareUnits(pairedUnits);
      const tokenIds: TokenIds = { yesTokenId: op.market.yesTokenId, noTokenId: op.market.noTokenId };
      // Claim before the await so no concurrent pass can submit a second merge.
      op.merge = { state: 'IN_FLIGHT' };
      this.log(`  2. Merging ${amount} attributable pairs (${describe})...`);
      try {
        const mergeResult = await this.ctf.mergeByTokenIds(op.market.conditionId, tokenIds, amount, this.toLifecycleRouting(op.market));
        op.merge = this.classifyMergeResult(mergeResult, pairedShares);
      } catch (error) {
        if (error instanceof MergeProvenanceError) {
          const provenance = error.provenance;
          if (provenance.state === 'NOT_SUBMITTED') {
            // Proven non-broadcast: the pairs are still held; a later pass may retry.
            op.merge = { state: 'NOT_STARTED' };
            this.log(`  ⚠️ Merge not submitted: ${error.message}`);
            return undefined;
          }
          op.merge = provenance.state === 'CONFIRMED' && typeof provenance.transactionHash === 'string' &&
            TX_HASH_PATTERN.test(provenance.transactionHash)
            ? { state: 'CONFIRMED', shares: pairedShares, value: pairedShares, txHash: provenance.transactionHash }
            : { state: 'UNCERTAIN', ...(provenance.transactionHash ? { txHash: provenance.transactionHash } : {}) };
        } else {
          op.merge = { state: 'UNCERTAIN' };
        }
        if (op.merge.state === 'UNCERTAIN') this.log(`  ⚠️ Merge outcome uncertain: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (op.merge.state === 'IN_FLIGHT' || op.merge.state === 'NOT_STARTED') return undefined;
    if (op.merge.state === 'UNCERTAIN') {
      return failure(`Merge outcome uncertain for ${pairedShares} pairs (${describe}); no realized profit booked`);
    }

    const merge = op.merge;
    // Post-merge reconciliation (PROBLEMS.md #10): uneven fills can leave
    // single-sided excess. Existing remediation runs unchanged on the live market.
    if (this.market && this.market.conditionId === op.market.conditionId &&
        this.market.yesTokenId === op.market.yesTokenId && this.market.noTokenId === op.market.noTokenId) {
      if (await this.updateBalance()) {
        const residual = this.balance.yesTokens - this.balance.noTokens;
        if (Math.abs(residual) > this.config.imbalanceThreshold) {
          this.log(`  ⚠️ Residual imbalance after merge: ${residual.toFixed(2)} - cleaning up...`);
          await this.fixImbalanceIfNeeded();
        }
      } else {
        // Cached inventory cannot prove a residual; the realized result below is unaffected.
        this.log('  ⏸️ Residual check skipped: fresh balance refresh failed');
      }
    }

    // Exact attribution: the whole leg was merged, or every fill shares one price.
    const attributedCost = (leg: Extract<BuyLegSettlement, { state: 'TERMINAL' }>): number | undefined =>
      leg.units === pairedUnits ? leg.cost
        : leg.uniformPrice && leg.weightedPrice !== undefined ? leg.weightedPrice * pairedShares : undefined;
    const yesCost = attributedCost(yes!), noCost = attributedCost(no!);
    if (yesCost === undefined || noCost === undefined) {
      return failure(`Merged ${merge.shares} pairs (tx ${merge.txHash}) but BUY cost attribution is not exact (${describe}); realized profit withheld`);
    }
    const feeUsd = estimateTakerFee(yesCost + noCost, this.config.feeRateBps);
    const profit = merge.value - yesCost - noCost - feeUsd;
    if (![yesCost, noCost, feeUsd, profit].every(Number.isFinite)) throw new Error('Invalid long-arb settlement totals');
    this.log(`  ✅ Long Arb completed: merged ${merge.shares} pairs, cost ${(yesCost + noCost).toFixed(4)}, realized $${profit.toFixed(4)}`);

    return finalize({
      success: true, size: merge.shares, profit, txHashes: [merge.txHash],
      facts: {
        yesOrderId: op.legYes.orderId!, noOrderId: op.legNo.orderId!,
        yesShares, yesCost, noShares, noCost,
        mergedShares: merge.shares, mergeValue: merge.value, feeUsd,
        fillTxHashes: [...new Set([...yes!.txHashes, ...no!.txHashes])],
      },
    });
  }

  /** A merge counts only with receipt-level confirmation from the CTF path. */
  private classifyMergeResult(result: MergeResult, expectedShares: number): LongArbMerge {
    const txHash = typeof result?.txHash === 'string' ? result.txHash : undefined;
    const confirmed = result?.success === true && txHash !== undefined && TX_HASH_PATTERN.test(txHash) &&
      (result.provenance === undefined || result.provenance.state === 'CONFIRMED');
    if (!confirmed) return { state: 'UNCERTAIN', ...(txHash ? { txHash } : {}) };
    // Collateral out equals pairs in by contract; a reported amount must agree.
    let value = expectedShares;
    for (const raw of [result.usdcReceived, result.amount]) {
      if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) continue;
      const reported = Number(raw);
      if (!Number.isFinite(reported) || Math.abs(reported - expectedShares) > 1e-6) return { state: 'UNCERTAIN', txHash };
      value = reported;
      break;
    }
    return { state: 'CONFIRMED', shares: expectedShares, value, txHash: txHash! };
  }

  private findPendingRebalanceSell(market: ArbitrageMarketConfig | null): PendingRebalanceSell | undefined {
    if (!market) return;
    for (const record of this.pendingRebalanceSells.values()) {
      if (!record.published && record.market.conditionId === market.conditionId &&
          record.market.yesTokenId === market.yesTokenId && record.market.noTokenId === market.noTokenId) return record;
    }
  }

  private async rebalanceSellAction(action: RebalanceAction): Promise<RebalanceResult> {
    let result: RebalanceResult;
    try {
      result = await this.rebalanceSell(action);
    } catch (error: any) {
      // Known non-submission (venue rejection, invalid amount): the existing failure path.
      this.log(`   ❌ Failed: ${error.message}`);
      const failure: RebalanceResult = { success: false, action, error: error.message };
      this.emit('rebalance', failure);
      return failure;
    }
    if (result.pending) {
      this.log(`   ⏳ SELL submitted; awaiting factual fills (${result.operationId})`);
      return result;
    }
    if (result.success) {
      // A balance refresh failure cannot demote a factual fill.
      try { await this.updateBalance(); } catch (error) { this.log(`Balance refresh: ${String(error)}`); }
    }
    this.publishRebalanceSell(result);
    return result;
  }

  /** Submit one corrective SELL and reconcile it from facts; never claims execution. */
  private async rebalanceSell(action: RebalanceAction): Promise<RebalanceResult> {
    const market = this.market!;
    const trading = this.tradingService!;
    const unresolved = this.findPendingRebalanceSell(market);
    if (unresolved) {
      return { success: false, action, operationId: unresolved.id, pending: true,
        error: `Rebalance SELL ${unresolved.id} pending factual reconciliation` };
    }
    const outcomes = market.outcomes || ['YES', 'NO'];
    const label = action.type === 'sell_yes' ? outcomes[0] : outcomes[1];
    const tokenId = action.type === 'sell_yes' ? market.yesTokenId : market.noTokenId;
    if (!Number.isFinite(action.amount) || action.amount <= 0) throw new Error(`Invalid SELL ${label} amount`);
    const record: PendingRebalanceSell = {
      id: `rebalance-sell-${++this.nextRebalanceSellId}`, kind: 'rebalance', action, label, submittedAt: Date.now(),
      market: { conditionId: market.conditionId, yesTokenId: market.yesTokenId, noTokenId: market.noTokenId },
      leg: { tokenId, requestedShares: action.amount, submission: 'UNCERTAIN' },
    };
    return this.submitFactualSell(record, { tokenId, side: 'SELL', amount: action.amount, orderType: 'FOK' });
  }

  /** Register the record before the venue call, submit once, and return only factual terminal state or a pending ack. */
  private async submitFactualSell(record: PendingRebalanceSell,
      order: Parameters<TradingService['createMarketOrder']>[0]): Promise<RebalanceResult> {
    const { action, label } = record;
    this.pendingRebalanceSells.set(record.id, record);

    const { rejected } = await this.submitSellLeg(record.leg, label, order);
    if (rejected !== undefined) {
      // Known non-submission: nothing to reconcile; existing failure path applies.
      this.pendingRebalanceSells.delete(record.id);
      throw new Error(rejected);
    }
    const terminal = await this.reconcileRebalanceSell(record);
    return terminal ?? { success: false, action, operationId: record.id, pending: true,
      error: `SELL_PENDING: factual reconciliation incomplete (${record.leg.orderId ? 'order ' + record.leg.orderId : 'no order identity'})` };
  }

  /**
   * Submit one SELL and record only what the venue reply proves about the local
   * order: identity and acceptance, never a fill. A known REJECTED reply returns
   * `rejected`; otherwise the leg is SUBMITTED (accepted with identity) or UNCERTAIN.
   */
  private async submitSellLeg(leg: PendingFillLeg, label: string,
      order: Parameters<TradingService['createMarketOrder']>[0]): Promise<{ rejected?: string }> {
    const trading = this.tradingService!;
    let reply: Awaited<ReturnType<TradingService['createMarketOrder']>> | undefined;
    let submissionError: string | undefined;
    try {
      reply = await trading.createMarketOrder(order);
    } catch (error) {
      // The attempt started; an exception cannot prove non-submission.
      submissionError = error instanceof Error ? error.message : String(error);
    }
    if (reply) {
      const orderId = typeof reply.orderId === 'string' ? reply.orderId.trim() : '';
      if (orderId) {
        leg.orderId = orderId;
        leg.tradeIds = new Set(reply.tradeIds ?? []);
      }
      if (reply.submissionState === 'REJECTED') return { rejected: reply.errorMsg || `Sell ${label} failed` };
      if (reply.submissionState === 'ACCEPTED' && orderId) leg.submission = 'SUBMITTED';
      submissionError = reply.errorMsg;
    }
    if (leg.submission !== 'SUBMITTED') {
      this.log(`   ⚠️ SELL ${label} submission uncertain${leg.orderId ? '' : ' (no order identity)'}: ${submissionError ?? 'no acceptance'}`);
    }
    return {};
  }

  // ===== clearPositions SELL factual authority =====

  /** Unreported clearPositions SELL on this market/token, terminal or not. */
  private findPendingClearSell(market: Pick<ArbitrageMarketConfig, 'conditionId'>, tokenId: string): PendingClearSell | undefined {
    for (const record of this.pendingClearSells.values()) {
      if (!record.reported && record.market.conditionId === market.conditionId && record.leg.tokenId === tokenId) return record;
    }
    return undefined;
  }

  /** Single flight per clear SELL record; concurrent callers share one reconciliation. */
  private reconcileClearSell(record: PendingClearSell): Promise<ClearAction | undefined> {
    if (record.terminal) return Promise.resolve(record.terminal);
    if (record.flight) return record.flight;
    const flight = this.reconcileClearSellOnce(record).finally(() => { if (record.flight === flight) record.flight = undefined; });
    record.flight = flight;
    return flight;
  }

  private async reconcileClearSellOnce(record: PendingClearSell): Promise<ClearAction | undefined> {
    const leg = record.leg;
    // An UNCERTAIN submission without order identity can never be proven; it stays unresolved.
    if (!leg.orderId) return undefined;
    if (leg.settlement?.state !== 'TERMINAL') {
      try {
        leg.settlement = await this.reconcileFillLeg(leg, 'SELL');
      } catch (error) {
        try { this.log(`Clear SELL ${record.id} reconciliation: ${String(error)}`); } catch { /* remain pending */ }
      }
    }
    const settlement = leg.settlement;
    if (settlement?.state !== 'TERMINAL') return undefined;
    if (record.terminal) return record.terminal;
    const requestedUnits = BigInt(Math.round(leg.requestedShares * 100));
    const facts: ClearSellFacts = {
      orderId: leg.orderId, tokenId: leg.tokenId, requestedShares: leg.requestedShares, soldShares: settlement.shares,
      ...(settlement.weightedPrice !== undefined ? { weightedPrice: settlement.weightedPrice } : {}),
      txHashes: [...settlement.txHashes], proceedsUsd: settlement.cost,
    };
    const success = settlement.units >= requestedUnits;
    record.terminal = {
      type: record.type, amount: settlement.shares, usdcResult: settlement.cost, success, operationId: record.id, facts,
      ...(settlement.txHashes.length === 1 ? { txHash: settlement.txHashes[0] } : {}),
      ...(success ? {} : { error: settlement.units === 0n
        ? `SELL ${record.label} never filled (${leg.orderId})`
        : `Partial SELL ${record.label}: ${settlement.shares} of ${leg.requestedShares} filled (${leg.orderId})` }),
    };
    return record.terminal;
  }

  /** Terminal log exactly once per clear SELL record, whichever observer arrives first. */
  private logClearSell(record: PendingClearSell, action: ClearAction): void {
    if (record.logged) return;
    record.logged = true;
    const facts = action.facts;
    const price = facts?.weightedPrice !== undefined ? ` @ ${facts.weightedPrice.toFixed(4)}` : '';
    if (action.success && facts) {
      this.log(`   ✅ Sold ${record.label}: ${facts.soldShares.toFixed(4)} → $${facts.proceedsUsd.toFixed(2)} USDC (factual${price})`);
    } else {
      this.log(`   ❌ Sell ${record.label} not executed: ${action.error ?? 'SELL not executed'}`);
    }
  }

  /**
   * Hand a terminal clear SELL to exactly one ClearPositionResult and release the
   * record; a second observer gets nothing rather than a duplicate of the proceeds.
   */
  private reportClearSell(record: PendingClearSell, action: ClearAction): ClearAction | undefined {
    if (record.reported) return undefined;
    record.reported = true;
    this.logClearSell(record, action);
    if (this.pendingClearSells.get(record.id) === record) this.pendingClearSells.delete(record.id);
    return action;
  }

  private pendingClearAction(record: PendingClearSell): ClearAction {
    return { type: record.type, amount: 0, usdcResult: 0, success: false, operationId: record.id, pending: true,
      error: `SELL_PENDING: factual reconciliation incomplete (${record.leg.orderId ? 'order ' + record.leg.orderId : 'no order identity'})` };
  }

  private pendingClearMergeAction(record: PendingClearMerge, reason: string): ClearAction {
    return { type: 'merge', amount: 0, usdcResult: 0, success: false, operationId: record.id, pending: true,
      ...(record.txHash ? { txHash: record.txHash } : {}),
      error: `MERGE_PENDING: ${record.pairs} pairs unresolved (${reason})` };
  }

  /**
   * Records a merge that may have been broadcast. The caller holds the market's interlock and
   * installs the record before releasing it, so no entrypoint can merge until it resolves.
   */
  private installPendingClearMerge(
    market: ArbitrageMarketConfig, pairs: number, outcome: Extract<ClearMergeThrow, { state: 'UNRESOLVED' }>, error: string
  ): PendingClearMerge {
    const record: PendingClearMerge = {
      id: `clear-merge-${++this.nextClearMergeId}`,
      market: { name: market.name, conditionId: market.conditionId, yesTokenId: market.yesTokenId, noTokenId: market.noTokenId },
      pairs,
      ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
      provenance: outcome.provenance,
      error,
      submittedAt: Date.now(),
    };
    this.pendingClearMerges.set(market.conditionId, record);
    return record;
  }

  /**
   * The shared decision for an unresolved merge record, made under the market's interlock: the
   * recorded transaction's own receipt is the only thing that may settle it. CONFIRMED and
   * REVERTED delete the record (if it is still the installed one) before returning, so the same
   * record can be booked or released by exactly one call; `pending`, `failed` (RPC/read failure
   * or "not found", not proof of non-execution), a lookup throw, a status for a different hash,
   * or a missing hash keep it installed. Performs no balance read and no write.
   */
  private async resolvePendingClearMerge(record: PendingClearMerge): Promise<PendingMergeResolution> {
    if (!record.txHash) return { state: 'UNRESOLVED', reason: 'no transaction identity; cannot be proven' };
    if (!this.ctf) return { state: 'UNRESOLVED', reason: 'CTF client not configured' };
    let status: TransactionStatus | undefined;
    try {
      status = await this.ctf.getTransactionStatus(record.txHash);
    } catch (error) {
      this.log(`   ⚠️ Merge ${record.id} status lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sameTx = status !== undefined && typeof status.txHash === 'string' && status.txHash.toLowerCase() === record.txHash.toLowerCase();
    if (sameTx && status!.status === 'confirmed') {
      if (this.pendingClearMerges.get(record.market.conditionId) === record) this.pendingClearMerges.delete(record.market.conditionId);
      return { state: 'CONFIRMED' };
    }
    if (sameTx && status!.status === 'reverted') {
      if (this.pendingClearMerges.get(record.market.conditionId) === record) this.pendingClearMerges.delete(record.market.conditionId);
      return { state: 'REVERTED', reason: status!.errorReason ? `: ${status!.errorReason}` : '' };
    }
    const seen = !status ? 'status unavailable' : !sameTx ? 'status for a different transaction' : `transaction ${status.status}`;
    return { state: 'UNRESOLVED', reason: seen };
  }

  /**
   * A guarded `clearPositions(market, true)` call that found an unresolved merge for the market.
   * It performs no balance read and no write; see {@link resolvePendingClearMerge} for what
   * settles it. CONFIRMED books the recorded pairs exactly once under the audited merge
   * contract; REVERTED releases the record with zero recovery. Residual inventory is handled by
   * a later call from a fresh read.
   */
  private async reconcileClearMergeCall(record: PendingClearMerge, market: ArbitrageMarketConfig): Promise<ClearPositionResult> {
    const base = { market, marketStatus: 'unknown' as const, yesBalance: 0, noBalance: 0 };
    this.log(`\n🧹 Clearing positions: ${market.name}`);
    this.log(`   ⏳ Unresolved clear merge ${record.id}: ${record.pairs} pairs${record.txHash ? `, tx ${record.txHash}` : ', no tx hash'}; no new write until it resolves`);

    let action: ClearAction;
    let recovered = 0;
    const resolution = await this.resolvePendingClearMerge(record);
    if (resolution.state === 'CONFIRMED') {
      action = { type: 'merge', amount: record.pairs, usdcResult: record.pairs, txHash: record.txHash, success: true, operationId: record.id };
      recovered = record.pairs;
      this.log(`   ✅ Merged: ${record.pairs.toFixed(4)} pairs → $${record.pairs.toFixed(2)} USDC (${record.id} confirmed on-chain); residuals need a fresh read`);
    } else if (resolution.state === 'REVERTED') {
      action = { type: 'merge', amount: 0, usdcResult: 0, txHash: record.txHash, success: false, operationId: record.id,
        error: `Merge reverted on-chain${resolution.reason}` };
      this.log(`   ❌ Merge ${record.id} reverted on-chain${resolution.reason}; inventory unchanged, a later call may re-plan from a fresh read`);
    } else if (!record.txHash || !this.ctf) {
      action = this.pendingClearMergeAction(record, resolution.reason);
    } else {
      action = this.pendingClearMergeAction(record, `${resolution.reason}; not proof of execution or non-execution`);
      this.log(`   ⏳ Merge ${record.id} still unresolved (${resolution.reason}); no SELL, no new merge`);
    }

    const result: ClearPositionResult = { ...base, actions: [action], totalUsdcRecovered: recovered, success: action.success };
    this.emit('settle', result);
    return result;
  }

  /**
   * A guarded `settlePosition(market, true)` call that found an unresolved merge for the market,
   * installed by either entrypoint. Same decision as {@link reconcileClearMergeCall}, reported
   * in settle shape: no balance read, no write, and recovery only for a CONFIRMED receipt.
   */
  private async reconcileSettleMergeCall(record: PendingClearMerge, market: ArbitrageMarketConfig): Promise<SettleResult> {
    this.log(`\n📊 Position: ${market.name}`);
    this.log(`   ⏳ Unresolved merge ${record.id}: ${record.pairs} pairs${record.txHash ? `, tx ${record.txHash}` : ', no tx hash'}; no new merge until it resolves`);

    const result: SettleResult = {
      market, yesBalance: 0, noBalance: 0, pairedTokens: 0, unpairedYes: 0, unpairedNo: 0, merged: false, operationId: record.id,
      ...(record.txHash ? { mergeTxHash: record.txHash } : {}),
    };
    const resolution = await this.resolvePendingClearMerge(record);
    if (resolution.state === 'CONFIRMED') {
      result.merged = true;
      result.mergeAmount = record.pairs;
      result.usdcRecovered = record.pairs;
      this.log(`   ✅ Merged: ${record.pairs.toFixed(4)} pairs → $${record.pairs.toFixed(2)} USDC (${record.id} confirmed on-chain); residuals need a fresh read`);
    } else if (resolution.state === 'REVERTED') {
      result.error = `Merge reverted on-chain${resolution.reason}`;
      this.log(`   ❌ Merge ${record.id} reverted on-chain${resolution.reason}; inventory unchanged, a later call may re-plan from a fresh read`);
    } else {
      result.pending = true;
      const proof = !record.txHash || !this.ctf ? resolution.reason : `${resolution.reason}; not proof of execution or non-execution`;
      result.error = `MERGE_PENDING: ${record.pairs} pairs unresolved (${proof})`;
      this.log(`   ⏳ Merge ${record.id} still unresolved (${resolution.reason}); no new merge`);
    }

    this.emit('settle', result);
    return result;
  }

  /** Read-only reconciliation of unresolved clear SELLs; submits nothing, reports nothing. */
  private flushPendingClearSells(): Promise<void> {
    if (this.clearSellFlushPromise) return this.clearSellFlushPromise;
    this.clearSellFlushPromise = Promise.resolve().then(async () => {
      for (const [id, record] of [...this.pendingClearSells]) {
        if (record.reported || record.terminal) continue;
        try {
          if (record.id !== id) throw new Error('Clear SELL pending ID mismatch');
          const action = await this.reconcileClearSell(record);
          if (action) this.logClearSell(record, action);
        } catch (error) {
          try { this.log(`Clear SELL reconciliation ${id}: ${String(error)}`); } catch { /* remain pending */ }
        }
      }
    }).finally(() => { this.clearSellFlushPromise = null; });
    return this.clearSellFlushPromise;
  }

  /** Single flight per SELL record; concurrent callers share one reconciliation. */
  private reconcileRebalanceSell(record: PendingRebalanceSell): Promise<RebalanceResult | undefined> {
    if (record.terminal) return Promise.resolve(record.terminal);
    if (record.flight) return record.flight;
    const flight = this.reconcileRebalanceSellOnce(record).finally(() => { if (record.flight === flight) record.flight = undefined; });
    record.flight = flight;
    return flight;
  }

  private async reconcileRebalanceSellOnce(record: PendingRebalanceSell): Promise<RebalanceResult | undefined> {
    const leg = record.leg;
    // An UNCERTAIN submission without order identity can never be proven; it stays unresolved.
    if (!leg.orderId) return undefined;
    if (leg.settlement?.state !== 'TERMINAL') {
      try {
        leg.settlement = await this.reconcileFillLeg(leg, 'SELL');
      } catch (error) {
        try { this.log(`Rebalance SELL ${record.id} reconciliation: ${String(error)}`); } catch { /* remain pending */ }
      }
    }
    const settlement = leg.settlement;
    if (settlement?.state !== 'TERMINAL') return undefined;
    const requestedUnits = BigInt(Math.round(leg.requestedShares * 100));
    const facts: RebalanceSellFacts = {
      orderId: leg.orderId, tokenId: leg.tokenId, requestedShares: leg.requestedShares, soldShares: settlement.shares,
      ...(settlement.weightedPrice !== undefined ? { weightedPrice: settlement.weightedPrice } : {}),
      txHashes: [...settlement.txHashes],
    };
    if (record.terminal) return record.terminal;
    record.terminal = settlement.units >= requestedUnits
      ? { success: true, action: record.action, operationId: record.id, facts }
      : { success: false, action: record.action, operationId: record.id, facts,
          error: settlement.units === 0n
            ? `SELL ${record.label} never filled (${leg.orderId})`
            : `Partial SELL ${record.label}: ${settlement.shares} of ${leg.requestedShares} filled (${leg.orderId})` };
    return record.terminal;
  }

  /** Terminal effects exactly once per SELL record: log, pacing, event, release. */
  private publishRebalanceSell(result: RebalanceResult): void {
    // Every joiner of the single-flight reconciliation holds this same terminal object
    // (`record.terminal` is assigned once), so the claim on it survives the record's
    // removal by an earlier publisher; the record flag alone would not.
    if (this.publishedRebalanceSells.has(result)) return;
    this.publishedRebalanceSells.add(result);
    const record = result.operationId ? this.pendingRebalanceSells.get(result.operationId) : undefined;
    if (record) {
      if (record.published) return;
      record.published = true;
    }
    const facts = result.facts;
    const price = facts?.weightedPrice !== undefined ? ` @ ${facts.weightedPrice.toFixed(4)}` : '';
    if (record?.kind === 'corrective') {
      // Imbalance correction never emitted events or paced the rebalancer; only its claim becomes factual.
      if (result.success && facts) {
        this.log(`   ✅ Sold ${facts.soldShares.toFixed(2)} excess ${record.label} to restore balance (factual${price})`);
      } else {
        this.log(`   ❌ Corrective SELL not executed: ${result.error ?? 'SELL not executed'}`);
      }
      if (this.pendingRebalanceSells.get(record.id) === record) this.pendingRebalanceSells.delete(record.id);
      return;
    }
    if (result.success && facts) {
      this.lastRebalanceTime = Date.now();
      this.log(`   ✅ Sold ${facts.soldShares.toFixed(2)} ${record?.label ?? ''} tokens (factual${price})`);
    } else {
      this.log(`   ❌ Failed: ${result.error ?? 'SELL not executed'}`);
    }
    try {
      this.emit('rebalance', result);
    } finally {
      if (record && this.pendingRebalanceSells.get(record.id) === record) this.pendingRebalanceSells.delete(record.id);
    }
  }

  /** Read-only reconciliation of unresolved corrective SELLs; submits nothing. */
  private flushPendingRebalanceSells(): Promise<void> {
    if (this.rebalanceSellFlushPromise) return this.rebalanceSellFlushPromise;
    this.rebalanceSellFlushPromise = Promise.resolve().then(async () => {
      for (const [id, record] of [...this.pendingRebalanceSells]) {
        if (record.published) continue;
        try {
          if (record.id !== id) throw new Error('Rebalance SELL pending ID mismatch');
          const result = await this.reconcileRebalanceSell(record);
          if (!result) continue;
          if (result.success) {
            try { await this.updateBalance(); } catch (error) { this.log(`Balance refresh: ${String(error)}`); }
          }
          this.publishRebalanceSell(result);
        } catch (error) {
          try { this.log(`Rebalance SELL reconciliation ${id}: ${String(error)}`); } catch { /* remain pending */ }
        }
      }
    }).finally(() => { this.rebalanceSellFlushPromise = null; });
    return this.rebalanceSellFlushPromise;
  }

  private reconcileBuyLeg(leg: PendingLongLeg): Promise<BuyLegSettlement> {
    return this.reconcileFillLeg(leg, 'BUY');
  }

  /** Factual fills of one local order. BUY: we bought `tokenId`; SELL: we sold it.
   * Identical authority for both sides (mirrors the short-arb SELL reconciliation). */
  private async reconcileFillLeg(leg: PendingFillLeg, side: 'BUY' | 'SELL'): Promise<FillLegSettlement> {
    if (!this.tradingService) throw new Error('Trading not configured');
    if (!leg.orderId) throw new Error(`${side} leg has no orderId`);
    const orderId = leg.orderId;
    // The counterparty side of a trade on our own token.
    const counter = side === 'BUY' ? 'SELL' : 'BUY';
    const pending: FillLegSettlement = { state: 'PENDING' };
    const details = await this.tradingService.getOrderFillDetails(orderId);
    if (details.id !== orderId || details.asset_id !== leg.tokenId || details.side !== side ||
        !Array.isArray(details.tradeIds)) return pending;
    const matched = parseShareUnits(details.sizeMatched, side);
    const orderTerminal = ['MATCHED', 'CANCELED'].includes(details.status ?? '') && details.tradeEnumerationPresent === true;
    const known = leg.tradeIds ??= new Set<string>();
    for (const id of details.tradeIds) known.add(id);
    const ids = [...known];
    if (!ids.length) {
      // A canceled FOK with complete, empty enumeration and zero matched volume never filled.
      if (details.status === 'CANCELED' && details.tradeEnumerationPresent === true && matched === 0n) {
        return { state: 'TERMINAL', units: 0n, shares: 0, cost: 0, uniformPrice: true, txHashes: [] };
      }
      return pending;
    }
    if (ids.some(id => typeof id !== 'string' || !id.trim() || !details.tradeIds.includes(id))) return pending;
    const trades = await this.tradingService.getTradeStatuses(ids);
    if (trades.length !== ids.length || new Set(trades.map(t => t.id)).size !== ids.length ||
        trades.some(t => !known.has(t.id))) return pending;
    const facts = leg.facts ??= new Map<string, string>();
    let units = 0n, cost = 0, complete = true;
    const prices = new Set<string>();
    const txHashes = new Set<string>();
    for (const trade of trades) {
      // Same factual authority as the short-arb SELL path: local allocation, confirmed
      // status AND transaction identity. Invalid siblings never complete a leg.
      if (!Array.isArray(trade.maker_orders) || !trade.taker_order_id) { complete = false; continue; }
      const makers = trade.maker_orders.filter(m => m.order_id === orderId);
      let size: string | undefined, rawPrice: string | undefined;
      if (trade.taker_order_id === orderId) {
        if (trade.trader_side !== 'TAKER' || makers.length || trade.asset_id !== leg.tokenId || trade.side !== side) {
          complete = false; continue;
        }
        size = trade.size; rawPrice = trade.price;
      } else {
        const maker = makers[0];
        // As maker on our token the taker took the counter side; on the complement any side.
        if (trade.trader_side !== 'MAKER' || makers.length !== 1 || maker.asset_id !== leg.tokenId ||
            (maker.side !== undefined && maker.side !== side) || !trade.asset_id ||
            !['BUY', 'SELL'].includes(trade.side ?? '') || (trade.asset_id === leg.tokenId && trade.side !== counter)) {
          complete = false; continue;
        }
        size = maker.matched_amount; rawPrice = maker.price;
        if (parseShareUnits(size, side) > parseShareUnits(trade.size, side)) { complete = false; continue; }
      }
      const confirmed = ['MINED', 'CONFIRMED'].includes(trade.status) &&
        typeof trade.transactionHash === 'string' && TX_HASH_PATTERN.test(trade.transactionHash);
      if (!confirmed) {
        // A retained fact can never be demoted; a failed child without a hash is a terminal non-fill.
        if (facts.has(trade.id) || trade.status !== 'FAILED' || trade.transactionHash?.trim()) complete = false;
        continue;
      }
      if (size === undefined) { complete = false; continue; }
      const quantity = parseShareUnits(size, side);
      const price = typeof rawPrice === 'string' && /^\d+(?:\.\d+)?$/.test(rawPrice) ? Number(rawPrice) : NaN;
      if (quantity <= 0n || !Number.isFinite(price) || price <= 0 || price > 1) throw new Error(`Invalid successful ${side} facts`);
      const hash = trade.transactionHash!.toLowerCase();
      const fingerprint = JSON.stringify([leg.tokenId, side, trade.trader_side, trade.taker_order_id, quantity.toString(), rawPrice, hash]);
      const prior = facts.get(trade.id);
      if (prior !== undefined && prior !== fingerprint) { complete = false; continue; }
      facts.set(trade.id, fingerprint);
      units += quantity;
      cost += Number(quantity) / 100 * price;
      prices.add(rawPrice!);
      txHashes.add(hash);
    }
    if (!complete) return pending;
    if (units > matched) throw new Error(`${side} child sizes exceed sizeMatched`);
    // Matched volume is a completeness check, never a source of shares.
    if (units !== matched || !orderTerminal) return pending;
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${side} shares exceed safe economic precision`);
    const shares = Number(units) / 100;
    if (!Number.isFinite(cost)) throw new Error(`Invalid ${side} settlement totals`);
    return { state: 'TERMINAL', units, shares, cost, weightedPrice: units > 0n ? cost / shares : undefined,
      uniformPrice: prices.size <= 1, txHashes: [...txHashes] };
  }

  /** Periodic reconciliation of long arbs whose BUY legs were not terminal inline.
   * Holds the execution lock so the merge cannot interleave with another execution. */
  private flushPendingLongArbs(): Promise<void> {
    if (this.longArbFlushPromise) return this.longArbFlushPromise;
    this.longArbFlushPromise = Promise.resolve().then(async () => {
      if (this.isExecuting) return;
      this.isExecuting = true;
      try {
        for (const [id, op] of [...this.pendingLongArbs]) {
          // A rebalancer writing this inventory may move the pairs; merge on a later pass.
          if (op.published || this.isRebalancerWriting(op.market)) continue;
          try {
            if (op.id !== id) throw new Error('Long-arb pending ID mismatch');
            const result = await this.reconcileLongArb(op);
            if (result) this.publishLongArbResult(result);
          } catch (error) {
            // One query/anomaly must not prevent independent operations progressing.
            try { this.log(`Long-arb reconciliation ${id}: ${String(error)}`); } catch { /* remain pending */ }
          }
        }
      } finally {
        this.isExecuting = false;
      }
    }).finally(() => { this.longArbFlushPromise = null; });
    return this.longArbFlushPromise;
  }

  private async reconcileSellLeg(orderId: string, includeExactUnits = false, leg?: PendingShortLeg): Promise<SellLegSettlement> {
    if (!this.tradingService) throw new Error('Trading not configured');
    const pending: SellLegSettlement = { state: 'PENDING' };
    const parseShares = (value: unknown): bigint => {
      if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid factual SELL shares');
      const [whole, fraction = ''] = value.split('.');
      return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    };
    const details = await this.tradingService.getOrderFillDetails(orderId);
    if (!leg || details.id !== orderId || details.asset_id !== leg.tokenId || details.side !== 'SELL' ||
        !Array.isArray(details.tradeIds)) return pending;
    const known = leg.tradeIds ??= new Set<string>();
    for (const id of details.tradeIds) known.add(id);
    const ids = [...known];
    if (!ids.length || ids.some(id => typeof id !== 'string' || !id.trim() || !details.tradeIds.includes(id))) return pending;
    const matched = parseShares(details.sizeMatched);
    const trades = await this.tradingService.getTradeStatuses(ids);
    if (trades.length !== ids.length || new Set(trades.map(t => t.id)).size !== ids.length ||
        trades.some(t => !known.has(t.id))) return pending;
    const facts = leg.facts ??= new Map<string, string>();
    let units = 0n, notional = 0, complete = true;
    const txHashes = new Set<string>();
    for (const trade of trades) {
      // Same factual authority as the frozen BUY/SELL paths: local allocation,
      // confirmed status AND transaction identity. Invalid siblings never complete a leg.
      if (!Array.isArray(trade.maker_orders) || !trade.taker_order_id) { complete = false; continue; }
      const makers = trade.maker_orders.filter(m => m.order_id === orderId);
      let size: string | undefined, rawPrice: string | undefined;
      if (trade.taker_order_id === orderId) {
        if (trade.trader_side !== 'TAKER' || makers.length || trade.asset_id !== leg.tokenId || trade.side !== 'SELL') {
          complete = false; continue;
        }
        size = trade.size; rawPrice = trade.price;
      } else {
        const maker = makers[0];
        if (trade.trader_side !== 'MAKER' || makers.length !== 1 || maker.asset_id !== leg.tokenId ||
            (maker.side !== undefined && maker.side !== 'SELL') || !trade.asset_id ||
            !['BUY', 'SELL'].includes(trade.side ?? '') || (trade.asset_id === leg.tokenId && trade.side !== 'BUY')) {
          complete = false; continue;
        }
        size = maker.matched_amount; rawPrice = maker.price;
        if (parseShares(size) > parseShares(trade.size)) { complete = false; continue; }
      }
      if (!['MINED', 'CONFIRMED'].includes(trade.status) ||
          typeof trade.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(trade.transactionHash)) {
        complete = false; continue;
      }
      if (size === undefined) { complete = false; continue; }
      const quantity = parseShares(size);
      const price = typeof rawPrice === 'string' && /^\d+(?:\.\d+)?$/.test(rawPrice) ? Number(rawPrice) : NaN;
      if (quantity <= 0n || !Number.isFinite(price) || price <= 0 || price > 1) throw new Error('Invalid successful SELL facts');
      const hash = trade.transactionHash.toLowerCase();
      const fingerprint = JSON.stringify([leg.tokenId, 'SELL', trade.trader_side, trade.taker_order_id, quantity.toString(), rawPrice, hash]);
      const prior = facts.get(trade.id);
      if (prior !== undefined && prior !== fingerprint) { complete = false; continue; }
      facts.set(trade.id, fingerprint);
      units += quantity;
      notional += Number(quantity) / 100 * price;
      txHashes.add(hash);
    }
    if (!complete || units === 0n) return pending;
    if (units > matched) throw new Error('SELL child sizes exceed sizeMatched');
    if (units !== matched || !['MATCHED', 'CANCELED'].includes(details.status ?? '') || details.tradeEnumerationPresent !== true) return pending;
    // FOK plus the full submitted share quantity and resolved children closes this leg.
    // A partial canceled order remains conservative; no recovery is inferred.
    if (leg.requestedShares === undefined || units !== parseShares(String(leg.requestedShares))) return pending;
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SELL shares exceed safe economic precision');
    const successShares = Number(units) / 100, weightedPrice = notional / successShares;
    if (!Number.isFinite(notional) || !Number.isFinite(weightedPrice)) throw new Error('Invalid SELL settlement totals');
    return { state: 'TERMINAL_SUCCESS', successShares, weightedPrice, txHashes: [...txHashes],
      ...(includeExactUnits ? { successUnits: units } : {}) };
  }

  private async reconcilePendingShortArb(pending: PendingShortArb): Promise<void> {
    if (pending.finalized) return;
    // A rejection is known non-submission, not a FAILED child trade. An unsubmitted
    // leg remains unresolved because its submission decision may still be in flight.
    const facts: TerminalShortLeg[] = [];
    for (const leg of [pending.legA, pending.legB]) {
      if (leg.submission === 'REJECTED') {
        facts.push({ state: 'REJECTED' });
        continue;
      }
      if (leg.submission === 'NOT_SUBMITTED' || leg.submission === 'UNCERTAIN') continue;
      if (!leg.orderId?.trim()) throw new Error('Submitted short-arb leg has no orderId');
      if (!leg.settlement || leg.settlement.state === 'PENDING') {
        leg.settlement = await this.reconcileSellLeg(leg.orderId, true, leg);
      }
      if (leg.settlement.state !== 'PENDING') facts.push(leg.settlement);
    }
    if (facts.length !== 2) return;
    const [legA, legB] = facts;
    const aSuccess = legA.state === 'TERMINAL_SUCCESS';
    const bSuccess = legB.state === 'TERMINAL_SUCCESS';
    if ((aSuccess && (typeof legA.successUnits !== 'bigint' || legA.successUnits <= 0n)) ||
        (bSuccess && (typeof legB.successUnits !== 'bigint' || legB.successUnits <= 0n))) {
      throw new Error('Missing exact short-arb settlement quantity');
    }
    let state: NonNullable<PendingShortArb['terminalResult']>['state'];
    if (aSuccess && bSuccess && legA.successUnits === legB.successUnits) {
      state = 'BALANCED_SUCCESS';
    } else if (aSuccess || bSuccess) {
      state = 'IMBALANCED';
    } else if (legA.state === 'TERMINAL_FAILED' && legB.state === 'TERMINAL_FAILED') {
      state = 'NO_FILL';
    } else if (legA.state === 'REJECTED' || legB.state === 'REJECTED') {
      state = 'SUBMISSION_REJECTED';
    } else {
      return;
    }
    // No awaits or notifications between claim and storage. Preserve terminal facts.
    if (pending.finalized) return;
    pending.finalized = true;
    pending.terminalResult = { state, legA, legB };
    pending.inventoryReconciled = !aSuccess && !bSuccess;
  }

  private flushPendingShortArbs(): Promise<void> {
    if (this.shortArbFlushPromise) return this.shortArbFlushPromise;
    this.shortArbFlushPromise = Promise.resolve().then(async () => {
      for (const [id, pending] of [...this.pendingShortArbs]) {
        if (pending.finalized) continue;
        try {
          if (pending.id !== id) throw new Error('Short-arb pending ID mismatch');
          await this.reconcilePendingShortArb(pending);
        } catch (error) {
          // One query/anomaly must not prevent independent operations progressing.
          try { this.log(`Short-arb reconciliation ${id}: ${String(error)}`); } catch { /* remain pending */ }
        }
      }
    }).finally(() => { this.shortArbFlushPromise = null; });
    return this.shortArbFlushPromise;
  }

  /** Session-local effects exactly once; notification attempted at most once.
   * A throwing synchronous EventEmitter listener prevents later listeners running.
   * No delivery acknowledgement or async-listener retry is provided.
   */
  private consumeTerminalShortArbs(): void {
    // Nested passes must not consume operations created by a listener in this pass.
    if (this.shortArbConsuming) return;
    this.shortArbConsuming = true;
    try {
      for (const [id, pending] of [...this.pendingShortArbs]) {
        if (this.pendingShortArbs.get(id) !== pending || pending.consumed === true) continue;
        try {
          if (pending.id !== id) throw new Error('Short-arb pending ID mismatch');
          if (pending.finalized !== true) continue;
          const terminal = pending.terminalResult;
          if (!terminal) throw new Error('Missing short-arb terminal');
          const validateLeg = (leg: PendingShortLeg, fact: TerminalShortLeg): void => {
            if (!leg.tokenId?.trim()) throw new Error('Missing short-arb token');
            if (fact.state === 'REJECTED') {
              if (leg.submission !== 'REJECTED' || leg.settlement) throw new Error('Inconsistent rejected leg');
              return;
            }
            if (leg.submission !== 'SUBMITTED' || !leg.orderId?.trim() || leg.settlement !== fact) {
              throw new Error('Inconsistent submitted leg');
            }
            if (fact.state === 'TERMINAL_FAILED') return;
            if (fact.state !== 'TERMINAL_SUCCESS' || typeof fact.successUnits !== 'bigint' || fact.successUnits <= 0n ||
                !Number.isFinite(fact.successShares) || fact.successShares !== Number(fact.successUnits) / 100 ||
                !Number.isFinite(fact.weightedPrice) || fact.weightedPrice <= 0 ||
                !Array.isArray(fact.txHashes) || fact.txHashes.length === 0 ||
                fact.txHashes.some(hash => typeof hash !== 'string' || !hash.trim())) {
              throw new Error('Invalid successful short-arb facts');
            }
          };
          validateLeg(pending.legA, terminal.legA);
          validateLeg(pending.legB, terminal.legB);
          const aSuccess = terminal.legA.state === 'TERMINAL_SUCCESS';
          const bSuccess = terminal.legB.state === 'TERMINAL_SUCCESS';
          const classification = terminal.legA.state === 'TERMINAL_SUCCESS' && terminal.legB.state === 'TERMINAL_SUCCESS' &&
            terminal.legA.successUnits === terminal.legB.successUnits
            ? 'BALANCED_SUCCESS' : aSuccess || bSuccess ? 'IMBALANCED'
            : terminal.legA.state === 'TERMINAL_FAILED' && terminal.legB.state === 'TERMINAL_FAILED'
              ? 'NO_FILL' : 'SUBMISSION_REJECTED';
          if (terminal.state !== classification) throw new Error('Inconsistent short-arb classification');
          if ((aSuccess || bSuccess) && pending.inventoryReconciled !== true) continue;
          const snapshotLeg = (leg: PendingShortLeg, fact: TerminalShortLeg): ShortArbSettledLeg => {
            const base = { tokenId: leg.tokenId, ...(leg.orderId ? { orderId: leg.orderId } : {}),
              submission: fact.state === 'REJECTED' ? 'REJECTED' as const : 'SUBMITTED' as const };
            if (fact.state !== 'TERMINAL_SUCCESS') return Object.freeze({ ...base, state: fact.state });
            return Object.freeze({ ...base, state: fact.state, successShares: fact.successShares,
              successUnits: fact.successUnits!.toString(), weightedPrice: fact.weightedPrice,
              txHashes: Object.freeze([...fact.txHashes]) });
          };
          const legA = snapshotLeg(pending.legA, terminal.legA);
          const legB = snapshotLeg(pending.legB, terminal.legB);
          const snapshot: ShortArbSettledEvent = Object.freeze({ operationId: id, conditionId: pending.conditionId,
            classification, legA, legB, inventoryReconciled: pending.inventoryReconciled === true });
          pending.consumed = true;
          try {
            this.stats.shortArbTerminals[classification]++;
            if (classification === 'BALANCED_SUCCESS') this.stats.executionsSucceeded++;
            this.emit('shortArbSettled', snapshot);
          } finally {
            if (this.pendingShortArbs.get(id) === pending) this.pendingShortArbs.delete(id);
          }
        } catch (error) {
          try { this.log(`Short-arb consumption ${id}: ${String(error)}`); } catch { /* isolate diagnostics */ }
        }
      }
    } finally {
      this.shortArbConsuming = false;
    }
  }

  private async executeShortArb(opportunity: ArbitrageOpportunity): Promise<ShortArbSubmissionAck> {
    const operationId = `short-${++this.nextShortArbId}`;
    const ack = (status: ShortArbSubmissionAck['status']): ShortArbSubmissionAck => ({
      type: 'SHORT_SUBMISSION', status, operationId,
    });
    const size = opportunity.recommendedSize;
    const market = this.market;
    const trading = this.tradingService;
    const heldPairs = Math.min(this.balance.yesTokens, this.balance.noTokens);
    const floors = [opportunity.priceCaps?.sellYes ?? opportunity.effectivePrices.sellYes * (1 - this.config.maxSlippagePct),
      opportunity.priceCaps?.sellNo ?? opportunity.effectivePrices.sellNo * (1 - this.config.maxSlippagePct)];
    if (!market || !trading || !Number.isFinite(size) || size <= 0 ||
        !Number.isFinite(heldPairs) || heldPairs < size || floors.some(price => !Number.isFinite(price) || price <= 0)) {
      return ack('SUBMISSION_REJECTED');
    }

    const pending: PendingShortArb = { id: operationId, conditionId: market.conditionId,
      legA: { tokenId: market.yesTokenId, requestedShares: size, submission: 'NOT_SUBMITTED' },
      legB: { tokenId: market.noTokenId, requestedShares: size, submission: 'NOT_SUBMITTED' }, finalized: false, consumed: false };
    this.pendingShortArbs.set(operationId, pending);
    const legs = [pending.legA, pending.legB];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      // Once the attempt starts, an exception cannot prove non-submission.
      leg.submission = 'UNCERTAIN';
      try {
        const result = await trading.createMarketOrder({ tokenId: leg.tokenId,
          side: 'SELL', amount: size, price: floors[i], orderType: 'FOK' });
        const orderId = typeof result.orderId === 'string' ? result.orderId.trim() : '';
        if (orderId) leg.orderId = orderId;
        if (result.submissionState === 'REJECTED') {
          leg.submission = 'REJECTED';
          if (i === 0) {
            this.pendingShortArbs.delete(operationId);
            return ack('SUBMISSION_REJECTED');
          }
          return ack('SUBMITTED_PENDING');
        }
        if (result.submissionState !== 'ACCEPTED' || !orderId) return ack('SUBMISSION_UNCERTAIN');
        leg.tradeIds = new Set(result.tradeIds ?? []);
        leg.submission = 'SUBMITTED';
      } catch {
        return ack('SUBMISSION_UNCERTAIN');
      }
    }
    return ack('SUBMITTED_PENDING');
  }

  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[ArbitrageService] ${message}`);
    }
  }

  /**
   * V2.3A: explicit lifecycle routing from market metadata.
   * Returns undefined when the market type is unknown (no silent false default).
   */
  private toLifecycleRouting(market: ArbitrageMarketConfig | null): LifecycleRouting | undefined {
    if (!market || typeof market.negRisk !== 'boolean') return undefined;
    return { negRisk: market.negRisk };
  }

  // ===== Market Scanning Methods =====

  /**
   * Scan markets for arbitrage opportunities
   *
   * @param criteria Filter criteria for markets
   * @param minProfit Minimum profit threshold (default: 0.005 = 0.5%)
   * @returns Array of scan results sorted by profit
   *
   * @example
   * ```typescript
   * const service = new ArbitrageService({ privateKey: '0x...' });
   *
   * // Scan markets with at least $5000 volume
   * const results = await service.scanMarkets({ minVolume24h: 5000 }, 0.005);
   *
   * // Start arbitraging the best opportunity
   * if (results.length > 0 && results[0].arbType !== 'none') {
   *   await service.start(results[0].market);
   * }
   * ```
   */
  async scanMarkets(
    criteria: ScanCriteria = {},
    minProfit = 0.005
  ): Promise<ScanResult[]> {
    const {
      minVolume24h = 1000,
      maxVolume24h,
      keywords = [],
      limit = 100,
    } = criteria;

    this.log(`Scanning markets (minVolume: $${minVolume24h}, minProfit: ${(minProfit * 100).toFixed(2)}%)...`);

    // Create temporary API clients for scanning
    const cache = createUnifiedCache();
    const gammaApi = new GammaApiClient(this.rateLimiter, cache);
    const tempMarketService = new MarketService(gammaApi, undefined, this.rateLimiter, cache);

    // Fetch active markets from Gamma API
    const markets = await gammaApi.getMarkets({
      active: true,
      closed: false,
      limit,
    });

    this.log(`Found ${markets.length} active markets`);

    const results: ScanResult[] = [];

    for (const gammaMarket of markets) {
      try {
        // Filter by volume
        const volume24h = gammaMarket.volume24hr || 0;
        if (volume24h < minVolume24h) continue;
        if (maxVolume24h && volume24h > maxVolume24h) continue;

        // Filter by keywords
        if (keywords.length > 0) {
          const marketText = `${gammaMarket.question} ${gammaMarket.description || ''}`.toLowerCase();
          const hasKeyword = keywords.some((kw) => marketText.includes(kw.toLowerCase()));
          if (!hasKeyword) continue;
        }

        // Skip non-binary markets
        if (!gammaMarket.conditionId || gammaMarket.outcomes?.length !== 2) continue;

        // Get market data for token IDs
        let clobMarket;
        try {
          clobMarket = await tempMarketService.getClobMarket(gammaMarket.conditionId);
          if (!clobMarket) continue; // Skip if market not found
        } catch {
          continue; // Skip if market data not available
        }

        // Use index-based access instead of name-based (supports Yes/No, Up/Down, Team1/Team2, etc.)
        const yesToken = clobMarket.tokens[0];  // primary outcome
        const noToken = clobMarket.tokens[1];   // secondary outcome
        if (!yesToken || !noToken) continue;

        // Get orderbook data
        let orderbook;
        try {
          orderbook = await tempMarketService.getProcessedOrderbook(gammaMarket.conditionId);
        } catch {
          continue; // Skip if orderbook not available
        }

        const { effectivePrices, longArbProfit, shortArbProfit } = orderbook.summary;

        // Determine best arbitrage type
        let arbType: 'long' | 'short' | 'none' = 'none';
        let profitRate = 0;

        if (longArbProfit > minProfit && longArbProfit >= shortArbProfit) {
          arbType = 'long';
          profitRate = longArbProfit;
        } else if (shortArbProfit > minProfit) {
          arbType = 'short';
          profitRate = shortArbProfit;
        }

        // Calculate available size (min of both sides)
        const yesAskSize = orderbook.yes.askSize || 0;
        const noAskSize = orderbook.no.askSize || 0;
        const yesBidSize = orderbook.yes.bidSize || 0;
        const noBidSize = orderbook.no.bidSize || 0;

        const availableSize = arbType === 'long'
          ? Math.min(yesAskSize, noAskSize)
          : Math.min(yesBidSize, noBidSize);

        // Calculate score (profit * volume * available_size)
        const score = profitRate * 100 * Math.log10(volume24h + 1) * Math.min(availableSize, 100) / 100;

        // Create market config
        const marketConfig: ArbitrageMarketConfig = {
          name: gammaMarket.question.slice(0, 60) + (gammaMarket.question.length > 60 ? '...' : ''),
          conditionId: gammaMarket.conditionId,
          yesTokenId: yesToken.tokenId,
          noTokenId: noToken.tokenId,
          outcomes: gammaMarket.outcomes as [string, string],
          negRisk: clobMarket.negRisk,
        };

        const longCost = effectivePrices.effectiveBuyYes + effectivePrices.effectiveBuyNo;
        const shortRevenue = effectivePrices.effectiveSellYes + effectivePrices.effectiveSellNo;

        let description: string;
        if (arbType === 'long') {
          description = `Buy YES@${effectivePrices.effectiveBuyYes.toFixed(4)} + NO@${effectivePrices.effectiveBuyNo.toFixed(4)} = ${longCost.toFixed(4)} → Merge for $1`;
        } else if (arbType === 'short') {
          description = `Sell YES@${effectivePrices.effectiveSellYes.toFixed(4)} + NO@${effectivePrices.effectiveSellNo.toFixed(4)} = ${shortRevenue.toFixed(4)}`;
        } else {
          description = `No opportunity (Long cost: ${longCost.toFixed(4)}, Short rev: ${shortRevenue.toFixed(4)})`;
        }

        results.push({
          market: marketConfig,
          arbType,
          profitRate,
          profitPercent: profitRate * 100,
          effectivePrices: {
            buyYes: effectivePrices.effectiveBuyYes,
            buyNo: effectivePrices.effectiveBuyNo,
            sellYes: effectivePrices.effectiveSellYes,
            sellNo: effectivePrices.effectiveSellNo,
            longCost,
            shortRevenue,
          },
          volume24h,
          availableSize,
          score,
          description,
        });
      } catch (error) {
        // Skip markets with errors
        continue;
      }
    }

    // Sort by profit (descending), then by score
    results.sort((a, b) => {
      if (b.profitRate !== a.profitRate) return b.profitRate - a.profitRate;
      return b.score - a.score;
    });

    this.log(`Found ${results.filter((r) => r.arbType !== 'none').length} markets with arbitrage opportunities`);

    return results;
  }

  /**
   * Quick scan for best arbitrage opportunities
   *
   * @param minProfit Minimum profit threshold (default: 0.005 = 0.5%)
   * @param limit Maximum number of results to return (default: 10)
   * @returns Top arbitrage opportunities
   *
   * @example
   * ```typescript
   * const service = new ArbitrageService({ privateKey: '0x...' });
   *
   * // Find best arbitrage opportunities
   * const top = await service.quickScan(0.005, 5);
   *
   * // Print results
   * for (const r of top) {
   *   console.log(`${r.market.name}: ${r.arbType} +${r.profitPercent.toFixed(2)}%`);
   * }
   *
   * // Start the best one
   * if (top.length > 0) {
   *   await service.start(top[0].market);
   * }
   * ```
   */
  async quickScan(minProfit = 0.005, limit = 10): Promise<ScanResult[]> {
    const results = await this.scanMarkets(
      { minVolume24h: 5000, limit: 100 },
      minProfit
    );

    // Return only markets with opportunities, limited to requested count
    return results
      .filter((r) => r.arbType !== 'none')
      .slice(0, limit);
  }

  /**
   * Find and start arbitraging the best opportunity
   *
   * @param minProfit Minimum profit threshold (default: 0.005 = 0.5%)
   * @returns The scan result that was started, or null if none found
   *
   * @example
   * ```typescript
   * const service = new ArbitrageService({
   *   privateKey: '0x...',
   *   autoExecute: true,
   *   profitThreshold: 0.005,
   * });
   *
   * // Find and start the best opportunity
   * const started = await service.findAndStart(0.005);
   * if (started) {
   *   console.log(`Started: ${started.market.name} (+${started.profitPercent.toFixed(2)}%)`);
   * }
   * ```
   */
  async findAndStart(minProfit = 0.005): Promise<ScanResult | null> {
    const results = await this.quickScan(minProfit, 1);

    if (results.length === 0) {
      this.log('No arbitrage opportunities found');
      return null;
    }

    const best = results[0];
    this.log(`Best opportunity: ${best.market.name} (${best.arbType} +${best.profitPercent.toFixed(2)}%)`);

    await this.start(best.market);
    return best;
  }
}
