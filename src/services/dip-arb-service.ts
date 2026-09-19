/**
 * DipArbService - Dip Arbitrage Service
 *
 * 暴跌套利服务 - 针对 Polymarket 15分钟/5分钟 UP/DOWN 市场
 *
 * 策略原理：
 * 1. 每个市场有一个 "price to beat"（开盘时的 Chainlink 价格）
 * 2. 结算规则：
 *    - UP 赢：结束时价格 >= price to beat
 *    - DOWN 赢：结束时价格 < price to beat
 *
 * 3. 套利流程：
 *    - Leg1：检测暴跌 → 买入暴跌侧
 *    - Leg2：等待对冲条件 → 买入另一侧
 *    - 利润：总成本 < $1 时获得无风险利润
 *
 * 使用示例：
 * ```typescript
 * const sdk = await PolymarketSDK.create({ privateKey: '...' });
 *
 * // 自动找到并启动
 * await sdk.dipArb.findAndStart({ coin: 'BTC' });
 *
 * // 监听信号
 * sdk.dipArb.on('signal', (signal) => {
 *   console.log(`Signal: ${signal.type} ${signal.side}`);
 * });
 * ```
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import {
  RealtimeServiceV2,
  type MarketSubscription,
  type OrderbookSnapshot,
  type Subscription,
  type CryptoPrice,
} from './realtime-service-v2.js';
import { TradingService, type MarketOrderParams, type OrderResult, type TradeStatus } from './trading-service.js';
import { MarketService } from './market-service.js';
import { CTFClient, MergeProvenanceError, RedeemProvenanceError, type MergeProvenance,
  type MergeResult, type RedeemResult, type LifecycleRouting } from '../clients/ctf-client.js';
import { resolvePolygonRpcUrl } from '../utils/rpc.js';
import { estimateTakerFee } from '../utils/price-utils.js';
import type { Side } from '../core/types.js';
import {
  type DipArbServiceConfig,
  type DipArbConfigInternal,
  type DipArbMarketConfig,
  type DipArbRoundState,
  type DipArbStats,
  type DipArbSignal,
  type DipArbLeg1Signal,
  type DipArbLeg2Signal,
  type DipArbExecutionResult,
  type DipArbRoundResult,
  type DipArbNewRoundEvent,
  type DipArbPriceUpdateEvent,
  type DipArbScanOptions,
  type DipArbFindAndStartOptions,
  type DipArbSide,
  type DipArbAutoRotateConfig,
  type DipArbSettleResult,
  type DipArbRotateEvent,
  type DipArbUnderlying,
  type DipArbPendingRedemption,
  DEFAULT_DIP_ARB_CONFIG,
  DEFAULT_AUTO_ROTATE_CONFIG,
  createDipArbInitialStats,
  createDipArbRoundState,
  calculateDipArbProfitRate,
  estimateUpWinRate,
  detectMispricing,
  parseUnderlyingFromSlug,
  parseDurationFromSlug,
  isDipArbLeg1Signal,
} from './dip-arb-types.js';

export type DipArbInventoryQuery = Readonly<{ walletAddress: string; tokenIds: readonly string[] }>;
export type DipArbClobWriter = 'LEG1' | 'LEG2' | 'EMERGENCY_EXIT' | 'SETTLE_SELL';
export type DipArbInventoryAdmissionGuard = (query: DipArbInventoryQuery & Readonly<{
  operationType: DipArbClobWriter | 'MERGE' | 'REDEEM';
}>) => string | undefined;
export type DipArbInventoryProtection = Readonly<{ blocked: true; reason: string; operationId: string }>;
type ClobScope = { originMarket: DipArbMarketConfig; wallet: string | undefined; market: DipArbMarketConfig; round: DipArbRoundState; trading: TradingService;
  ctf: CTFClient | null; running: boolean; invocation: symbol; guard: DipArbInventoryAdmissionGuard | undefined };
type SellSettlementLeg = {
  tokenId: string; requestedShares: number; attempted: boolean; rejected: boolean;
  orderId?: string; tradeIds: Set<string>;
  facts: Map<string, { shares: bigint; price: bigint; hash: string }>;
  observed: boolean; completeEvidence: boolean; residual?: bigint;
};
type SellComposition = Array<{ leg: object; tokenId: string; side: DipArbSide; shares: number } | undefined>;
type SellSettlement = {
  scope: ClobScope; legs: SellSettlementLeg[]; emitted: boolean;
  composition: SellComposition; finalizedComposition?: SellComposition;
  flight?: Promise<DipArbSettleResult>; finalized?: DipArbSettleResult;
};
type BuyExecution = {
  signal: DipArbLeg1Signal | DipArbLeg2Signal; scope?: ClobScope; submitted: boolean;
  orders: Array<{ orderId?: string; ids: Set<string>; rejected: boolean; facts: Map<string, { units: bigint; hash: string; price?: bigint }> }>;
  flight?: Promise<DipArbExecutionResult & DipArbInventoryDiagnostic>;
  result?: DipArbExecutionResult & DipArbInventoryDiagnostic;
  executionEmitted?: boolean;
  publishExecution?: boolean;
  interruption?: DipArbInventoryDiagnostic['inventoryInterruption'];
};
type ClobLifecycle = { operationId: string; wallet: string; tokenIds: readonly string[];
  writerType: DipArbClobWriter | 'POSITION'; invocation?: symbol; round: DipArbRoundState; scope?: ClobScope;
  submission: 'ACTIVE' | 'ACCEPTED' | 'UNCERTAIN' | 'EXISTING';
  lifecycle: 'WRITING' | 'PENDING' | 'POSITION'; orderId?: string; tradeIds: readonly string[] };
class InventoryAdmissionRefusal extends Error {}
type CtfScope = { ctf: CTFClient; market: DipArbMarketConfig; wallet: string;
  guard: DipArbInventoryAdmissionGuard | undefined; round: DipArbRoundState | null;
  originMarket: DipArbMarketConfig; foreground: boolean; running: boolean };
type CtfLifecycle = { operationId: string; wallet: string; tokenIds: readonly string[];
  state: 'ACTIVE' | MergeProvenance['state']; transactionHash?: string };
export type DipArbInventoryDiagnostic = {
  status?: 'BLOCKED_INVENTORY';
  inventoryInterruption?: Readonly<{ status: 'BLOCKED_INVENTORY'; reason: string }>;
};
function isInventoryRefusal(result: unknown): boolean {
  return !!result && typeof result === 'object' && 'status' in result && result.status === 'BLOCKED_INVENTORY';
}

// ===== DipArbService =====

export class DipArbService extends EventEmitter {
  // Dependencies
  private realtimeService: RealtimeServiceV2;
  private tradingService: TradingService | null = null;
  private marketService: MarketService;
  private ctf: CTFClient | null = null;

  private inventoryAdmissionGuard?: DipArbInventoryAdmissionGuard;
  private clobLifecycles = new Map<string, ClobLifecycle>();
  private ctfLifecycles = new Map<string, CtfLifecycle>();
  private nextCtfOperation = 0;
  private nextClobOperation = 0;
  private seenClobOrders = new Set<string>();
  private closedInventoryLegs = new WeakSet<object>();
  private admittingInventory = false;
  private protectedClobReconciliation?: Promise<void>;
  private clobReleaseFlights = new Map<DipArbRoundState, Map<string, Promise<void>>>();

  setInventoryAdmissionGuard(guard?: DipArbInventoryAdmissionGuard): void {
    if (!guard && (this.clobLifecycles.size || this.ctfLifecycles.size)) throw new Error('DipArb inventory lifecycle still protected');
    this.inventoryAdmissionGuard = guard;
    // Existing DipArb legs are identities, never attributed from aggregate wallet balances.
    if (guard && this.currentRound && this.tradingService) {
      const wallet = this.inventoryWallet(this.tradingService.getAddress());
      for (const leg of [this.currentRound.leg1, this.currentRound.leg2]) {
        if (!leg || this.closedInventoryLegs.has(leg) || leg.shares <= 0 || [...this.clobLifecycles.values()].some(r =>
          r.round === this.currentRound && r.tokenIds.includes(leg.tokenId))) continue;
        const operationId = `dip-clob-${++this.nextClobOperation}`;
        this.clobLifecycles.set(operationId, { operationId, wallet, tokenIds: Object.freeze([leg.tokenId]),
          writerType: 'POSITION', round: this.currentRound,
          scope: this.market ? { originMarket: this.market, market: { ...this.market }, wallet,
            round: this.currentRound, trading: this.tradingService, ctf: this.ctf,
            running: this.isRunning, invocation: Symbol(), guard } : undefined,
          submission: leg.exitPending ? 'UNCERTAIN' : 'EXISTING', lifecycle: 'POSITION', tradeIds: [] });
      }
    }
  }

  getInventoryProtection(query: DipArbInventoryQuery): DipArbInventoryProtection | undefined {
    const wallet = this.inventoryWallet(query.walletAddress);
    if (!query.tokenIds.length || query.tokenIds.some(t => typeof t !== 'string' || !t.trim())) {
      throw new Error('Invalid inventory token identity');
    }
    for (const record of this.ctfLifecycles.values()) {
      if (record.wallet === wallet && record.tokenIds.some(t => query.tokenIds.includes(t))) {
        return Object.freeze({ blocked: true, reason: `DIP_ARB_CTF_${record.state}`, operationId: record.operationId });
      }
    }
    for (const record of this.clobLifecycles.values()) {
      if (record.wallet === wallet && record.tokenIds.some(t => query.tokenIds.includes(t))) {
        return Object.freeze({ blocked: true, reason: `DIP_ARB_${record.submission === 'UNCERTAIN'
          ? 'UNCERTAIN' : record.lifecycle}`, operationId: record.operationId });
      }
    }
  }

  private inventoryWallet(address: string): string {
    if (!ethers.utils.isAddress(address)) throw new InventoryAdmissionRefusal('Invalid inventory wallet identity');
    return ethers.utils.getAddress(address).toLowerCase();
  }

  private captureCtfScope(market: DipArbMarketConfig, round: DipArbRoundState | null, foreground = false): CtfScope {
    const ctf = this.ctf!;
    let wallet = '';
    try { wallet = ctf.getAddress(); } catch { /* Admission fails closed when isolation is enabled. */ }
    return { ctf, wallet, market: Object.freeze({ ...market }), originMarket: market, round, foreground,
      guard: this.inventoryAdmissionGuard, running: this.isRunning };
  }

  private async writeCtf(scope: CtfScope, writer: 'MERGE' | 'REDEEM', amount?: string): Promise<MergeResult | RedeemResult> {
    const tokenIds = Object.freeze({ yesTokenId: scope.market.upTokenId, noTokenId: scope.market.downTokenId });
    const routing = this.toLifecycleRouting(scope.market);
    // Preserve the existing opt-in admission contract, including legacy caller arguments.
    if (!scope.guard) {
      if (this.inventoryAdmissionGuard) throw new InventoryAdmissionRefusal('Inventory guard changed during preparation');
      return writer === 'MERGE'
        ? scope.ctf.mergeByTokenIds(scope.market.conditionId, tokenIds, amount!, routing)
        : scope.ctf.redeemByTokenIds(scope.market.conditionId, tokenIds, undefined, routing);
    }
    const wallet = this.inventoryWallet(scope.wallet);
    const tokens = Object.freeze([tokenIds.yesTokenId, tokenIds.noTokenId]);
    const current = () => {
      try {
        return scope.ctf === this.ctf && scope.guard === this.inventoryAdmissionGuard &&
          this.inventoryWallet(scope.ctf.getAddress()) === wallet && scope.running === this.isRunning &&
          (!scope.foreground || (scope.originMarket === this.market && scope.round === this.currentRound)) &&
          scope.originMarket.conditionId === scope.market.conditionId &&
          scope.originMarket.upTokenId === tokens[0] && scope.originMarket.downTokenId === tokens[1] &&
          scope.originMarket.negRisk === scope.market.negRisk;
      } catch { return false; }
    };
    if (tokens.some(t => typeof t !== 'string' || !t.trim()) || !current() || this.admittingInventory) {
      throw new InventoryAdmissionRefusal('Stale or invalid CTF inventory identity');
    }
    let reason: string | undefined;
    this.admittingInventory = true;
    try { reason = scope.guard(Object.freeze({ walletAddress: wallet, tokenIds: tokens, operationType: writer })); }
    catch (error) { throw new InventoryAdmissionRefusal(error instanceof Error ? error.message : 'Inventory guard failed'); }
    finally { this.admittingInventory = false; }
    if (reason || !current()) throw new InventoryAdmissionRefusal(reason || 'CTF context changed during admission');
    if ([...this.ctfLifecycles.values()].some(r => r.wallet === wallet && r.tokenIds.some(t => tokens.includes(t)))) {
      throw new InventoryAdmissionRefusal('DipArb CTF lifecycle unresolved');
    }
    // An owned position may continue into CTF; an in-flight or ambiguous CLOB writer may not.
    if ([...this.clobLifecycles.values()].some(r => r.wallet === wallet && r.tokenIds.some(t => tokens.includes(t)) &&
      ((r.round !== scope.round && r.scope?.market.conditionId !== scope.market.conditionId) ||
        r.submission === 'ACTIVE' || r.submission === 'UNCERTAIN' ||
        r.writerType === 'EMERGENCY_EXIT' || r.writerType === 'SETTLE_SELL'))) {
      throw new InventoryAdmissionRefusal('DipArb CLOB lifecycle unresolved');
    }
    const operationId = `dip-ctf-${++this.nextCtfOperation}`;
    const record: CtfLifecycle = { operationId, wallet, tokenIds: tokens, state: 'ACTIVE' };
    this.ctfLifecycles.set(operationId, record);
    const observe = (provenance: MergeProvenance) => {
      if (!this.ctfLifecycles.has(operationId)) return;
      record.state = provenance.state;
      if (provenance.transactionHash) record.transactionHash = provenance.transactionHash;
      if (provenance.state === 'NOT_SUBMITTED' || provenance.state === 'CONFIRMED') this.ctfLifecycles.delete(operationId);
    };
    try {
      const result = writer === 'MERGE'
        ? await scope.ctf.mergeByTokenIds(scope.market.conditionId, tokenIds, amount!, routing, observe)
        : await scope.ctf.redeemByTokenIds(scope.market.conditionId, tokenIds, undefined, routing, observe);
      if (result.provenance) observe(result.provenance);
      if (record.state !== 'CONFIRMED') throw new Error('CTF write lacks confirmed provenance');
      return result;
    } catch (error) {
      if ((writer === 'MERGE' && error instanceof MergeProvenanceError) ||
          (writer === 'REDEEM' && error instanceof RedeemProvenanceError)) observe(error.provenance);
      else if (this.ctfLifecycles.has(operationId) && record.state === 'ACTIVE') record.state = 'UNCERTAIN';
      throw error;
    }
  }

  private inventoryBlocked<T extends object>(result: T, error: InventoryAdmissionRefusal): T & DipArbInventoryDiagnostic {
    try { this.emit('inventoryBlocked', Object.freeze({ reason: error.message })); } catch { /* diagnostic only */ }
    return { ...result, status: 'BLOCKED_INVENTORY' };
  }

  private clobWalletSnapshot(trading: TradingService | null): string {
    try { return trading?.getAddress() ?? ''; } catch { return ''; }
  }

  private async submitClob(scope: ClobScope, writerType: DipArbClobWriter, params: MarketOrderParams,
    retryTransition?: { retiringIds: ReadonlySet<string>; commit: () => void }): Promise<OrderResult> {
    if (!scope.guard) {
      retryTransition?.commit();
      return scope.trading.createMarketOrder(params);
    }
    const wallet = this.inventoryWallet(scope.wallet ?? '');
    const token = params.tokenId;
    const current = () => scope.originMarket === this.market && scope.market.upTokenId === this.market.upTokenId &&
      scope.market.downTokenId === this.market.downTokenId && scope.round === this.currentRound &&
      scope.running === this.isRunning && scope.guard === this.inventoryAdmissionGuard &&
      scope.trading === this.tradingService && this.inventoryWallet(this.clobWalletSnapshot(scope.trading)) === wallet;
    if (!token?.trim() || ![scope.market.upTokenId, scope.market.downTokenId].includes(token) || !current() || this.admittingInventory) throw new InventoryAdmissionRefusal('Stale or reentrant inventory admission');
    const leg1 = scope.round.leg1, leg2 = scope.round.leg2, phase = scope.round.phase;
    let reason: string | undefined;
    this.admittingInventory = true;
    try { reason = scope.guard(Object.freeze({ walletAddress: wallet, tokenIds: Object.freeze([token]), operationType: writerType })); }
    catch (error) { throw new InventoryAdmissionRefusal(error instanceof Error ? error.message : 'Inventory guard failed'); }
    finally { this.admittingInventory = false; }
    if (reason || !current() || scope.round.leg1 !== leg1 || scope.round.leg2 !== leg2 || scope.round.phase !== phase) throw new InventoryAdmissionRefusal(reason || 'Inventory context changed during admission');
    for (const prior of this.clobLifecycles.values()) {
      if (retryTransition?.retiringIds.has(prior.operationId)) continue;
      if (prior.wallet !== wallet || !prior.tokenIds.includes(token)) continue;
      if (prior.round !== scope.round || prior.submission === 'ACTIVE' || prior.submission === 'UNCERTAIN' ||
          (prior.writerType === 'EMERGENCY_EXIT' || prior.writerType === 'SETTLE_SELL') ||
          (params.side === 'BUY' && prior.invocation !== scope.invocation)) {
        throw new InventoryAdmissionRefusal('DipArb inventory lifecycle unresolved');
      }
    }
    retryTransition?.commit(); // Final identity check after admission; no await before transport.
    const operationId = `dip-clob-${++this.nextClobOperation}`;
    const record: ClobLifecycle = { operationId, wallet, tokenIds: Object.freeze([token]), writerType,
      round: scope.round, scope, invocation: scope.invocation, submission: 'ACTIVE', lifecycle: 'WRITING', tradeIds: [] };
    this.clobLifecycles.set(operationId, record);
    try {
      const result = await scope.trading.createMarketOrder(params);
      const orderId = typeof result.orderId === 'string' ? result.orderId.trim() : '';
      if (result.submissionState === 'REJECTED') this.clobLifecycles.delete(operationId);
      else if (result.submissionState === 'ACCEPTED' && orderId && !this.seenClobOrders.has(`${wallet}:${orderId}`)) {
        this.seenClobOrders.add(`${wallet}:${orderId}`);
        record.submission = 'ACCEPTED'; record.lifecycle = 'PENDING'; record.orderId = orderId;
        record.tradeIds = Object.freeze([...(result.tradeIds ?? [])]);
      } else {
        record.submission = 'UNCERTAIN'; record.lifecycle = 'PENDING';
        // Preserve a unique factual order identity for later read-only resolution.
        if (result.submissionState === 'UNCERTAIN' && orderId && !this.seenClobOrders.has(`${wallet}:${orderId}`)) {
          this.seenClobOrders.add(`${wallet}:${orderId}`);
          record.orderId = orderId;
          record.tradeIds = Object.freeze([...(result.tradeIds ?? [])]);
        }
      }
      return result;
    } catch (error) { record.submission = 'UNCERTAIN'; record.lifecycle = 'PENDING'; throw error; }
  }

  // Exclusively a protection proof; never books fills, fees, proceeds or PnL.
  private reconcileProtectedClobLifecycles(): Promise<void> {
    if (this.protectedClobReconciliation) return this.protectedClobReconciliation;
    const run = async () => {
      const visited = new Map<DipArbRoundState, Set<string>>();
      for (const record of [...this.clobLifecycles.values()]) {
        if (!this.clobLifecycles.has(record.operationId) || !record.scope ||
            record.submission === 'ACTIVE' || (record.submission !== 'EXISTING' && !record.orderId)) continue;
        let tokens = visited.get(record.round);
        if (!tokens) visited.set(record.round, tokens = new Set());
        for (const token of record.tokenIds) {
          if (tokens.has(token)) continue;
          tokens.add(token);
          await this.releaseClobAfterExit(record.scope, token);
        }
      }
    };
    const flight = Promise.resolve().then(run).finally(() => {
      if (this.protectedClobReconciliation === flight) this.protectedClobReconciliation = undefined;
    });
    this.protectedClobReconciliation = flight;
    return flight;
  }

  private releaseClobAfterExit(scope: ClobScope, token: string): Promise<void> {
    let flights = this.clobReleaseFlights.get(scope.round);
    if (!flights) this.clobReleaseFlights.set(scope.round, flights = new Map());
    const key = `${scope.wallet}:${token}`;
    const existing = flights.get(key);
    if (existing) return existing;
    const flight = Promise.resolve().then(() => this.proveClobRelease(scope, token)).finally(() => {
      flights!.delete(key);
      if (!flights!.size) this.clobReleaseFlights.delete(scope.round);
    });
    flights.set(key, flight);
    return flight;
  }

  private async proveClobRelease(scope: ClobScope, token: string): Promise<void> {
    if (!scope.guard || !scope.ctf) return;
    try {
      const wallet = this.inventoryWallet(scope.wallet ?? '');
      if (this.inventoryWallet(scope.trading.getAddress()) !== wallet) return;
      if (this.inventoryWallet(scope.ctf.getAddress()) !== wallet) return;
      const records = [...this.clobLifecycles.values()].filter(r => r.wallet === wallet && r.round === scope.round && r.tokenIds.includes(token));
      if (!records.length || records.some(r => r.submission === 'ACTIVE' || (r.submission === 'UNCERTAIN' && !r.orderId))) return;
      const initialRecords = new Set(this.clobLifecycles.values());
      for (const record of records) {
        if (record.submission === 'EXISTING') continue;
        if (!record.orderId) return;
        const details = await scope.trading.getOrderFillDetails(record.orderId);
        const ids = [...new Set([...record.tradeIds, ...details.tradeIds])];
        record.tradeIds = Object.freeze(ids);
        if (!ids.length) return;
        const trades = await scope.trading.getTradeStatuses(ids);
        if (ids.some(id => !details.tradeIds.includes(id))) return;
        if (trades.length !== ids.length || new Set(trades.map(t => t.id)).size !== ids.length ||
          trades.some(t => !ids.includes(t.id) || !(t.transactionHash?.trim() || t.status === 'FAILED'))) return;
        const units = (value: unknown) => {
          if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2}0*)?$/.test(value)) throw new Error('Invalid shares');
          const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
        };
        if (trades.reduce((n, t) => n + units(t.size), 0n) !== units(details.sizeMatched)) return;
      }
      const balances = await scope.ctf.getPositionBalanceByTokenIds(scope.market.conditionId,
        { yesTokenId: scope.market.upTokenId, noTokenId: scope.market.downTokenId });
      const held = token === scope.market.upTokenId ? balances.yesBalance
        : token === scope.market.downTokenId ? balances.noBalance : undefined;
      if (typeof held !== 'string' || !/^0(?:\.0+)?$/.test(held) || [...this.clobLifecycles.values()].some(r => r.wallet === wallet &&
        r.tokenIds.includes(token) && !initialRecords.has(r))) return;
      if (this.inventoryWallet(scope.trading.getAddress()) !== wallet || this.inventoryWallet(scope.ctf.getAddress()) !== wallet) return;
      for (const record of records) this.clobLifecycles.delete(record.operationId);
      for (const leg of [scope.round.leg1, scope.round.leg2]) {
        if (leg?.tokenId === token) this.closedInventoryLegs.add(leg);
      }
    } catch { /* Insufficient facts retain protection. */ }
  }

  // Configuration
  private config: DipArbConfigInternal;
  private autoRotateConfig: Required<DipArbAutoRotateConfig>;

  // State
  private market: DipArbMarketConfig | null = null;
  private currentRound: DipArbRoundState | null = null;
  private isRunning = false;
  private readonly executionOwners = new Set<symbol>();
  private get isExecuting(): boolean { return this.executionOwners.size > 0; }
  private lastExecutionTime = 0;
  private stats: DipArbStats;

  // Subscriptions
  private marketSubscription: MarketSubscription | null = null;
  private chainlinkSubscription: Subscription | null = null;

  // Auto-rotate state
  private rotateCheckInterval: ReturnType<typeof setInterval> | null = null;
  private nextMarket: DipArbMarketConfig | null = null;

  // Pending redemption state (for background redemption after market resolution)
  private pendingRedemptions: DipArbPendingRedemption[] = [];
  private redemptionFlight?: Promise<void>;
  private accountedRedeemTransactions = new Map<string, Readonly<DipArbSettleResult>>();
  private confirmedRedeemLifecycles = new WeakMap<DipArbRoundState, Map<string, DipArbPendingRedemption>>();
  private publicRedeemFlight?: Promise<DipArbSettleResult & DipArbInventoryDiagnostic>;
  private buyExecutions = new WeakMap<DipArbRoundState, Partial<Record<'leg1' | 'leg2', BuyExecution>>>();
  private buyEvidenceOwners = new Map<string, object>();
  private emergencySells = new WeakMap<object, { settlement: SellSettlement; entryCost?: number; accounted: boolean; result?: DipArbExecutionResult }>();
  private emergencyFlights = new WeakMap<object, Promise<DipArbExecutionResult | null>>();
  private sellSettlements = new WeakMap<DipArbRoundState, SellSettlement>();
  private sellEvidenceOwners = new Map<string, SellSettlementLeg>();
  private redeemCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Orderbook state
  private upAsks: Array<{ price: number; size: number }> = [];
  private downAsks: Array<{ price: number; size: number }> = [];

  // Price history for sliding window detection
  // Each entry: { timestamp: number, upAsk: number, downAsk: number }
  private priceHistory: Array<{ timestamp: number; upAsk: number; downAsk: number }> = [];
  private readonly MAX_HISTORY_LENGTH = 100;  // Keep last 100 price points

  // Price state
  private currentUnderlyingPrice = 0;
  private lastPriceUpdate = 0;

  // Signal state - prevent duplicate signals within same round
  private leg1SignalEmitted = false;
  private lastSignalTime = 0;


  // Smart logging state - reduce orderbook noise
  private lastOrderbookLogTime = 0;
  private readonly ORDERBOOK_LOG_INTERVAL_MS = 10000;  // Log orderbook every 10 seconds
  private orderbookBuffer: Array<{ timestamp: number; upAsk: number; downAsk: number; upDepth: number; downDepth: number }> = [];
  private readonly ORDERBOOK_BUFFER_SIZE = 50;  // Keep 5 seconds of data at ~10 updates/sec

  constructor(
    realtimeService: RealtimeServiceV2,
    tradingService: TradingService | null,
    marketService: MarketService,
    privateKey?: string,
    chainId: number = 137
  ) {
    super();

    this.realtimeService = realtimeService;
    this.tradingService = tradingService;
    this.marketService = marketService;


    // Initialize with default config
    this.config = { ...DEFAULT_DIP_ARB_CONFIG };

    this.autoRotateConfig = { ...DEFAULT_AUTO_ROTATE_CONFIG };
    this.stats = createDipArbInitialStats();

    // Initialize CTF if private key provided
    if (privateKey) {
      this.ctf = new CTFClient({
        privateKey,
        rpcUrl: resolvePolygonRpcUrl(),
        chainId,
      });
    }
  }

  /** Read only order-attributed BUY quantities; balances are never a fill fallback. */
  private async reconcileLegShares(operation: BuyExecution): Promise<{ shares: number; terminal: boolean; cost?: number; price?: number }> {
    const scope = operation.scope!;
    let terminal = operation.orders.length > 0;
    for (const order of operation.orders) {
      if (order.rejected) continue;
      if (!order.orderId) { terminal = false; continue; }
      try {
        const wallet = this.inventoryWallet(scope.wallet ?? '');
        if (this.inventoryWallet(scope.trading.getAddress()) !== wallet) throw new Error('BUY wallet changed');
        const key = `${wallet}:order:${order.orderId}`;
        const owner = this.buyEvidenceOwners.get(key);
        if (owner && owner !== order) throw new Error('BUY order reused');
        this.buyEvidenceOwners.set(key, order);
        const details = await scope.trading.getOrderFillDetails(order.orderId);
        if (details.id !== order.orderId || details.asset_id !== operation.signal.tokenId || details.side !== 'BUY') throw new Error('BUY order identity unavailable');
        for (const id of details.tradeIds) order.ids.add(id);
        const ids = [...order.ids];
        if (!ids.length || ids.some(id => typeof id !== 'string' || !id.trim() || !details.tradeIds.includes(id))) throw new Error('BUY children incomplete');
        const unique = new Map<string, TradeStatus>();
        const conflictingIds = new Set<string>();
        for (const row of await scope.trading.getTradeStatuses(ids)) {
          const prior = unique.get(row.id);
          if (prior && JSON.stringify({ ...prior, transactionHash: prior.transactionHash?.toLowerCase() }) !==
              JSON.stringify({ ...row, transactionHash: row.transactionHash?.toLowerCase() })) conflictingIds.add(row.id);
          unique.set(row.id, row);
        }
        let attributed = 0n;
        let allTerminal = unique.size === ids.length && conflictingIds.size === 0 && [...unique.keys()].every(id => ids.includes(id));
        const staged = new Map(order.facts);
        for (const trade of unique.values()) {
          try {
            if (!ids.includes(trade.id) || conflictingIds.has(trade.id)) throw new Error('Unproven BUY child');
            if (!Array.isArray(trade.maker_orders) || !trade.taker_order_id) throw new Error('BUY association unavailable');
            const makers = trade.maker_orders.filter(m => m.order_id === order.orderId);
            let size: string | undefined, price: string | undefined;
            if (trade.taker_order_id === order.orderId) {
              if (trade.trader_side !== 'TAKER' || makers.length || trade.asset_id !== operation.signal.tokenId || trade.side !== 'BUY') throw new Error('Contradictory BUY taker');
              size = trade.size; price = trade.price;
            } else {
              if (trade.trader_side !== 'MAKER' || makers.length !== 1) throw new Error('Ambiguous BUY maker');
              const maker = makers[0];
              if (maker.asset_id !== operation.signal.tokenId || (maker.side !== undefined && maker.side !== 'BUY') ||
                  !trade.asset_id || !['BUY', 'SELL'].includes(trade.side ?? '') ||
                  (trade.asset_id === operation.signal.tokenId && trade.side !== 'SELL')) throw new Error('Contradictory BUY maker');
              size = maker.matched_amount; price = maker.price;
              if (this.sellUnits(size) > this.sellUnits(trade.size)) throw new Error('BUY maker exceeds trade');
            }
            const units = this.sellUnits(size); attributed += units;
            const confirmed = ['MINED', 'CONFIRMED'].includes(trade.status) &&
              typeof trade.transactionHash === 'string' && /^0x[0-9a-f]{64}$/i.test(trade.transactionHash);
            if (!confirmed) {
              if (staged.has(trade.id)) throw new Error('BUY fact contradicted');
              if (trade.status !== 'FAILED' || trade.transactionHash?.trim()) allTerminal = false;
              continue;
            }
            if (units <= 0n) throw new Error('Invalid BUY quantity');
            const fact = { units, hash: trade.transactionHash!.toLowerCase() }, prior = staged.get(trade.id);
            const tradeKey = `${wallet}:trade:${trade.id}`;
            if ((prior && (prior.units !== units || prior.hash !== fact.hash)) ||
                (this.buyEvidenceOwners.has(tradeKey) && this.buyEvidenceOwners.get(tradeKey) !== order)) throw new Error('Conflicting BUY fact');
            let priceUnits: bigint | undefined;
            try {
              priceUnits = this.sellUnits(price, 18);
              if (priceUnits <= 0n || priceUnits > 10n ** 18n) priceUnits = undefined;
            } catch { /* Quantity remains factual when price is unknown. */ }
            if (priceUnits === undefined || (prior?.price !== undefined && prior.price !== priceUnits)) allTerminal = false;
            staged.set(trade.id, { ...fact, price: prior?.price ?? priceUnits });
          } catch { allTerminal = false; } // One invalid child does not erase valid siblings.
        }
        // Matched volume is a completeness check, never a source of shares.
        try { if (attributed !== this.sellUnits(details.sizeMatched)) allTerminal = false; }
        catch { allTerminal = false; }
        if (this.inventoryWallet(scope.trading.getAddress()) !== wallet) throw new Error('BUY wallet changed');
        for (const id of staged.keys()) this.buyEvidenceOwners.set(`${wallet}:trade:${id}`, order);
        order.facts = staged; terminal = terminal && allTerminal;
      } catch { terminal = false; }
    }
    const units = operation.orders.reduce((sum, order) => sum + [...order.facts.values()].reduce((n, f) => n + f.units, 0n), 0n);
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) return { shares: 0, terminal: false };
    const facts = operation.orders.flatMap(order => [...order.facts.values()]);
    const shares = Number(ethers.utils.formatUnits(units.toString(), 6));
    if (!facts.length || facts.some(fact => fact.price === undefined)) return { shares, terminal: false };
    const costUnits = facts.reduce((sum, fact) => sum + fact.units * fact.price!, 0n);
    const cost = Number(ethers.utils.formatUnits(costUnits.toString(), 24));
    return { shares, terminal, cost, price: units > 0n ? Number(ethers.utils.formatUnits((costUnits / units).toString(), 18)) : undefined };
  }

  private async submitBuyLeg(operation: BuyExecution, scope: ClobScope, writer: 'LEG1' | 'LEG2',
    splitCount: number, amount: number, price: number): Promise<void> {
    if (operation.submitted) return;
    operation.scope = { ...scope, market: { ...scope.market }, wallet: this.clobWalletSnapshot(scope.trading) };
    operation.submitted = true; // Claim before transport, including ambiguous exceptions.
    for (let i = 0; i < splitCount; i++) {
      const order: BuyExecution['orders'][number] = { ids: new Set(), rejected: false, facts: new Map() };
      operation.orders.push(order);
      try {
        const result = await this.submitClob(scope, writer, { tokenId: operation.signal.tokenId, side: 'BUY', amount, price, orderType: 'FOK' });
        order.rejected = result.submissionState === 'REJECTED';
        if (!order.rejected && typeof result.orderId === 'string' && result.orderId.trim()) order.orderId = result.orderId.trim();
        for (const id of result.tradeIds ?? []) order.ids.add(id);
        if (order.rejected || result.submissionState === 'UNCERTAIN' || !order.orderId) break;
      } catch (error) {
        if (error instanceof InventoryAdmissionRefusal) {
          operation.orders.pop(); // No submission took place.
          if (!operation.orders.length) { operation.submitted = false; throw error; }
          operation.interruption = Object.freeze({ status: 'BLOCKED_INVENTORY', reason: error.message });
          this.inventoryBlocked({}, error);
        }
        break;
      }
      if (i < splitCount - 1 && this.config.orderIntervalMs > 0) await new Promise(resolve => setTimeout(resolve, this.config.orderIntervalMs));
    }
  }

  private async executeBuyLeg(kind: 'leg1' | 'leg2', signal: DipArbLeg1Signal | DipArbLeg2Signal, publishExecution = false): Promise<DipArbExecutionResult & DipArbInventoryDiagnostic> {
    const round = this.currentRound;
    if (!round || signal.roundId !== round.roundId) {

      const result = { success: false, leg: kind, roundId: signal.roundId, error: 'Stale BUY round', executionTimeMs: 0 };
      return this.inventoryAdmissionGuard ? this.inventoryBlocked(result, new InventoryAdmissionRefusal(result.error)) : result;
    }
    let operations = this.buyExecutions.get(round);
    if (!operations) { operations = {}; this.buyExecutions.set(round, operations); }
    if (kind === 'leg2' && operations.leg1 && !operations.leg1.result) {

      return { success: false, leg: kind, roundId: signal.roundId, error: 'BUY_PENDING: Leg1 unresolved', executionTimeMs: 0 };
    }
    let operation = operations[kind];
    if (!operation) { operation = { signal: { ...signal }, submitted: false, orders: [] }; operations[kind] = operation; }
    operation.publishExecution ||= publishExecution;
    if (operation.result) return { ...operation.result };
    if (!operation.flight) {
      const captured = operation;
      let resolve!: (result: DipArbExecutionResult & DipArbInventoryDiagnostic) => void;
      let reject!: (error: unknown) => void;
      operation.flight = new Promise((yes, no) => { resolve = yes; reject = no; });
      const owner = Symbol();
      this.executionOwners.add(owner);
      const run = kind === 'leg1' ? this.executeLeg1Attempt(captured.signal as DipArbLeg1Signal, captured)
        : this.executeLeg2Attempt(captured.signal as DipArbLeg2Signal, captured);
      void run.then(result => {
        if (result.success && captured.publishExecution && !captured.executionEmitted) {
          captured.executionEmitted = true; // Claim before listeners, including reentrant/throwing listeners.
          this.emit('execution', result);
        }
        return result;
      }).then(resolve, reject).finally(() => this.executionOwners.delete(owner));
    }
    const flight = operation.flight;
    try { return { ...await flight }; }
    finally { if (operation.flight === flight) operation.flight = undefined; }
  }

  // ===== Public API: Configuration =====

  /**
   * Update configuration
   */
  updateConfig(config: Partial<DipArbServiceConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
    this.log(`Config updated: ${JSON.stringify(config)}`);
  }

  /**
   * Get current configuration
   */
  getConfig(): DipArbConfigInternal {
    return { ...this.config };
  }

  // ===== Public API: Market Discovery =====

  /**
   * Scan for upcoming UP/DOWN markets
   *
   * Uses MarketService.scanCryptoShortTermMarkets()
   */
  async scanUpcomingMarkets(options: DipArbScanOptions = {}): Promise<DipArbMarketConfig[]> {
    const {
      coin = 'all',
      duration = 'all',
      minMinutesUntilEnd = 5,
      maxMinutesUntilEnd = 60,
      limit = 20,
    } = options;

    try {
      const gammaMarkets = await this.marketService.scanCryptoShortTermMarkets({
        coin: coin as 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'all',
        duration: duration as '5m' | '15m' | 'all',
        minMinutesUntilEnd,
        maxMinutesUntilEnd,
        limit,
        sortBy: 'endDate',
      });

      // Get full market info with token IDs for each market
      const results: DipArbMarketConfig[] = [];

      for (const gm of gammaMarkets) {
        // Retry up to 3 times for network errors
        let retries = 3;
        while (retries > 0) {
          try {
            // Get full market info from CLOB API via MarketService
            const market = await this.marketService.getMarket(gm.conditionId);

            // Find UP and DOWN tokens
            const upToken = market.tokens.find(t =>
              t.outcome.toLowerCase() === 'up' || t.outcome.toLowerCase() === 'yes'
            );
            const downToken = market.tokens.find(t =>
              t.outcome.toLowerCase() === 'down' || t.outcome.toLowerCase() === 'no'
            );

            if (upToken?.tokenId && downToken?.tokenId) {
              results.push({
                name: gm.question,
                slug: gm.slug,
                conditionId: gm.conditionId,
                upTokenId: upToken.tokenId,
                downTokenId: downToken.tokenId,
                negRisk: market.negRisk,
                underlying: parseUnderlyingFromSlug(gm.slug),
                durationMinutes: parseDurationFromSlug(gm.slug),
                endTime: gm.endDate,
              });
            }
            break; // Success, exit retry loop
          } catch (error) {
            retries--;
            if (retries > 0) {
              // Wait 1 second before retry
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }
      }

      return results;
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  /**
   * Find the best market and start monitoring
   */
  async findAndStart(options: DipArbFindAndStartOptions = {}): Promise<DipArbMarketConfig | null> {
    const { coin, preferDuration = '15m' } = options;

    const scanOptions: DipArbScanOptions = {
      coin: coin || 'all',
      duration: preferDuration,
      minMinutesUntilEnd: 10,
      maxMinutesUntilEnd: 60,
      limit: 10,
    };

    const markets = await this.scanUpcomingMarkets(scanOptions);

    if (markets.length === 0) {
      this.log('No suitable markets found');
      return null;
    }

    // Find the best market (prefer specified coin, then by time)
    let bestMarket = markets[0];
    if (coin) {
      const coinMarket = markets.find(m => m.underlying === coin);
      if (coinMarket) {
        bestMarket = coinMarket;
      }
    }

    await this.start(bestMarket);
    return bestMarket;
  }

  // ===== Public API: Lifecycle =====

  /**
   * Start monitoring a market
   */
  async start(market: DipArbMarketConfig): Promise<void> {
    if (this.isRunning) {
      throw new Error('DipArbService is already running. Call stop() first.');
    }

    // Validate token IDs
    if (!market.upTokenId || !market.downTokenId) {
      throw new Error(`Invalid market config: missing token IDs. upTokenId=${market.upTokenId}, downTokenId=${market.downTokenId}`);
    }

    this.market = market;
    this.isRunning = true;
    this.stats = createDipArbInitialStats();
    this.priceHistory = [];  // Clear price history for new market

    this.log(`Starting Dip Arb monitor for: ${market.name}`);
    this.log(`Condition ID: ${market.conditionId.slice(0, 20)}...`);
    this.log(`Underlying: ${market.underlying}`);
    this.log(`Duration: ${market.durationMinutes}m`);
    this.log(`Auto Execute: ${this.config.autoExecute ? 'YES' : 'NO'}`);

    // Initialize trading service if available
    if (this.tradingService) {
      try {
        await this.tradingService.initialize();
        this.log(`Wallet: ${this.ctf?.getAddress()}`);
      } catch (error) {
        this.log(`Warning: Trading service init failed: ${error}`);
      }
    } else {
      this.log('No wallet configured - monitoring only');
    }

    // Connect realtime service and wait for connection
    this.realtimeService.connect();

    // Wait for WebSocket connection (with timeout)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.log('Warning: WebSocket connection timeout, proceeding anyway');
        resolve();
      }, 10000);

      // Check if already connected
      if (this.realtimeService.isConnected?.()) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      this.realtimeService.once('connected', () => {
        clearTimeout(timeout);
        this.log('WebSocket connected');
        resolve();
      });
    });

    // Subscribe to market orderbook
    this.log(`Subscribing to tokens: UP=${market.upTokenId.slice(0, 20)}..., DOWN=${market.downTokenId.slice(0, 20)}...`);
    this.marketSubscription = this.realtimeService.subscribeMarkets(
      [market.upTokenId, market.downTokenId],
      {
        onOrderbook: (book: OrderbookSnapshot) => {
          // Handle the orderbook update (always)
          this.handleOrderbookUpdate(book);

          // Smart logging: only log at intervals, not every update
          if (this.config.debug) {
            this.updateOrderbookBuffer(book);
            this.maybeLogOrderbookSummary();
          }
        },
        onError: (error: Error) => this.emit('error', error),
      }
    );

    // Subscribe to Chainlink prices for the underlying asset
    // Format: ETH -> ETH/USD
    const chainlinkSymbol = `${market.underlying}/USD`;
    console.log(`[DipArb] Subscribing to Chainlink prices: ${chainlinkSymbol}`);
    this.chainlinkSubscription = this.realtimeService.subscribeCryptoChainlinkPrices(
      [chainlinkSymbol],
      {
        onPrice: (price: CryptoPrice) => {
          this.log(`Received ${price.symbol} Price: $${price.price.toFixed(2)}`); // Use this.log for consistency
          this.handleChainlinkPriceUpdate(price);
        },
      }
    );

    // Heartbeat to reassure user
    setInterval(() => {
      if (this.isRunning) {
        const lastPrice = this.currentUnderlyingPrice > 0 ? this.currentUnderlyingPrice.toFixed(2) : 'Waiting';
        const timeSinceUpdate = this.lastPriceUpdate > 0 ? Math.round((Date.now() - this.lastPriceUpdate) / 1000) + 's ago' : 'Never';
        this.log(`💓 Monitoring active. Last Price: $${lastPrice} (${timeSinceUpdate})`);
      }
    }, 60000);

    // ✅ FIX: Check and merge existing pairs at startup
    if (this.ctf && this.config.autoMerge) {
      await this.scanAndMergeExistingPairs();
    }

    this.emit('started', market);
    this.log('Monitoring for dip arbitrage opportunities...');
  }

  /**
   * ✅ FIX: Scan and merge existing UP/DOWN pairs at startup
   *
   * When the service starts or rotates to a new market, check if there are
   * existing UP + DOWN token pairs from previous sessions and merge them.
   */
  private async scanAndMergeExistingPairs(): Promise<void> {
    if (!this.ctf || !this.market) return;
    const scope = this.captureCtfScope(this.market, this.currentRound, true);

    try {
      const tokenIds = {
        yesTokenId: scope.market.upTokenId,
        noTokenId: scope.market.downTokenId,
      };

      const balances = await scope.ctf.getPositionBalanceByTokenIds(
        scope.market.conditionId,
        tokenIds
      );

      const upBalance = parseFloat(balances.yesBalance);
      const downBalance = parseFloat(balances.noBalance);

      // Calculate how many pairs can be merged
      const pairsToMerge = Math.min(upBalance, downBalance);

      if (pairsToMerge > 0.01) {  // Minimum 0.01 to avoid dust
        this.log(`🔍 Found existing pairs: UP=${upBalance.toFixed(2)}, DOWN=${downBalance.toFixed(2)}`);
        this.log(`🔄 Auto-merging ${pairsToMerge.toFixed(2)} pairs at startup...`);

        try {
          const result = await this.writeCtf(scope, 'MERGE', pairsToMerge.toString());

          if (result.success) {
            this.log(`✅ Startup merge successful: ${pairsToMerge.toFixed(2)} pairs → $${result.usdcReceived || pairsToMerge.toFixed(2)} pUSD`);
            this.log(`   TxHash: ${result.txHash?.slice(0, 20)}...`);
          } else {
            this.log(`❌ Startup merge failed`);
          }
        } catch (mergeError) {
          if (mergeError instanceof InventoryAdmissionRefusal) { this.inventoryBlocked({}, mergeError); return; }
          this.log(`❌ Startup merge error: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`);
        }
      } else if (upBalance > 0 || downBalance > 0) {
        // Has tokens but not enough pairs to merge
        this.log(`📊 Existing positions: UP=${upBalance.toFixed(2)}, DOWN=${downBalance.toFixed(2)} (no pairs to merge)`);
      }
    } catch (error) {
      this.log(`Warning: Failed to scan existing pairs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Stop rotate check
    this.stopRotateCheck();

    // Unsubscribe
    if (this.marketSubscription) {
      this.marketSubscription.unsubscribe();
      this.marketSubscription = null;
    }

    if (this.chainlinkSubscription) {
      this.chainlinkSubscription.unsubscribe();
      this.chainlinkSubscription = null;
    }

    // Update stats
    this.stats.runningTimeMs = Date.now() - this.stats.startTime;

    this.log('Stopped');
    this.log(`Rounds monitored: ${this.stats.roundsMonitored}`);
    this.log(`Rounds completed: ${this.stats.roundsSuccessful}`);
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
   * Get current market
   */
  getMarket(): DipArbMarketConfig | null {
    return this.market;
  }

  // ===== Public API: State Access =====

  /**
   * Get statistics
   */
  getStats(): DipArbStats {
    return {
      ...this.stats,
      runningTimeMs: this.isRunning ? Date.now() - this.stats.startTime : this.stats.runningTimeMs,
      currentRound: this.currentRound ? {
        roundId: this.currentRound.roundId,
        phase: this.currentRound.phase,
        priceToBeat: this.currentRound.priceToBeat,
        leg1: this.currentRound.leg1 && this.currentRound.leg1.shares > 0
          ? { side: this.currentRound.leg1.side, tokenId: this.currentRound.leg1.tokenId,
              shares: this.currentRound.leg1.shares, price: this.currentRound.leg1.price, cost: this.currentRound.leg1.cost } : undefined,
        leg2: this.currentRound.leg2 && this.currentRound.leg2.shares > 0
          ? { side: this.currentRound.leg2.side, tokenId: this.currentRound.leg2.tokenId,
              shares: this.currentRound.leg2.shares, price: this.currentRound.leg2.price, cost: this.currentRound.leg2.cost } : undefined,
      } : undefined,
    };
  }

  /**
   * Get current round state
   */
  getCurrentRound(): DipArbRoundState | null {
    return this.currentRound ? { ...this.currentRound } : null;
  }

  /**
   * Get current price to beat
   */
  getPriceToBeat(): number | null {
    return this.currentRound?.priceToBeat ?? null;
  }

  // ===== Public API: Manual Execution =====

  /**
   * Execute Leg1 trade
   */
  async executeLeg1(signal: DipArbLeg1Signal): Promise<DipArbExecutionResult & DipArbInventoryDiagnostic> {
    return this.executeBuyLeg('leg1', signal);
  }

  private async executeLeg1Attempt(signal: DipArbLeg1Signal, operation: BuyExecution): Promise<DipArbExecutionResult & DipArbInventoryDiagnostic> {
    const originMarket = this.market, round = this.currentRound, trading = this.tradingService, ctf = this.ctf;
    const guard = this.inventoryAdmissionGuard, running = this.isRunning, invocation = Symbol();
    const market = guard && originMarket ? { ...originMarket } : originMarket;
    const wallet = guard ? this.clobWalletSnapshot(trading) : undefined;
    if (guard) signal = { ...signal };
    const startTime = Date.now();

    if (!trading || !market || !round) {

      return {
        success: false,
        leg: 'leg1',
        roundId: signal.roundId,
        error: 'Trading service not available or no active round',
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Audit #4: risk gate on the exposure-opening leg only. Leg2 hedges and
    // emergency exits bypass it — blocking an exit can only increase risk.
    const blockReason = !operation.submitted && this.config.preExecutionGuard?.({
      strategy: 'dipArb',
      side: 'BUY',
      usdcAmount: signal.shares * signal.targetPrice,
      marketKey: market.conditionId,
    });
    if (blockReason) {

      return {
        success: false,
        leg: 'leg1',
        roundId: signal.roundId,
        error: `Blocked by risk guard: ${blockReason}`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      if (guard && signal.roundId !== round.roundId) throw new InventoryAdmissionRefusal('Stale round signal');


      // 计算拆分订单参数
      const splitCount = Math.max(1, this.config.splitOrders);

      // 🔴 FIXED: Enforce minimum trade value to ensure exit capability
      const MIN_TRADE_VALUE = 1.5;  // $1.50 (50% buffer above Polymarket's $1 minimum)
      const minSharesForMinValue = Math.ceil(MIN_TRADE_VALUE / signal.targetPrice);
      const adjustedShares = Math.max(signal.shares, minSharesForMinValue);

      // Calculate total trade value
      const totalTradeValue = adjustedShares * signal.targetPrice;

      // Reject if still below minimum (should never happen after adjustment, but safety check)
      if (totalTradeValue < MIN_TRADE_VALUE) {
        this.log(`❌ Trade value $${totalTradeValue.toFixed(2)} below minimum $${MIN_TRADE_VALUE}`);
        this.log(`   Price: ${signal.targetPrice.toFixed(4)}, Shares: ${adjustedShares}`);
        return {
          success: false,
          leg: 'leg1',
          roundId: signal.roundId,
          error: `Trade value $${totalTradeValue.toFixed(2)} below minimum $${MIN_TRADE_VALUE} - cannot guarantee exit`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      if (adjustedShares > signal.shares) {
        this.log(`📊 Shares adjusted: ${signal.shares} → ${adjustedShares} (to meet $${MIN_TRADE_VALUE} minimum at price ${signal.targetPrice.toFixed(4)})`);
      }

      const sharesPerOrder = adjustedShares / splitCount;
      const amountPerOrder = sharesPerOrder * signal.targetPrice;

      await this.submitBuyLeg(operation, { originMarket: originMarket!, wallet, market: market!, round: round!, trading: trading!, ctf, guard, running, invocation }, 'LEG1', splitCount, amountPerOrder, signal.targetPrice);
      const factual = await this.reconcileLegShares(operation);
      const totalSharesFilled = factual.shares;
      const totalAmountSpent = factual.cost;
      const lastOrderId = operation.orders[operation.orders.length - 1]?.orderId;
      const failedOrders = operation.orders.filter(order => order.rejected).length;
      const inventoryInterruption = operation.interruption;
      const current = round === this.currentRound && originMarket === this.market &&
        operation.scope?.round === round && operation.scope.originMarket === originMarket &&
        operation.scope.trading === this.tradingService && operation.scope.market.upTokenId === market.upTokenId &&
        operation.scope.market.downTokenId === market.downTokenId && operation.scope.market.conditionId === market.conditionId;
      const ready = current && factual.terminal && totalAmountSpent !== undefined && factual.price !== undefined && totalSharesFilled >= adjustedShares;
      if (!ready) {
        if (totalSharesFilled > 0) {
          const partial = round.leg1;
          if (partial && partial.tokenId === signal.tokenId) { partial.shares = totalSharesFilled; partial.price = factual.price; partial.cost = factual.cost; }
          else round.leg1 = { side: signal.dipSide, price: factual.price, cost: factual.cost,
            shares: totalSharesFilled, timestamp: Date.now(), tokenId: signal.tokenId };
        }
        return { success: false, leg: 'leg1', roundId: signal.roundId, shares: totalSharesFilled, price: factual.price, cost: factual.cost,
          orderId: lastOrderId, ...(inventoryInterruption ? { inventoryInterruption } : {}), error: 'BUY_PENDING: factual quantity incomplete', executionTimeMs: Date.now() - startTime };
      }

      // 至少有一笔成功
      if (totalSharesFilled > 0) {
        const avgPrice = factual.price!;

        // Record leg1 fill
        round.leg1 = {
          side: signal.dipSide,
          price: avgPrice,
          cost: totalAmountSpent,
          shares: totalSharesFilled,
          timestamp: Date.now(),
          tokenId: signal.tokenId,
        };
        round.phase = 'leg1_filled';
        operation.result = { success: true, leg: 'leg1', roundId: signal.roundId,
          side: signal.dipSide, price: avgPrice, cost: totalAmountSpent, shares: totalSharesFilled, orderId: lastOrderId,
          ...(inventoryInterruption ? { inventoryInterruption } : {}), executionTimeMs: Date.now() - startTime };
        this.stats.leg1Filled++;

        this.lastExecutionTime = Date.now();

        // Detailed execution logging (uses reconciled actual fill price)
        const actualPrice = avgPrice;
        const slippage = ((actualPrice - signal.currentPrice) / signal.currentPrice * 100);
        const execTimeMs = Date.now() - startTime;

        this.log(`✅ Leg1 FILLED: ${signal.dipSide} x${totalSharesFilled.toFixed(1)} @ ${actualPrice.toFixed(4)}`);
        this.log(`   Expected: ${signal.currentPrice.toFixed(4)} | Actual: ${actualPrice.toFixed(4)} | Slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}%`);
        this.log(`   Execution time: ${execTimeMs}ms | Orders: ${splitCount - failedOrders}/${splitCount}`);

        // Log orderbook after execution
        if (this.config.debug) {
          this.logOrderbookContext('Post-Leg1');
        }

        return {
          success: true,
          ...(inventoryInterruption ? { inventoryInterruption } : {}),
          leg: 'leg1',
          roundId: signal.roundId,
          side: signal.dipSide,
          price: actualPrice,
          cost: totalAmountSpent,
          shares: totalSharesFilled,
          orderId: lastOrderId,
          executionTimeMs: execTimeMs,
        };
      } else {
        return {
          success: false,
          leg: 'leg1',
          roundId: signal.roundId,
          error: 'All orders failed',
          executionTimeMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      if (error instanceof InventoryAdmissionRefusal) return this.inventoryBlocked({ success: false, leg: 'leg1' as const, roundId: round!.roundId, error: error.message, executionTimeMs: Date.now() - startTime }, error);
      return {
        success: false,
        leg: 'leg1',
        roundId: signal.roundId,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute Leg2 trade
   */
  async executeLeg2(signal: DipArbLeg2Signal): Promise<DipArbExecutionResult & DipArbInventoryDiagnostic> {
    return this.executeBuyLeg('leg2', signal);
  }

  private async executeLeg2Attempt(signal: DipArbLeg2Signal, operation: BuyExecution): Promise<DipArbExecutionResult & DipArbInventoryDiagnostic> {
    const originMarket = this.market, round = this.currentRound, trading = this.tradingService, ctf = this.ctf;
    const guard = this.inventoryAdmissionGuard, running = this.isRunning, invocation = Symbol();
    const market = guard && originMarket ? { ...originMarket } : originMarket;
    const wallet = guard ? this.clobWalletSnapshot(trading) : undefined;
    if (guard) signal = { ...signal };
    const startTime = Date.now();

    if (!trading || !market || !round) {

      return {
        success: false,
        leg: 'leg2',
        roundId: signal.roundId,
        error: 'Trading service not available or no active round',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      if (guard && signal.roundId !== round.roundId) throw new InventoryAdmissionRefusal('Stale round signal');


      // 计算拆分订单参数
      const splitCount = Math.max(1, this.config.splitOrders);

      // 机制保证：确保满足 $1 最低限额
      const minSharesForMinAmount = Math.ceil(1 / signal.targetPrice);
      const adjustedShares = Math.max(signal.shares, minSharesForMinAmount);

      if (adjustedShares > signal.shares) {
        this.log(`📊 Leg2 Shares adjusted: ${signal.shares} → ${adjustedShares} (to meet $1 minimum at price ${signal.targetPrice.toFixed(4)})`);
      }

      const sharesPerOrder = adjustedShares / splitCount;
      const amountPerOrder = sharesPerOrder * signal.targetPrice;

      await this.submitBuyLeg(operation, { originMarket: originMarket!, wallet, market: market!, round: round!, trading: trading!, ctf, guard, running, invocation }, 'LEG2', splitCount, amountPerOrder, signal.targetPrice);
      const factual = await this.reconcileLegShares(operation);
      const totalSharesFilled = factual.shares;
      const totalAmountSpent = factual.cost;
      const lastOrderId = operation.orders[operation.orders.length - 1]?.orderId;
      const failedOrders = operation.orders.filter(order => order.rejected).length;
      const inventoryInterruption = operation.interruption;
      const current = round === this.currentRound && originMarket === this.market &&
        operation.scope?.round === round && operation.scope.originMarket === originMarket &&
        operation.scope.trading === this.tradingService && operation.scope.market.upTokenId === market.upTokenId &&
        operation.scope.market.downTokenId === market.downTokenId && operation.scope.market.conditionId === market.conditionId;
      const ready = current && factual.terminal && totalAmountSpent !== undefined && factual.price !== undefined && totalSharesFilled >= adjustedShares && totalSharesFilled === round.leg1?.shares && round.leg1.price !== undefined;
      if (!ready) {
        if (totalSharesFilled > 0) {
          const partial = round.leg2;
          if (partial && partial.tokenId === signal.tokenId) { partial.shares = totalSharesFilled; partial.price = factual.price; partial.cost = factual.cost; }
          else round.leg2 = { side: signal.hedgeSide, price: factual.price, cost: factual.cost,
            shares: totalSharesFilled, timestamp: Date.now(), tokenId: signal.tokenId };
        }
        return { success: false, leg: 'leg2', roundId: signal.roundId, shares: totalSharesFilled, price: factual.price, cost: factual.cost,
          orderId: lastOrderId, ...(inventoryInterruption ? { inventoryInterruption } : {}), error: 'BUY_PENDING: factual quantity incomplete', executionTimeMs: Date.now() - startTime };
      }

      // 至少有一笔成功
      if (totalSharesFilled > 0) {
        const avgPrice = factual.price!;
        const leg1Price = round.leg1!.price!;
        const actualTotalCost = leg1Price + avgPrice;

        // Record leg2 fill
        round.leg2 = {
          side: signal.hedgeSide,
          price: avgPrice,
          cost: totalAmountSpent,
          shares: totalSharesFilled,
          timestamp: Date.now(),
          tokenId: signal.tokenId,
        };
        round.phase = 'completed';
        operation.result = { success: true, leg: 'leg2', roundId: signal.roundId,
          side: signal.hedgeSide, price: avgPrice, cost: totalAmountSpent, shares: totalSharesFilled, orderId: lastOrderId,
          ...(inventoryInterruption ? { inventoryInterruption } : {}), executionTimeMs: Date.now() - startTime };
        round.totalCost = actualTotalCost;
        // Two factual BUY legs prove shares, prices and cost of the paired
        // position. They do not prove realized collateral: the $1 pair payout
        // only exists once a merge or redeem is factually confirmed, so no
        // realized profit is booked or published here.

        const pairedBuyCost = (round.leg1?.cost ?? leg1Price * totalSharesFilled) + totalAmountSpent;
        this.stats.leg2Filled++;
        this.stats.roundsSuccessful++;
        this.stats.totalSpent += pairedBuyCost;

        this.lastExecutionTime = Date.now();

        // Detailed execution logging
        const slippage = ((avgPrice - signal.currentPrice) / signal.currentPrice * 100);
        const execTimeMs = Date.now() - startTime;

        this.log(`✅ Leg2 FILLED: ${signal.hedgeSide} x${totalSharesFilled.toFixed(1)} @ ${avgPrice.toFixed(4)}`);
        this.log(`   Expected: ${signal.currentPrice.toFixed(4)} | Actual: ${avgPrice.toFixed(4)} | Slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}%`);
        this.log(`   Leg1: ${leg1Price.toFixed(4)} + Leg2: ${avgPrice.toFixed(4)} = ${actualTotalCost.toFixed(4)} per pair`);
        this.log(`   Paired: ${totalSharesFilled.toFixed(1)} shares | Factual BUY cost: $${pairedBuyCost.toFixed(2)} | Realized profit: unknown until merge/redeem is confirmed`);
        this.log(`   Execution time: ${execTimeMs}ms | Orders: ${splitCount - failedOrders}/${splitCount}`);

        // Log orderbook after execution
        if (this.config.debug) {
          this.logOrderbookContext('Post-Leg2');
        }

        const roundResult: DipArbRoundResult = {
          roundId: signal.roundId,
          status: 'completed',
          leg1: round.leg1,
          leg2: round.leg2,
          totalCost: round.totalCost,
          // profit / profitRate are withheld: the pair is formed but not settled.
          merged: false,
        };

        this.emit('roundComplete', roundResult);

        // Auto merge if enabled
        if (this.config.autoMerge && (!guard || (round === this.currentRound && originMarket === this.market))) {
          const mergeResult = await this.merge();
          roundResult.merged = mergeResult.success;
          roundResult.mergeTxHash = mergeResult.txHash;
        }

        return {
          success: true,
          ...(inventoryInterruption ? { inventoryInterruption } : {}),
          leg: 'leg2',
          roundId: signal.roundId,
          side: signal.hedgeSide,
          price: avgPrice,
          cost: totalAmountSpent,
          shares: totalSharesFilled,
          orderId: lastOrderId,
          executionTimeMs: Date.now() - startTime,
        };
      } else {
        return {
          success: false,
          leg: 'leg2',
          roundId: signal.roundId,
          error: 'All orders failed',
          executionTimeMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      if (error instanceof InventoryAdmissionRefusal) return this.inventoryBlocked({ success: false, leg: 'leg2' as const, roundId: round!.roundId, error: error.message, executionTimeMs: Date.now() - startTime }, error);
      return {
        success: false,
        leg: 'leg2',
        roundId: signal.roundId,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Merge UP + DOWN tokens to USDC.e
   *
   * Uses mergeByTokenIds with Polymarket token IDs for correct CLOB market handling.
   * This locks in profit immediately after Leg2 completes.
   */
  async merge(): Promise<DipArbExecutionResult & DipArbInventoryDiagnostic> {
    const startTime = Date.now();
    const roundId = this.currentRound?.roundId || 'unknown';

    if (!this.ctf || !this.market || !this.currentRound) {
      return {
        success: false,
        leg: 'merge',
        roundId,
        error: 'CTF client not available or no completed round',
        executionTimeMs: Date.now() - startTime,
      };
    }

    const scope = this.captureCtfScope(this.market, this.currentRound, true);
    // Merge the minimum of Leg1 and Leg2 shares (should be equal after our fix).
    // Reconcile against on-chain balances first so we never attempt to merge
    // more pairs than are actually held (PROBLEMS.md #10).
    let shares = Math.min(
      this.currentRound.leg1?.shares || 0,
      this.currentRound.leg2?.shares || 0
    );

    try {
      const positions = await scope.ctf.getPositionBalanceByTokenIds(
        scope.market.conditionId,
        { yesTokenId: scope.market.upTokenId, noTokenId: scope.market.downTokenId }
      );
      const heldPairs = Math.min(
        parseFloat(positions.yesBalance) || 0,
        parseFloat(positions.noBalance) || 0
      );
      if (heldPairs > 0 && heldPairs + 1e-9 < shares) {
        this.log(`⚠️ Merge clamped: recorded ${shares.toFixed(2)} pairs but on-chain holds ${heldPairs.toFixed(2)} — merging actual`);
        shares = Math.floor(heldPairs * 1e6) / 1e6;
      }
    } catch {
      // Fall back to recorded shares when the chain is unreachable.
    }

    if (shares <= 0) {
      return {
        success: false,
        leg: 'merge',
        roundId,
        error: 'No shares to merge',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      this.log(`🔄 Merging ${shares.toFixed(1)} UP + DOWN → pUSD...`);

      const result = await this.writeCtf(scope, 'MERGE', shares.toString());

      if (result.success) {
        this.log(`✅ Merge successful: ${shares.toFixed(1)} pairs → $${result.usdcReceived || shares.toFixed(2)} pUSD`);
        this.log(`   TxHash: ${result.txHash?.slice(0, 20)}...`);
      }

      return {
        success: result.success,
        leg: 'merge',
        roundId,
        shares,
        txHash: result.txHash,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      if (error instanceof InventoryAdmissionRefusal) return this.inventoryBlocked({ success: false, leg: 'merge' as const,
        roundId, error: error.message, executionTimeMs: Date.now() - startTime }, error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`❌ Merge failed: ${errorMsg}`);
      return {
        success: false,
        leg: 'merge',
        roundId,
        error: errorMsg,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  // ===== Private: Event Handlers =====

  private handleOrderbookUpdate(book: OrderbookSnapshot): void {
    if (!this.market) return;

    // Determine which side this update is for
    const tokenId = book.tokenId;
    const isUpToken = tokenId === this.market.upTokenId;
    const isDownToken = tokenId === this.market.downTokenId;

    // OrderbookLevel has price and size as numbers
    if (isUpToken) {
      this.upAsks = book.asks.map(l => ({ price: l.price, size: l.size }));
    } else if (isDownToken) {
      this.downAsks = book.asks.map(l => ({ price: l.price, size: l.size }));
    }

    // Record price history for sliding window detection
    this.recordPriceHistory();

    // Emit orderbookUpdate event for dashboard
    const upPrice = this.upAsks[0]?.price ?? 0;
    const downPrice = this.downAsks[0]?.price ?? 0;
    this.emit('orderbookUpdate', { upPrice, downPrice, sum: upPrice + downPrice });

    // Log orderbook summary at intervals
    this.maybeLogOrderbookSummary();

    // Service accepted BUYs even when the original signal no longer exists.
    // A pending operation blocks normal phase processing, never resubmits.
    const buys = this.currentRound && this.buyExecutions.get(this.currentRound);
    const kind = buys?.leg1?.submitted && !buys.leg1.result ? 'leg1'
      : buys?.leg2?.submitted && !buys.leg2.result ? 'leg2' : undefined;
    if (kind && buys) {
      const pending = buys[kind]!;
      if (!pending.flight) void this.executeBuyLeg(kind, pending.signal, true).catch(error => this.emit('error', error));
      return;
    }

    // Check if we need to start a new round (async but fire-and-forget to not block orderbook updates)
    this.checkAndStartNewRound().catch(err => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    // Skip signal detection entirely if already executing (prevents duplicate detection logs)
    if (this.isExecuting) {
      return;
    }

    // Detect signals
    const signal = this.detectSignal();
    if (signal) {
      this.handleSignal(signal);
    }
  }

  /**
   * Record current prices to history buffer for sliding window detection
   */
  private recordPriceHistory(): void {
    const upAsk = this.upAsks[0]?.price ?? 0;
    const downAsk = this.downAsks[0]?.price ?? 0;

    // Only record if we have valid prices
    if (upAsk <= 0 || downAsk <= 0) return;

    this.priceHistory.push({
      timestamp: Date.now(),
      upAsk,
      downAsk,
    });

    // Trim history to max length
    if (this.priceHistory.length > this.MAX_HISTORY_LENGTH) {
      this.priceHistory = this.priceHistory.slice(-this.MAX_HISTORY_LENGTH);
    }
  }

  /**
   * Get price from N milliseconds ago for sliding window detection
   *
   * @param side - 'UP' or 'DOWN'
   * @param msAgo - Milliseconds ago (e.g., 3000 for 3 seconds)
   * @returns Price from that time, or null if not available
   */
  private getPriceFromHistory(side: 'UP' | 'DOWN', msAgo: number): number | null {
    const targetTime = Date.now() - msAgo;

    // Find the closest price point at or before targetTime
    for (let i = this.priceHistory.length - 1; i >= 0; i--) {
      const entry = this.priceHistory[i];
      if (entry.timestamp <= targetTime) {
        return side === 'UP' ? entry.upAsk : entry.downAsk;
      }
    }

    return null;
  }

  private handleChainlinkPriceUpdate(price: CryptoPrice): void {
    if (!this.market) return;

    // Only handle updates for our underlying (symbol format: ETH/USD)
    const expectedSymbol = `${this.market.underlying}/USD`;
    if (price.symbol !== expectedSymbol) return;

    if (this.config.debug) {
      this.log(`Chainlink price update: ${price.symbol} = $${price.price.toFixed(2)}`);
    }

    this.currentUnderlyingPrice = price.price;
    this.lastPriceUpdate = Date.now();

    // Emit price update event
    if (this.currentRound) {
      const event: DipArbPriceUpdateEvent = {
        underlying: this.market.underlying,
        value: price.price,
        priceToBeat: this.currentRound.priceToBeat,
        changePercent: this.currentRound.priceToBeat > 0
          ? ((price.price - this.currentRound.priceToBeat) / this.currentRound.priceToBeat) * 100
          : 0,
      };
      this.emit('priceUpdate', event);
    }
  }

  // ===== Private: Round Management =====

  private async checkAndStartNewRound(): Promise<void> {
    // Existing orderbook cycle also services lifecycles whose original round has ended.
    if (this.clobLifecycles.size) await this.reconcileProtectedClobLifecycles();
    if (!this.market) return;

    // If no current round or current round is completed/expired, start new round
    if (!this.currentRound || this.currentRound.phase === 'completed' || this.currentRound.phase === 'expired') {
      // Check if market is still active
      if (new Date() >= this.market.endTime) {
        // Always log market end (not just in debug mode)
        if (!this.currentRound) {
          console.log('[DipArb] Market has ended before round could start');
        }
        return;
      }

      // Get current prices
      const upPrice = this.upAsks[0]?.price ?? 0.5;
      const downPrice = this.downAsks[0]?.price ?? 0.5;

      // Use current underlying price as price to beat (or fallback to 0)
      const priceToBeat = this.currentUnderlyingPrice || 0;

      // Create new round
      const roundId = `${this.market.slug}-${Date.now()}`;
      this.currentRound = createDipArbRoundState(
        roundId,
        priceToBeat,
        upPrice,
        downPrice,
        this.market.durationMinutes
      );

      // Clear price history for new round - we only want to detect instant drops within this round
      this.priceHistory = [];

      // Reset signal state for new round
      this.leg1SignalEmitted = false;

      this.stats.roundsMonitored++;

      const event: DipArbNewRoundEvent = {
        roundId,
        priceToBeat,
        upOpen: upPrice,
        downOpen: downPrice,
        startTime: this.currentRound.startTime,
        endTime: this.currentRound.endTime,
      };

      this.emit('newRound', event);
      this.log(`New round: ${roundId}, Price to Beat: ${priceToBeat.toFixed(2)}`);
    }

    // Check for round expiration - exit Leg1 if Leg2 times out.
    // Also stop out early when the Leg1 position has decayed beyond
    // stopLossPct, so we exit while the position is still sellable instead
    // of waiting until it is sub-$1 dust (PROBLEMS.md #4).
    if (this.currentRound && this.currentRound.phase === 'leg1_filled' && this.currentRound.leg1) {
      const leg1 = this.currentRound.leg1;
      const elapsed = (Date.now() - (leg1.timestamp || this.currentRound.startTime)) / 1000;
      const leg1Bid = leg1.side === 'UP'
        ? (this.upAsks[0]?.price ?? null)
        : (this.downAsks[0]?.price ?? null);
      const stopHit = leg1.price !== undefined && leg1Bid !== null
        && leg1.price > 0
        && (leg1.price - leg1Bid) / leg1.price >= this.config.stopLossPct;
      if (stopHit) {
        this.log(`🛑 Stop-loss: ${leg1.side} ${leg1.price!.toFixed(4)} → ${leg1Bid!.toFixed(4)} (≥${(this.config.stopLossPct * 100).toFixed(0)}% down), exiting unhedged Leg1...`);
      }
      if (stopHit || elapsed > this.config.leg2TimeoutSeconds) {
        if (!stopHit) {
          // ✅ FIX: Exit Leg1 position to avoid unhedged exposure
          this.log(`⚠️ Leg2 timeout (${elapsed.toFixed(0)}s > ${this.config.leg2TimeoutSeconds}s), exiting Leg1 position...`);
        }

        // Try to sell Leg1 position
        const expiringRound = this.currentRound;
        const expiringMarket = this.market;
        const exitResult = await this.emergencyExitLeg1();
        if (isInventoryRefusal(exitResult)) return;

        // Only the captured round's factual terminal exit can complete it.
        // Keep pending/failure reconciliable, and claim terminality before emitting
        // so concurrent checks and throwing/reentrant listeners cannot replay it.
        if (!exitResult?.success || exitResult.sellState !== 'COMPLETE' || exitResult.residual !== 0 ||
            this.currentRound !== expiringRound || this.market !== expiringMarket ||
            expiringRound.leg1 !== leg1 || expiringRound.phase !== 'leg1_filled') return;
        expiringRound.phase = 'expired';
        this.stats.roundsExpired++;
        this.stats.roundsCompleted++;

        const result: DipArbRoundResult = {
          roundId: expiringRound.roundId,
          status: 'expired',
          leg1: expiringRound.leg1,
          merged: false,
          exitResult,  // Include exit result for tracking
        };

        this.emit('roundComplete', result);
        this.log(`Round expired: ${expiringRound.roundId} | Exit: ${exitResult?.success ? 'SUCCESS' : 'FAILED'}`);
      }
    }
  }

  /**
   * Emergency exit Leg1 position when Leg2 times out
   * Sells the Leg1 tokens at market price to avoid unhedged exposure
   */
  private async emergencyExitLeg1(): Promise<DipArbExecutionResult | null> {
    const round = this.currentRound;
    if (!round) return null;
    const prior = this.emergencyFlights.get(round);
    if (prior) return prior;
    const flight = this.runEmergencyExitLeg1();
    this.emergencyFlights.set(round, flight);
    try { return await flight; }
    finally { if (this.emergencyFlights.get(round) === flight) this.emergencyFlights.delete(round); }
  }

  private async reconcileEmergencySell(leg1: NonNullable<DipArbRoundState['leg1']>): Promise<DipArbExecutionResult> {
    const attempt = this.emergencySells.get(leg1)!;
    if (attempt.result) return this.sameSellComposition(attempt.settlement.composition,
      this.captureSellComposition(attempt.settlement.scope.round)) && this.currentRound === attempt.settlement.scope.round &&
      this.market === attempt.settlement.scope.originMarket ? { ...attempt.result } :
      { ...attempt.result, success: false, sellState: 'PENDING', profit: undefined };
    const { settlement } = attempt;
    const result = await this.reconcileSellSettlement(settlement);
    const fact = result.sellLegs?.[0];
    const unchanged = this.currentRound === settlement.scope.round && this.market === settlement.scope.originMarket &&
      this.sameSellComposition(settlement.composition, this.captureSellComposition(settlement.scope.round));
    // Update only the captured position, only when both attributed fills and balance agree.
    if (unchanged && fact?.realizedShares !== undefined && fact.residual !== undefined &&
        (fact.residual > 0 || result.success) &&
        this.sellUnits(String(fact.realizedShares)) + this.sellUnits(String(fact.residual)) ===
          this.sellUnits(String(fact.requestedShares))) {
      leg1.shares = fact.residual;
      if (attempt.entryCost !== undefined) leg1.cost = attempt.entryCost * fact.residual / fact.requestedShares;
      settlement.composition = this.captureSellComposition(settlement.scope.round);
    }
    const output: DipArbExecutionResult = { success: result.success && unchanged, leg: 'exit',
      roundId: settlement.scope.round.roundId, side: leg1.side, orderId: fact?.orderId,
      shares: fact?.realizedShares, price: fact?.executionPrice, amountReceived: fact?.proceeds,
      residual: fact?.residual, profit: undefined, sellState: result.sellState, executionTimeMs: result.executionTimeMs };
    if (output.success && !attempt.accounted) {
      attempt.accounted = true;
      if (attempt.entryCost !== undefined && fact?.proceeds !== undefined) {
        output.profit = fact.proceeds - attempt.entryCost
          - estimateTakerFee(attempt.entryCost, this.config.feeRateBps)
          - estimateTakerFee(fact.proceeds, this.config.feeRateBps);
        this.stats.totalProfit += output.profit;
      }
      leg1.exitPending = false;
      attempt.result = { ...output };
      if (settlement.scope.guard) await this.releaseClobAfterExit(settlement.scope, leg1.tokenId);
      this.log(`Emergency SELL confirmed: ${output.shares} shares, proceeds ${output.amountReceived}`);
    }
    return output;
  }

  /** Retry only an explicitly canceled, never-matched order with no trade history.
   * CLOB cancellation kills the unfilled remainder, not previously matched trades.
   * Missing enumeration is UNKNOWN; known failed children are not an empty history.
   */
  private async emergencySellCanRetry(leg1: NonNullable<DipArbRoundState['leg1']>): Promise<boolean> {
    const prior = this.emergencySells.get(leg1);
    if (!prior || prior.accounted) return false;
    const { scope, legs } = prior.settlement, leg = legs[0];
    if (!leg.orderId || leg.facts.size || leg.tradeIds.size || leg1.exitTradeIds?.length) return false;
    const records = [...this.clobLifecycles.values()].filter(r => r.round === scope.round &&
      r.writerType === 'EMERGENCY_EXIT' && r.tokenIds.includes(leg.tokenId));
    if (records.some(r => r.tradeIds.length || r.orderId !== leg.orderId)) return false;
    const unchanged = () => this.emergencySells.get(leg1) === prior && this.currentRound === scope.round &&
      this.market === scope.originMarket && this.sameSellComposition(prior.settlement.composition,
        this.captureSellComposition(scope.round)) && this.inventoryWallet(scope.trading.getAddress()) ===
        this.inventoryWallet(scope.wallet ?? '');
    try {
      if (!unchanged()) return false;
      const order = await scope.trading.getOrderFillDetails(leg.orderId);
      // Retain every newly discovered child even when terminality cannot be proved.
      if (Array.isArray(order.tradeIds)) for (const id of order.tradeIds) leg.tradeIds.add(id);
      if (order.id !== leg.orderId || order.asset_id !== leg.tokenId || order.side !== 'SELL' ||
          order.status !== 'CANCELED' || order.tradeEnumerationPresent !== true ||
          !Array.isArray(order.tradeIds) || order.tradeIds.length || leg.tradeIds.size ||
          this.sellUnits(order.sizeMatched) !== 0n || !scope.ctf) return false;
      if (this.inventoryWallet(scope.ctf.getAddress()) !== this.inventoryWallet(scope.wallet ?? '')) return false;
      const balances = await scope.ctf.getPositionBalanceByTokenIds(scope.market.conditionId,
        { yesTokenId: scope.market.upTokenId, noTokenId: scope.market.downTokenId });
      const balance = this.sellUnits(leg.tokenId === scope.market.upTokenId ? balances.yesBalance : balances.noBalance);
      return unchanged() && !leg.facts.size && !leg.tradeIds.size && !leg1.exitTradeIds?.length &&
        !records.some(r => r.tradeIds.length) &&
        this.inventoryWallet(scope.ctf.getAddress()) === this.inventoryWallet(scope.wallet ?? '') &&
        balance === this.sellUnits(String(leg.requestedShares));
    } catch { return false; }
  }

  private async runEmergencyExitLeg1(): Promise<DipArbExecutionResult | null> {
    const originMarket = this.market, round = this.currentRound, trading = this.tradingService, ctf = this.ctf;
    const guard = this.inventoryAdmissionGuard, running = this.isRunning, invocation = Symbol();
    const market = originMarket ? { ...originMarket } : originMarket;
    const wallet = this.clobWalletSnapshot(trading);
    if (!trading || !market || !round?.leg1) {
      this.log('Cannot exit Leg1: no trading service or position');
      return null;
    }

    const leg1 = round.leg1;
    const composition = this.captureSellComposition(round);
    const completed = this.emergencySells.get(leg1)?.result;
    if (completed) return this.reconcileEmergencySell(leg1);
    const legToken = leg1.tokenId, legSide = leg1.side;
    const startTime = Date.now();
    const DUST_EPSILON = 0.001;
    let validateRetry: (() => void) | undefined;
    let retireRetry: (() => void) | undefined;
    const retryPrior = this.emergencySells.get(leg1);
    const retiringIds = new Set<string>();

    try {
      // UNKNOWN retains the same attempt. Failed known children never prove order terminality.
      if (leg1.exitPending) {
        if (!(await this.emergencySellCanRetry(leg1))) {
          if (this.emergencySells.has(leg1)) return this.reconcileEmergencySell(leg1);
          return { success: false, leg: 'exit', roundId: round.roundId,
            error: 'Prior SELL pending settlement', executionTimeMs: Date.now() - startTime };
        }
        const prior = this.emergencySells.get(leg1)!;
        const identity = Object.freeze({ round, roundId: round.roundId, phase: round.phase,
          leg: leg1, side: leg1.side, tokenId: leg1.tokenId, shares: leg1.shares,
          wallet, market: originMarket, conditionId: market.conditionId,
          upTokenId: market.upTokenId, downTokenId: market.downTokenId, trading, ctf, running, guard });
        const records = [...this.clobLifecycles.entries()].filter(([, record]) =>
          record.round === round && record.writerType === 'EMERGENCY_EXIT' &&
          record.orderId === prior.settlement.legs[0].orderId && record.wallet === this.inventoryWallet(wallet ?? ''));
        for (const [id] of records) retiringIds.add(id);
        validateRetry = () => {
          if (this.currentRound !== identity.round || round.roundId !== identity.roundId || round.phase !== identity.phase ||
              round.leg1 !== identity.leg || leg1.side !== identity.side || leg1.tokenId !== identity.tokenId ||
              leg1.shares !== identity.shares || this.market !== identity.market ||
              this.market?.conditionId !== identity.conditionId || this.market?.upTokenId !== identity.upTokenId ||
              this.market?.downTokenId !== identity.downTokenId || this.tradingService !== identity.trading ||
              this.ctf !== identity.ctf || this.isRunning !== identity.running || this.inventoryAdmissionGuard !== identity.guard ||
              this.inventoryWallet(this.clobWalletSnapshot(trading)) !== this.inventoryWallet(identity.wallet) ||
              this.inventoryWallet(ctf?.getAddress() ?? '') !== this.inventoryWallet(identity.wallet) ||
              this.emergencySells.get(leg1) !== prior ||
              !this.sameSellComposition(composition, this.captureSellComposition(round)) ||
              records.some(([id, record]) => this.clobLifecycles.get(id) !== record || record.tradeIds.length)) {
            throw new InventoryAdmissionRefusal('Emergency retry identity changed before submission');
          }
        };
        retireRetry = () => {
          validateRetry!();
          for (const [id] of records) this.clobLifecycles.delete(id);
          this.emergencySells.delete(leg1);
          leg1.exitTradeIds = undefined;
          leg1.exitSubmitPrice = undefined;
          leg1.exitSubmitShares = undefined;
        };
      }

      // ---- PRE-SUBMIT: read CTF balance as single source of truth ----
      let currentBalance = leg1.shares; // fallback when CTF unavailable
      if (ctf) {
        try {
          const pos = await ctf.getPositionBalanceByTokenIds(
            market.conditionId,
            { yesTokenId: market.upTokenId, noTokenId: market.downTokenId }
          );
          const held = legSide === 'UP'
            ? parseFloat(pos.yesBalance)
            : parseFloat(pos.noBalance);
          if (!Number.isFinite(held)) {
            this.log('⚠️ CTF balance read failed — cannot verify position, refusing to SELL');
            return { success: false, leg: 'exit', roundId: round.roundId,
              error: 'CTF balance read failed', executionTimeMs: Date.now() - startTime };
          }
          currentBalance = held;
        } catch {
          this.log('⚠️ CTF balance query failed — cannot verify position, refusing to SELL');
          return { success: false, leg: 'exit', roundId: round.roundId,
            error: 'CTF balance query failed', executionTimeMs: Date.now() - startTime };
        }
      }

      validateRetry?.();
      if (retireRetry && currentBalance !== leg1.shares) {
        throw new InventoryAdmissionRefusal('Emergency retry quantity changed before submission');
      }
      if (currentBalance <= DUST_EPSILON) return { success: false, leg: 'exit', roundId: round.roundId,
        error: 'No attributed SELL fills; zero balance alone cannot confirm an exit', executionTimeMs: Date.now() - startTime };
      // ---- FRESH SELL using current on-chain balance ----
      const exitAmount = currentBalance;
      const currentPrice = legSide === 'UP'
        ? (this.upAsks[0]?.price ?? 0.5)
        : (this.downAsks[0]?.price ?? 0.5);
      const exitValue = exitAmount * currentPrice;

      if (exitValue < 1) {
        this.log(`⚠️ Exit value ($${exitValue.toFixed(2)}) below $1 minimum — stuck dust; will attempt merge/redeem at expiry`);
        this.emit('dustStuck', { roundId: round.roundId, side: legSide,
          shares: leg1.shares, tokenId: legToken, exitValue });
        return { success: false, leg: 'exit', roundId: round.roundId,
          error: `Exit value ($${exitValue.toFixed(2)}) below Polymarket minimum ($1) — stuck dust`, executionTimeMs: Date.now() - startTime };
      }

      this.log(`Selling ${exitAmount.toFixed(2)} ${legSide} tokens...`);
      const exitFloor = currentPrice * (1 - this.config.maxSlippage);
      const scope: ClobScope = { originMarket: originMarket!, wallet,
        market: { ...market }, round, trading, ctf, guard, running, invocation };
      const settlement: SellSettlement = { scope, emitted: false, composition,
        legs: [{ tokenId: legToken, requestedShares: exitAmount, attempted: true, rejected: false,
          tradeIds: new Set(), facts: new Map(), observed: false, completeEvidence: false }] };
      const installAttempt = () => {
        retireRetry?.();
        this.emergencySells.set(leg1, { settlement, entryCost: typeof leg1.cost === 'number' &&
          Number.isFinite(leg1.cost) && leg1.cost >= 0 && exitAmount === leg1.shares ? leg1.cost : undefined, accounted: false });
        leg1.exitPending = true;
      };
      if (!retireRetry) installAttempt();
      const result = await this.submitClob(scope, 'EMERGENCY_EXIT', {
        tokenId: legToken, side: 'SELL' as Side, amount: exitAmount, price: exitFloor, orderType: 'FOK' },
        retireRetry ? { retiringIds, commit: installAttempt } : undefined);
      if (result.submissionState === 'REJECTED') {
        this.emergencySells.delete(leg1);
        leg1.exitPending = false;
        return { success: false, leg: 'exit', roundId: round.roundId,
          error: result.errorMsg, executionTimeMs: Date.now() - startTime };
      }
      const factual = settlement.legs[0];
      factual.orderId = typeof result.orderId === 'string' && result.orderId.trim() ? result.orderId.trim() : undefined;
      factual.tradeIds = new Set(result.tradeIds ?? []);
      leg1.exitTradeIds = result.tradeIds ?? [];
      this.log('Emergency SELL submitted — awaiting attributed factual fills');
      return await this.reconcileEmergencySell(leg1);
    } catch (error) {
      if (error instanceof InventoryAdmissionRefusal) {
        if (retryPrior && this.emergencySells.get(leg1) === retryPrior) {
          return { success: false, leg: 'exit', roundId: round.roundId, sellState: 'PENDING',
            error: error.message, executionTimeMs: Date.now() - startTime };
        }
        this.emergencySells.delete(leg1); leg1.exitPending = false;
        return this.inventoryBlocked({ success: false, leg: 'exit' as const, roundId: round!.roundId, error: error.message, executionTimeMs: Date.now() - startTime }, error);
      }
      this.log(`❌ Leg1 exit error: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, leg: 'exit', roundId: round.roundId,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime };
    }
  }

  // ===== Private: Signal Detection =====

  private detectSignal(): DipArbSignal | null {
    if (!this.currentRound || !this.market) return null;

    // Check based on current phase
    if (this.currentRound.phase === 'waiting') {
      return this.detectLeg1Signal();
    } else if (this.currentRound.phase === 'leg1_filled') {
      return this.detectLeg2Signal();
    }

    return null;
  }

  private detectLeg1Signal(): DipArbLeg1Signal | null {
    if (!this.currentRound || !this.market) return null;

    // Check if within trading window (轮次开始后的交易窗口)
    const elapsed = (Date.now() - this.currentRound.startTime) / 60000;
    if (elapsed > this.config.windowMinutes) {
      return null;
    }

    const upPrice = this.upAsks[0]?.price ?? 1;
    const downPrice = this.downAsks[0]?.price ?? 1;
    const { openPrices } = this.currentRound;

    // Skip if no valid prices
    if (upPrice >= 1 || downPrice >= 1 || openPrices.up <= 0 || openPrices.down <= 0) {
      return null;
    }

    // ========================================
    // Pattern 1: Instant Dip Detection (核心策略)
    // ========================================
    // 检测 slidingWindowMs (默认 3 秒) 内的瞬时暴跌
    // 这是策略的核心！我们捕捉的是"情绪性暴跌"，不是趋势

    const upPriceAgo = this.getPriceFromHistory('UP', this.config.slidingWindowMs);
    const downPriceAgo = this.getPriceFromHistory('DOWN', this.config.slidingWindowMs);

    // UP instant dip: 3秒内暴跌 >= dipThreshold
    if (upPriceAgo !== null && upPriceAgo > 0) {
      const upInstantDrop = (upPriceAgo - upPrice) / upPriceAgo;
      if (upInstantDrop >= this.config.dipThreshold) {
        if (this.config.debug) {
          this.log(`⚡ Instant DIP detected! UP: ${upPriceAgo.toFixed(4)} → ${upPrice.toFixed(4)} = -${(upInstantDrop * 100).toFixed(1)}% in ${this.config.slidingWindowMs}ms`);
        }
        const signal = this.createLeg1Signal('UP', upPrice, downPrice, 'dip', upInstantDrop, upPriceAgo);
        if (signal && this.validateSignalProfitability(signal)) {
          return signal;
        }
      }
    }

    // DOWN instant dip: 3秒内暴跌 >= dipThreshold
    if (downPriceAgo !== null && downPriceAgo > 0) {
      const downInstantDrop = (downPriceAgo - downPrice) / downPriceAgo;
      if (downInstantDrop >= this.config.dipThreshold) {
        if (this.config.debug) {
          this.log(`⚡ Instant DIP detected! DOWN: ${downPriceAgo.toFixed(4)} → ${downPrice.toFixed(4)} = -${(downInstantDrop * 100).toFixed(1)}% in ${this.config.slidingWindowMs}ms`);
        }
        const signal = this.createLeg1Signal('DOWN', downPrice, upPrice, 'dip', downInstantDrop, downPriceAgo);
        if (signal && this.validateSignalProfitability(signal)) {
          return signal;
        }
      }
    }

    // ========================================
    // Pattern 2: Surge Detection (if enabled)
    // ========================================
    // 暴涨检测：当 token 价格暴涨时，买入对手 token
    if (this.config.enableSurge && upPriceAgo !== null && downPriceAgo !== null) {
      // UP surged in sliding window, buy DOWN
      if (upPriceAgo > 0) {
        const upSurge = (upPrice - upPriceAgo) / upPriceAgo;
        if (upSurge >= this.config.surgeThreshold) {
          if (this.config.debug) {
            this.log(`⚡ Instant SURGE detected! UP: ${upPriceAgo.toFixed(4)} → ${upPrice.toFixed(4)} = +${(upSurge * 100).toFixed(1)}% in ${this.config.slidingWindowMs}ms`);
          }
          // 买入 DOWN，参考价格是 DOWN 的历史价格
          const signal = this.createLeg1Signal('DOWN', downPrice, upPrice, 'surge', upSurge, downPriceAgo);
          if (signal && this.validateSignalProfitability(signal)) {
            return signal;
          }
        }
      }

      // DOWN surged in sliding window, buy UP
      if (downPriceAgo > 0) {
        const downSurge = (downPrice - downPriceAgo) / downPriceAgo;
        if (downSurge >= this.config.surgeThreshold) {
          if (this.config.debug) {
            this.log(`⚡ Instant SURGE detected! DOWN: ${downPriceAgo.toFixed(4)} → ${downPrice.toFixed(4)} = +${(downSurge * 100).toFixed(1)}% in ${this.config.slidingWindowMs}ms`);
          }
          // 买入 UP，参考价格是 UP 的历史价格
          const signal = this.createLeg1Signal('UP', upPrice, downPrice, 'surge', downSurge, upPriceAgo);
          if (signal && this.validateSignalProfitability(signal)) {
            return signal;
          }
        }
      }
    }

    // ========================================
    // Pattern 3: Mispricing Detection
    // ========================================
    // 定价偏差：基于底层资产价格估计胜率，检测错误定价
    if (this.currentRound.priceToBeat > 0 && this.currentUnderlyingPrice > 0) {
      const estimatedWinRate = estimateUpWinRate(this.currentUnderlyingPrice, this.currentRound.priceToBeat);
      const upMispricing = detectMispricing(upPrice, estimatedWinRate);
      const downMispricing = detectMispricing(downPrice, 1 - estimatedWinRate);

      // UP is underpriced
      if (upMispricing >= this.config.dipThreshold) {
        const signal = this.createLeg1Signal('UP', upPrice, downPrice, 'mispricing', upMispricing);
        if (signal && this.validateSignalProfitability(signal)) {
          return signal;
        }
      }

      // DOWN is underpriced
      if (downMispricing >= this.config.dipThreshold) {
        const signal = this.createLeg1Signal('DOWN', downPrice, upPrice, 'mispricing', downMispricing);
        if (signal && this.validateSignalProfitability(signal)) {
          return signal;
        }
      }
    }

    return null;
  }

  private createLeg1Signal(
    side: DipArbSide,
    price: number,
    oppositeAsk: number,
    source: 'dip' | 'surge' | 'mispricing',
    dropPercent: number,
    referencePrice?: number  // 用于 dip/surge: 滑动窗口前的价格
  ): DipArbLeg1Signal | null {
    if (!this.currentRound || !this.market) return null;

    const targetPrice = price * (1 + this.config.maxSlippage);
    // Fee-aware estimate (PROBLEMS.md #1): taker fees on both legs' notional
    // come out of the $1 payout, so include them before comparing to sumTarget.
    const grossEstimate = targetPrice + oppositeAsk;
    const estFee = estimateTakerFee(
      grossEstimate * this.config.shares,
      this.config.feeRateBps
    ) / this.config.shares;
    const estimatedTotalCost = grossEstimate + estFee;
    const estimatedProfitRate = calculateDipArbProfitRate(estimatedTotalCost);

    // openPrice: 对于 dip/surge 信号，使用滑动窗口参考价格；否则使用轮次开盘价
    const openPrice = referencePrice ??
      (side === 'UP' ? this.currentRound.openPrices.up : this.currentRound.openPrices.down);

    const signal: DipArbLeg1Signal = {
      type: 'leg1',
      roundId: this.currentRound.roundId,
      dipSide: side,
      currentPrice: price,
      openPrice,  // 参考价格（3秒前的价格或轮次开盘价）
      dropPercent,
      targetPrice,
      shares: this.config.shares,
      tokenId: side === 'UP' ? this.market.upTokenId : this.market.downTokenId,
      oppositeAsk,
      estimatedTotalCost,
      estimatedProfitRate,
      source,
    };

    // Add BTC info if available
    if (this.currentRound.priceToBeat > 0 && this.currentUnderlyingPrice > 0) {
      const btcChangePercent = ((this.currentUnderlyingPrice - this.currentRound.priceToBeat) / this.currentRound.priceToBeat) * 100;
      signal.btcInfo = {
        btcPrice: this.currentUnderlyingPrice,
        priceToBeat: this.currentRound.priceToBeat,
        btcChangePercent,
        estimatedWinRate: estimateUpWinRate(this.currentUnderlyingPrice, this.currentRound.priceToBeat),
      };
    }

    return signal;
  }

  private detectLeg2Signal(): DipArbLeg2Signal | null {
    if (!this.currentRound || !this.market || !this.currentRound.leg1) return null;

    const leg1 = this.currentRound.leg1;
    const hedgeSide: DipArbSide = leg1.side === 'UP' ? 'DOWN' : 'UP';
    const currentPrice = hedgeSide === 'UP' ? (this.upAsks[0]?.price ?? 1) : (this.downAsks[0]?.price ?? 1);

    if (currentPrice >= 1) return null;

    const targetPrice = currentPrice * (1 + this.config.maxSlippage);
    // Fee-aware hedge gate (PROBLEMS.md #1): totalCost must survive taker
    // fees before it counts as a hedgeable opportunity.
    if (leg1.price === undefined) return null;
    const grossCost = leg1.price + targetPrice;
    const hedgeFee = estimateTakerFee(
      grossCost * leg1.shares,
      this.config.feeRateBps
    ) / Math.max(leg1.shares, 1e-9);
    const totalCost = grossCost + hedgeFee;

    // Check if profitable - 只用 sumTarget 控制 (now fee-inclusive)
    if (totalCost > this.config.sumTarget) {
      // 每 5 秒输出一次等待日志，避免刷屏
      if (this.config.debug && Date.now() % 5000 < 100) {
        const profitRate = calculateDipArbProfitRate(totalCost);
        this.log(`⏳ Waiting Leg2: ${hedgeSide} @ ${currentPrice.toFixed(4)}, cost ${totalCost.toFixed(4)} > ${this.config.sumTarget}, profit ${(profitRate * 100).toFixed(1)}%`);
      }
      return null;
    }

    const expectedProfitRate = calculateDipArbProfitRate(totalCost);

    if (this.config.debug) {
      this.log(`✅ Leg2 signal found! ${hedgeSide} @ ${currentPrice.toFixed(4)}, totalCost ${totalCost.toFixed(4)}, profit ${(expectedProfitRate * 100).toFixed(2)}%`);
    }

    // ✅ FIX: Use leg1.shares instead of config.shares to ensure balanced hedge
    // This is critical - Leg2 must buy exactly the same shares as Leg1 to create a perfect hedge
    return {
      type: 'leg2',
      roundId: this.currentRound.roundId,
      hedgeSide,
      leg1,
      currentPrice,
      targetPrice,
      totalCost,
      expectedProfitRate,
      shares: leg1.shares,  // Must match Leg1 to ensure balanced hedge
      tokenId: hedgeSide === 'UP' ? this.market.upTokenId : this.market.downTokenId,
    };
  }

  private validateSignalProfitability(signal: DipArbLeg1Signal): boolean {
    // Leg1 验证：只检查跌幅是否足够大
    // 不在 Leg1 阶段检查 sumTarget，因为：
    // 1. Leg1 的目的是抄底，买入暴跌的一侧
    // 2. Leg2 会等待对侧价格下降后再买入
    // 3. sumTarget 应该在 Leg2 阶段检查

    // 只做基本验证：确保价格合理
    if (signal.currentPrice <= 0 || signal.currentPrice >= 1) {
      if (this.config.debug) {
        this.log(`❌ Signal rejected: invalid price ${signal.currentPrice.toFixed(4)}`);
      }
      return false;
    }

    // 确保跌幅达到阈值（这个已经在 detectLeg1Signal 中检查过，这里再确认一下）
    if (signal.dropPercent < this.config.dipThreshold) {
      if (this.config.debug) {
        this.log(`❌ Signal rejected: drop ${(signal.dropPercent * 100).toFixed(1)}% < threshold ${(this.config.dipThreshold * 100).toFixed(1)}%`);
      }
      return false;
    }

    if (this.config.debug) {
      this.log(`✅ Leg1 signal validated: ${signal.dipSide} @ ${signal.currentPrice.toFixed(4)}, drop ${(signal.dropPercent * 100).toFixed(1)}%`);
      this.log(`   (Leg2 will check sumTarget when opposite price drops)`);
    }

    return true;
  }

  // ===== Private: Signal Handling =====

  private async handleSignal(signal: DipArbSignal): Promise<void> {
    const now = Date.now();

    // Global cooldown to prevent spamming signals in any mode (Auto or Manual)
    if (now - this.lastSignalTime < this.config.executionCooldown) {
      if (this.config.debug) {
        // Only log skipped signals if we haven't logged one recently (avoid log spam too)
        // For now, just suppressing the log completely for 'skipped' to clean up the console
      }
      return;
    }

    this.lastSignalTime = now;

    // Check if we can execute before emitting signal
    // This prevents logging signals that won't be executed
    if (!this.config.autoExecute) {
      // Manual mode: always emit signal for user to decide
      this.stats.signalsDetected++;
      this.emit('signal', signal);

      if (this.config.debug) {
        if (isDipArbLeg1Signal(signal)) {
          this.log(`Signal: Leg1 ${signal.dipSide} @ ${signal.currentPrice.toFixed(4)} (${signal.source})`);
        } else {
          this.log(`Signal: Leg2 ${signal.hedgeSide} @ ${signal.currentPrice.toFixed(4)}`);
        }
      }
      return;
    }

    // Auto-execute mode: only emit and log if we will actually execute
    // Note: isExecuting is already checked in processOrderbook(), this is a safety guard
    if (this.isExecuting) {
      return;
    }

    // CRITICAL: Set isExecuting immediately to prevent duplicate signals from being processed
    // This must happen before any async operations or emit() calls


    const owner = Symbol();
    this.executionOwners.add(owner);
    try {
      // Will execute - now emit signal and log
      this.stats.signalsDetected++;
      this.emit('signal', signal);


      if (this.config.debug) {
        const signalType = isDipArbLeg1Signal(signal) ? 'Leg1' : 'Leg2';

        // Log orderbook context before execution (last 5 seconds of data)
        this.logOrderbookContext(`${signalType} Signal`);

        if (isDipArbLeg1Signal(signal)) {
          this.log(`🎯 Signal: Leg1 ${signal.dipSide} @ ${signal.currentPrice.toFixed(4)} (${signal.source})`);
          this.log(`   Target: ${signal.targetPrice.toFixed(4)} | Opposite: ${signal.oppositeAsk.toFixed(4)} | Est.Cost: ${signal.estimatedTotalCost.toFixed(4)}`);
        } else {
          this.log(`🎯 Signal: Leg2 ${signal.hedgeSide} @ ${signal.currentPrice.toFixed(4)}`);
          this.log(`   Target: ${signal.targetPrice.toFixed(4)} | TotalCost: ${signal.totalCost.toFixed(4)} | Profit: ${(signal.expectedProfitRate * 100).toFixed(2)}%`);
        }
      }

      // Execute
      let result: DipArbExecutionResult;

      if (isDipArbLeg1Signal(signal)) {
        result = await this.executeBuyLeg('leg1', signal, true);
      } else {
        result = await this.executeBuyLeg('leg2', signal, true);
      }

    } finally { this.executionOwners.delete(owner); }
  }

  // ===== Public API: Auto-Rotate =====

  /**
   * Configure and enable auto-rotate
   *
   * Auto-rotate 会自动：
   * 1. 监控当前市场到期时间
   * 2. 在市场结束前预加载下一个市场
   * 3. 市场结束时自动结算（redeem 或 sell）
   * 4. 无缝切换到下一个 15m 市场
   *
   * @example
   * ```typescript
   * sdk.dipArb.enableAutoRotate({
   *   underlyings: ['BTC', 'ETH'],
   *   duration: '15m',
   *   autoSettle: true,
   *   settleStrategy: 'redeem',
   * });
   * ```
   */
  enableAutoRotate(config: Partial<DipArbAutoRotateConfig> = {}): void {
    this.autoRotateConfig = {
      ...this.autoRotateConfig,
      ...config,
      enabled: true,
    };

    this.log(`Auto-rotate enabled: ${JSON.stringify(this.autoRotateConfig)}`);
    this.startRotateCheck();

    // Start background redemption check if using redeem strategy
    if (this.autoRotateConfig.settleStrategy === 'redeem') {
      this.startRedeemCheck();

      // ✅ FIX: Scan for existing redeemable positions at startup
      this.scanAndQueueRedeemablePositions().catch(err => {
        this.log(`Warning: Failed to scan redeemable positions: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /**
   * ✅ FIX: Scan for existing redeemable positions and add them to the queue
   *
   * This is called when auto-rotate is enabled to recover any positions
   * from previous sessions that can be redeemed.
   */
  private async scanAndQueueRedeemablePositions(): Promise<void> {
    if (!this.ctf) {
      this.log('Cannot scan redeemable positions: CTF client not available');
      return;
    }

    try {
      // Scan for recently ended markets of the configured underlyings
      const now = Date.now();
      const markets = await this.scanUpcomingMarkets({
        coin: this.autoRotateConfig.underlyings.length === 1
          ? this.autoRotateConfig.underlyings[0]
          : 'all',
        duration: this.autoRotateConfig.duration,
        minMinutesUntilEnd: -60,  // Include markets that ended up to 60 minutes ago
        maxMinutesUntilEnd: 0,    // Only ended markets
        limit: 20,
      });

      this.log(`🔍 Scanning ${markets.length} recently ended markets for redeemable positions...`);

      let foundCount = 0;
      for (const market of markets) {
        // Skip current market
        if (market.conditionId === this.market?.conditionId) continue;

        // Check if we have any position in this market
        try {
          const scope = this.captureCtfScope(market, market.conditionId === this.market?.conditionId ? this.currentRound : null);
          const tokenIds = {
            yesTokenId: market.upTokenId,
            noTokenId: market.downTokenId,
          };

          const balances = await scope.ctf.getPositionBalanceByTokenIds(
            scope.market.conditionId,
            tokenIds
          );

          const upBalance = parseFloat(balances.yesBalance);
          const downBalance = parseFloat(balances.noBalance);

          // If we have any tokens, check if market is resolved
          if (upBalance > 0.01 || downBalance > 0.01) {
            const resolution = await scope.ctf.getMarketResolution(scope.market.conditionId, this.toLifecycleRouting(scope.market));

            if (resolution.isResolved) {
              // Check if we have winning tokens
              const winningBalance = resolution.winningOutcome === 'YES' ? upBalance : downBalance;

              if (winningBalance > 0.01) {
                // Add to pending redemption queue
                const pending: DipArbPendingRedemption = {
                  market: scope.market,
                  round: {
                    roundId: `recovery-${market.slug}`,
                    priceToBeat: 0,
                    openPrices: { up: 0, down: 0 },
                    startTime: 0,
                    endTime: market.endTime.getTime(),
                    phase: 'completed',
                  },
                  marketEndTime: market.endTime.getTime(),
                  addedAt: now,
                  retryCount: 0,
                };

                this.pendingRedemptions.push(pending);
                foundCount++;
                this.log(`📌 Found redeemable: ${market.slug} | ${resolution.winningOutcome} won | Balance: ${winningBalance.toFixed(2)}`);
              }
            } else if (upBalance > 0.01 && downBalance > 0.01) {
              // Market not resolved but we have pairs - can merge
              const pairsToMerge = Math.min(upBalance, downBalance);
              this.log(`📌 Found mergeable pairs in ${market.slug}: ${pairsToMerge.toFixed(2)}`);

              // Try to merge immediately
              try {
                const result = await this.writeCtf(scope, 'MERGE', pairsToMerge.toString());
                if (result.success) {
                  this.log(`✅ Merged ${pairsToMerge.toFixed(2)} pairs from ${market.slug}`);
                }
              } catch (mergeErr) {
                if (mergeErr instanceof InventoryAdmissionRefusal) { this.inventoryBlocked({}, mergeErr); continue; }
                this.log(`⚠️ Failed to merge ${market.slug}: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
              }
            }
          }
        } catch (err) {
          // Skip this market on error
        }
      }

      if (foundCount > 0) {
        this.log(`✅ Found ${foundCount} redeemable positions, added to queue`);
      } else {
        this.log('No redeemable positions found');
      }
    } catch (error) {
      this.log(`Error scanning redeemable positions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Disable auto-rotate
   */
  disableAutoRotate(): void {
    this.autoRotateConfig.enabled = false;
    this.stopRotateCheck();
    this.stopRedeemCheck();
    this.log('Auto-rotate disabled');

    // Warn if there are pending redemptions
    if (this.pendingRedemptions.length > 0) {
      this.log(`Warning: ${this.pendingRedemptions.length} pending redemptions will not be processed`);
    }
  }

  /**
   * Get auto-rotate configuration
   */
  getAutoRotateConfig(): Required<DipArbAutoRotateConfig> {
    return { ...this.autoRotateConfig };
  }

  /**
   * Manually settle current position
   *
   * 结算策略：
   * - 'redeem': 等待市场结算后 redeem（需要等待结算完成）
   * - 'sell': 直接卖出 token（更快但可能有滑点）
   */
  async settle(strategy: 'redeem' | 'sell' = 'redeem'): Promise<DipArbSettleResult & DipArbInventoryDiagnostic> {
    const startTime = Date.now();

    if (!this.market || !this.currentRound) {
      return {
        success: false,
        strategy,
        error: 'No active market or round',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      if (strategy === 'redeem') {
        return await this.settleByRedeem();
      } else {
        return await this.settleBySell();
      }
    } catch (error) {
      return {
        success: false,
        strategy,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Manually rotate to next market
   */
  async rotateToNextMarket(): Promise<DipArbMarketConfig | null> {
    if (!this.autoRotateConfig.enabled) {
      this.log('Auto-rotate not enabled');
      return null;
    }

    // Find next market
    const nextMarket = await this.findNextMarket();
    if (!nextMarket) {
      this.log('No suitable next market found');
      return null;
    }

    // Stop current monitoring
    await this.stop();

    // Start new market
    await this.start(nextMarket);

    const event: DipArbRotateEvent = {
      previousMarket: this.market?.conditionId,
      newMarket: nextMarket.conditionId,
      reason: 'manual',
      timestamp: Date.now(),
    };
    this.emit('rotate', event);

    return nextMarket;
  }

  // ===== Private: Auto-Rotate Implementation =====

  private startRotateCheck(): void {
    if (this.rotateCheckInterval) {
      clearInterval(this.rotateCheckInterval);
    }

    // Check every 30 seconds
    this.rotateCheckInterval = setInterval(() => {
      this.checkRotation();
    }, 30000);

    // Also check immediately
    this.checkRotation();
  }

  private stopRotateCheck(): void {
    if (this.rotateCheckInterval) {
      clearInterval(this.rotateCheckInterval);
      this.rotateCheckInterval = null;
    }
  }

  // ===== Private: Pending Redemption Processing =====

  private startRedeemCheck(): void {
    if (this.redeemCheckInterval) {
      clearInterval(this.redeemCheckInterval);
    }

    const intervalMs = (this.autoRotateConfig.redeemRetryIntervalSeconds || 30) * 1000;

    // Check every 30 seconds (configurable)
    this.redeemCheckInterval = setInterval(() => {
      this.processPendingRedemptions();
    }, intervalMs);

    this.log(`Redeem check started (interval: ${intervalMs / 1000}s)`);
  }

  private stopRedeemCheck(): void {
    if (this.redeemCheckInterval) {
      clearInterval(this.redeemCheckInterval);
      this.redeemCheckInterval = null;
    }
  }

  /**
   * Add a position to pending redemption queue
   */
  private addPendingRedemption(market: DipArbMarketConfig, round: DipArbRoundState): void {
    const pending: DipArbPendingRedemption = {
      market,
      round,
      marketEndTime: market.endTime.getTime(),
      addedAt: Date.now(),
      retryCount: 0,
    };
    this.pendingRedemptions.push(pending);
    this.log(`Added pending redemption: ${market.slug} (queue size: ${this.pendingRedemptions.length})`);
  }

  /**
   * Process all pending redemptions
   * Called periodically by redeemCheckInterval
   */
  private async processPendingRedemptions(): Promise<void> {
    if (this.redemptionFlight || this.publicRedeemFlight) return;
    const flight = Promise.resolve().then(() => this.processPendingRedemptionsOnce());
    this.redemptionFlight = flight;
    try { await flight; }
    finally { if (this.redemptionFlight === flight) this.redemptionFlight = undefined; }
  }

  private removePendingRedemption(pending: DipArbPendingRedemption): void {
    const index = this.pendingRedemptions.indexOf(pending);
    if (index !== -1) this.pendingRedemptions.splice(index, 1);
  }

  private redeemLifecycleKey(market: DipArbMarketConfig): string {
    return JSON.stringify([market.conditionId, market.upTokenId, market.downTokenId]);
  }

  private confirmRedeem(pending: DipArbPendingRedemption, wallet: string, txHash: string, payout?: string): void {
    if (!this.pendingRedemptions.includes(pending)) return;
    Object.assign(pending, { state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: txHash, historicalWallet: wallet });
    let lifecycles = this.confirmedRedeemLifecycles.get(pending.round);
    if (!lifecycles) this.confirmedRedeemLifecycles.set(pending.round, lifecycles = new Map());
    lifecycles.set(this.redeemLifecycleKey(pending.market), pending);
    if (payout !== undefined) this.finalizeRedeem(pending, txHash, payout);
  }

  private confirmedRedeemResult(pending: DipArbPendingRedemption): DipArbSettleResult {
    if (pending.state !== 'CONFIRMED_PAYOUT_PENDING') throw new Error('Redeem is not confirmed');
    const finalized = this.accountedRedeemTransactions.get(pending.transactionHash.toLowerCase());
    if (finalized) return { ...finalized };
    return { success: false, strategy: 'redeem', market: pending.market, txHash: pending.transactionHash,
      amountReceived: undefined, error: 'CONFIRMED_PAYOUT_PENDING', executionTimeMs: 0 };
  }

  private finalizeRedeem(pending: DipArbPendingRedemption, txHash: string, payout: string): void {
    if (!this.pendingRedemptions.includes(pending)) return;
    const identity = txHash.toLowerCase();
    if (this.accountedRedeemTransactions.has(identity)) {
      this.removePendingRedemption(pending);
      return;
    }
    const amountReceived = parseFloat(payout);
    const result: DipArbSettleResult = { success: true, strategy: 'redeem', market: pending.market,
      txHash, amountReceived, executionTimeMs: 0 };
    this.stats.totalProfit += amountReceived;
    this.accountedRedeemTransactions.set(identity, Object.freeze({ ...result }));
    this.removePendingRedemption(pending);
    // No await or consumer code between accounting, the tombstone and dequeue.
    try { this.emit('settled', result); } catch { /* Accounting is already final. */ }
    try { this.log(`Redemption successful: ${pending.market.slug} | Amount: $${amountReceived.toFixed(2)}`); }
    catch { /* Telemetry cannot retry a confirmed transaction. */ }
  }

  private async processPendingRedemptionsOnce(): Promise<void> {
    if (this.pendingRedemptions.length === 0) {
      return;
    }

    const now = Date.now();
    const waitMs = (this.autoRotateConfig.redeemWaitMinutes || 5) * 60 * 1000;

    for (const pending of [...this.pendingRedemptions].reverse()) {
      if (!this.pendingRedemptions.includes(pending)) continue;
      const confirmed = this.confirmedRedeemLifecycles.get(pending.round)?.get(this.redeemLifecycleKey(pending.market));
      // Only pre-submission duplicates use lifecycle identity. Confirmed items
      // have their own factual transaction identity, even in the same round.
      if (pending.state !== 'CONFIRMED_PAYOUT_PENDING' && confirmed && confirmed !== pending) {
        this.removePendingRedemption(pending);
        continue;
      }
      if (pending.state === 'CONFIRMED_PAYOUT_PENDING') {
        const hash = pending.transactionHash;
        const wallet = pending.historicalWallet;
        if (this.accountedRedeemTransactions.has(hash.toLowerCase())) {
          this.removePendingRedemption(pending);
          continue;
        }
        try {
          if (!this.ctf) continue;
          const payout = await this.ctf.getRedeemPayout(hash, wallet);
          if (!this.pendingRedemptions.includes(pending) || pending.transactionHash !== hash ||
              pending.historicalWallet !== wallet) continue;
          if (payout.state === 'PAYOUT_KNOWN' && payout.transactionHash.toLowerCase() === hash.toLowerCase()) {
            this.finalizeRedeem(pending, hash, payout.pusdReceived);
          }
        } catch { /* Keep confirmed evidence and retry only this read in a later cycle. */ }
        continue;
      }
      const timeSinceEnd = now - pending.marketEndTime;

      // Skip if not enough time has passed since market end
      if (timeSinceEnd < waitMs) {
        const waitLeft = Math.round((waitMs - timeSinceEnd) / 1000);
        if (this.config.debug) {
          this.log(`Pending redemption ${pending.market.slug}: waiting ${waitLeft}s more for resolution`);
        }
        continue;
      }

      // Try to redeem
      pending.retryCount++;
      pending.lastRetryAt = now;

      let scope: CtfScope | undefined;
      let redeemInvoked = false;
      const hasUnresolvedCtf = () => !!scope && [...this.ctfLifecycles.values()].some(record =>
        record.wallet === scope!.wallet.toLowerCase() && record.tokenIds.some(token =>
          token === scope!.market.upTokenId || token === scope!.market.downTokenId));
      try {
        if (!this.ctf) {
          this.log(`Cannot redeem ${pending.market.slug}: CTF client not available`);
          continue;
        }

        // Check if market is resolved
        scope = this.captureCtfScope(pending.market, pending.round);
        const resolution = await scope.ctf.getMarketResolution(scope.market.conditionId, this.toLifecycleRouting(scope.market));
        if (!this.pendingRedemptions.includes(pending)) continue;

        if (!resolution.isResolved) {
          this.log(`Pending redemption ${pending.market.slug}: market not yet resolved (retry ${pending.retryCount})`);

          // Give up after too many retries (10 minutes of trying)
          if (pending.retryCount > 20) {
            this.log(`Giving up on redemption ${pending.market.slug}: too many retries`);
            this.removePendingRedemption(pending);
            // An unresolved market only exhausts the queue; no redeem occurred.
          }
          continue;
        }

        // Market is resolved, try to redeem using Polymarket token IDs
        this.log(`Redeeming ${pending.market.slug}...`);
        redeemInvoked = true;
        const result = await this.writeCtf(scope, 'REDEEM');

        this.confirmRedeem(pending, scope.wallet, result.txHash, result.usdcReceived);
      } catch (error) {
        if (error instanceof RedeemProvenanceError && error.provenance.state === 'CONFIRMED') {
          if (!this.pendingRedemptions.includes(pending)) continue;
          const txHash = error.provenance.transactionHash ?? '';
          this.confirmRedeem(pending, scope!.wallet, txHash, error.usdcReceived);
          continue;
        }
        if (error instanceof InventoryAdmissionRefusal) { this.inventoryBlocked({}, error); continue; }
        this.log(`Redemption error for ${pending.market.slug}: ${error instanceof Error ? error.message : String(error)}`);

        // Give up after too many retries
        if (pending.retryCount > 20) {
          this.log(`Giving up on redemption ${pending.market.slug}: error after max retries`);
          this.removePendingRedemption(pending);
          // Factual non-confirmation suppresses settlement even without an inventory guard.
          if (error instanceof RedeemProvenanceError && error.provenance.state !== 'CONFIRMED') continue;
          if (!redeemInvoked || hasUnresolvedCtf()) continue;
          this.emit('settled', {
            success: false,
            strategy: 'redeem',
            market: pending.market,
            error: error instanceof Error ? error.message : String(error),
            executionTimeMs: 0,
          } as DipArbSettleResult);
        }
      }
    }
  }

  /**
   * Get pending redemptions (for debugging/monitoring)
   */
  getPendingRedemptions(): DipArbPendingRedemption[] {
    return [...this.pendingRedemptions];
  }

  private async checkRotation(): Promise<void> {
    if (!this.autoRotateConfig.enabled || !this.market) {
      if (this.config.debug) {
        this.log(`checkRotation: skipped (enabled=${this.autoRotateConfig.enabled}, market=${!!this.market})`);
      }
      return;
    }

    const now = Date.now();
    const endTime = this.market.endTime.getTime();
    const timeUntilEnd = endTime - now;
    const preloadMs = (this.autoRotateConfig.preloadMinutes || 2) * 60 * 1000;

    if (this.config.debug) {
      const timeLeftSec = Math.round(timeUntilEnd / 1000);
      this.log(`checkRotation: timeUntilEnd=${timeLeftSec}s, preloadMs=${preloadMs / 1000}s, nextMarket=${this.nextMarket?.slug || 'none'}`);
    }

    // Preload next market when close to end
    if (timeUntilEnd <= preloadMs && !this.nextMarket) {
      this.log('Preloading next market...');
      this.nextMarket = await this.findNextMarket();
      if (this.nextMarket) {
        this.log(`Next market ready: ${this.nextMarket.slug}`);
      } else {
        this.log('No next market found during preload');
      }
    }

    // Market ended - settle and rotate
    if (timeUntilEnd <= 0) {
      this.log(`Market ended ${Math.round(-timeUntilEnd / 1000)}s ago, initiating rotation...`);

      // Settle if configured and has position
      if (this.autoRotateConfig.autoSettle && this.currentRound?.leg1) {
        const strategy = this.autoRotateConfig.settleStrategy || 'redeem';

        if (strategy === 'redeem') {
          // For redeem strategy, add to pending queue (will be processed after 5 min wait)
          this.addPendingRedemption(this.market, this.currentRound);
          this.log(`Position added to pending redemption queue (will redeem after ${this.autoRotateConfig.redeemWaitMinutes || 5}min)`);
        } else {
          // For sell strategy, execute immediately
          const sellingRound = this.currentRound;
          const settleResult = await this.settle('sell');
          if (!settleResult.success || settleResult.sellState !== 'COMPLETE') return;
          const settlement = this.sellSettlements.get(sellingRound);
          if (!settlement?.finalizedComposition || this.currentRound !== sellingRound ||
              this.market !== settlement.scope.originMarket ||
              !this.sameSellComposition(settlement.finalizedComposition, this.captureSellComposition(sellingRound))) return;
          if (settlement && !settlement.emitted) {
            settlement.emitted = true;
            try { this.emit('settled', settleResult); } catch { /* Final facts cannot be replayed by telemetry. */ }
          }
        }
      }

      // Rotate to next market
      if (this.nextMarket) {
        const previousMarket = this.market;
        const newMarket = this.nextMarket;
        this.nextMarket = null;

        // Stop current market (this clears the rotate check interval)
        await this.stop();

        // Start new market
        await this.start(newMarket);

        // Restart the rotate check interval for the new market
        this.startRotateCheck();

        const event: DipArbRotateEvent = {
          previousMarket: previousMarket.conditionId,
          newMarket: newMarket.conditionId,
          reason: 'marketEnded',
          timestamp: Date.now(),
        };
        this.emit('rotate', event);
      } else {
        // Try to find a market
        this.log('No preloaded market, searching...');
        const newMarket = await this.findNextMarket();
        if (newMarket) {
          const previousMarket = this.market;

          // Stop current market (this clears the rotate check interval)
          await this.stop();

          // Start new market
          await this.start(newMarket);

          // Restart the rotate check interval for the new market
          this.startRotateCheck();

          const event: DipArbRotateEvent = {
            previousMarket: previousMarket.conditionId,
            newMarket: newMarket.conditionId,
            reason: 'marketEnded',
            timestamp: Date.now(),
          };
          this.emit('rotate', event);
        } else {
          this.log('No next market available, stopping...');
          await this.stop();
        }
      }
    }
  }

  private async findNextMarket(): Promise<DipArbMarketConfig | null> {
    const markets = await this.scanUpcomingMarkets({
      coin: this.autoRotateConfig.underlyings.length === 1
        ? this.autoRotateConfig.underlyings[0]
        : 'all',
      duration: this.autoRotateConfig.duration,
      minMinutesUntilEnd: 5,
      maxMinutesUntilEnd: 30,
      limit: 10,
    });

    // Filter to configured underlyings
    const filtered = markets.filter(m =>
      this.autoRotateConfig.underlyings.includes(m.underlying as DipArbUnderlying)
    );

    // Exclude current market
    const available = filtered.filter(m =>
      m.conditionId !== this.market?.conditionId
    );

    // Return the soonest one
    return available.length > 0 ? available[0] : null;
  }

  private async settleByRedeem(): Promise<DipArbSettleResult & DipArbInventoryDiagnostic> {
    if (!this.ctf || !this.market || !this.currentRound) {
      return {
        success: false,
        strategy: 'redeem',
        error: 'CTF client or market not available',
        executionTimeMs: 0,
      };
    }
    const scope = this.captureCtfScope(this.market, this.currentRound, true);
    // Public calls and the queue share one transport/finalization critical section.
    while (this.publicRedeemFlight || this.redemptionFlight) {
      try { await (this.publicRedeemFlight ?? this.redemptionFlight); } catch { /* Recheck captured lifecycle. */ }
    }
    const flight = Promise.resolve().then(() => this.settleCapturedRedeem(scope));
    this.publicRedeemFlight = flight;
    try { return await flight; }
    finally { if (this.publicRedeemFlight === flight) this.publicRedeemFlight = undefined; }
  }

  private async settleCapturedRedeem(scope: CtfScope): Promise<DipArbSettleResult & DipArbInventoryDiagnostic> {
    const startTime = Date.now();
    const prior = this.confirmedRedeemLifecycles.get(scope.round!)?.get(this.redeemLifecycleKey(scope.market));
    if (prior) return this.confirmedRedeemResult(prior);
    const confirmed = (txHash: string, payout?: string): DipArbSettleResult => {
      const pending = this.pendingRedemptions.find(p => p.round === scope.round &&
        this.redeemLifecycleKey(p.market) === this.redeemLifecycleKey(scope.market)) ?? {
        market: scope.market, round: scope.round!, marketEndTime: scope.market.endTime.getTime(),
        addedAt: Date.now(), retryCount: 0,
      };
      if (!this.pendingRedemptions.includes(pending)) this.pendingRedemptions.push(pending);
      this.confirmRedeem(pending, scope.wallet, txHash, payout);
      return this.confirmedRedeemResult(pending);
    };
    try {
      // Check market resolution first
      const resolution = await scope.ctf.getMarketResolution(scope.market.conditionId, this.toLifecycleRouting(scope.market));

      if (!resolution.isResolved) {
        return {
          success: false,
          strategy: 'redeem',
          error: 'Market not yet resolved',
          executionTimeMs: Date.now() - startTime,
        };
      }

      const result = await this.writeCtf(scope, 'REDEEM');

      return confirmed(result.txHash, result.usdcReceived);
    } catch (error) {
      if (error instanceof RedeemProvenanceError && error.provenance.state === 'CONFIRMED') {
        return confirmed(error.provenance.transactionHash ?? '', error.usdcReceived);
      }
      if (error instanceof InventoryAdmissionRefusal) return this.inventoryBlocked({ success: false, strategy: 'redeem' as const,
        error: error.message, executionTimeMs: Date.now() - startTime }, error);
      return {
        success: false,
        strategy: 'redeem',
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  private async settleBySell(): Promise<DipArbSettleResult> {
    const round = this.currentRound, market = this.market, trading = this.tradingService;
    if (!round || !market || !trading) return { success: false, strategy: 'sell',
      error: 'Trading service or market not available', executionTimeMs: 0 };
    let settlement = this.sellSettlements.get(round);
    if (!settlement) {
      settlement = { emitted: false, composition: this.captureSellComposition(round),
        scope: { originMarket: market, market: { ...market }, round, trading,
        ctf: this.ctf, wallet: this.clobWalletSnapshot(trading), guard: this.inventoryAdmissionGuard,
        running: this.isRunning, invocation: Symbol() },
        legs: [round.leg1, round.leg2].filter((leg): leg is NonNullable<typeof leg> => !!leg).map(leg => ({
          tokenId: leg.tokenId, requestedShares: leg.shares, attempted: false, rejected: false,
          tradeIds: new Set<string>(), facts: new Map(), observed: false, completeEvidence: false,
        })) };
      this.sellSettlements.set(round, settlement);
    }
    const copy = (result: DipArbSettleResult): DipArbSettleResult => ({ ...result,
      sellLegs: result.sellLegs?.map(leg => ({ ...leg })) });
    if (settlement.finalized && settlement.finalizedComposition &&
        this.sameSellComposition(settlement.finalizedComposition, this.captureSellComposition(round)) &&
        settlement.scope.originMarket === market) return copy(settlement.finalized);
    settlement.finalized = undefined;
    if (!settlement.flight) {
      const captured = settlement;
      captured.flight = Promise.resolve().then(() => this.reconcileSellSettlement(captured));
    }
    const flight = settlement.flight!;
    try { return copy(await flight); }
    finally { if (settlement.flight === flight) settlement.flight = undefined; }
  }

  private captureSellComposition(round: DipArbRoundState): SellComposition {
    return [round.leg1, round.leg2].map(leg => leg
      ? { leg, tokenId: leg.tokenId, side: leg.side, shares: leg.shares } : undefined);
  }

  private sameSellComposition(before: SellComposition, after: SellComposition): boolean {
    return before.every((leg, i) => leg === undefined ? after[i] === undefined :
      after[i]?.leg === leg.leg && after[i]?.tokenId === leg.tokenId &&
      after[i]?.side === leg.side && after[i]?.shares === leg.shares);
  }

  /** Exact fixed-point facts; an invalid observation must never become zero. */
  private sellUnits(value: unknown, decimals = 6): bigint {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid SELL fact');
    const [whole, fraction = ''] = value.split('.');
    if (/[^0]/.test(fraction.slice(decimals))) throw new Error('Inexact SELL fact');
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0'));
  }

  private sellTradeExecution(trade: TradeStatus, leg: SellSettlementLeg,
    order: Awaited<ReturnType<TradingService['getOrderFillDetails']>>): { size: string | undefined; price: string | undefined } | undefined {
    // IDs are opaque: retain exact equality, never lowercase or coerce them.
    if ((order.id !== undefined && order.id !== leg.orderId) ||
        (order.asset_id !== undefined && order.asset_id !== leg.tokenId) ||
        (order.side !== undefined && order.side !== 'SELL') ||
        typeof trade.taker_order_id !== 'string' || !trade.taker_order_id.trim() ||
        !Array.isArray(trade.maker_orders)) return;
    const makers = trade.maker_orders.filter(maker => maker.order_id === leg.orderId);
    if (trade.taker_order_id === leg.orderId) {
      if (trade.trader_side !== 'TAKER' || makers.length || trade.asset_id !== leg.tokenId || trade.side !== 'SELL') return;
      return { size: trade.size, price: trade.price };
    }
    if (trade.trader_side !== 'MAKER' || makers.length !== 1) return;
    const maker = makers[0];
    // Top-level size/price/side describe the taker. Only this maker allocation
    // describes our order. An omitted maker side needs explicit order evidence.
    if (maker.asset_id !== leg.tokenId || (maker.side !== undefined ? maker.side !== 'SELL' :
        order.id !== leg.orderId || order.asset_id !== leg.tokenId || order.side !== 'SELL')) return;
    if ((trade.side !== 'BUY' && trade.side !== 'SELL') || !trade.asset_id ||
        (trade.asset_id === leg.tokenId && trade.side !== 'BUY')) return;
    if (this.sellUnits(maker.matched_amount) > this.sellUnits(trade.size)) return;
    return { size: maker.matched_amount, price: maker.price };
  }

  private async reconcileSellSettlement(settlement: SellSettlement): Promise<DipArbSettleResult> {
    const startTime = Date.now(), { scope, legs } = settlement;
    const composition = this.captureSellComposition(scope.round);
    const compositionUnchanged = () => this.currentRound === scope.round && this.market === scope.originMarket &&
      this.sameSellComposition(composition, this.captureSellComposition(scope.round));
    let refusal: InventoryAdmissionRefusal | undefined;
    for (const leg of legs) {
      leg.completeEvidence = false;
      leg.residual = undefined;
      if (!leg.attempted) {
        leg.attempted = true; // Installed before transport, including ambiguous exceptions.
        try {
          const response = await this.submitClob(scope, 'SETTLE_SELL', {
            tokenId: leg.tokenId, side: 'SELL', amount: leg.requestedShares,
          });
          leg.rejected = response.submissionState === 'REJECTED';
          if (!leg.rejected && typeof response.orderId === 'string' && response.orderId.trim()) {
            leg.orderId = response.orderId.trim();
            for (const id of response.tradeIds ?? []) leg.tradeIds.add(id);
          }
        } catch (error) {
          if (error instanceof InventoryAdmissionRefusal) {
            leg.attempted = false; refusal = error; break;
          }
          // Unknown submission stays unresolved; never retry it blindly.
        }
      }
      if (leg.rejected || !leg.orderId) continue;
      try {
        const wallet = this.inventoryWallet(scope.wallet ?? '');
        if (this.inventoryWallet(scope.trading.getAddress()) !== wallet) continue;
        const orderKey = `${wallet}:order:${leg.orderId}`;
        const owner = this.sellEvidenceOwners.get(orderKey);
        if (owner && owner !== leg) continue;
        this.sellEvidenceOwners.set(orderKey, leg);
        const details = await scope.trading.getOrderFillDetails(leg.orderId);
        for (const id of details.tradeIds) leg.tradeIds.add(id);
        const ids = [...leg.tradeIds];
        if (!ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) continue;
        const returnedTrades = await scope.trading.getTradeStatuses(ids);
        const uniqueTrades = new Map<string, TradeStatus>();
        const fingerprint = (trade: TradeStatus) => JSON.stringify([trade.status, trade.transactionHash?.toLowerCase(),
          trade.size, trade.price, trade.asset_id, trade.side, trade.taker_order_id, trade.trader_side, trade.maker_orders]);
        for (const trade of returnedTrades) {
          const prior = uniqueTrades.get(trade.id);
          if (prior && fingerprint(prior) !== fingerprint(trade)) throw new Error('Conflicting duplicate SELL trade');
          uniqueTrades.set(trade.id, trade);
        }
        const trades = [...uniqueTrades.values()];
        if (trades.length !== ids.length || trades.some(t => !ids.includes(t.id))) continue;
        if (ids.some(id => !details.tradeIds.includes(id))) continue;
        const staged = new Map(leg.facts);
        let terminal = true;
        let attributed = 0n, identitiesComplete = true;
        for (const trade of trades) {
          try {
            const execution = this.sellTradeExecution(trade, leg, details);
            const tradeOwner = this.sellEvidenceOwners.get(`${wallet}:trade:${trade.id}`);
            if (!execution || (tradeOwner && tradeOwner !== leg)) throw new Error('Unattributed SELL trade');
            const shares = this.sellUnits(execution.size);
            attributed += shares;
            const confirmed = (trade.status === 'MINED' || trade.status === 'CONFIRMED') &&
              typeof trade.transactionHash === 'string' && /^0x[0-9a-f]{64}$/i.test(trade.transactionHash);
            if (!confirmed) {
              if (staged.has(trade.id)) throw new Error('Conflicting SELL evidence');
              if (trade.status !== 'FAILED' || trade.transactionHash?.trim()) terminal = false;
              continue;
            }
            const fact = { shares, price: this.sellUnits(execution.price, 18), hash: trade.transactionHash!.toLowerCase() };
            if (fact.shares <= 0n || fact.price <= 0n || fact.price > 10n ** 18n) throw new Error('Invalid SELL fill');
            const prior = staged.get(trade.id);
            if (prior && (prior.shares !== fact.shares || prior.price !== fact.price || prior.hash !== fact.hash)) {
              throw new Error('Conflicting SELL fill');
            }
            staged.set(trade.id, fact);
          } catch {
            identitiesComplete = false;
            terminal = false; // Keep valid siblings; an unproven child cannot complete the order.
          }
        }
        const matched = this.sellUnits(details.sizeMatched);
        if (attributed > matched || (identitiesComplete && attributed !== matched)) continue;
        const executed = [...staged.values()].reduce((sum, fact) => sum + fact.shares, 0n);
        if (executed > this.sellUnits(String(leg.requestedShares))) throw new Error('SELL exceeds requested shares');
        if (executed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe SELL shares');
        for (const id of staged.keys()) this.sellEvidenceOwners.set(`${wallet}:trade:${id}`, leg);
        leg.facts = staged;
        leg.observed = staged.size > 0 || terminal;
        leg.completeEvidence = terminal;
        if (!scope.ctf || this.inventoryWallet(scope.ctf.getAddress()) !== this.inventoryWallet(scope.wallet ?? '')) continue;
        const balances = await scope.ctf.getPositionBalanceByTokenIds(scope.market.conditionId,
          { yesTokenId: scope.market.upTokenId, noTokenId: scope.market.downTokenId });
        if (this.inventoryWallet(scope.ctf.getAddress()) !== this.inventoryWallet(scope.wallet ?? '') ||
            this.inventoryWallet(scope.trading.getAddress()) !== this.inventoryWallet(scope.wallet ?? '')) continue;
        leg.residual = this.sellUnits(leg.tokenId === scope.market.upTokenId ? balances.yesBalance : balances.noBalance);
      } catch { /* Keep prior facts and order identity for a later read-only reconciliation. */ }
    }
    let gross = 0n;
    const observations = legs.map(leg => {
      const fills = [...leg.facts.values()];
      const shares = fills.reduce((sum, fact) => sum + fact.shares, 0n);
      const proceeds = fills.reduce((sum, fact) => sum + fact.shares * fact.price, 0n);
      gross += proceeds;
      const realizedShares = leg.observed ? Number(ethers.utils.formatUnits(shares.toString(), 6)) : undefined;
      const received = leg.observed ? Number(ethers.utils.formatUnits(proceeds.toString(), 24)) : undefined;
      return { tokenId: leg.tokenId, requestedShares: leg.requestedShares, orderId: leg.orderId,
        realizedShares, proceeds: received,
        executionPrice: realizedShares && received !== undefined ? received / realizedShares : undefined,
        residual: leg.residual === undefined ? undefined : Number(ethers.utils.formatUnits(leg.residual.toString(), 6)) };
    });
    let compositionReady = compositionUnchanged();
    if (compositionReady && !this.sameSellComposition(settlement.composition, composition)) {
      // A later call may observe changed legs already closed elsewhere. Verify their
      // current inventory; never submit extra SELLs or invent proceeds for them.
      compositionReady = false;
      try {
        const wallet = this.inventoryWallet(scope.wallet ?? '');
        if (scope.ctf && this.inventoryWallet(scope.ctf.getAddress()) === wallet &&
            this.inventoryWallet(scope.trading.getAddress()) === wallet) {
          const balances = await scope.ctf.getPositionBalanceByTokenIds(scope.market.conditionId,
            { yesTokenId: scope.market.upTokenId, noTokenId: scope.market.downTokenId });
          compositionReady = composition.every(leg => !leg ||
            (leg.tokenId === scope.market.upTokenId ? this.sellUnits(balances.yesBalance) === 0n :
              leg.tokenId === scope.market.downTokenId && this.sellUnits(balances.noBalance) === 0n)) &&
            this.inventoryWallet(scope.ctf.getAddress()) === wallet &&
            this.inventoryWallet(scope.trading.getAddress()) === wallet;
        }
      } catch { /* A changed composition needs a successful factual balance read. */ }
    }
    compositionReady = compositionReady && compositionUnchanged();
    const complete = compositionReady && legs.length > 0 && legs.every(leg => leg.completeEvidence && leg.residual === 0n &&
      [...leg.facts.values()].reduce((sum, fact) => sum + fact.shares, 0n) === this.sellUnits(String(leg.requestedShares)) &&
      leg.requestedShares > 0);
    const result: DipArbSettleResult = { success: complete, strategy: 'sell',
      sellState: complete ? 'COMPLETE' : !compositionReady || legs.some(leg => !leg.rejected &&
        (!leg.completeEvidence || leg.residual === undefined)) ? 'PENDING'
        : observations.some(leg => (leg.realizedShares ?? 0) > 0) ? 'RESIDUAL' : 'NO_FILL',
      sellLegs: observations,
      amountReceived: legs.some(leg => leg.observed) ? Number(ethers.utils.formatUnits(gross.toString(), 24)) : undefined,
      executionTimeMs: Date.now() - startTime };
    // Cumulative observation only: this path does not increment PnL/fees/stats.
    if (complete) {
      settlement.finalized = result;
      settlement.finalizedComposition = composition;
    }
    return refusal ? this.inventoryBlocked(result, refusal) : result;
  }

  // ===== Private: Helpers =====

  /**
   * Update orderbook buffer for smart logging
   * Keeps last 5 seconds of orderbook data
   */
  private updateOrderbookBuffer(_book: OrderbookSnapshot): void {
    if (!this.market) return;

    const upAsk = this.upAsks[0]?.price ?? 0;
    const downAsk = this.downAsks[0]?.price ?? 0;

    this.orderbookBuffer.push({
      timestamp: Date.now(),
      upAsk,
      downAsk,
      upDepth: this.upAsks.length,
      downDepth: this.downAsks.length,
    });

    // Keep only last ORDERBOOK_BUFFER_SIZE entries
    if (this.orderbookBuffer.length > this.ORDERBOOK_BUFFER_SIZE) {
      this.orderbookBuffer = this.orderbookBuffer.slice(-this.ORDERBOOK_BUFFER_SIZE);
    }
  }

  /**
   * Log orderbook summary at intervals (every 10 seconds)
   * Reduces log noise from ~10 logs/sec to 1 log/10sec
   */
  private maybeLogOrderbookSummary(): void {
    const now = Date.now();

    // Only log every ORDERBOOK_LOG_INTERVAL_MS
    if (now - this.lastOrderbookLogTime < this.ORDERBOOK_LOG_INTERVAL_MS) {
      return;
    }

    this.lastOrderbookLogTime = now;

    const upAsk = this.upAsks[0]?.price ?? 0;
    const downAsk = this.downAsks[0]?.price ?? 0;
    const sum = upAsk + downAsk;

    this.log(`📊 Orderbook: UP=${upAsk.toFixed(3)} | DOWN=${downAsk.toFixed(3)} | Sum=${sum.toFixed(3)}`);
  }

  /**
   * Log orderbook buffer around a signal/trade
   * Called when signal is detected to capture market context
   */
  private logOrderbookContext(eventType: string): void {
    if (this.orderbookBuffer.length === 0) return;

    this.log(`📈 ${eventType} - Orderbook context (last ${this.orderbookBuffer.length} ticks):`);

    // Log first, middle, and last entries for context
    const first = this.orderbookBuffer[0];
    const mid = this.orderbookBuffer[Math.floor(this.orderbookBuffer.length / 2)];
    const last = this.orderbookBuffer[this.orderbookBuffer.length - 1];

    const formatTime = (ts: number) => new Date(ts).toISOString().slice(11, 23);

    this.log(`   ${formatTime(first.timestamp)}: UP=${first.upAsk.toFixed(4)} DOWN=${first.downAsk.toFixed(4)}`);
    if (this.orderbookBuffer.length > 2) {
      this.log(`   ${formatTime(mid.timestamp)}: UP=${mid.upAsk.toFixed(4)} DOWN=${mid.downAsk.toFixed(4)}`);
    }
    this.log(`   ${formatTime(last.timestamp)}: UP=${last.upAsk.toFixed(4)} DOWN=${last.downAsk.toFixed(4)}`);

    // Calculate price changes
    const upChange = ((last.upAsk - first.upAsk) / first.upAsk * 100).toFixed(2);
    const downChange = ((last.downAsk - first.downAsk) / first.downAsk * 100).toFixed(2);
    this.log(`   Change: UP ${upChange}% | DOWN ${downChange}%`);
  }

  private log(message: string): void {
    const shouldLog = this.config.debug || message.startsWith('Starting') || message.startsWith('Stopped');
    if (!shouldLog) return;

    const formatted = `[DipArb] ${message}`;

    // Use custom log handler if provided
    if (this.config.logHandler) {
      this.config.logHandler(formatted);
    } else {
      console.log(formatted);
    }
  }

  /**
   * V2.3A: explicit lifecycle routing from market metadata.
   * Returns undefined when the market type is unknown (no silent false default).
   */
  private toLifecycleRouting(market: DipArbMarketConfig | null): LifecycleRouting | undefined {
    if (!market || typeof market.negRisk !== 'boolean') return undefined;
    return { negRisk: market.negRisk };
  }
}

// Re-export types
export * from './dip-arb-types.js';
