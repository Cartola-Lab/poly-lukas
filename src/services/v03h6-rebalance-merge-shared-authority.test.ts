import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type RebalanceAction, type RebalanceResult,
  type ClearPositionResult, type SettleResult } from './arbitrage-service.js';
import { MergeProvenanceError, type MergeProvenance, type TransactionStatus } from '../clients/ctf-client.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
const services: ArbitrageService[] = [];
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const HASH = (n: string) => '0x' + n.repeat(32);
const MERGE_TX = HASH('ab');
const OTHER_TX = HASH('cd');

type Inventory = { pusd: number; yes: number; no: number };
const inv = (pusd: number, yes: number, no: number): Inventory => ({ pusd, yes, no });
const act = (type: RebalanceAction['type'], amount: number): RebalanceAction => Object.freeze({ type, amount, reason: 'explicit', priority: 1 }) as RebalanceAction;
const NONE_WITHHELD: RebalanceAction = { type: 'none', amount: 0, reason: 'Rebalance withheld', priority: 0 };
const LOCK_WITHHELD = 'Rebalance withheld: clear or settle operation active for this market';

const provenanceError = (state: MergeProvenance['state'], transactionHash?: string, message = 'tx.wait timeout') =>
  new MergeProvenanceError(new Error(message), { state, ...(transactionHash ? { transactionHash } : {}) });
const txStatus = (status: TransactionStatus['status'], txHash = MERGE_TX, extra: Partial<TransactionStatus> = {}): TransactionStatus =>
  ({ txHash, status, confirmations: status === 'confirmed' || status === 'reverted' ? 3 : 0, ...extra });

/** 0.40 + 0.50 on 5 pairs: a valid long that spends 4.5 pUSD. */
const longOpp: ArbitrageOpportunity = Object.freeze({
  type: 'long', profitRate: 0.1, profitPercent: 10,
  effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
  priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
  maxOrderbookSize: 20, maxBalanceSize: 10, recommendedSize: 5, estimatedProfit: 0.5, description: 'h6', timestamp: 1,
}) as ArbitrageOpportunity;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * One active market shared by rebalance(), settlePosition() and clearPositions(). Every refresh
 * reports `fresh` (YES == NO by default so a clear has no residual SELL). Merges confirm with
 * MERGE_TX unless a test overrides the client; `getTransactionStatus` answers from `statuses`
 * (default: pending).
 */
