import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageMarketConfig, type ClearPositionResult, type SettleResult } from './arbitrage-service.js';
import { MergeProvenanceError, type MergeProvenance, type TransactionStatus } from '../clients/ctf-client.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
type Balances = { yesBalance: string; noBalance: string };
type Emitted = SettleResult | ClearPositionResult;
const services: ArbitrageService[] = [];
const HASH = (n: string) => '0x' + n.repeat(32);
const MERGE_TX = HASH('ab');
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const tick = () => new Promise<void>(r => setImmediate(r));

/** Deferred whose settlement is controlled by the test. */
function gate<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const provenanceError = (state: MergeProvenance['state'], transactionHash?: string, message = 'tx.wait timeout') =>
  new MergeProvenanceError(new Error(message), { state, ...(transactionHash ? { transactionHash } : {}) });
const txStatus = (status: TransactionStatus['status'], txHash = MERGE_TX, extra: Partial<TransactionStatus> = {}): TransactionStatus =>
  ({ txHash, status, confirmations: status === 'confirmed' || status === 'reverted' ? 3 : 0, ...extra });

const taker = (id: string, orderId: string, asset: string, size: string, price: string, hash = HASH('11')) => ({
  id, status: 'MINED', size, price, transactionHash: hash, asset_id: asset, side: 'SELL', taker_order_id: orderId, trader_side: 'TAKER', maker_orders: [],
});

/**
 * Active market A, YES 10 / NO 10 by default; market B 4 / 4. A clear residual SELL of YES fills as
 * `cy`, of NO as `cn`. `getTransactionStatus` answers from `statuses` (default: pending).
 */
function fixture(options: { yes?: string; no?: string } = {}) {
  const service = new ArbitrageService({ enableLogging: false, minTradeSize: 1 });
  services.push(service);
  const marketA: ArbitrageMarketConfig = { name: 'A', conditionId: 'cond-a', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const marketB: ArbitrageMarketConfig = { name: 'B', conditionId: 'cond-b', yesTokenId: 'yes-b', noTokenId: 'no-b', negRisk: false };
  const balances: Record<string, Balances> = {
    'cond-a': { yesBalance: options.yes ?? '10', noBalance: options.no ?? '10' },
    'cond-b': { yesBalance: '4', noBalance: '4' },
  };
  const trades: Record<string, ReturnType<typeof taker>> = {
    ty: taker('ty', 'cy', 'yes', '10', '0.55', HASH('11')),
    tn: taker('tn', 'cn', 'no', '10', '0.45', HASH('22')),
  };
  const orders: Record<string, OrderRow> = {
    cy: { id: 'cy', asset_id: 'yes', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['ty'], sizeMatched: '10' },
    cn: { id: 'cn', asset_id: 'no', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['tn'], sizeMatched: '10' },
  };
  const statuses: Record<string, TransactionStatus> = {};
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>(async order => accepted(order.tokenId === 'yes' ? 'cy' : 'cn')),
    getOrderFillDetails: vi.fn(async (id: string) => {
      const row = orders[id];
      if (!row) throw new Error(`unknown order ${id}`);
      return { ...row, tradeIds: [...row.tradeIds] };
    }),
    getTradeStatuses: vi.fn(async (ids: string[]): Promise<TradeStatus[]> =>
      ids.map(id => (trades[id] ?? { id, status: 'UNKNOWN' }) as unknown as TradeStatus)),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue('wallet'),
    getPusdBalance: vi.fn(async () => '100'),
    getPositionBalanceByTokenIds: vi.fn(async (conditionId: string) => ({ ...balances[conditionId] })),
    getMarketResolution: vi.fn(async (_conditionId: string): Promise<{ isResolved: boolean; winningOutcome?: string }> => ({ isResolved: false })),
    mergeByTokenIds: vi.fn(async (_c: string, _t: unknown, amount: string) => ({ success: true, txHash: MERGE_TX, amount })),
    redeemByTokenIds: vi.fn(),
    getTransactionStatus: vi.fn(async (txHash: string): Promise<TransactionStatus> => statuses[txHash] ?? txStatus('pending', txHash)),
    split: vi.fn(),
  };
  Object.assign(service, { tradingService: trading, ctf });
  const settles = vi.fn<(result: Emitted) => void>();
  service.on('settle', settles);
  const logs: string[] = [];
  vi.spyOn(service as unknown as { log: (m: string) => void }, 'log').mockImplementation(m => { logs.push(m); });
  const pendingMerges = service['pendingClearMerges'];
  const active = service['activeClearMarkets'];
  const settle = (market: ArbitrageMarketConfig = marketA, execute = true) => service.settlePosition(market, execute);
  const clear = (market: ArbitrageMarketConfig = marketA, execute = true) => service.clearPositions(market, execute);
  const merges = () => ctf.mergeByTokenIds.mock.calls;
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  const reads = () => ctf.getPositionBalanceByTokenIds.mock.calls;
  /** Positive recovery across every emitted settle result, whichever entrypoint produced it. */
  const emittedRecovery = () => settles.mock.calls.reduce((acc, [r]) =>
    acc + ('totalUsdcRecovered' in r ? r.totalUsdcRecovered : r.usdcRecovered ?? 0), 0);
  return { service, marketA, marketB, balances, statuses, trading, ctf, settles, logs, pendingMerges, active, settle, clear, merges, sells, reads, emittedRecovery };
}
type H = ReturnType<typeof fixture>;

