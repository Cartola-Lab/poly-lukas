import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type RebalanceResult } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
type Excess = 'YES' | 'NO';
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

const token = (excess: Excess) => excess === 'YES' ? 'yes' : 'no';

/** Inventory 20 / 10 (or mirrored): imbalance 10 → the corrective path sells 90% = 9 of the excess token. */
function fixture(excess: Excess = 'YES') {
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: true });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const trades: Record<string, Trade> = { t1: taker('t1', 'c1', token(excess), '9', '0.55', HASH('11')) };
  const orders: Record<string, OrderRow> = {
    c1: { id: 'c1', asset_id: token(excess), side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['t1'], sizeMatched: '9' },
  };
  const balances = excess === 'YES' ? { yesBalance: '20', noBalance: '10' } : { yesBalance: '10', noBalance: '20' };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>().mockResolvedValue(accepted('c1')),
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
    getPusdBalance: vi.fn().mockResolvedValue('100'),
    getPositionBalanceByTokenIds: vi.fn(async () => ({ ...balances })),
    mergeByTokenIds: vi.fn(),
    split: vi.fn(),
  };
  const realtime = { connect: vi.fn(), disconnect: vi.fn(), subscribeMarkets: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) };
  Object.assign(service, { market, tradingService: trading, ctf, realtimeService: realtime,
    balance: { usdc: 100, pUsdBalance: 100, yesTokens: Number(balances.yesBalance), noTokens: Number(balances.noBalance), lastUpdate: 0 } });
  const events = vi.fn<(result: RebalanceResult) => void>();
  service.on('rebalance', events);
  const logs: string[] = [];
  vi.spyOn(service as unknown as { log: (m: string) => void }, 'log').mockImplementation(m => { logs.push(m); });
  const pending = service['pendingRebalanceSells'];
  const flush = () => service['flushPendingRebalanceSells']();
  const fix = () => service['fixImbalanceIfNeeded']();
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  return { service, market, excess, trades, orders, balances, trading, ctf, events, logs, pending, flush, fix, sells };
}
type H = ReturnType<typeof fixture>;

const soldLogs = (h: H) => h.logs.filter(m => /Sold .*excess/.test(m));
const notExecutedLogs = (h: H) => h.logs.filter(m => /Corrective SELL not executed/.test(m));
const record = (h: H) => h.pending.get('corrective-sell-1');