function fixture(cached: Inventory, fresh: Inventory) {
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: false, enableRebalancer: true, rebalanceCooldown: 0 });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const orders: Record<string, OrderRow> = {};
  const trades: Record<string, TradeStatus> = {};
  const statuses: Record<string, TransactionStatus> = {};
  const modes = { sell: 'pending' as 'pending' | 'filled' };
  let sellCount = 0;
  const fill = (id: string, tokenId: string, size: string) => {
    Object.assign(orders[id], { status: 'MATCHED', tradeIds: [`t-${id}`], sizeMatched: size });
    trades[`t-${id}`] = { id: `t-${id}`, status: 'MINED', size, price: '0.55', transactionHash: HASH('11'),
      asset_id: tokenId, side: 'SELL', taker_order_id: id, trader_side: 'TAKER', maker_orders: [] } as unknown as TradeStatus;
  };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>().mockImplementation(async o => {
      const id = `r${++sellCount}`;
      orders[id] = { id, asset_id: o.tokenId, side: o.side, status: 'LIVE', tradeEnumerationPresent: true, tradeIds: [], sizeMatched: '0' };
      if (o.side === 'SELL' && modes.sell === 'filled') fill(id, o.tokenId, String(o.amount));
      return accepted(id);
    }),
    getOrderFillDetails: vi.fn(async (id: string) => ({ ...orders[id], tradeIds: [...orders[id].tradeIds] })),
    getTradeStatuses: vi.fn(async (ids: string[]) => ids.map(id => trades[id])),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue('wallet'),
    getPusdBalance: vi.fn(async () => String(fresh.pusd)),
    getPositionBalanceByTokenIds: vi.fn(async () => ({ yesBalance: String(fresh.yes), noBalance: String(fresh.no) })),
    mergeByTokenIds: vi.fn(async (_c: string, _t: unknown, amount: string) => ({ success: true, txHash: MERGE_TX, amount })),
    split: vi.fn(async () => ({ txHash: 'split-tx' })),
    getMarketResolution: vi.fn(async (): Promise<{ isResolved: boolean; winningOutcome?: string }> => ({ isResolved: false })),
    getTransactionStatus: vi.fn(async (txHash: string): Promise<TransactionStatus> => statuses[txHash] ?? txStatus('pending', txHash)),
    redeemByTokenIds: vi.fn(),
  };
  const realtime = { connect: vi.fn(), disconnect: vi.fn(), subscribeMarkets: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) };
  const cachedBalance = { usdc: cached.pusd, pUsdBalance: cached.pusd, yesTokens: cached.yes, noTokens: cached.no, lastUpdate: 0 };
  Object.assign(service, { market, tradingService: trading, ctf, realtimeService: realtime, isRunning: true, totalCapital: 20, balance: cachedBalance });
  const events = vi.fn<(result: RebalanceResult) => void>();
  service.on('rebalance', events);
  const settles = vi.fn<(result: SettleResult | ClearPositionResult) => void>();
  service.on('settle', settles);
  service.on('error', vi.fn());
  service.on('execution', vi.fn());
  const reads = () => ctf.getPusdBalance.mock.calls.length + ctf.getPositionBalanceByTokenIds.mock.calls.length;
  const clearReads = () => { ctf.getPusdBalance.mockClear(); ctf.getPositionBalanceByTokenIds.mockClear(); };
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  const merges = () => ctf.mergeByTokenIds.mock.calls;
  const pendingMerges = service['pendingClearMerges'];
  const pendingSells = service['pendingRebalanceSells'];
  const active = service['activeClearMarkets'];
  const writers = service['rebalancerInventoryWrites'];
  const settle = (execute = true) => service.settlePosition(market, execute);
  const clear = (execute = true) => service.clearPositions(market, execute);
  const fillSell = (orderId: string) => {
    const record = [...pendingSells.values()].find(r => r.leg.orderId === orderId);
    if (!record) throw new Error(`no pending SELL record for ${orderId}`);
    fill(orderId, record.leg.tokenId, String(record.leg.requestedShares));
  };
  /** Parks the next merge (whichever entrypoint issues it) until `release()`; returns once it is in flight. */
  const holdNextMerge = async (start: () => Promise<unknown>) => {
    const gate = deferred<{ success: true; txHash: string; amount: string }>();
    ctf.mergeByTokenIds.mockImplementationOnce(() => gate.promise);
    const flight = start();
    await macrotask();
    expect(merges()).toHaveLength(1);
    expect(active.has('condition')).toBe(true);
    return { flight, release: () => gate.resolve({ success: true, txHash: MERGE_TX, amount: '5' }), fail: (e: unknown) => gate.reject(e) };
  };
  /** Real public path: rebalance(merge 5) whose client throw leaves the outcome unresolved. */
  const openRebalancePendingMerge = async (error: unknown = provenanceError('SUBMITTED', MERGE_TX)) => {
    ctf.mergeByTokenIds.mockRejectedValueOnce(error);
    const result = await service.rebalance(act('merge', 5));
    expect(result).toMatchObject({ success: false, pending: true, operationId: 'clear-merge-1' });
    expect(pendingMerges.get('condition')).toMatchObject({ id: 'clear-merge-1', pairs: 5 });
    expect(active.size).toBe(0);
    expect(writers.size).toBe(0);
    events.mockClear();
    clearReads();
    return pendingMerges.get('condition')!;
  };
  return { service, market, trading, ctf, modes, statuses, events, settles, reads, clearReads, sells, merges,
    pendingMerges, pendingSells, active, writers, settle, clear, fillSell, holdNextMerge, openRebalancePendingMerge };
}
type H = ReturnType<typeof fixture>;

/** Pre-read refusal: no balance read, no write of any kind, no event, no lingering guard. */
function expectLockWithheld(h: H, result: RebalanceResult, action: RebalanceAction | undefined, readsBefore: number, mergesBefore: number) {
  expect(result).toEqual({ success: false, action: action ?? NONE_WITHHELD, error: LOCK_WITHHELD });
  if (action) expect(result.action).toBe(action);
  expect(h.reads()).toBe(readsBefore);
  expect(h.merges()).toHaveLength(mergesBefore);
  expect(h.sells()).toHaveLength(0);
  expect(h.ctf.split).not.toHaveBeenCalled();
  expect(h.writers.size).toBe(0);
  expect(h.events).not.toHaveBeenCalled();
}

function expectSettleWithheld(result: SettleResult) {
  expect(result).toMatchObject({ withheld: true, merged: false, pairedTokens: 0, error: /^settlePosition withheld/ });
  expect(result.usdcRecovered).toBeUndefined();
}
function expectClearWithheld(result: ClearPositionResult) {
  expect(result).toMatchObject({ withheld: true, success: false, actions: [], totalUsdcRecovered: 0, error: /^clearPositions withheld/ });
}

