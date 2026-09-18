import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ClearAction, type ClearPositionResult } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
const services: ArbitrageService[] = [];
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const rejected: Reply = { success: false, submissionState: 'REJECTED', errorMsg: 'venue rejection' };
const HASH = (n: string) => '0x' + n.repeat(32);

/** Raw CLOB trade rows as the service receives them; string literals stand in for the SDK enums. */
type Trade = {
  id: string; status: string; size?: string; price?: string; transactionHash?: string; asset_id?: string; side?: string;
  taker_order_id?: string; trader_side?: string;
  maker_orders?: Array<{ order_id: string; asset_id?: string; side?: string; matched_amount?: string; price?: string }>;
};
const taker = (id: string, orderId: string, asset: string, size: string, price: string, hash = HASH('11'), status = 'MINED'): Trade =>
  ({ id, status, size, price, transactionHash: hash, asset_id: asset, side: 'SELL', taker_order_id: orderId, trader_side: 'TAKER', maker_orders: [] });
/** We were maker on our own token: the taker bought it (counter side), our allocation is `matched_amount` @ maker price. */
const maker = (id: string, orderId: string, asset: string, matched: string, price: string, hash = HASH('11')): Trade =>
  ({ id, status: 'MINED', size: matched, price: '0.99', transactionHash: hash, asset_id: asset, side: 'BUY', taker_order_id: 'someone-else',
    trader_side: 'MAKER', maker_orders: [{ order_id: orderId, asset_id: asset, side: 'SELL', matched_amount: matched, price }] });

/**
 * Active market, YES 10 / NO 0: no pairs to merge, the clear path sells 10 unpaired YES.
 * Order `cy` fills fully as taker @ 0.55 unless a test says otherwise.
 */
function fixture(options: { yes?: string; no?: string } = {}) {
  const service = new ArbitrageService({ enableLogging: false });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const trades: Record<string, Trade> = {
    ty: taker('ty', 'cy', 'yes', '10', '0.55', HASH('11')),
    tn: taker('tn', 'cn', 'no', '10', '0.45', HASH('22')),
  };
  const orders: Record<string, OrderRow> = {
    cy: { id: 'cy', asset_id: 'yes', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['ty'], sizeMatched: '10' },
    cn: { id: 'cn', asset_id: 'no', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['tn'], sizeMatched: '10' },
  };
  const balances = { yesBalance: options.yes ?? '10', noBalance: options.no ?? '0' };
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
    getPositionBalanceByTokenIds: vi.fn(async () => ({ ...balances })),
    getMarketResolution: vi.fn(async () => ({ isResolved: false })),
    mergeByTokenIds: vi.fn(async (_c: string, _t: unknown, amount: string) => ({ success: true, txHash: HASH('ab'), amount })),
    redeemByTokenIds: vi.fn(),
    split: vi.fn(),
  };
  Object.assign(service, { tradingService: trading, ctf });
  const settles = vi.fn<(result: ClearPositionResult) => void>();
  service.on('settle', settles);
  const logs: string[] = [];
  vi.spyOn(service as unknown as { log: (m: string) => void }, 'log').mockImplementation(m => { logs.push(m); });
  const pending = service['pendingClearSells'];
  const flush = () => service['flushPendingClearSells']();
  const clear = (execute = true) => service.clearPositions(market, execute);
  /** Bypasses the per-market interlock so the inner per-token stale-read layer is exercised on its own. */
  const clearUnguarded = () => service['runClearPositions'](market, true);
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  return { service, market, trades, orders, balances, trading, ctf, settles, logs, pending, flush, clear, clearUnguarded, sells };
}
type H = ReturnType<typeof fixture>;

const sellActions = (r: ClearPositionResult) => r.actions.filter(a => a.type === 'sell_yes' || a.type === 'sell_no');
const soldLogs = (h: H) => h.logs.filter(m => /✅ Sold/.test(m));