/** Holds a settle inside its merge so a second call overlaps its economic phase. */
async function startHeldSettleMerge(h: H) {
  const merge = gate<{ success: true; txHash: string; amount: string }>();
  h.ctf.mergeByTokenIds.mockImplementationOnce(() => merge.promise);
  const a = h.settle();
  await tick(); await tick();
  expect(h.merges()).toHaveLength(1);
  expect(h.active.has('cond-a')).toBe(true);
  return { a, merge };
}

/** The losing concurrent settle: no read, no write, no recovery, explicit withheld non-success, no event. */
function expectSettleWithheld(h: H, result: SettleResult, market: ArbitrageMarketConfig = h.marketA) {
  expect(result).toEqual({
    market, yesBalance: 0, noBalance: 0, pairedTokens: 0, unpairedYes: 0, unpairedNo: 0, merged: false, withheld: true,
    error: expect.stringMatching(/^settlePosition withheld: another clear or settle operation is active/),
  });
  expect(result.usdcRecovered).toBeUndefined();
  expect(result.pending).toBeUndefined();
  expect(h.logs).toContainEqual(expect.stringMatching(/⏸️ settlePosition withheld for A/));
}

/** The initial settle whose merge is unresolved: nothing booked, one record installed, guard released. */
function expectUnresolvedInitialSettle(h: H, result: SettleResult, txHash?: string) {
  expect(result).toMatchObject({ yesBalance: 10, noBalance: 10, pairedTokens: 10, merged: false, pending: true, operationId: 'clear-merge-1',
    error: expect.stringMatching(/^MERGE_PENDING: 10 pairs unresolved \(merge outcome /) });
  expect(result.usdcRecovered).toBeUndefined();
  expect(result.mergeAmount).toBeUndefined();
  expect(result.withheld).toBeUndefined();
  if (txHash) expect(result.mergeTxHash).toBe(txHash); else expect(result.mergeTxHash).toBeUndefined();
  expect(h.pendingMerges.size).toBe(1);
  const record = h.pendingMerges.get('cond-a');
  expect(record).toMatchObject({ id: 'clear-merge-1', pairs: 10, market: { conditionId: 'cond-a', yesTokenId: 'yes', noTokenId: 'no' } });
  expect(record?.txHash).toBe(txHash);
  expect(h.active.size).toBe(0);
  expect(h.merges()).toHaveLength(1);
}

/** A later settle that finds the merge still unresolved: no read, no write, no recovery, record retained. */
function expectSettleStillPending(h: H, result: SettleResult, readsBefore: number, mergesBefore = 1) {
  expect(h.reads()).toHaveLength(readsBefore);
  expect(h.merges()).toHaveLength(mergesBefore);
  expect(h.sells()).toEqual([]);
  expect(result).toMatchObject({ yesBalance: 0, noBalance: 0, pairedTokens: 0, merged: false, pending: true, operationId: 'clear-merge-1',
    error: expect.stringMatching(/^MERGE_PENDING: 10 pairs unresolved/) });
  expect(result.usdcRecovered).toBeUndefined();
  expect(result.withheld).toBeUndefined();
  expect(h.pendingMerges.get('cond-a')?.id).toBe('clear-merge-1');
}

/** Installs an unresolved merge from settle (UNCERTAIN with hash) and clears event history. */
async function settleUnresolved(h: H) {
  h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', MERGE_TX));
  const first = await h.settle();
  expectUnresolvedInitialSettle(h, first, MERGE_TX);
  h.settles.mockClear();
  return first;
}

/** Installs an unresolved merge from clear (UNCERTAIN with hash) and clears event history. */
async function clearUnresolved(h: H) {
  h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', MERGE_TX));
  const first = await h.clear();
  expect(first.actions).toHaveLength(1);
  expect(first.actions[0]).toMatchObject({ type: 'merge', pending: true, operationId: 'clear-merge-1' });
  expect(h.pendingMerges.get('cond-a')?.id).toBe('clear-merge-1');
  h.settles.mockClear();
  return first;
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3H settlePosition shares the same-market merge interlock', () => {
  it('settle ∥ settle same market: at most one merge; the loser is withheld with zero reads, zero writes, no event', async () => {
    const h = fixture();
    const { a, merge } = await startHeldSettleMerge(h);
    const readsBefore = h.reads().length;
    const b = await h.settle();
    expectSettleWithheld(h, b);
    expect(h.reads()).toHaveLength(readsBefore);
    expect(h.merges()).toHaveLength(1);
    expect(h.settles).not.toHaveBeenCalled();
    merge.resolve({ success: true, txHash: MERGE_TX, amount: '10' });
    const ra = await a;
    expect(h.merges()).toHaveLength(1);
    expect(ra).toMatchObject({ merged: true, mergeAmount: 10, mergeTxHash: MERGE_TX, usdcRecovered: 10 });
    expect(ra.withheld).toBeUndefined();
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.settles).toHaveBeenCalledWith(ra);
    expect(h.active.size).toBe(0);
    expect(h.emittedRecovery()).toBe(10);
  });

  it('settle ∥ clear same market, settle first: clear is withheld and submits no second merge', async () => {
    const h = fixture();
    const { a, merge } = await startHeldSettleMerge(h);
    const readsBefore = h.reads().length;
    const c = await h.clear();
    expect(c.withheld).toBe(true);
    expect(c.totalUsdcRecovered).toBe(0);
    expect(h.reads()).toHaveLength(readsBefore);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells()).toEqual([]);
    merge.resolve({ success: true, txHash: MERGE_TX, amount: '10' });
    const ra = await a;
    expect(ra.usdcRecovered).toBe(10);
    expect(h.merges()).toHaveLength(1);
    expect(h.emittedRecovery()).toBe(10);
  });

  it('settle ∥ clear same market, clear first: settle is withheld and submits no second merge', async () => {
    const h = fixture();
    const merge = gate<{ success: true; txHash: string; amount: string }>();
    h.ctf.mergeByTokenIds.mockImplementationOnce(() => merge.promise);
    const c = h.clear();
    await tick(); await tick();
    expect(h.merges()).toHaveLength(1);
    expect(h.active.has('cond-a')).toBe(true);
    const readsBefore = h.reads().length;
    const s = await h.settle();
    expectSettleWithheld(h, s);
    expect(h.reads()).toHaveLength(readsBefore);
    expect(h.merges()).toHaveLength(1);
    merge.resolve({ success: true, txHash: MERGE_TX, amount: '10' });
    const rc = await c;
    expect(rc.totalUsdcRecovered).toBe(10);
    expect(h.merges()).toHaveLength(1);
    expect(h.emittedRecovery()).toBe(10);
  });

  it('after the first settle completes, a subsequent settle reads fresh and acts on remaining inventory', async () => {
    const h = fixture();
    const first = await h.settle();
    expect(first.usdcRecovered).toBe(10);
    h.balances['cond-a'] = { yesBalance: '3', noBalance: '3' };
    const second = await h.settle();
    expect(h.reads()).toHaveLength(2);
    expect(h.merges()).toHaveLength(2);
    expect(second).toMatchObject({ yesBalance: 3, noBalance: 3, merged: true, mergeAmount: 3, usdcRecovered: 3 });
    expect(h.active.size).toBe(0);
  });

  it('a synchronous early return (no CTF client) still releases the guard and emits nothing', async () => {
    const h = fixture();
    Object.assign(h.service, { ctf: null });
    const result = await h.settle();
    expect(result).toMatchObject({ merged: false, error: 'CTF client not configured' });
    expect(result.withheld).toBeUndefined();
    expect(h.active.size).toBe(0);
    expect(h.settles).not.toHaveBeenCalled();
  });

  it('different markets settle concurrently and each merges independently', async () => {
    const h = fixture();
    const { a, merge } = await startHeldSettleMerge(h);
    const rb = await h.settle(h.marketB);
    expect(rb).toMatchObject({ merged: true, mergeAmount: 4, usdcRecovered: 4 });
    expect(rb.withheld).toBeUndefined();
    expect(h.merges().map(([c]) => c)).toEqual(['cond-a', 'cond-b']);
    merge.resolve({ success: true, txHash: MERGE_TX, amount: '10' });
    const ra = await a;
    expect(ra.usdcRecovered).toBe(10);
    expect(h.active.size).toBe(0);
  });

  it('execute=false while execute=true is running stays write-free and neither takes nor releases the live guard', async () => {
    const h = fixture();
    const { a, merge } = await startHeldSettleMerge(h);
    const plan = await h.settle(h.marketA, false);
    expect(plan).toMatchObject({ yesBalance: 10, noBalance: 10, pairedTokens: 10, merged: false });
    expect(plan.withheld).toBeUndefined();
    expect(h.merges()).toHaveLength(1);
    expect(h.active.has('cond-a')).toBe(true);
    merge.resolve({ success: true, txHash: MERGE_TX, amount: '10' });
    await a;
    expect(h.active.size).toBe(0);
  });

  it('execute=false alone never touches the interlock', async () => {
    const h = fixture();
    const addSpy = vi.spyOn(h.active, 'add');
    const plan = await h.settle(h.marketA, false);
    expect(plan.merged).toBe(false);
    expect(h.merges()).toHaveLength(0);
    expect(addSpy).not.toHaveBeenCalled();
    expect(h.active.size).toBe(0);
  });
});