/** Action a reconciliation result uses to describe the existing merge, never the caller's request. */
const existingMerge = (pairs: number) => ({ type: 'merge', amount: pairs, priority: 0, reason: expect.stringMatching(/^Unresolved merge clear-merge-1/) });

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3H6 rebalance writes are withheld while settle/clear owns the market', () => {
  const requests: Array<[string, RebalanceAction | undefined]> = [
    ['explicit merge', act('merge', 5)],
    ['explicit sell_yes', act('sell_yes', 5)],
    ['explicit split', act('split', 5)],
    ['calculated (no action)', undefined],
  ];

  it.each(requests)('settle parked in its merge → rebalance %s withheld before its balance read', async (_label, action) => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const held = await h.holdNextMerge(() => h.settle());
    const readsBefore = h.reads();
    const result = await h.service.rebalance(action);
    expectLockWithheld(h, result, action, readsBefore, 1);
    held.release();
    expect(await held.flight).toMatchObject({ merged: true, mergeAmount: 20, mergeTxHash: MERGE_TX });
    expect(h.active.size).toBe(0);
  });

  it.each(requests)('clear parked in its merge → rebalance %s withheld before its balance read', async (_label, action) => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const held = await h.holdNextMerge(() => h.clear());
    const readsBefore = h.reads();
    const result = await h.service.rebalance(action);
    expectLockWithheld(h, result, action, readsBefore, 1);
    held.release();
    expect(await held.flight).toMatchObject({ success: true, totalUsdcRecovered: 20 });
    expect(h.active.size).toBe(0);
  });

  it('race-2 replay: settle parked in mergeByTokenIds (record not yet installed) → rebalance SELL withheld pre-read; the merge then goes UNCERTAIN', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const held = await h.holdNextMerge(() => h.settle());
    expect(h.pendingMerges.size).toBe(0);
    const readsBefore = h.reads();
    const action = act('sell_yes', 5);
    expectLockWithheld(h, await h.service.rebalance(action), action, readsBefore, 1);
    held.fail(provenanceError('UNCERTAIN', MERGE_TX));
    expect(await held.flight).toMatchObject({ pending: true, operationId: 'clear-merge-1' });
    expect(h.pendingMerges.get('condition')).toMatchObject({ pairs: 20, txHash: MERGE_TX });
    // The record now owns the market: the same SELL is still refused, this time by the record.
    const again = await h.service.rebalance(action);
    expect(again).toMatchObject({ success: false, pending: true, operationId: 'clear-merge-1', action: existingMerge(20) });
    expect(h.sells()).toHaveLength(0);
  });

  it('a settle on a different market does not withhold this market', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const other = { name: 'o', conditionId: 'other', yesTokenId: 'oy', noTokenId: 'on', negRisk: false };
    const gate = deferred<{ success: true; txHash: string; amount: string }>();
    h.ctf.mergeByTokenIds.mockImplementationOnce(() => gate.promise);
    const settle = h.service.settlePosition(other, true);
    await macrotask();
    expect(h.active.has('other')).toBe(true);
    const result = await h.service.rebalance(act('split', 5));
    expect(result).toMatchObject({ success: true, txHash: 'split-tx' });
    gate.resolve({ success: true, txHash: MERGE_TX, amount: '20' });
    await settle;
  });
});