/** Accepted but unproven: no proceeds, no success claim, record retained, no resubmission. */
function expectPendingSell(h: H, result: ClearPositionResult, type: ClearAction['type'] = 'sell_yes') {
  const [action] = sellActions(result);
  expect(action).toMatchObject({ type, amount: 0, usdcResult: 0, success: false, pending: true, operationId: 'clear-sell-1' });
  expect(action.facts).toBeUndefined();
  expect(result.totalUsdcRecovered).toBe(0);
  expect(result.success).toBe(false);
  expect(soldLogs(h)).toEqual([]);
  const record = h.pending.get('clear-sell-1');
  expect(record).toBeDefined();
  expect(record?.reported).toBeUndefined();
  expect(record?.terminal).toBeUndefined();
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3 B4 clearPositions SELL factual authority', () => {
  it('a factual full taker SELL yields proceeds = factual shares × factual trade price, exactly once', async () => {
    const h = fixture();
    const result = await h.clear();
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toEqual({ tokenId: 'yes', side: 'SELL', amount: 10, orderType: 'FOK' });
    expect(sellActions(result)).toHaveLength(1);
    expect(sellActions(result)[0]).toEqual({
      type: 'sell_yes', amount: 10, usdcResult: 5.5, success: true, operationId: 'clear-sell-1', txHash: HASH('11'),
      facts: { orderId: 'cy', tokenId: 'yes', requestedShares: 10, soldShares: 10, weightedPrice: 0.55, txHashes: [HASH('11')], proceedsUsd: 5.5 },
    });
    expect(result.totalUsdcRecovered).toBeCloseTo(5.5, 12);
    expect(result.success).toBe(true);
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.settles).toHaveBeenCalledWith(result);
    expect(soldLogs(h)).toEqual([expect.stringMatching(/Sold YES: 10\.0000 → \$5\.50 USDC \(factual @ 0\.5500\)/)]);
    expect(h.pending.size).toBe(0);
    await h.flush(); await h.flush();
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.settles).toHaveBeenCalledTimes(1);
  });

  it('never books the old 0.5 estimate: proceeds follow the factual price', async () => {
    const h = fixture();
    h.trades.ty.price = '0.31';
    const result = await h.clear();
    expect(result.totalUsdcRecovered).toBeCloseTo(3.1, 12);
    expect(sellActions(result)[0].usdcResult).not.toBe(5);
  });

  it('a factual full maker SELL yields proceeds = local matched_amount × maker price', async () => {
    const h = fixture();
    h.trades.ty = maker('ty', 'cy', 'yes', '10', '0.6', HASH('11'));
    const result = await h.clear();
    expect(sellActions(result)[0]).toMatchObject({ success: true, amount: 10, usdcResult: 6, facts: { soldShares: 10, weightedPrice: 0.6, proceedsUsd: 6 } });
    expect(result.totalUsdcRecovered).toBeCloseTo(6, 12);
  });

  it('multiple fills at different prices sum factual proceeds (4 @ 0.40 + 6 @ 0.55 = 4.90, not 5.00)', async () => {
    const h = fixture();
    h.trades.t1 = taker('t1', 'cy', 'yes', '4', '0.40', HASH('11'));
    h.trades.t2 = taker('t2', 'cy', 'yes', '6', '0.55', HASH('33'));
    h.orders.cy.tradeIds = ['t1', 't2'];
    const result = await h.clear();
    const [action] = sellActions(result);
    expect(action).toMatchObject({ success: true, amount: 10 });
    expect(action.usdcResult).toBeCloseTo(4.9, 12);
    expect(action.facts).toMatchObject({ soldShares: 10, proceedsUsd: expect.closeTo(4.9, 12), weightedPrice: expect.closeTo(0.49, 12) });
    expect(action.facts?.txHashes.sort()).toEqual([HASH('11'), HASH('33')].sort());
    expect(action.txHash).toBeUndefined();
    expect(result.totalUsdcRecovered).toBeCloseTo(4.9, 12);
    expect(result.totalUsdcRecovered).not.toBeCloseTo(5, 12);
  });

  it('a terminal partial reports only the factual quantity and proceeds, never the request', async () => {
    const h = fixture();
    h.trades.ty = taker('ty', 'cy', 'yes', '6', '0.60', HASH('11'));
    h.orders.cy = { ...h.orders.cy, status: 'CANCELED', sizeMatched: '6' };
    const result = await h.clear();
    const [action] = sellActions(result);
    expect(action).toMatchObject({ type: 'sell_yes', amount: 6, usdcResult: expect.closeTo(3.6, 12), success: false, operationId: 'clear-sell-1',
      facts: { requestedShares: 10, soldShares: 6, proceedsUsd: expect.closeTo(3.6, 12) } });
    expect(action.error).toMatch(/Partial SELL YES: 6 of 10 filled \(cy\)/);
    expect(action.pending).toBeUndefined();
    expect(result.totalUsdcRecovered).toBeCloseTo(3.6, 12);
    expect(result.success).toBe(false);
    expect(h.logs).toContainEqual(expect.stringMatching(/Sell YES not executed: Partial SELL YES: 6 of 10 filled/));
    expect(soldLogs(h)).toEqual([]);
    expect(h.pending.size).toBe(0);
  });

  it('accepted with zero factual fills: recovered USDC = 0, no success claim, record retained', async () => {
    const h = fixture();
    h.orders.cy = { ...h.orders.cy, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    const result = await h.clear();
    expectPendingSell(h, result);
    expect(h.logs).toContainEqual(expect.stringMatching(/⏳ Sell YES submitted; awaiting factual fills \(clear-sell-1\)/));
    expect(h.pending.get('clear-sell-1')?.leg).toMatchObject({ orderId: 'cy', tokenId: 'yes', submission: 'SUBMITTED', requestedShares: 10 });
    await h.flush();
    expectPendingSell(h, result);
    expect(h.sells()).toHaveLength(1);
  });

  it('a canceled FOK with empty enumeration and zero matched is a terminal non-sale with zero proceeds', async () => {
    const h = fixture();
    h.orders.cy = { ...h.orders.cy, status: 'CANCELED', tradeIds: [], sizeMatched: '0' };
    const result = await h.clear();
    expect(sellActions(result)[0]).toMatchObject({ amount: 0, usdcResult: 0, success: false, error: expect.stringMatching(/never filled \(cy\)/),
      facts: { soldShares: 0, proceedsUsd: 0, txHashes: [] } });
    expect(result.totalUsdcRecovered).toBe(0);
    expect(h.pending.size).toBe(0);
  });

  it('lookup unknown: no fabricated proceeds, no blind resubmission across calls and flushes', async () => {
    const h = fixture();
    h.trading.getOrderFillDetails.mockRejectedValue(new Error('CLOB unavailable'));
    const first = await h.clear();
    expectPendingSell(h, first);
    await h.flush();
    const second = await h.clear();
    expect(h.sells()).toHaveLength(1);
    expect(sellActions(second)).toEqual([expect.objectContaining({ pending: true, operationId: 'clear-sell-1', usdcResult: 0 })]);
    expect(h.logs).toContainEqual(expect.stringMatching(/⏳ Sell YES clear-sell-1 still awaiting factual fills; no new order/));
    expect(second.totalUsdcRecovered).toBe(0);
  });

  it('a venue REJECTED reply is a known non-submission: failed action, zero proceeds, no record', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockResolvedValue(rejected);
    const result = await h.clear();
    expect(sellActions(result)[0]).toEqual({ type: 'sell_yes', amount: 0, usdcResult: 0, success: false, error: 'venue rejection' });
    expect(result.totalUsdcRecovered).toBe(0);
    expect(h.pending.size).toBe(0);
    expect(h.trading.getOrderFillDetails).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual(expect.stringMatching(/❌ Sell YES failed: venue rejection/));
  });

  it('a thrown submission without identity stays unresolved and cannot be proven or resubmitted', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockRejectedValue(new Error('socket hang up'));
    const result = await h.clear();
    const [action] = sellActions(result);
    expect(action).toMatchObject({ pending: true, usdcResult: 0, success: false, error: expect.stringMatching(/no order identity/) });
    expect(h.logs).toContainEqual(expect.stringMatching(/SELL YES submission uncertain \(no order identity\): socket hang up/));
    await h.flush();
    await h.clear();
    expect(h.sells()).toHaveLength(1);
  });

  describe.each<[string, (h: H) => void]>([
    ['wrong orderId on the order row', h => { h.orders.cy = { ...h.orders.cy, id: 'other' }; }],
    ['wrong token on the order row', h => { h.orders.cy = { ...h.orders.cy, asset_id: 'no' }; }],
    ['wrong side on the order row', h => { h.orders.cy = { ...h.orders.cy, side: 'BUY' }; }],
    ['taker child owned by another order', h => { h.trades.ty.taker_order_id = 'other'; }],
    ['taker child on the wrong token', h => { h.trades.ty.asset_id = 'no'; }],
    ['taker child on the wrong side', h => { h.trades.ty.side = 'BUY'; }],
    ['FAILED child with a hash', h => { h.trades.ty.status = 'FAILED'; }],
    ['UNKNOWN child', h => { delete h.trades.ty; }],
    ['unconfirmed child', h => { h.trades.ty.status = 'MATCHED'; }],
    ['invalid tx hash', h => { h.trades.ty.transactionHash = '0xnothex'; }],
    ['missing tx hash', h => { delete h.trades.ty.transactionHash; }],
    ['sizeMatched without factual children', h => { h.orders.cy = { ...h.orders.cy, tradeIds: [] }; }],
    ['maker allocation on the wrong token', h => { h.trades.ty = maker('ty', 'cy', 'no', '10', '0.6'); }],
    ['maker allocation on the wrong side', h => { const t = maker('ty', 'cy', 'yes', '10', '0.6'); t.maker_orders![0].side = 'BUY'; h.trades.ty = t; }],
  ])('%s', (_label, corrupt) => {
    it('yields no proceeds, no success claim, and no resubmission', async () => {
      const h = fixture();
      corrupt(h);
      const result = await h.clear();
      expectPendingSell(h, result);
      await h.flush();
      await h.clear();
      expect(h.sells()).toHaveLength(1);
      expect(h.settles).toHaveBeenCalledTimes(2);
      for (const call of h.settles.mock.calls) expect(call[0].totalUsdcRecovered).toBe(0);
    });
  });

  it('a FAILED child without a hash is a terminal non-fill: zero proceeds, no success', async () => {
    const h = fixture();
    h.trades.ty = { ...h.trades.ty, status: 'FAILED', transactionHash: undefined };
    h.orders.cy = { ...h.orders.cy, status: 'CANCELED', sizeMatched: '0' };
    const result = await h.clear();
    expect(sellActions(result)[0]).toMatchObject({ success: false, amount: 0, usdcResult: 0, facts: { soldShares: 0, proceedsUsd: 0 } });
    expect(result.totalUsdcRecovered).toBe(0);
  });

  it('child sizes exceeding sizeMatched never produce proceeds', async () => {
    const h = fixture();
    h.orders.cy = { ...h.orders.cy, sizeMatched: '4' };
    const result = await h.clear();
    expectPendingSell(h, result);
    expect(h.logs).toContainEqual(expect.stringMatching(/Clear SELL clear-sell-1 reconciliation: .*exceed sizeMatched/));
  });

  it('a later factual fill completes the retained order exactly once, reported by exactly one later call', async () => {
    const h = fixture();
    h.orders.cy = { ...h.orders.cy, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    const first = await h.clear();
    expectPendingSell(h, first);
    h.orders.cy = { ...h.orders.cy, status: 'MATCHED', tradeIds: ['ty'], sizeMatched: '10' };
    await Promise.all([h.flush(), h.flush()]);
    expect(soldLogs(h)).toEqual([expect.stringMatching(/Sold YES: 10\.0000 → \$5\.50 USDC/)]);
    expect(h.pending.get('clear-sell-1')?.terminal).toMatchObject({ usdcResult: 5.5, success: true });
    expect(h.pending.get('clear-sell-1')?.reported).toBeUndefined();
    // The flush never emits; the next clearPositions call carries the facts once.
    expect(h.settles).toHaveBeenCalledTimes(1);
    const second = await h.clear();
    expect(sellActions(second)).toEqual([expect.objectContaining({ operationId: 'clear-sell-1', success: true, usdcResult: 5.5 })]);
    expect(second.totalUsdcRecovered).toBeCloseTo(5.5, 12);
    expect(h.sells()).toHaveLength(1);
    expect(h.pending.size).toBe(0);
    expect(soldLogs(h)).toHaveLength(1);
    // Fresh inventory is sized only from a read taken after the facts were reported.
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    const third = await h.clear();
    expect(sellActions(third)).toEqual([]);
    expect(third.totalUsdcRecovered).toBe(0);
    expect(h.sells()).toHaveLength(1);
  });

  it('repeated reconciliation of the same facts never double-counts recovered USDC', async () => {
    const h = fixture();
    const result = await h.clear();
    const record = { ...h.pending };
    expect(record).toEqual({});
    for (let i = 0; i < 3; i++) await h.flush();
    expect(result.totalUsdcRecovered).toBeCloseTo(5.5, 12);
    expect(h.settles).toHaveBeenCalledTimes(1);
    const sum = h.settles.mock.calls.reduce((acc, [r]) => acc + r.totalUsdcRecovered, 0);
    expect(sum).toBeCloseTo(5.5, 12);
  });

  it('concurrent calls (interlock bypassed): the SELL is submitted once and its proceeds appear in exactly one result', async () => {
    const h = fixture();
    let release!: (row: OrderRow) => void;
    h.trading.getOrderFillDetails.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const a = h.clearUnguarded();
    await new Promise(r => setImmediate(r));
    const b = h.clearUnguarded();
    await new Promise(r => setImmediate(r));
    release({ ...h.orders.cy, tradeIds: [...h.orders.cy.tradeIds] });
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.sells()).toHaveLength(1);
    const totals = [ra, rb].map(r => r.totalUsdcRecovered);
    expect(totals.reduce((x, y) => x + y, 0)).toBeCloseTo(5.5, 12);
    const withProceeds = [ra, rb].filter(r => sellActions(r).some(a => a.success));
    expect(withProceeds).toHaveLength(1);
    expect(h.settles).toHaveBeenCalledTimes(2);
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.pending.size).toBe(0);
  });

  it('a call whose balance read predates a concurrent SELL submission withholds its own SELL (interlock bypassed)', async () => {
    const h = fixture();
    let releaseRead!: (b: { yesBalance: string; noBalance: string }) => void;
    h.ctf.getPositionBalanceByTokenIds
      .mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve; }))
      .mockImplementation(async () => ({ ...h.balances }));
    const stale = h.clearUnguarded();
    await new Promise(r => setImmediate(r));
    const fresh = await h.clearUnguarded();
    expect(sellActions(fresh)[0]).toMatchObject({ success: true, usdcResult: 5.5 });
    releaseRead({ yesBalance: '10', noBalance: '0' });
    const staleResult = await stale;
    expect(h.sells()).toHaveLength(1);
    expect(sellActions(staleResult)[0]).toMatchObject({ success: false, usdcResult: 0, error: expect.stringMatching(/submitted after this balance read/) });
    expect(staleResult.totalUsdcRecovered).toBe(0);
  });
});