describe('P0.3H settlePosition initial merge throw classification', () => {
  it('UNCERTAIN with tx hash: record installed before the guard releases, pending result, zero recovery', async () => {
    const h = fixture();
    let activeAtInstall: boolean | undefined;
    const setSpy = vi.spyOn(h.pendingMerges, 'set').mockImplementation(function (this: Map<string, unknown>, k, v) {
      activeAtInstall = h.active.has('cond-a');
      return Map.prototype.set.call(this, k, v) as typeof h.pendingMerges;
    });
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', MERGE_TX));
    const result = await h.settle();
    expectUnresolvedInitialSettle(h, result, MERGE_TX);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(activeAtInstall).toBe(true);
    expect(result.error).toMatch(/merge outcome uncertain: tx\.wait timeout/);
    expect(h.pendingMerges.get('cond-a')?.provenance).toBe('UNCERTAIN');
    expect(h.logs).toContainEqual(expect.stringMatching(/⏳ Merge outcome uncertain \(clear-merge-1, tx 0xab/));
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.emittedRecovery()).toBe(0);
  });

  it('SUBMITTED provenance: identical conservative behaviour', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('SUBMITTED', MERGE_TX, 'socket hang up'));
    const result = await h.settle();
    expectUnresolvedInitialSettle(h, result, MERGE_TX);
    expect(result.error).toMatch(/merge outcome submitted: socket hang up/);
    expect(h.pendingMerges.get('cond-a')?.provenance).toBe('SUBMITTED');
  });

  it('UNCERTAIN without tx hash: pending now, no second merge later from either entrypoint, no balance inference', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN'));
    const result = await h.settle();
    expectUnresolvedInitialSettle(h, result, undefined);
    const laterSettle = await h.settle();
    expectSettleStillPending(h, laterSettle, 1);
    expect(laterSettle.mergeTxHash).toBeUndefined();
    expect(laterSettle.error).toMatch(/no transaction identity; cannot be proven/);
    const laterClear = await h.clear();
    expect(laterClear.actions).toHaveLength(1);
    expect(laterClear.actions[0]).toMatchObject({ type: 'merge', pending: true, operationId: 'clear-merge-1', usdcResult: 0 });
    expect(h.reads()).toHaveLength(1);
    expect(h.merges()).toHaveLength(1);
    expect(h.ctf.getTransactionStatus).not.toHaveBeenCalled();
    expect(h.pendingMerges.get('cond-a')?.id).toBe('clear-merge-1');
  });

  it('a malformed provenance hash is treated as no identity', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', '0xnothex'));
    const result = await h.settle();
    expectUnresolvedInitialSettle(h, result, undefined);
  });

  it('plain untyped throw: unresolved UNKNOWN record, no blind retry, no recovery', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await h.settle();
    expectUnresolvedInitialSettle(h, result, undefined);
    expect(result.error).toMatch(/merge outcome unknown: ECONNRESET/);
    expect(h.pendingMerges.get('cond-a')?.provenance).toBe('UNKNOWN');
    const later = await h.settle();
    expectSettleStillPending(h, later, 1);
  });

  it('a non-Error throw is also unresolved', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce('boom');
    const result = await h.settle();
    expectUnresolvedInitialSettle(h, result, undefined);
    expect(result.error).toMatch(/merge outcome unknown: boom/);
  });

  it('NOT_SUBMITTED: ordinary failure result, no record, no same-call retry; a later call reads fresh and may merge', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('NOT_SUBMITTED', undefined, 'Insufficient token balance'));
    const result = await h.settle();
    expect(result).toMatchObject({ yesBalance: 10, noBalance: 10, pairedTokens: 10, merged: false, error: 'Insufficient token balance' });
    expect(result.pending).toBeUndefined();
    expect(result.withheld).toBeUndefined();
    expect(result.operationId).toBeUndefined();
    expect(result.usdcRecovered).toBeUndefined();
    expect(h.pendingMerges.size).toBe(0);
    expect(h.merges()).toHaveLength(1);
    expect(h.active.size).toBe(0);
    expect(h.logs).toContainEqual(expect.stringMatching(/❌ Merge failed: Insufficient token balance/));

    const next = await h.settle();
    expect(h.reads()).toHaveLength(2);
    expect(h.merges()).toHaveLength(2);
    expect(next).toMatchObject({ merged: true, mergeAmount: 10, usdcRecovered: 10 });
  });

  it('CONFIRMED provenance with a valid hash thrown after receipt: factual success booked once, no record', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('CONFIRMED', MERGE_TX, 'formatUnits failed'));
    const result = await h.settle();
    expect(result).toMatchObject({ yesBalance: 10, noBalance: 10, merged: true, mergeAmount: 10, mergeTxHash: MERGE_TX, usdcRecovered: 10 });
    expect(result.error).toBeUndefined();
    expect(result.pending).toBeUndefined();
    expect(h.pendingMerges.size).toBe(0);
    expect(h.active.size).toBe(0);
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.emittedRecovery()).toBe(10);
    expect(h.logs).toContainEqual(expect.stringMatching(/✅ Merge TX: 0xab.* \(confirmed; client error after receipt: formatUnits failed\)/));
  });

  it('CONFIRMED provenance without a valid hash is unresolved, not booked', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('CONFIRMED', undefined, 'receipt lost'));
    const result = await h.settle();
    expectUnresolvedInitialSettle(h, result, undefined);
    expect(h.pendingMerges.get('cond-a')?.provenance).toBe('UNCERTAIN');
  });
});