describe('P0.3H6 settle/clear are withheld while a rebalance write is in flight', () => {
  it('rebalance MERGE parked in mergeByTokenIds → settle(true) and clear(true) withheld; exactly one merge', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const held = await h.holdNextMerge(() => h.service.rebalance(act('merge', 5)));
    expect(h.writers.size).toBe(1);
    expectSettleWithheld(await h.settle());
    expectClearWithheld(await h.clear());
    expect(h.merges()).toHaveLength(1);
    expect(h.settles).not.toHaveBeenCalled();
    held.release();
    expect(await held.flight).toMatchObject({ success: true, txHash: MERGE_TX, action: { type: 'merge', amount: 5 } });
    expect(h.active.size).toBe(0);
    expect(h.writers.size).toBe(0);
    // Released: settle reads fresh and merges on its own authority.
    expect(await h.settle()).toMatchObject({ merged: true, mergeAmount: 20 });
    expect(h.merges()).toHaveLength(2);
  });

  it('rebalance SELL parked at the venue → settle(true) and clear(true) withheld', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const gate = deferred<Reply>();
    h.trading.createMarketOrder.mockImplementationOnce(() => gate.promise);
    const reb = h.service.rebalance(act('sell_yes', 5));
    await macrotask();
    expect(h.sells()).toHaveLength(1);
    expect(h.active.has('condition')).toBe(true);
    expectSettleWithheld(await h.settle());
    expectClearWithheld(await h.clear());
    expect(h.merges()).toHaveLength(0);
    gate.resolve({ success: false, submissionState: 'REJECTED', errorMsg: 'venue rejection' });
    expect(await reb).toMatchObject({ success: false, error: /venue rejection/ });
    expect(h.active.size).toBe(0);
    expect(h.writers.size).toBe(0);
  });

  it('rebalance SPLIT parked in ctf.split → settle(true) and clear(true) withheld', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const gate = deferred<{ txHash: string }>();
    h.ctf.split.mockImplementationOnce(() => gate.promise);
    const reb = h.service.rebalance(act('split', 5));
    await macrotask();
    expect(h.ctf.split).toHaveBeenCalledTimes(1);
    expectSettleWithheld(await h.settle());
    expectClearWithheld(await h.clear());
    expect(h.merges()).toHaveLength(0);
    gate.resolve({ txHash: 'split-tx' });
    expect(await reb).toMatchObject({ success: true, txHash: 'split-tx' });
    expect(h.active.size).toBe(0);
  });

  it('race-1 replay: rebalance parked in its authoritative read → settle/clear cannot merge or install a record under that snapshot', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const reb = h.service.rebalance(act('sell_yes', 5));
    expect(h.active.has('condition')).toBe(true);
    expect(h.writers.size).toBe(1);
    h.ctf.mergeByTokenIds.mockRejectedValue(provenanceError('UNCERTAIN', MERGE_TX));
    expectSettleWithheld(await h.settle());
    expectClearWithheld(await h.clear());
    expect(h.merges()).toHaveLength(0);
    expect(h.pendingMerges.size).toBe(0);
    h.modes.sell = 'filled';
    gate.resolve('100');
    expect(await reb).toMatchObject({ success: true, facts: { soldShares: 5 } });
    expect(h.active.size).toBe(0);
  });
});

describe('P0.3H6 calculated rebalance authority', () => {
  it('rebalance() derives MERGE from ONE authoritative read taken under the shared interlock', async () => {
    const h = fixture(inv(0, 50, 50), inv(0, 50, 50));
    Object.assign(h.service, { totalCapital: 50 });
    const planned = h.service.calculateRebalanceAction();
    expect(planned).toMatchObject({ type: 'merge', amount: 12.5 });
    const held = await h.holdNextMerge(() => h.service.rebalance());
    expect(h.ctf.getPositionBalanceByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.ctf.getPusdBalance).toHaveBeenCalledTimes(1);
    expect(h.merges()[0][2]).toBe('12.5');
    held.release();
    expect(await held.flight).toMatchObject({ success: true, txHash: MERGE_TX, action: { type: 'merge', amount: 12.5 } });
    expect(h.reads()).toBe(4); // one authoritative read + one post-write refresh
    expect(h.events).toHaveBeenCalledTimes(1);
  });
});