/** Submitted but unproven: no completion claim, no event, record retained for reconciliation. */
function expectUnresolved(h: H) {
  expect(soldLogs(h)).toEqual([]);
  expect(notExecutedLogs(h)).toEqual([]);
  expect(h.events).not.toHaveBeenCalled();
  expect(record(h)).toBeDefined();
  expect(record(h)?.published).toBeFalsy();
  expect(record(h)?.kind).toBe('corrective');
  expect(h.logs).toContainEqual(expect.stringMatching(/⏳ Corrective SELL submitted; awaiting factual fills \(corrective-sell-1\)/));
  expect(h.service['lastRebalanceTime']).toBe(0);
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe.each<Excess>(['YES', 'NO'])('P0.3 B3 corrective SELL factual authority (%s excess)', excess => {
  it('claims correction only from factual fills, exactly once, without events or pacing', async () => {
    const h = fixture(excess);
    await h.fix();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.trading.createMarketOrder).toHaveBeenCalledWith({ tokenId: token(excess), side: 'SELL', amount: 9, orderType: 'FOK' });
    expect(soldLogs(h)).toEqual([expect.stringMatching(new RegExp(`Sold 9\\.00 excess ${excess} to restore balance \\(factual @ 0\\.5500\\)`))]);
    expect(h.events).not.toHaveBeenCalled();
    expect(h.service['lastRebalanceTime']).toBe(0);
    expect(h.pending.size).toBe(0);
    await h.flush(); await h.flush();
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.sells()).toHaveLength(1);
  });

  it('keeps the best-bid price floor on the corrective order', async () => {
    const h = fixture(excess);
    Object.assign(h.service['orderbook'], excess === 'YES' ? { yesBids: [{ price: 0.6, size: 50 }] } : { noBids: [{ price: 0.6, size: 50 }] });
    await h.fix();
    const [order] = h.trading.createMarketOrder.mock.calls[0];
    expect(order).toMatchObject({ tokenId: token(excess), side: 'SELL', amount: 9, orderType: 'FOK' });
    expect(order.price).toBeCloseTo(0.6 * 0.99, 12);
  });

  it('accepted with zero factual fills is not a correction', async () => {
    const h = fixture(excess);
    h.orders.c1 = { ...h.orders.c1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await h.fix();
    expectUnresolved(h);
    expect(record(h)?.leg).toMatchObject({ orderId: 'c1', tokenId: token(excess), submission: 'SUBMITTED', requestedShares: 9 });
    await h.flush();
    expectUnresolved(h);
    expect(h.sells()).toHaveLength(1);
  });

  it('canceled FOK with empty enumeration and zero matched is a terminal non-correction', async () => {
    const h = fixture(excess);
    h.orders.c1 = { ...h.orders.c1, status: 'CANCELED', tradeIds: [], sizeMatched: '0' };
    await h.fix();
    expect(soldLogs(h)).toEqual([]);
    expect(notExecutedLogs(h)).toEqual([expect.stringMatching(/never filled \(c1\)/)]);
    expect(h.events).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
  });

  it('lookup failure stays unknown: no completion claim, no blind resubmission', async () => {
    const h = fixture(excess);
    h.trading.getOrderFillDetails.mockRejectedValue(new Error('CLOB unavailable'));
    await h.fix();
    expectUnresolved(h);
    await h.flush(); await h.fix(); await h.flush();
    expect(h.sells()).toHaveLength(1);
    expectUnresolved(h);
    expect(h.logs).toContainEqual(expect.stringMatching(/Corrective SELL withheld: corrective-sell-1 pending factual reconciliation/));
  });

  it('factual partial correction preserves the factual quantity and never claims full cleanup', async () => {
    const h = fixture(excess);
    h.trades.t1.size = '6';
    h.orders.c1 = { ...h.orders.c1, status: 'CANCELED', sizeMatched: '6' };
    await h.fix();
    expect(soldLogs(h)).toEqual([]);
    expect(notExecutedLogs(h)).toEqual([expect.stringMatching(/Partial corrective SELL|Partial SELL .*: 6 of 9 filled \(c1\)/)]);
    expect(h.events).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
  });

  it('partial fills on a still-open corrective order remain pending with facts retained', async () => {
    const h = fixture(excess);
    h.trades.t1.size = '6';
    h.orders.c1 = { ...h.orders.c1, status: 'LIVE', sizeMatched: '6' };
    await h.fix();
    expectUnresolved(h);
    expect(record(h)?.leg.facts?.size).toBe(1);
    expect(record(h)?.leg.settlement).toEqual({ state: 'PENDING' });
  });

  it.each<[string, (h: H) => void]>([
    ['wrong token on the order', h => { h.orders.c1.asset_id = token(excess) === 'yes' ? 'no' : 'yes'; }],
    ['wrong token on the child trade', h => { h.trades.t1.asset_id = token(excess) === 'yes' ? 'no' : 'yes'; }],
    ['wrong side on the order', h => { h.orders.c1.side = 'BUY'; }],
    ['wrong side on the child trade', h => { h.trades.t1.side = 'BUY'; }],
    ['wrong order identity', h => { h.orders.c1.id = 'someone-else'; }],
    ['child attributed to a different taker order', h => { h.trades.t1.taker_order_id = 'other'; }],
    ['FAILED child', h => { h.trades.t1.status = 'FAILED'; }],
    ['unknown child', h => { delete h.trades.t1; }],
    ['unconfirmed child (MATCHED, no hash)', h => { h.trades.t1.status = 'MATCHED'; delete h.trades.t1.transactionHash; }],
    ['invalid tx hash', h => { h.trades.t1.transactionHash = '0xdeadbeef'; }],
    ['enumeration absent', h => { h.orders.c1.tradeEnumerationPresent = false; }],
    ['child not enumerated by the order', h => { h.orders.c1.tradeIds = ['t2']; }],
    ['children exceed sizeMatched', h => { h.orders.c1.sizeMatched = '5'; }],
  ])('%s → no correction claim, no resubmission', async (_name, mutate) => {
    const h = fixture(excess);
    mutate(h);
    await h.fix();
    expectUnresolved(h);
    await h.flush(); await h.fix();
    expect(h.sells()).toHaveLength(1);
  });

  it('maker allocation counts only the local matched amount of each child', async () => {
    const h = fixture(excess);
    h.trades.t1 = { id: 't1', status: 'MINED', size: '50', price: '0.6', transactionHash: HASH('33'), asset_id: token(excess), side: 'BUY',
      taker_order_id: 'taker-1', trader_side: 'MAKER',
      maker_orders: [{ order_id: 'stranger', asset_id: token(excess), side: 'SELL', matched_amount: '41', price: '0.6' },
        { order_id: 'c1', asset_id: token(excess), side: 'SELL', matched_amount: '5', price: '0.5' }] };
    h.trades.t2 = { ...h.trades.t1, id: 't2', size: '4', price: '0.6', transactionHash: HASH('44'), taker_order_id: 'taker-2',
      maker_orders: [{ order_id: 'c1', asset_id: token(excess), side: 'SELL', matched_amount: '4', price: '0.6' }] };
    h.orders.c1.tradeIds = ['t1', 't2'];
    await h.fix();
    const weighted = ((5 * 0.5 + 4 * 0.6) / 9).toFixed(4);
    expect(soldLogs(h)).toEqual([expect.stringMatching(new RegExp(`Sold 9\\.00 excess ${excess} .*factual @ ${weighted.replace('.', '\\.')}`))]);
    expect(h.pending.size).toBe(0);
  });

  it('taker fill counts the factual local quantity, not the requested amount', async () => {
    const h = fixture(excess);
    // Requested 9; the venue reports a 9.5 factual fill. Completion reports 9.50, never 9.
    h.trades.t1.size = '9.5'; h.orders.c1.sizeMatched = '9.5';
    await h.fix();
    expect(soldLogs(h)).toEqual([expect.stringMatching(/Sold 9\.50 excess/)]);
  });

  it('conflicting facts for the same child never complete the correction', async () => {
    const h = fixture(excess);
    h.orders.c1 = { ...h.orders.c1, status: 'LIVE' };
    await h.fix();
    expectUnresolved(h);
    h.trades.t1.price = '0.7'; h.orders.c1.status = 'MATCHED';
    await h.flush();
    expectUnresolved(h);
  });

  it('factual completion after an earlier UNKNOWN completes the original order exactly once', async () => {
    const h = fixture(excess);
    h.trading.getOrderFillDetails.mockRejectedValueOnce(new Error('timeout'));
    await h.fix();
    expectUnresolved(h);
    await Promise.all([h.flush(), h.flush()]);
    expect(soldLogs(h)).toHaveLength(1);
    expect(soldLogs(h)[0]).toMatch(/Sold 9\.00 excess/);
    expect(h.sells()).toHaveLength(1);
    expect(h.pending.size).toBe(0);
    for (let i = 0; i < 3; i++) await h.flush();
    expect(soldLogs(h)).toHaveLength(1);
  });

  it('repeated reconciliation of an unresolved correction never duplicates submission or completion', async () => {
    const h = fixture(excess);
    h.orders.c1 = { ...h.orders.c1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await h.fix();
    for (let i = 0; i < 3; i++) { await h.flush(); await h.fix(); }
    expect(h.sells()).toHaveLength(1);
    expectUnresolved(h);
    h.orders.c1 = { ...h.orders.c1, status: 'MATCHED', tradeIds: ['t1'], sizeMatched: '9' };
    await Promise.all([h.flush(), h.flush()]);
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.sells()).toHaveLength(1);
  });

  it('concurrent corrective calls submit exactly one SELL', async () => {
    const h = fixture(excess);
    let release!: (reply: Reply) => void;
    h.trading.createMarketOrder.mockImplementationOnce(() => new Promise<Reply>(resolve => { release = resolve; }));
    const first = h.fix();
    await vi.waitFor(() => expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1));
    const second = h.fix();
    await vi.waitFor(() => expect(h.logs).toContainEqual(expect.stringMatching(/Corrective SELL withheld: corrective-sell-1/)));
    release(accepted('c1'));
    await Promise.all([first, second]);
    expect(h.sells()).toHaveLength(1);
    expect(soldLogs(h)).toHaveLength(1);
  });

  it('a flush joining the inline reconciliation publishes the completion once', async () => {
    const h = fixture(excess);
    let release!: (row: OrderRow) => void;
    h.trading.getOrderFillDetails.mockImplementationOnce(() => new Promise<OrderRow>(resolve => { release = resolve; }));
    const inline = h.fix();
    await vi.waitFor(() => expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(1));
    const joiners = [h.flush(), h.flush()];
    release({ ...h.orders.c1, tradeIds: [...h.orders.c1.tradeIds] });
    await Promise.all([inline, ...joiners]);
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.sells()).toHaveLength(1);
    expect(h.pending.size).toBe(0);
  });

  it('an unresolved rebalancer SELL on the market withholds the corrective SELL', async () => {
    const h = fixture(excess);
    h.orders.r1 = { id: 'r1', asset_id: token(excess), side: 'SELL', status: 'LIVE', tradeEnumerationPresent: true, tradeIds: [], sizeMatched: '0' };
    h.trading.createMarketOrder.mockResolvedValueOnce(accepted('r1'));
    await h.service.rebalance({ type: excess === 'YES' ? 'sell_yes' : 'sell_no', amount: 9, reason: 'r', priority: 1 });
    expect(h.pending.get('rebalance-sell-1')).toBeDefined();
    await h.fix();
    expect(h.sells()).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringMatching(/Corrective SELL withheld: rebalance-sell-1/));
  });

  it('an unresolved corrective SELL withholds the rebalancer on the same market only', async () => {
    const h = fixture(excess);
    h.orders.c1 = { ...h.orders.c1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await h.fix();
    Object.assign(h.service, { isRunning: true, totalCapital: 130 });
    await h.service['checkAndRebalance']();
    expect(h.sells()).toHaveLength(1);
    expect(await h.service.rebalance({ type: excess === 'YES' ? 'sell_yes' : 'sell_no', amount: 9, reason: 'r', priority: 1 }))
      .toMatchObject({ success: false, pending: true, operationId: 'corrective-sell-1' });
    h.market.conditionId = 'other';
    await h.service['checkAndRebalance']();
    expect(h.sells()).toHaveLength(2);
  });

  it('venue rejection is a known non-submission: failure log, no pending record', async () => {
    const h = fixture(excess);
    h.trading.createMarketOrder.mockResolvedValueOnce(rejected);
    await h.fix();
    expect(h.logs).toContainEqual(expect.stringMatching(/Failed to fix imbalance: venue rejection/));
    expect(soldLogs(h)).toEqual([]);
    expect(h.pending.size).toBe(0);
    expect(h.events).not.toHaveBeenCalled();
  });

  it('a submission exception without order identity stays unresolved and blocks re-submission', async () => {
    const h = fixture(excess);
    h.trading.createMarketOrder.mockRejectedValueOnce(new Error('socket hang up'));
    await h.fix();
    expectUnresolved(h);
    await h.flush(); await h.fix();
    expect(h.sells()).toHaveLength(1);
    expect(h.trading.getOrderFillDetails).not.toHaveBeenCalled();
  });

  it('an uncertain acceptance with an orderId is reconciled from facts, never resubmitted', async () => {
    const h = fixture(excess);
    h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'UNCERTAIN', orderId: 'c1', errorMsg: 'timeout' });
    await h.fix();
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.sells()).toHaveLength(1);
  });

  it('does nothing when the imbalance is within threshold or below the minimum trade size', async () => {
    const h = fixture(excess);
    Object.assign(h.balances, { yesBalance: '12', noBalance: '10' });
    await h.fix();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
  });
});