describe('P0.3H cross-entrypoint merge authority', () => {
  it('a pending clear merge blocks settle before any balance read: zero reads, zero writes, pending settle result', async () => {
    const h = fixture();
    await clearUnresolved(h);
    h.statuses[MERGE_TX] = txStatus('pending');
    const result = await h.settle();
    expectSettleStillPending(h, result, 1);
    expect(result.mergeTxHash).toBe(MERGE_TX);
    expect(result.error).toMatch(/transaction pending; not proof of execution or non-execution/);
    expect(h.ctf.getTransactionStatus).toHaveBeenCalledWith(MERGE_TX);
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.emittedRecovery()).toBe(0);
  });

  it('a pending settle merge blocks clear: zero reads, zero writes, zero SELL, pending clear action', async () => {
    const h = fixture();
    await settleUnresolved(h);
    h.statuses[MERGE_TX] = txStatus('pending');
    const later = await h.clear();
    expect(h.reads()).toHaveLength(1);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells()).toEqual([]);
    expect(later).toMatchObject({ yesBalance: 0, noBalance: 0, totalUsdcRecovered: 0, success: false });
    expect(later.withheld).toBeUndefined();
    expect(later.actions).toEqual([expect.objectContaining({ type: 'merge', amount: 0, usdcResult: 0, success: false, pending: true,
      operationId: 'clear-merge-1', txHash: MERGE_TX })]);
    expect(h.pendingMerges.get('cond-a')?.id).toBe('clear-merge-1');
  });

  it('a settle-installed record confirmed by clear books once; a following settle reads fresh and books nothing twice', async () => {
    const h = fixture();
    await settleUnresolved(h);
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const byClear = await h.clear();
    expect(byClear.actions).toEqual([{ type: 'merge', amount: 10, usdcResult: 10, txHash: MERGE_TX, success: true, operationId: 'clear-merge-1' }]);
    expect(byClear.totalUsdcRecovered).toBe(10);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.reads()).toHaveLength(1);
    expect(h.merges()).toHaveLength(1);

    h.balances['cond-a'] = { yesBalance: '0', noBalance: '0' };
    const next = await h.settle();
    expect(h.reads()).toHaveLength(2);
    expect(h.merges()).toHaveLength(1);
    expect(next).toMatchObject({ yesBalance: 0, noBalance: 0, merged: false });
    expect(next.usdcRecovered).toBeUndefined();
    expect(next.operationId).toBeUndefined();
    expect(h.emittedRecovery()).toBe(10);
  });

  it('a clear-installed record confirmed by settle books once; a following clear reads fresh and books nothing twice', async () => {
    const h = fixture();
    await clearUnresolved(h);
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const bySettle = await h.settle();
    expect(bySettle).toEqual({
      market: h.marketA, yesBalance: 0, noBalance: 0, pairedTokens: 0, unpairedYes: 0, unpairedNo: 0,
      merged: true, mergeAmount: 10, mergeTxHash: MERGE_TX, usdcRecovered: 10, operationId: 'clear-merge-1',
    });
    expect(h.pendingMerges.size).toBe(0);
    expect(h.reads()).toHaveLength(1);
    expect(h.merges()).toHaveLength(1);

    h.balances['cond-a'] = { yesBalance: '0', noBalance: '0' };
    const next = await h.clear();
    expect(h.reads()).toHaveLength(2);
    expect(h.merges()).toHaveLength(1);
    expect(next.actions).toEqual([]);
    expect(next.totalUsdcRecovered).toBe(0);
    expect(h.emittedRecovery()).toBe(10);
    expect(h.settles.mock.calls.filter(([r]) => ('totalUsdcRecovered' in r ? r.totalUsdcRecovered : r.usdcRecovered ?? 0) > 0)).toHaveLength(1);
  });

  it('concurrent settle and clear while a record is unresolved: one reconciles, the other is withheld, recovery booked once', async () => {
    const h = fixture();
    await settleUnresolved(h);
    let release!: (s: TransactionStatus) => void;
    h.ctf.getTransactionStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const s = h.settle();
    await tick(); await tick();
    expect(h.active.has('cond-a')).toBe(true);
    const c = await h.clear();
    expect(c.withheld).toBe(true);
    release(txStatus('confirmed'));
    const rs = await s;
    expect(rs.usdcRecovered).toBe(10);
    expect(h.merges()).toHaveLength(1);
    expect(h.reads()).toHaveLength(1);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.active.size).toBe(0);
    expect(h.emittedRecovery()).toBe(10);
  });

  it('a pending merge on market A does not affect settle or clear on market B', async () => {
    const h = fixture();
    await settleUnresolved(h);
    const sb = await h.settle(h.marketB);
    expect(sb).toMatchObject({ merged: true, mergeAmount: 4, usdcRecovered: 4 });
    h.balances['cond-b'] = { yesBalance: '2', noBalance: '2' };
    const cb = await h.clear(h.marketB);
    expect(cb.success).toBe(true);
    expect(h.merges().map(([c]) => c)).toEqual(['cond-a', 'cond-b', 'cond-b']);
    expect(h.pendingMerges.size).toBe(1);
    expect(h.pendingMerges.has('cond-b')).toBe(false);
  });

  it('dry run while a settle merge is unresolved performs no write and does not touch the record', async () => {
    const h = fixture();
    await settleUnresolved(h);
    const plan = await h.settle(h.marketA, false);
    expect(plan).toMatchObject({ yesBalance: 10, noBalance: 10, pairedTokens: 10, merged: false });
    expect(plan.pending).toBeUndefined();
    expect(h.merges()).toHaveLength(1);
    expect(h.ctf.getTransactionStatus).not.toHaveBeenCalled();
    expect(h.pendingMerges.get('cond-a')?.id).toBe('clear-merge-1');
    const clearPlan = await h.clear(h.marketA, false);
    expect(clearPlan.success).toBe(true);
    expect(h.merges()).toHaveLength(1);
    expect(h.pendingMerges.get('cond-a')?.id).toBe('clear-merge-1');
  });
});