describe('P0.3H6 rebalance MERGE outcomes', () => {
  it('normal confirmed merge: success:true, client txHash, one event, no record, guards released', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const action = act('merge', 5);
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: true, action, txHash: MERGE_TX });
    expect(h.merges()).toHaveLength(1);
    expect(h.merges()[0][2]).toBe('5');
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toBe(result);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.active.size).toBe(0);
    expect(h.writers.size).toBe(0);
    expect(h.reads()).toBe(4);
  });

  it('NOT_SUBMITTED: failure, no record, one failure event, no same-call retry; a later call merges from a fresh read', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('NOT_SUBMITTED', undefined, 'gas estimation failed'));
    const action = act('merge', 5);
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, action, error: 'gas estimation failed' });
    expect(result.pending).toBeUndefined();
    expect(h.merges()).toHaveLength(1);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: false, error: 'gas estimation failed' });
    expect(h.reads()).toBe(2); // no post-failure refresh
    h.clearReads();
    expect(await h.service.rebalance(action)).toMatchObject({ success: true, txHash: MERGE_TX });
    expect(h.merges()).toHaveLength(2);
    expect(h.reads()).toBe(4);
  });

  it.each([
    ['SUBMITTED with hash', provenanceError('SUBMITTED', MERGE_TX), 'SUBMITTED', MERGE_TX, 'merge outcome submitted: tx.wait timeout'],
    ['UNCERTAIN with hash', provenanceError('UNCERTAIN', MERGE_TX), 'UNCERTAIN', MERGE_TX, 'merge outcome uncertain: tx.wait timeout'],
    ['UNCERTAIN without hash', provenanceError('UNCERTAIN'), 'UNCERTAIN', undefined, 'merge outcome uncertain: tx.wait timeout'],
    ['CONFIRMED with malformed hash', provenanceError('CONFIRMED', 'not-a-hash'), 'UNCERTAIN', undefined, 'merge outcome uncertain: tx.wait timeout'],
    ['plain Error', new Error('socket hang up'), 'UNKNOWN', undefined, 'merge outcome unknown: socket hang up'],
    ['non-Error throw', 'string failure', 'UNKNOWN', undefined, 'merge outcome unknown: string failure'],
  ] as const)('%s → pending record installed before the interlock releases, pending result, no event', async (_label, error, provenance, txHash, detail) => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(error);
    // The record must already own the market when the guard is released.
    const recordAtRelease: boolean[] = [];
    const originalDelete = h.active.delete.bind(h.active);
    vi.spyOn(h.active, 'delete').mockImplementation(key => { recordAtRelease.push(h.pendingMerges.has('condition')); return originalDelete(key); });
    const action = act('merge', 5);
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, pending: true, action, operationId: 'clear-merge-1', ...(txHash ? { txHash } : {}),
      error: `MERGE_PENDING: 5 pairs unresolved (${detail})` });
    expect(result.action).toBe(action);
    expect(recordAtRelease).toEqual([true]);
    const record = h.pendingMerges.get('condition');
    expect(record).toMatchObject({ id: 'clear-merge-1', pairs: 5, provenance, market: { conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no' } });
    expect(record?.txHash).toBe(txHash);
    expect(record?.error).toBe(error instanceof Error ? error.message : String(error));
    expect(h.events).not.toHaveBeenCalled();
    expect(h.reads()).toBe(2); // authoritative read only; nothing is inferred from balances afterwards
    expect(h.active.size).toBe(0);
    expect(h.writers.size).toBe(0);
    // Same-call and later retries are forbidden: the next call reconciles instead of merging.
    h.clearReads();
    const again = await h.service.rebalance(action);
    expect(again).toMatchObject({ success: false, pending: true, operationId: 'clear-merge-1', action: existingMerge(5) });
    expect(h.merges()).toHaveLength(1);
    expect(h.reads()).toBe(0);
    if (!txHash) expect(h.ctf.getTransactionStatus).not.toHaveBeenCalled();
  });

  it('CONFIRMED-at-throw: success:true with the provenance hash, no record, one event, one merge', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('CONFIRMED', OTHER_TX, 'receipt parse failed'));
    const action = act('merge', 5);
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: true, action, txHash: OTHER_TX });
    expect(h.merges()).toHaveLength(1);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toBe(result);
    expect(h.reads()).toBe(4); // post-confirmation refresh
  });

  it('a failed post-write refresh does not demote a confirmed merge', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    h.ctf.getPusdBalance.mockResolvedValueOnce('100').mockRejectedValueOnce(new Error('rpc'));
    const result = await h.service.rebalance(act('merge', 5));
    expect(result).toMatchObject({ success: true, txHash: MERGE_TX });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: true });
  });

  it('event safety: a listener throw after a confirmed merge surfaces to the caller without a contradictory failure event or a second merge', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    h.service.on('rebalance', () => { throw new Error('listener exploded'); });
    await expect(h.service.rebalance(act('merge', 5))).rejects.toThrow('listener exploded');
    expect(h.merges()).toHaveLength(1);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: true, txHash: MERGE_TX });
    expect(h.pendingMerges.size).toBe(0);
    expect(h.active.size).toBe(0);
    expect(h.writers.size).toBe(0);
  });
});

