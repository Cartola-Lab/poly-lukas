import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageMarketConfig, type ClearPositionResult } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';
import { MergeProvenanceError } from '../clients/ctf-client.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
type Balances = { yesBalance: string; noBalance: string };
const services: ArbitrageService[] = [];
const HASH = (n: string) => '0x' + n.repeat(32);
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const tick = () => new Promise<void>(r => setImmediate(r));

/** Deferred whose settlement is controlled by the test. */
function gate<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const taker = (id: string, orderId: string, asset: string, size: string, price: string, hash = HASH('11')) => ({
  id, status: 'MINED', size, price, transactionHash: hash, asset_id: asset, side: 'SELL', taker_order_id: orderId, trader_side: 'TAKER', maker_orders: [],
});

/**
 * Active market, YES 10 / NO 10 by default: paired inventory that a clear merges. Residual SELLs
 * (order `cy` on YES, `cn` on NO) fill fully as taker unless a test changes the rows.
 */
function fixture(options: { yes?: string; no?: string; resolved?: boolean; usdcReceived?: string } = {}) {
  const service = new ArbitrageService({ enableLogging: false, minTradeSize: 1 });
  services.push(service);
  const marketA: ArbitrageMarketConfig = { name: 'A', conditionId: 'cond-a', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const marketB: ArbitrageMarketConfig = { name: 'B', conditionId: 'cond-b', yesTokenId: 'yes-b', noTokenId: 'no-b', negRisk: false };
  const balances: Record<string, Balances> = {
    'cond-a': { yesBalance: options.yes ?? '10', noBalance: options.no ?? '10' },
    'cond-b': { yesBalance: '4', noBalance: '4' },
  };
  const trades: Record<string, ReturnType<typeof taker>> = {
    ty: taker('ty', 'cy', 'yes', '3', '0.55', HASH('11')),
    tn: taker('tn', 'cn', 'no', '3', '0.45', HASH('22')),
  };
  const orders: Record<string, OrderRow> = {
    cy: { id: 'cy', asset_id: 'yes', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['ty'], sizeMatched: '3' },
    cn: { id: 'cn', asset_id: 'no', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['tn'], sizeMatched: '3' },
  };
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
    getMarketResolution: vi.fn(async (_conditionId: string): Promise<{ isResolved: boolean; winningOutcome?: string }> =>
      options.resolved ? { isResolved: true, winningOutcome: 'YES' } : { isResolved: false }),
    mergeByTokenIds: vi.fn(async (_c: string, _t: unknown, amount: string) => ({ success: true, txHash: HASH('ab'), amount })),
    redeemByTokenIds: vi.fn(async () => ({
      success: true, provenance: { state: 'CONFIRMED', txHash: HASH('cd') }, txHash: HASH('cd'), outcome: 'YES',
      tokensRedeemed: '10', usdcReceived: options.usdcReceived ?? '9.75',
    })),
    split: vi.fn(),
  };
  Object.assign(service, { tradingService: trading, ctf });
  const settles = vi.fn<(result: ClearPositionResult) => void>();
  service.on('settle', settles);
  const logs: string[] = [];
  vi.spyOn(service as unknown as { log: (m: string) => void }, 'log').mockImplementation(m => { logs.push(m); });
  const active = service['activeClearMarkets'];
  const pendingSells = service['pendingClearSells'];
  const clear = (market: ArbitrageMarketConfig = marketA, execute = true) => service.clearPositions(market, execute);
  const merges = () => ctf.mergeByTokenIds.mock.calls;
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  const reads = () => ctf.getPositionBalanceByTokenIds.mock.calls;
  return { service, marketA, marketB, balances, trades, orders, trading, ctf, settles, logs, active, pendingSells, clear, merges, sells, reads };
}
type H = ReturnType<typeof fixture>;

const byType = (r: ClearPositionResult, type: string) => r.actions.filter(a => a.type === type);
const sellActions = (r: ClearPositionResult) => r.actions.filter(a => a.type === 'sell_yes' || a.type === 'sell_no');

/** The losing concurrent call: no read, no write, no recovered USDC, explicit withheld non-success. */
function expectWithheld(h: H, result: ClearPositionResult, market: ArbitrageMarketConfig = h.marketA) {
  expect(result).toEqual({
    market,
    marketStatus: 'unknown',
    yesBalance: 0,
    noBalance: 0,
    actions: [],
    totalUsdcRecovered: 0,
    success: false,
    withheld: true,
    error: expect.stringMatching(/withheld: another clear operation is active/),
  });
  expect(h.logs).toContainEqual(expect.stringMatching(/⏸️ clearPositions withheld for A/));
}