describe('P0.3 B3 long-arb leg-2 rejection path', () => {
  const MERGE_TX = HASH('ab');
  const long: ArbitrageOpportunity = {
    type: 'long', profitRate: 0.1, profitPercent: 10,
    effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
    priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
    maxOrderbookSize: 20, maxBalanceSize: 20, recommendedSize: 10, estimatedProfit: 1, description: 'leg-2 rejection', timestamp: 1,
  };

  /** Leg 1 (YES) fills 10, leg 2 (NO) is rejected: inventory 20 YES / 10 NO after the fill; corrective sells 9 YES. */
  function longFixture() {
    const h = fixture('YES');
    h.orders.ly = { id: 'ly', asset_id: 'yes', side: 'BUY', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['ty'], sizeMatched: '10' };
    h.trades.ty = { ...taker('ty', 'ly', 'yes', '10', '0.4', HASH('22')), side: 'BUY' };
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('ly')).mockResolvedValueOnce(rejected).mockResolvedValue(accepted('c1'));
    h.ctf.mergeByTokenIds.mockResolvedValue({ success: true, txHash: MERGE_TX, provenance: { state: 'CONFIRMED', transactionHash: MERGE_TX } });
    const execution = vi.fn();
    h.service.on('execution', execution);
    return { ...h, execution };
  }

  it('corrective SELL accepted without fills produces no false "Sold excess" claim and the long finalizes from YES facts', async () => {
    const h = longFixture();
    h.orders.c1 = { ...h.orders.c1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    const result = await h.service.execute(long);
    expect(result).toMatchObject({ type: 'long', success: false, profit: 0 });
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: 'yes', amount: 9 });
    expectUnresolved(h);
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
  });

  it('a later factual fill completes the same corrective order exactly once', async () => {
    const h = longFixture();
    h.orders.c1 = { ...h.orders.c1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await h.service.execute(long);
    expectUnresolved(h);
    h.orders.c1 = { ...h.orders.c1, status: 'MATCHED', tradeIds: ['t1'], sizeMatched: '9' };
    await Promise.all([h.flush(), h.flush()]);
    expect(soldLogs(h)).toEqual([expect.stringMatching(/Sold 9\.00 excess YES to restore balance \(factual @ 0\.5500\)/)]);
    expect(h.sells()).toHaveLength(1);
    expect(h.pending.size).toBe(0);
    expect(h.events).not.toHaveBeenCalled();
    await h.flush();
    expect(soldLogs(h)).toHaveLength(1);
  });

  it('a partial corrective fill preserves the factual quantity and never claims full cleanup', async () => {
    const h = longFixture();
    h.trades.t1.size = '6';
    h.orders.c1 = { ...h.orders.c1, status: 'CANCELED', sizeMatched: '6' };
    const result = await h.service.execute(long);
    expect(result).toMatchObject({ success: false, profit: 0 });
    expect(soldLogs(h)).toEqual([]);
    expect(notExecutedLogs(h)).toEqual([expect.stringMatching(/6 of 9 filled \(c1\)/)]);
    expect(h.sells()).toHaveLength(1);
    expect(h.pending.size).toBe(0);
  });

  it('a factual full corrective fill logs completion exactly once and books no PnL', async () => {
    const h = longFixture();
    const result = await h.service.execute(long);
    expect(result).toMatchObject({ success: false, profit: 0 });
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
    expect(h.events).not.toHaveBeenCalled();
  });
});