describe('P0.3H6 an existing pending merge owns every rebalance write', () => {
  it.each([
    ['rebalance()', undefined],
    ['caller SELL', act('sell_yes', 5)],
    ['caller SPLIT', act('split', 5)],
    ['caller MERGE', act('merge', 5)],
  ])('%s with an unresolved record: zero balance read, zero write, result describes the existing merge, no event', async (_label, action) => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const record = await h.openRebalancePendingMerge();
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, pending: true, action: existingMerge(5), operationId: 'clear-merge-1', txHash: MERGE_TX,
      error: 'MERGE_PENDING: 5 pairs unresolved (transaction pending; not proof of execution or non-execution)' });
    expect(result.action.type).toBe('merge');
    if (action) expect(result.action).not.toBe(action);
    expect(h.ctf.getTransactionStatus).toHaveBeenCalledWith(MERGE_TX);
    expect(h.reads()).toBe(0);
    expect(h.sells()).toHaveLength(0);
    expect(h.ctf.split).not.toHaveBeenCalled();
    expect(h.merges()).toHaveLength(1);
    expect(h.pendingMerges.get('condition')).toBe(record);
    expect(h.events).not.toHaveBeenCalled();
    expect(h.active.size).toBe(0);
    expect(h.writers.size).toBe(0);
  });

  it.each([
    ['status pending', (h: H) => { h.statuses[MERGE_TX] = txStatus('pending'); }, 'transaction pending'],
    ['status failed (not found / RPC failure)', (h: H) => { h.statuses[MERGE_TX] = txStatus('failed', MERGE_TX, { errorReason: 'Transaction not found' }); }, 'transaction failed'],
    ['status for a different hash', (h: H) => { h.statuses[MERGE_TX] = txStatus('confirmed', OTHER_TX); }, 'status for a different transaction'],
    ['status lookup throws', (h: H) => { h.ctf.getTransactionStatus.mockRejectedValueOnce(new Error('rpc down')); }, 'status unavailable'],
  ])('%s → record remains, pending result, no event, no write', async (_label, arrange, reason) => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const record = await h.openRebalancePendingMerge();
    arrange(h);
    const result = await h.service.rebalance(act('split', 5));
    expect(result).toMatchObject({ success: false, pending: true, operationId: 'clear-merge-1', txHash: MERGE_TX,
      error: `MERGE_PENDING: 5 pairs unresolved (${reason}; not proof of execution or non-execution)` });
    expect(h.pendingMerges.get('condition')).toBe(record);
    expect(h.reads()).toBe(0);
    expect(h.ctf.split).not.toHaveBeenCalled();
    expect(h.merges()).toHaveLength(1);
    expect(h.events).not.toHaveBeenCalled();
  });

  it('no-hash record: pending indefinitely, no status lookup, no balance inference, no retry', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const record = await h.openRebalancePendingMerge(provenanceError('UNCERTAIN'));
    expect(record.txHash).toBeUndefined();
    for (const action of [undefined, act('merge', 5), act('sell_no', 5)]) {
      const result = await h.service.rebalance(action);
      expect(result).toEqual({ success: false, pending: true, action: existingMerge(5), operationId: 'clear-merge-1',
        error: 'MERGE_PENDING: 5 pairs unresolved (no transaction identity; cannot be proven)' });
      expect(result.txHash).toBeUndefined();
    }
    expect(h.ctf.getTransactionStatus).not.toHaveBeenCalled();
    expect(h.reads()).toBe(0);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells()).toHaveLength(0);
    expect(h.pendingMerges.get('condition')).toBe(record);
    expect(h.events).not.toHaveBeenCalled();
  });

  it('confirmed reconciliation: record deleted, success event exactly once, no new merge, caller action not executed', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.openRebalancePendingMerge();
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const callerSplit = act('split', 5);
    const result = await h.service.rebalance(callerSplit);
    expect(result).toEqual({ success: true, action: existingMerge(5), operationId: 'clear-merge-1', txHash: MERGE_TX });
    expect(result.action).not.toBe(callerSplit);
    expect(h.ctf.split).not.toHaveBeenCalled();
    expect(h.merges()).toHaveLength(1);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toBe(result);
    expect(h.reads()).toBe(2); // guarded post-confirmation refresh only
    expect(h.active.size).toBe(0);
    expect(h.writers.size).toBe(0);
  });

  it('reverted reconciliation: record deleted, failure event exactly once, no same-call write; a later call re-plans fresh', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.openRebalancePendingMerge();
    h.statuses[MERGE_TX] = txStatus('reverted', MERGE_TX, { errorReason: 'insufficient balance' });
    const result = await h.service.rebalance(act('split', 5));
    expect(result).toEqual({ success: false, action: existingMerge(5), operationId: 'clear-merge-1', txHash: MERGE_TX,
      error: 'Merge reverted on-chain: insufficient balance' });
    expect(result.pending).toBeUndefined();
    expect(h.ctf.split).not.toHaveBeenCalled();
    expect(h.merges()).toHaveLength(1);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: false, error: /reverted/ });
    expect(h.reads()).toBe(0);
    // Released: the next call is a normal fresh-authority write.
    expect(await h.service.rebalance(act('split', 5))).toMatchObject({ success: true, txHash: 'split-tx' });
    expect(h.ctf.split).toHaveBeenCalledTimes(1);
  });

  it('a confirmed reconciliation whose refresh fails is still reported as confirmed', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.openRebalancePendingMerge();
    h.statuses[MERGE_TX] = txStatus('confirmed');
    h.ctf.getPositionBalanceByTokenIds.mockRejectedValueOnce(new Error('rpc'));
    const result = await h.service.rebalance();
    expect(result).toMatchObject({ success: true, operationId: 'clear-merge-1' });
    expect(h.events).toHaveBeenCalledTimes(1);
  });
});