/** Holds call A inside its merge so a second call overlaps its economic phase. */
async function startHeldMerge(h: H) {
  const merge = gate<{ success: true; txHash: string; amount: string }>();
  h.ctf.mergeByTokenIds.mockImplementationOnce(() => merge.promise);
  const a = h.clear();
  await tick(); await tick();
  expect(h.merges()).toHaveLength(1);
  expect(h.active.has('cond-a')).toBe(true);
  return { a, merge };
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3 clearPositions concurrent-merge interlock', () => {
  it('same market, two concurrent execute=true calls submit at most one merge', async () => {
    const h = fixture();
    const { a, merge } = await startHeldMerge(h);
    const b = await h.clear();
    expect(h.merges()).toHaveLength(1);
    merge.resolve({ success: true, txHash: HASH('ab'), amount: '10' });
    const ra = await a;
    expect(h.merges()).toHaveLength(1);
    expect(byType(ra, 'merge')).toEqual([{ type: 'merge', amount: 10, usdcResult: 10, txHash: HASH('ab'), success: true }]);
    expect(ra.success).toBe(true);
    expect(b.withheld).toBe(true);
  });

  it('the losing call performs zero merge, zero SELL, zero balance read, books nothing and emits no settle', async () => {
    const h = fixture();
    const { a, merge } = await startHeldMerge(h);
    const readsBefore = h.reads().length;
    const b = await h.clear();
    expectWithheld(h, b);
    expect(h.reads()).toHaveLength(readsBefore);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells()).toHaveLength(0);
    expect(h.settles).not.toHaveBeenCalled();
    merge.resolve({ success: true, txHash: HASH('ab'), amount: '10' });
    await a;
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.sells()).toHaveLength(0);
  });

  it('the losing call does not carry B4 pending semantics: it owns no order and no pending record', async () => {
    const h = fixture();
    const { a, merge } = await startHeldMerge(h);
    const b = await h.clear();
    expect(b.actions.some(x => x.pending)).toBe(false);
    expect(b.actions.some(x => x.operationId)).toBe(false);
    expect(h.pendingSells.size).toBe(0);
    merge.resolve({ success: true, txHash: HASH('ab'), amount: '10' });
    await a;
  });

  it('after the first merge succeeds, the second caller never enters the stale SELL fallback', async () => {
    const h = fixture();
    const { a, merge } = await startHeldMerge(h);
    const b = h.clear();
    merge.resolve({ success: true, txHash: HASH('ab'), amount: '10' });
    const [ra, rb] = await Promise.all([a, b]);
    // Under the old flow B would have read 10/10, failed its merge, and tried to SELL 10 YES + 10 NO.
    expect(h.sells()).toHaveLength(0);
    expect(sellActions(rb)).toEqual([]);
    expect(sellActions(ra)).toEqual([]);
    expect(rb.withheld).toBe(true);
    expect(ra.totalUsdcRecovered).toBe(10);
  });

  it('a merge that throws (proven not submitted) releases the interlock and a later new call runs normally', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(new MergeProvenanceError(new Error('merge reverted'), { state: 'NOT_SUBMITTED' }));
    const first = await h.clear();
    expect(byType(first, 'merge')[0]).toMatchObject({ success: false, usdcResult: 0, error: 'merge reverted' });
    expect(h.active.size).toBe(0);
    // A proven non-broadcast keeps the pre-existing fallback: residual SELLs from its own read.
    expect(h.sells().map(([o]) => [o.tokenId, o.amount])).toEqual([['yes', 10], ['no', 10]]);
    h.orders.cy = { ...h.orders.cy, sizeMatched: '10' }; h.trades.ty.size = '10';
    h.orders.cn = { ...h.orders.cn, sizeMatched: '10' }; h.trades.tn.size = '10';

    const second = await h.clear();
    expect(h.active.size).toBe(0);
    expect(h.merges()).toHaveLength(2);
    expect(byType(second, 'merge')[0]).toMatchObject({ success: true, amount: 10 });
  });

  it('after the first call completes, a subsequent call takes a fresh balance read and acts on remaining inventory', async () => {
    const h = fixture();
    const first = await h.clear();
    expect(first.totalUsdcRecovered).toBe(10);
    expect(h.reads()).toHaveLength(1);
    expect(h.active.size).toBe(0);

    h.balances['cond-a'] = { yesBalance: '0', noBalance: '3' };
    const second = await h.clear();
    expect(h.reads()).toHaveLength(2);
    expect(second).toMatchObject({ yesBalance: 0, noBalance: 3 });
    expect(second.withheld).toBeUndefined();
    expect(h.merges()).toHaveLength(1);
    expect(h.sells().map(([o]) => [o.tokenId, o.amount])).toEqual([['no', 3]]);
    expect(sellActions(second)[0]).toMatchObject({ type: 'sell_no', success: true, amount: 3, usdcResult: 1.35, facts: { orderId: 'cn', soldShares: 3, proceedsUsd: 1.35 } });
    expect(second.totalUsdcRecovered).toBeCloseTo(1.35, 12);
  });

  it('different markets clear concurrently and each merges independently', async () => {
    const h = fixture();
    const { a, merge } = await startHeldMerge(h);
    const rb = await h.clear(h.marketB);
    expect(rb.withheld).toBeUndefined();
    expect(rb.success).toBe(true);
    expect(byType(rb, 'merge')[0]).toMatchObject({ amount: 4, usdcResult: 4, success: true });
    expect(h.merges().map(([c, , amt]) => [c, amt])).toEqual([['cond-a', '10'], ['cond-b', '4']]);
    expect(h.active.has('cond-a')).toBe(true);
    expect(h.active.has('cond-b')).toBe(false);
    merge.resolve({ success: true, txHash: HASH('ab'), amount: '10' });
    const ra = await a;
    expect(ra.totalUsdcRecovered).toBe(10);
    expect(h.active.size).toBe(0);
  });

  it('execute=false while execute=true is running stays write-free and neither takes nor releases the live guard', async () => {
    const h = fixture();
    const { a, merge } = await startHeldMerge(h);
    const plan = await h.clear(h.marketA, false);
    expect(plan.withheld).toBeUndefined();
    expect(plan.success).toBe(true);
    expect(plan.actions).toEqual([{ type: 'merge', amount: 10, usdcResult: 10, success: true }]);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells()).toHaveLength(0);
    expect(h.active.has('cond-a')).toBe(true);
    // The live guard is intact: a live caller is still withheld after the dry run.
    expectWithheld(h, await h.clear());
    merge.resolve({ success: true, txHash: HASH('ab'), amount: '10' });
    await a;
    expect(h.active.size).toBe(0);
  });

  it('execute=false alone never touches the interlock', async () => {
    const h = fixture();
    const plan = await h.clear(h.marketA, false);
    expect(plan.success).toBe(true);
    expect(h.active.size).toBe(0);
    expect(h.merges()).toHaveLength(0);
  });

  it('resolved-market factual redeem is unchanged for a single call and the guard is released', async () => {
    const h = fixture({ resolved: true, usdcReceived: '9.75' });
    const result = await h.clear();
    expect(byType(result, 'redeem')).toEqual([{ type: 'redeem', amount: 10, usdcResult: 9.75, txHash: HASH('cd'), success: true }]);
    expect(result.totalUsdcRecovered).toBe(9.75);
    expect(result.success).toBe(true);
    expect(h.merges()).toHaveLength(0);
    expect(h.active.size).toBe(0);
  });

  it('resolved market: a concurrent same-market call is withheld and submits no second redeem', async () => {
    const h = fixture({ resolved: true });
    const redeem = gate<Awaited<ReturnType<H['ctf']['redeemByTokenIds']>>>();
    h.ctf.redeemByTokenIds.mockImplementationOnce(() => redeem.promise);
    const a = h.clear();
    await tick(); await tick();
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
    expectWithheld(h, await h.clear());
    redeem.resolve({ success: true, provenance: { state: 'CONFIRMED', txHash: HASH('cd') }, txHash: HASH('cd'), outcome: 'YES', tokensRedeemed: '10', usdcReceived: '9.75' });
    const ra = await a;
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
    expect(ra.totalUsdcRecovered).toBe(9.75);
  });

  it('winning call: merge plus residual factual SELL keeps B4 SELL semantics', async () => {
    const h = fixture({ yes: '13', no: '10' });
    const result = await h.clear();
    expect(byType(result, 'merge')[0]).toMatchObject({ amount: 10, usdcResult: 10, success: true });
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toEqual({ tokenId: 'yes', side: 'SELL', amount: 3, orderType: 'FOK' });
    const [sell] = sellActions(result);
    expect(sell).toMatchObject({
      type: 'sell_yes', amount: 3, success: true, operationId: 'clear-sell-1', txHash: HASH('11'),
      facts: { orderId: 'cy', tokenId: 'yes', requestedShares: 3, soldShares: 3, weightedPrice: 0.55, txHashes: [HASH('11')] },
    });
    expect(sell.usdcResult).toBeCloseTo(1.65, 12);
    expect(sell.facts?.proceedsUsd).toBeCloseTo(1.65, 12);
    expect(sell.pending).toBeUndefined();
    expect(result.totalUsdcRecovered).toBeCloseTo(11.65, 12);
    expect(result.success).toBe(true);
    expect(h.pendingSells.size).toBe(0);
    expect(h.active.size).toBe(0);
  });

  it('an unresolved clear SELL keeps its B4 duplicate protection across sequential guarded calls', async () => {
    const h = fixture({ yes: '13', no: '10' });
    h.orders.cy = { ...h.orders.cy, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    const first = await h.clear();
    expect(sellActions(first)[0]).toMatchObject({ type: 'sell_yes', pending: true, success: false, usdcResult: 0, operationId: 'clear-sell-1' });
    expect(h.pendingSells.size).toBe(1);
    expect(h.active.size).toBe(0);

    h.balances['cond-a'] = { yesBalance: '3', noBalance: '0' };
    const second = await h.clear();
    expect(h.sells()).toHaveLength(1);
    expect(sellActions(second)[0]).toMatchObject({ type: 'sell_yes', pending: true, operationId: 'clear-sell-1' });
    expect(h.logs).toContainEqual(expect.stringMatching(/⏳ Sell YES clear-sell-1 still awaiting factual fills; no new order/));

    h.orders.cy = { ...h.orders.cy, status: 'MATCHED', tradeIds: ['ty'], sizeMatched: '3' };
    const third = await h.clear();
    expect(h.sells()).toHaveLength(1);
    expect(sellActions(third)[0]).toMatchObject({ type: 'sell_yes', success: true, amount: 3, operationId: 'clear-sell-1' });
    expect(sellActions(third)[0].usdcResult).toBeCloseTo(1.65, 12);
    expect(third.totalUsdcRecovered).toBeCloseTo(1.65, 12);
    expect(h.pendingSells.size).toBe(0);
  });

  it('an exception thrown during the guarded phase releases the guard so the next call is not blocked', async () => {
    const h = fixture();
    h.ctf.getPositionBalanceByTokenIds.mockRejectedValueOnce(new Error('RPC down'));
    await expect(h.clear()).rejects.toThrow('RPC down');
    expect(h.active.size).toBe(0);
    expect(h.merges()).toHaveLength(0);

    const next = await h.clear();
    expect(next.withheld).toBeUndefined();
    expect(next.success).toBe(true);
    expect(h.merges()).toHaveLength(1);
    expect(h.active.size).toBe(0);
  });

  it('a synchronous early return (no CTF client) still releases the guard', async () => {
    const h = fixture();
    Object.assign(h.service, { ctf: null });
    const result = await h.clear();
    expect(result).toMatchObject({ success: false, error: 'CTF client not configured' });
    expect(h.active.size).toBe(0);
  });

  it('recovered USDC is never double-counted across concurrent same-market calls', async () => {
    const h = fixture();
    const { a, merge } = await startHeldMerge(h);
    const b = h.clear();
    const c = h.clear();
    merge.resolve({ success: true, txHash: HASH('ab'), amount: '10' });
    const results = await Promise.all([a, b, c]);
    const total = results.reduce((acc, r) => acc + r.totalUsdcRecovered, 0);
    expect(total).toBe(10);
    expect(results.filter(r => r.withheld)).toHaveLength(2);
    expect(results.filter(r => r.success)).toHaveLength(1);
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.merges()).toHaveLength(1);
  });

  it('the interlock is keyed by conditionId, so a re-entrant call for the same market after settle is not blocked', async () => {
    const h = fixture();
    const first = await h.clear();
    expect(first.success).toBe(true);
    h.balances['cond-a'] = { yesBalance: '0', noBalance: '0' };
    const second = await h.clear();
    expect(second).toMatchObject({ success: true, actions: [], totalUsdcRecovered: 0 });
    expect(second.withheld).toBeUndefined();
    expect(h.active.size).toBe(0);
  });
});