describe('P0.3H settle reconciliation of an unresolved merge by transaction status', () => {
  it('pending status: later settle performs zero writes and zero reads; stays pending', async () => {
    const h = fixture();
    await settleUnresolved(h);
    h.statuses[MERGE_TX] = txStatus('pending');
    const later = await h.settle();
    expectSettleStillPending(h, later, 1);
    expect(later.mergeTxHash).toBe(MERGE_TX);
    expect(later.error).toMatch(/transaction pending; not proof of execution or non-execution/);
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.emittedRecovery()).toBe(0);
  });

  it('failed status (RPC failure / not found) is NOT non-execution: stays pending, no retry', async () => {
    const h = fixture();
    await settleUnresolved(h);
    h.statuses[MERGE_TX] = txStatus('failed', MERGE_TX, { errorReason: 'Transaction not found' });
    const later = await h.settle();
    expectSettleStillPending(h, later, 1);
    expect(later.error).toMatch(/transaction failed; not proof/);
    h.statuses[MERGE_TX] = txStatus('failed', MERGE_TX, { errorReason: 'RPC unreachable' });
    const again = await h.settle();
    expectSettleStillPending(h, again, 1);
    expect(h.logs.filter(m => /still unresolved \(transaction failed\)/.test(m))).toHaveLength(2);
  });

  it('status lookup throwing keeps the record pending', async () => {
    const h = fixture();
    await settleUnresolved(h);
    h.ctf.getTransactionStatus.mockRejectedValueOnce(new Error('provider down'));
    const later = await h.settle();
    expectSettleStillPending(h, later, 1);
    expect(later.error).toMatch(/status unavailable/);
    expect(h.logs).toContainEqual(expect.stringMatching(/status lookup failed: provider down/));
  });

  it('a status for a different transaction hash is not accepted', async () => {
    const h = fixture();
    await settleUnresolved(h);
    h.ctf.getTransactionStatus.mockResolvedValueOnce(txStatus('confirmed', HASH('ff')));
    const later = await h.settle();
    expectSettleStillPending(h, later, 1);
    expect(later.error).toMatch(/status for a different transaction/);
  });

  it('confirmed: recovery = recorded pairs exactly once, record released, no read and no new write in that call', async () => {
    const h = fixture();
    await settleUnresolved(h);
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const later = await h.settle();
    expect(h.reads()).toHaveLength(1);
    expect(h.merges()).toHaveLength(1);
    expect(later).toEqual({
      market: h.marketA, yesBalance: 0, noBalance: 0, pairedTokens: 0, unpairedYes: 0, unpairedNo: 0,
      merged: true, mergeAmount: 10, mergeTxHash: MERGE_TX, usdcRecovered: 10, operationId: 'clear-merge-1',
    });
    expect(h.pendingMerges.size).toBe(0);
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.settles).toHaveBeenCalledWith(later);
    expect(h.logs.filter(m => /✅ Merged: 10\.0000 pairs → \$10\.00 USDC \(clear-merge-1 confirmed on-chain\)/.test(m))).toHaveLength(1);

    h.balances['cond-a'] = { yesBalance: '0', noBalance: '1' };
    const next = await h.settle();
    expect(h.reads()).toHaveLength(2);
    expect(h.merges()).toHaveLength(1);
    expect(next).toMatchObject({ yesBalance: 0, noBalance: 1, pairedTokens: 0, merged: false });
    expect(next.usdcRecovered).toBeUndefined();
    expect(h.emittedRecovery()).toBe(10);
  });

  it('reverted: zero recovery, record released, no write in that call; the following call reads fresh and may act', async () => {
    const h = fixture();
    await settleUnresolved(h);
    h.statuses[MERGE_TX] = txStatus('reverted', MERGE_TX, { errorReason: 'ERC1155: insufficient balance' });
    const later = await h.settle();
    expect(h.reads()).toHaveLength(1);
    expect(h.merges()).toHaveLength(1);
    expect(later).toEqual({
      market: h.marketA, yesBalance: 0, noBalance: 0, pairedTokens: 0, unpairedYes: 0, unpairedNo: 0,
      merged: false, mergeTxHash: MERGE_TX, operationId: 'clear-merge-1', error: 'Merge reverted on-chain: ERC1155: insufficient balance',
    });
    expect(later.pending).toBeUndefined();
    expect(later.usdcRecovered).toBeUndefined();
    expect(h.pendingMerges.size).toBe(0);

    const next = await h.settle();
    expect(h.reads()).toHaveLength(2);
    expect(h.merges()).toHaveLength(2);
    expect(next).toMatchObject({ merged: true, mergeAmount: 10, usdcRecovered: 10 });
    expect(h.emittedRecovery()).toBe(10);
  });

  it('the record survives a lifecycle change: settle reconciles the transaction before clear may redeem', async () => {
    const h = fixture();
    await settleUnresolved(h);
    h.ctf.getMarketResolution.mockResolvedValue({ isResolved: true, winningOutcome: 'YES' });
    const later = await h.clear();
    expect(later.actions[0]).toMatchObject({ type: 'merge', pending: true, operationId: 'clear-merge-1' });
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const settled = await h.settle();
    expect(settled.usdcRecovered).toBe(10);
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    expect(h.pendingMerges.size).toBe(0);
  });

  it('an unresolved result is never represented as withheld, and a withheld result never as pending', async () => {
    const h = fixture();
    const unresolved = await settleUnresolved(h);
    expect(unresolved.pending).toBe(true);
    expect(unresolved.withheld).toBeUndefined();
    let release!: (s: TransactionStatus) => void;
    h.ctf.getTransactionStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const a = h.settle();
    await tick(); await tick();
    const b = await h.settle();
    expect(b.withheld).toBe(true);
    expect(b.pending).toBeUndefined();
    expect(b.operationId).toBeUndefined();
    release(txStatus('pending'));
    const ra = await a;
    expect(ra.pending).toBe(true);
    expect(ra.withheld).toBeUndefined();
  });
});