describe('P0.3H6 cross-entrypoint reconciliation', () => {
  it('rebalance-origin pending merge → settlePosition(true) reconciles it (confirmed) and releases the market', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.openRebalancePendingMerge();
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const result = await h.settle();
    expect(result).toMatchObject({ merged: true, mergeAmount: 5, usdcRecovered: 5, operationId: 'clear-merge-1', mergeTxHash: MERGE_TX });
    expect(h.merges()).toHaveLength(1);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.events).not.toHaveBeenCalled(); // the settle entrypoint reports through its own event
    expect(h.settles).toHaveBeenCalledTimes(1);
    // A second observer finds no record and takes the fresh path.
    h.clearReads();
    expect(await h.service.rebalance(act('split', 5))).toMatchObject({ success: true, txHash: 'split-tx' });
    expect(h.reads()).toBe(4);
  });

  it('rebalance-origin pending merge → clearPositions(true) reconciles it (confirmed)', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.openRebalancePendingMerge();
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const result = await h.clear();
    expect(result).toMatchObject({ success: true, totalUsdcRecovered: 5,
      actions: [{ type: 'merge', amount: 5, usdcResult: 5, success: true, operationId: 'clear-merge-1', txHash: MERGE_TX }] });
    expect(h.merges()).toHaveLength(1);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.events).not.toHaveBeenCalled();
  });

  it('rebalance-origin pending merge → settle sees it still pending, then rebalance sees it reverted: released exactly once', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const record = await h.openRebalancePendingMerge();
    expect(await h.settle()).toMatchObject({ pending: true, operationId: 'clear-merge-1', merged: false });
    expect(h.pendingMerges.get('condition')).toBe(record);
    h.statuses[MERGE_TX] = txStatus('reverted');
    expect(await h.service.rebalance()).toMatchObject({ success: false, operationId: 'clear-merge-1', error: /reverted/ });
    expect(h.pendingMerges.size).toBe(0);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.merges()).toHaveLength(1);
  });

  it('settle-origin pending merge → rebalance reconciles it: pending, then confirmed with the settle pairs, no caller write', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('SUBMITTED', MERGE_TX));
    expect(await h.settle()).toMatchObject({ pending: true, operationId: 'clear-merge-1', pairedTokens: 20 });
    const record = h.pendingMerges.get('condition')!;
    expect(record.pairs).toBe(20);
    h.clearReads();
    const callerSell = act('sell_yes', 5);
    expect(await h.service.rebalance(callerSell)).toMatchObject({ success: false, pending: true, operationId: 'clear-merge-1', action: existingMerge(20) });
    expect(h.reads()).toBe(0);
    expect(h.sells()).toHaveLength(0);
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const confirmed = await h.service.rebalance(callerSell);
    expect(confirmed).toEqual({ success: true, action: existingMerge(20), operationId: 'clear-merge-1', txHash: MERGE_TX });
    expect(confirmed.action).not.toBe(callerSell);
    expect(h.sells()).toHaveLength(0);
    expect(h.merges()).toHaveLength(1);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.events).toHaveBeenCalledTimes(1);
  });

  it('clear-origin pending merge → rebalance reconciles it (reverted), then a later settle merges from a fresh read', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(new Error('nonce too low'));
    expect(await h.clear()).toMatchObject({ success: false, actions: [{ type: 'merge', pending: true, operationId: 'clear-merge-1' }] });
    expect(h.pendingMerges.get('condition')).toMatchObject({ pairs: 20, provenance: 'UNKNOWN' });
    // No hash: nothing can prove it; rebalance stays pending.
    expect(await h.service.rebalance(act('split', 5))).toMatchObject({ pending: true, operationId: 'clear-merge-1', action: existingMerge(20) });
    expect(h.ctf.split).not.toHaveBeenCalled();
    // Give the record identity out-of-band the way a client hash would have, then revert it.
    h.pendingMerges.get('condition')!.txHash = MERGE_TX;
    h.statuses[MERGE_TX] = txStatus('reverted');
    expect(await h.service.rebalance(act('split', 5))).toMatchObject({ success: false, operationId: 'clear-merge-1', error: /reverted/ });
    expect(h.pendingMerges.size).toBe(0);
    expect(h.ctf.split).not.toHaveBeenCalled();
    expect(await h.settle()).toMatchObject({ merged: true, mergeAmount: 20 });
    expect(h.merges()).toHaveLength(2);
  });

  it('exactly-once: rebalance-origin confirmed record is booked by whichever observer runs first; the others take the fresh path', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.openRebalancePendingMerge();
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const first = await h.service.rebalance();
    expect(first).toMatchObject({ success: true, operationId: 'clear-merge-1' });
    const settle = await h.settle();
    expect(settle.operationId).toBeUndefined();
    expect(settle).toMatchObject({ merged: true, mergeAmount: 20 }); // fresh read, its own merge
    expect(h.merges()).toHaveLength(2);
    expect(h.events).toHaveBeenCalledTimes(1);
  });
});