describe('P0.3 B4 clearPositions multi-side accounting', () => {
  /** YES 10 / NO 10 with a failing merge: both sides are sold independently. */
  function twoSided() {
    const h = fixture({ yes: '10', no: '10' });
    h.ctf.mergeByTokenIds.mockRejectedValue(new Error('merge reverted'));
    return h;
  }

  it('YES and NO both clear: totalUsdcRecovered = factual YES proceeds + factual NO proceeds', async () => {
    const h = twoSided();
    const result = await h.clear();
    expect(h.sells().map(([o]) => [o.tokenId, o.amount])).toEqual([['yes', 10], ['no', 10]]);
    const [yes, no] = sellActions(result);
    expect(yes).toMatchObject({ type: 'sell_yes', success: true, usdcResult: 5.5, operationId: 'clear-sell-1', facts: { orderId: 'cy', tokenId: 'yes' } });
    expect(no).toMatchObject({ type: 'sell_no', success: true, usdcResult: 4.5, operationId: 'clear-sell-2', facts: { orderId: 'cn', tokenId: 'no' } });
    expect(result.totalUsdcRecovered).toBeCloseTo(10, 12);
    expect(result.actions.filter(a => a.type === 'merge')[0]).toMatchObject({ success: false, usdcResult: 0 });
    expect(result.success).toBe(false);
  });

  it('YES succeeds, NO unknown: only YES factual proceeds counted, NO not fabricated', async () => {
    const h = twoSided();
    h.orders.cn = { ...h.orders.cn, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    const result = await h.clear();
    const [yes, no] = sellActions(result);
    expect(yes).toMatchObject({ type: 'sell_yes', success: true, usdcResult: 5.5 });
    expect(no).toMatchObject({ type: 'sell_no', success: false, pending: true, usdcResult: 0, amount: 0, operationId: 'clear-sell-2' });
    expect(result.totalUsdcRecovered).toBeCloseTo(5.5, 12);
    expect(result.success).toBe(false);
    expect(h.pending.size).toBe(1);
    expect(h.pending.get('clear-sell-2')?.leg.tokenId).toBe('no');
  });

  it('NO facts on a YES order never count as YES proceeds', async () => {
    const h = twoSided();
    h.orders.cy = { ...h.orders.cy, tradeIds: ['tn'] };
    const result = await h.clear();
    const [yes, no] = sellActions(result);
    expect(yes).toMatchObject({ type: 'sell_yes', pending: true, usdcResult: 0 });
    expect(no).toMatchObject({ type: 'sell_no', success: true, usdcResult: 4.5 });
    expect(result.totalUsdcRecovered).toBeCloseTo(4.5, 12);
  });

  it('a pending NO from an earlier call is reported once by the later call while YES proceeds are not repeated', async () => {
    const h = twoSided();
    h.orders.cn = { ...h.orders.cn, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    const first = await h.clear();
    expect(first.totalUsdcRecovered).toBeCloseTo(5.5, 12);
    h.orders.cn = { ...h.orders.cn, status: 'MATCHED', tradeIds: ['tn'], sizeMatched: '10' };
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '10' });
    const second = await h.clear();
    expect(sellActions(second)).toEqual([expect.objectContaining({ type: 'sell_no', success: true, usdcResult: 4.5, operationId: 'clear-sell-2' })]);
    expect(second.totalUsdcRecovered).toBeCloseTo(4.5, 12);
    expect(h.sells()).toHaveLength(2);
    const sum = h.settles.mock.calls.reduce((acc, [r]) => acc + r.totalUsdcRecovered, 0);
    expect(sum).toBeCloseTo(10, 12);
  });
});

describe('P0.3 B4 clearPositions dry run', () => {
  it('execute=false performs no CLOB write and keeps its estimates as estimates', async () => {
    const h = fixture({ yes: '10', no: '2' });
    const result = await h.clear(false);
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    expect(h.trading.getOrderFillDetails).not.toHaveBeenCalled();
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.settles).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
    expect(result.actions).toEqual([
      { type: 'merge', amount: 2, usdcResult: 2, success: true },
      { type: 'sell_yes', amount: 8, usdcResult: 4, success: true },
    ]);
    expect(result.totalUsdcRecovered).toBe(6);
    for (const action of result.actions) {
      expect(action.facts).toBeUndefined();
      expect(action.operationId).toBeUndefined();
      expect(action.pending).toBeUndefined();
    }
    expect(h.logs).toContainEqual(expect.stringMatching(/📋 Plan: 2 actions, ~\$6\.00 pUSD/));
  });

  it('a dry run neither consumes nor disturbs a retained pending SELL', async () => {
    const h = fixture();
    h.orders.cy = { ...h.orders.cy, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await h.clear();
    expect(h.pending.size).toBe(1);
    await h.clear(false);
    expect(h.pending.size).toBe(1);
    expect(h.sells()).toHaveLength(1);
  });
});