describe('P0.3H unchanged neighbours', () => {
  it('a normally returned merge books exactly as before', async () => {
    const h = fixture();
    const result = await h.settle();
    expect(result).toEqual({
      market: h.marketA, yesBalance: 10, noBalance: 10, pairedTokens: 10, unpairedYes: 0, unpairedNo: 0,
      merged: true, mergeAmount: 10, mergeTxHash: MERGE_TX, usdcRecovered: 10,
    });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('cond-a', { yesTokenId: 'yes', noTokenId: 'no' }, '10', { negRisk: false });
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.active.size).toBe(0);
  });

  it('settleMultiple sums only present usdcRecovered; withheld and pending entries contribute zero', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', MERGE_TX));
    const results = await h.service.settleMultiple([h.marketA, h.marketB, h.marketA], true);
    expect(results.map(r => [r.market.name, r.merged, r.pending ?? false, r.usdcRecovered])).toEqual([
      ['A', false, true, undefined],
      ['B', true, false, 4],
      ['A', false, true, undefined],
    ]);
    expect(h.merges().map(([c]) => c)).toEqual(['cond-a', 'cond-b']);
    expect(h.reads().map(([c]) => c)).toEqual(['cond-a', 'cond-b']);
    expect(h.logs).toContainEqual(expect.stringMatching(/Total Merged: \$4\.00 USDC/));
    expect(h.emittedRecovery()).toBe(4);
  });

  it('settleMultiple with execute=false is read-only across markets and never touches the interlock', async () => {
    const h = fixture();
    const addSpy = vi.spyOn(h.active, 'add');
    const results = await h.service.settleMultiple([h.marketA, h.marketB], false);
    expect(results.map(r => [r.pairedTokens, r.merged])).toEqual([[10, false], [4, false]]);
    expect(h.merges()).toHaveLength(0);
    expect(addSpy).not.toHaveBeenCalled();
  });
});