describe('P0.3H6 neighbours unchanged', () => {
  it('H3: rebalance A in its fresh read → rebalance B refused by the writer (before the shared interlock check)', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const a = h.service.rebalance(act('merge', 5));
    expect(h.writers.size).toBe(1);
    expect(h.active.has('condition')).toBe(true);
    const b = await h.service.rebalance(act('merge', 5));
    expect(b).toEqual({ success: false, action: act('merge', 5), error: 'Rebalance withheld: another rebalance owns this market' });
    gate.resolve('100');
    expect(await a).toMatchObject({ success: true, txHash: MERGE_TX });
    expect(h.merges()).toHaveLength(1);
    expect(h.writers.size).toBe(0);
    expect(h.active.size).toBe(0);
  });

  it('H3: an explicit merge above fresh pairs is withheld without resize; guards released', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 3));
    const action = act('merge', 5);
    expect(await h.service.rebalance(action)).toEqual({ success: false, action, error: 'Rebalance withheld: merge 5 exceeds fresh paired tokens 3' });
    expect(h.merges()).toHaveLength(0);
    expect(h.active.size).toBe(0);
    expect(h.writers.size).toBe(0);
  });

  it('H3: a failed authoritative read withholds and releases both guards', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    h.ctf.getPusdBalance.mockRejectedValueOnce(new Error('rpc'));
    expect(await h.service.rebalance(act('merge', 5))).toMatchObject({ success: false, error: 'Fresh balance refresh failed; rebalance withheld' });
    expect(h.merges()).toHaveLength(0);
    expect(h.active.size).toBe(0);
    expect(h.writers.size).toBe(0);
  });

  it('H4: a pending LONG refuses rebalance(merge) before the interlock is even consulted', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const ack = await h.service.execute(longOpp);
    expect(ack).toMatchObject({ pending: true, operationId: 'long-1' });
    h.clearReads();
    const result = await h.service.rebalance(act('merge', 5));
    expect(result).toEqual({ success: false, action: act('merge', 5), error: 'Rebalance withheld: long arb long-1 pending factual reconciliation' });
    expect(h.reads()).toBe(0);
    expect(h.merges()).toHaveLength(0);
    expect(h.active.size).toBe(0);
  });

  it('H5: a pending rebalance SELL refuses rebalance(merge) and rebalance() before any read', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const ack = await h.service.rebalance(act('sell_yes', 5));
    expect(ack).toMatchObject({ success: false, pending: true, operationId: 'rebalance-sell-1' });
    h.clearReads();
    expect(await h.service.rebalance(act('merge', 5))).toEqual({ success: false, action: act('merge', 5),
      error: 'Rebalance withheld: SELL rebalance-sell-1 pending factual reconciliation' });
    expect(await h.service.rebalance()).toMatchObject({ error: 'Rebalance withheld: SELL rebalance-sell-1 pending factual reconciliation' });
    expect(h.reads()).toBe(0);
    expect(h.merges()).toHaveLength(0);
    expect(h.active.size).toBe(0);
  });

  it('H5 → H6: once the SELL is factual and published, a merge runs under the shared interlock', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.service.rebalance(act('sell_yes', 5));
    h.fillSell('r1');
    await h.service['flushPendingRebalanceSells']();
    expect(h.pendingSells.size).toBe(0);
    const held = await h.holdNextMerge(() => h.service.rebalance(act('merge', 5)));
    expectSettleWithheld(await h.settle());
    held.release();
    expect(await held.flight).toMatchObject({ success: true, txHash: MERGE_TX });
  });

  it('H1: settle ∥ settle and settle-origin → clear reconciliation are unchanged', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const held = await h.holdNextMerge(() => h.settle());
    expectSettleWithheld(await h.settle());
    held.fail(provenanceError('UNCERTAIN', MERGE_TX));
    expect(await held.flight).toMatchObject({ pending: true, operationId: 'clear-merge-1' });
    h.statuses[MERGE_TX] = txStatus('confirmed');
    expect(await h.clear()).toMatchObject({ success: true, totalUsdcRecovered: 20, actions: [{ type: 'merge', success: true, operationId: 'clear-merge-1' }] });
    expect(h.pendingMerges.size).toBe(0);
    expect(h.merges()).toHaveLength(1);
  });

  it('dry runs never take or observe the interlock', async () => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    const held = await h.holdNextMerge(() => h.service.rebalance(act('merge', 5)));
    expect(await h.settle(false)).toMatchObject({ merged: false, pairedTokens: 20 });
    expect(await h.clear(false)).toMatchObject({ success: true, actions: [expect.objectContaining({ type: 'merge' })] });
    expect(h.merges()).toHaveLength(1);
    held.release();
    expect(await held.flight).toMatchObject({ success: true });
  });
});
