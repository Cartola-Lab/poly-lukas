import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type RebalanceAction, type RebalanceResult } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
type Side = 'sell_yes' | 'sell_no';
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

const token = (type: Side) => type === 'sell_yes' ? 'yes' : 'no';
/** YES 40 / NO 20 (or mirrored) → the rebalancer wants to SELL 20 of the excess token. */
const action = (type: Side): RebalanceAction =>
  ({ type, amount: 20, reason: 'Risk', priority: 100 });

function fixture(type: Side = 'sell_yes') {
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: false, enableRebalancer: true });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const trades: Record<string, Trade> = { t1: taker('t1', 'r1', token(type), '20', '0.55', HASH('11')) };
  const orders: Record<string, OrderRow> = {
    r1: { id: 'r1', asset_id: token(type), side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['t1'], sizeMatched: '20' },
  };
  const balances = type === 'sell_yes' ? { yesBalance: '40', noBalance: '20' } : { yesBalance: '20', noBalance: '40' };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>().mockResolvedValue(accepted('r1')),
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
  Object.assign(service, { market, tradingService: trading, ctf, realtimeService: realtime, isRunning: true, totalCapital: 160,
    balance: { usdc: 100, pUsdBalance: 100, yesTokens: Number(balances.yesBalance), noTokens: Number(balances.noBalance), lastUpdate: 0 } });
  const events = vi.fn<(result: RebalanceResult) => void>();
  service.on('rebalance', events);
  const logs: string[] = [];
  vi.spyOn(service as unknown as { log: (m: string) => void }, 'log').mockImplementation(m => { logs.push(m); });
  const recovery = vi.spyOn(service as unknown as { fixImbalanceIfNeeded: ArbitrageService['fixImbalanceIfNeeded'] }, 'fixImbalanceIfNeeded');
  const pending = service['pendingRebalanceSells'];
  const flush = () => service['flushPendingRebalanceSells']();
  const check = () => service['checkAndRebalance']();
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  return { service, market, type, trades, orders, balances, trading, ctf, events, logs, recovery, pending, flush, check, sells };
}
type H = ReturnType<typeof fixture>;

const soldLogs = (h: H) => h.logs.filter(m => /Sold/.test(m));
const successEvents = (h: H) => h.events.mock.calls.filter(([r]) => r.success);

/** The pending acknowledgment: no completion claim, no event, no "Sold" log, record retained. */
function expectPending(h: H, result: RebalanceResult, operationId = 'rebalance-sell-1') {
  expect(result).toMatchObject({ success: false, pending: true, operationId });
  expect(result.facts).toBeUndefined();
  expect(h.events).not.toHaveBeenCalled();
  expect(soldLogs(h)).toEqual([]);
  expect(h.pending.get(operationId)?.published).toBeFalsy();
  expect(h.service['lastRebalanceTime']).toBe(0);
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe.each<Side>(['sell_yes', 'sell_no'])('P0.3 B2 rebalance %s factual authority', type => {
  it('reports success only from factual SELL fills, exactly once', async () => {
    const h = fixture(type);
    const result = await h.service.rebalance(action(type));
    expect(result).toEqual({
      success: true, action: action(type), operationId: 'rebalance-sell-1',
      facts: { orderId: 'r1', tokenId: token(type), requestedShares: 20, soldShares: 20, weightedPrice: 0.55, txHashes: [HASH('11')] },
    });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.trading.createMarketOrder).toHaveBeenCalledWith({ tokenId: token(type), side: 'SELL', amount: 20, orderType: 'FOK' });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveBeenCalledWith(result);
    expect(soldLogs(h)).toEqual([expect.stringMatching(/Sold 20\.00 .* \(factual @ 0\.5500\)/)]);
    expect(h.pending.size).toBe(0);
    expect(h.service['lastRebalanceTime']).toBeGreaterThan(0);
    // Repeated flushes cannot replay the terminal effects.
    await h.flush(); await h.flush();
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(soldLogs(h)).toHaveLength(1);
  });

  it('SELL accepted with zero factual fills is not a rebalance success', async () => {
    const h = fixture(type);
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    const result = await h.service.rebalance(action(type));
    expectPending(h, result);
    expect(h.pending.get('rebalance-sell-1')?.leg).toMatchObject({ orderId: 'r1', tokenId: token(type), submission: 'SUBMITTED', requestedShares: 20 });
    await h.flush();
    expect(h.events).not.toHaveBeenCalled();
    expect(h.sells()).toHaveLength(1);
  });

  it('canceled FOK with empty enumeration and zero matched volume is a terminal non-fill, not success', async () => {
    const h = fixture(type);
    h.orders.r1 = { ...h.orders.r1, status: 'CANCELED', tradeIds: [], sizeMatched: '0' };
    const result = await h.service.rebalance(action(type));
    expect(result).toMatchObject({ success: false, operationId: 'rebalance-sell-1', error: expect.stringMatching(/never filled/),
      facts: { orderId: 'r1', soldShares: 0, requestedShares: 20, txHashes: [] } });
    expect(result.pending).toBeUndefined();
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0].success).toBe(false);
    expect(soldLogs(h)).toEqual([]);
    expect(h.service['lastRebalanceTime']).toBe(0);
    expect(h.pending.size).toBe(0);
  });

  it('lookup failure is unknown: no success and no blind resubmission', async () => {
    const h = fixture(type);
    h.trading.getOrderFillDetails.mockRejectedValue(new Error('CLOB unavailable'));
    const result = await h.service.rebalance(action(type));
    expectPending(h, result);
    await h.flush(); await h.check(); await h.flush();
    expect(h.sells()).toHaveLength(1);
    expect(h.events).not.toHaveBeenCalled();
    expect(h.pending.get('rebalance-sell-1')?.leg.settlement).toBeUndefined();
  });

  it('factual partial SELL preserves the factual quantity and is not full success', async () => {
    const h = fixture(type);
    h.trades.t1.size = '12';
    h.orders.r1 = { ...h.orders.r1, status: 'CANCELED', sizeMatched: '12' };
    const result = await h.service.rebalance(action(type));
    expect(result).toMatchObject({ success: false, operationId: 'rebalance-sell-1', error: expect.stringMatching(/Partial SELL .*12 of 20/),
      facts: { orderId: 'r1', tokenId: token(type), requestedShares: 20, soldShares: 12, weightedPrice: 0.55, txHashes: [HASH('11')] } });
    expect(result.pending).toBeUndefined();
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveBeenCalledWith(result);
    expect(soldLogs(h)).toEqual([]);
    expect(h.service['lastRebalanceTime']).toBe(0);
  });

  it('partial fills on a still-open order remain pending without inflation', async () => {
    const h = fixture(type);
    h.trades.t1.size = '12';
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE', sizeMatched: '12' };
    expectPending(h, await h.service.rebalance(action(type)));
    // Retained facts never inflate to the requested quantity.
    expect(h.pending.get('rebalance-sell-1')?.leg.facts?.size).toBe(1);
    expect(h.pending.get('rebalance-sell-1')?.leg.settlement).toEqual({ state: 'PENDING' });
  });

  it.each<[string, (h: H) => void]>([
    ['wrong token on the order', h => { h.orders.r1.asset_id = token(type) === 'yes' ? 'no' : 'yes'; }],
    ['wrong token on the child trade', h => { h.trades.t1.asset_id = token(type) === 'yes' ? 'no' : 'yes'; }],
    ['wrong side on the order', h => { h.orders.r1.side = 'BUY'; }],
    ['wrong side on the child trade', h => { h.trades.t1.side = 'BUY'; }],
    ['wrong order identity', h => { h.orders.r1.id = 'someone-else'; }],
    ['child attributed to a different taker order', h => { h.trades.t1.taker_order_id = 'other'; }],
    ['FAILED child', h => { h.trades.t1.status = 'FAILED'; }],
    ['unknown child', h => { delete h.trades.t1; }],
    ['unconfirmed child (MATCHED, no hash)', h => { h.trades.t1.status = 'MATCHED'; delete h.trades.t1.transactionHash; }],
    ['invalid tx hash', h => { h.trades.t1.transactionHash = '0xdeadbeef'; }],
    ['enumeration absent', h => { h.orders.r1.tradeEnumerationPresent = false; }],
    ['child not enumerated by the order', h => { h.orders.r1.tradeIds = ['t2']; }],
  ])('%s → no success, no event, no resubmission', async (_name, mutate) => {
    const h = fixture(type);
    mutate(h);
    expectPending(h, await h.service.rebalance(action(type)));
    await h.flush(); await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.events).not.toHaveBeenCalled();
    expect(h.recovery).not.toHaveBeenCalled();
  });

  it('maker allocation counts only the local allocation of each child', async () => {
    const h = fixture(type);
    // Taker sold/bought 50 against three makers; only 20 of them are ours (12 + 8).
    h.trades.t1 = { id: 't1', status: 'MINED', size: '50', price: '0.6', transactionHash: HASH('33'), asset_id: token(type), side: 'BUY',
      taker_order_id: 'taker-1', trader_side: 'MAKER',
      maker_orders: [{ order_id: 'stranger', asset_id: token(type), side: 'SELL', matched_amount: '30', price: '0.6' },
        { order_id: 'r1', asset_id: token(type), side: 'SELL', matched_amount: '12', price: '0.5' }] };
    h.trades.t2 = { ...h.trades.t1, id: 't2', size: '8', price: '0.6', transactionHash: HASH('44'), taker_order_id: 'taker-2',
      maker_orders: [{ order_id: 'r1', asset_id: token(type), side: 'SELL', matched_amount: '8', price: '0.6' }] };
    h.orders.r1.tradeIds = ['t1', 't2'];
    const result = await h.service.rebalance(action(type));
    expect(result).toMatchObject({ success: true, facts: { soldShares: 20, requestedShares: 20, txHashes: [HASH('33'), HASH('44')] } });
    expect(result.facts?.weightedPrice).toBeCloseTo((12 * 0.5 + 8 * 0.6) / 20, 10);
    expect(h.events).toHaveBeenCalledTimes(1);
  });

  it('maker allocation whose taker side does not match our token is not counted', async () => {
    const h = fixture(type);
    // We are the maker SELLing our token, so the taker on the same token must be BUYing.
    h.trades.t1 = { ...h.trades.t1, side: 'SELL', trader_side: 'MAKER', taker_order_id: 'taker-1',
      maker_orders: [{ order_id: 'r1', asset_id: token(type), side: 'SELL', matched_amount: '20', price: '0.55' }] };
    expectPending(h, await h.service.rebalance(action(type)));
  });

  it('taker execution counts the factual local quantity, never the requested amount', async () => {
    const h = fixture(type);
    h.trades.t1.size = '20'; h.trades.t1.price = '0.52';
    const result = await h.service.rebalance({ ...action(type), amount: 19.5 });
    expect(result).toMatchObject({ success: true, facts: { soldShares: 20, requestedShares: 19.5, weightedPrice: 0.52 } });
    expect(h.trading.createMarketOrder).toHaveBeenCalledWith({ tokenId: token(type), side: 'SELL', amount: 19.5, orderType: 'FOK' });
  });

  it('sizeMatched is a consistency check: children exceeding it never complete', async () => {
    const h = fixture(type);
    h.orders.r1.sizeMatched = '15';
    expectPending(h, await h.service.rebalance(action(type)));
    await h.flush();
    expect(h.events).not.toHaveBeenCalled();
  });

  it('conflicting facts for the same child never complete the SELL', async () => {
    const h = fixture(type);
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE' };
    expectPending(h, await h.service.rebalance(action(type)));
    h.trades.t1.price = '0.7'; h.orders.r1.status = 'MATCHED';
    await h.flush();
    expect(h.events).not.toHaveBeenCalled();
    expect(h.pending.get('rebalance-sell-1')?.leg.settlement).toEqual({ state: 'PENDING' });
  });

  it('factual completion after an earlier UNKNOWN completes the original order exactly once', async () => {
    const h = fixture(type);
    h.trading.getOrderFillDetails.mockRejectedValueOnce(new Error('timeout'));
    expectPending(h, await h.service.rebalance(action(type)));
    await Promise.all([h.flush(), h.check(), h.flush()]);
    expect(h.sells()).toHaveLength(1);
    expect(successEvents(h)).toHaveLength(1);
    expect(successEvents(h)[0][0]).toMatchObject({ operationId: 'rebalance-sell-1', facts: { orderId: 'r1', soldShares: 20 } });
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.pending.size).toBe(0);
    await h.flush(); await h.check();
    expect(h.events).toHaveBeenCalledTimes(1);
  });

  it('repeated reconciliation of an unresolved SELL never duplicates events or submissions', async () => {
    const h = fixture(type);
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    expectPending(h, await h.service.rebalance(action(type)));
    for (let i = 0; i < 3; i++) { await h.flush(); await h.check(); }
    expect(h.sells()).toHaveLength(1);
    expect(h.events).not.toHaveBeenCalled();
    h.orders.r1 = { ...h.orders.r1, status: 'MATCHED', tradeIds: ['t1'], sizeMatched: '20' };
    await Promise.all([h.flush(), h.flush(), h.check()]);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: true, facts: { soldShares: 20 } });
    expect(h.sells()).toHaveLength(1);
  });

  it('an unresolved prior SELL blocks new SELL submission on the same market', async () => {
    const h = fixture(type);
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    expectPending(h, await h.service.rebalance(action(type)));
    const again = await h.service.rebalance(action(type));
    expect(again).toMatchObject({ success: false, pending: true, operationId: 'rebalance-sell-1' });
    await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.pending.size).toBe(1);
    expect(h.events).not.toHaveBeenCalled();
    // Balance reads are not needed while the market is blocked.
    expect(h.ctf.getPusdBalance).not.toHaveBeenCalled();
  });

  it('a different market is not blocked by the unresolved SELL', async () => {
    const h = fixture(type);
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    expectPending(h, await h.service.rebalance(action(type)));
    h.market.conditionId = 'other';
    await h.check();
    expect(h.sells()).toHaveLength(2);
    expect(h.pending.size).toBe(2);
  });

  it('two concurrent rebalance checks submit exactly one SELL', async () => {
    const h = fixture(type);
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await Promise.all([h.check(), h.check()]);
    expect(h.sells()).toHaveLength(1);
    expect(h.events).not.toHaveBeenCalled();
  });

  it('concurrent direct rebalance calls submit exactly one SELL', async () => {
    const h = fixture(type);
    let release!: (reply: Reply) => void;
    h.trading.createMarketOrder.mockImplementationOnce(() => new Promise<Reply>(resolve => { release = resolve; }));
    const first = h.service.rebalance(action(type));
    await Promise.resolve();
    const second = await h.service.rebalance(action(type));
    expect(second).toMatchObject({ success: false, pending: true, operationId: 'rebalance-sell-1' });
    release(accepted('r1'));
    expect(await first).toMatchObject({ success: true, facts: { soldShares: 20 } });
    expect(h.sells()).toHaveLength(1);
    expect(h.events).toHaveBeenCalledTimes(1);
  });

  it('the automatic rebalancer consumes pacing on the attempt and never re-sells an unresolved order', async () => {
    const h = fixture(type);
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.service['lastRebalanceTime']).toBeGreaterThan(0);
    Object.assign(h.service, { lastRebalanceTime: 0 });
    await h.check(); await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.events).not.toHaveBeenCalled();
  });

  it('venue rejection is a known non-submission: failure event, no pending record', async () => {
    const h = fixture(type);
    h.trading.createMarketOrder.mockResolvedValueOnce(rejected);
    const result = await h.service.rebalance(action(type));
    expect(result).toMatchObject({ success: false, error: 'venue rejection' });
    expect(result.pending).toBeUndefined();
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.pending.size).toBe(0);
    expect(soldLogs(h)).toEqual([]);
  });

  it('a submission exception without order identity stays unresolved and blocks re-submission', async () => {
    const h = fixture(type);
    h.trading.createMarketOrder.mockRejectedValueOnce(new Error('socket hang up'));
    expectPending(h, await h.service.rebalance(action(type)));
    await h.flush(); await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.trading.getOrderFillDetails).not.toHaveBeenCalled();
    expect(h.events).not.toHaveBeenCalled();
  });

  it('an uncertain acceptance with an orderId is reconciled from facts, never resubmitted', async () => {
    const h = fixture(type);
    h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'UNCERTAIN', orderId: 'r1', errorMsg: 'timeout' });
    const result = await h.service.rebalance(action(type));
    expect(result).toMatchObject({ success: true, facts: { orderId: 'r1', soldShares: 20 } });
    expect(h.sells()).toHaveLength(1);
  });

  it('a listener error neither demotes the factual success nor republishes it', async () => {
    const h = fixture(type);
    h.events.mockImplementationOnce(() => { throw new Error('listener'); });
    await expect(h.service.rebalance(action(type))).rejects.toThrow('listener');
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: true, facts: { soldShares: 20 } });
    expect(h.pending.size).toBe(0);
    await h.flush();
    expect(h.events).toHaveBeenCalledTimes(1);
  });

  it('a balance refresh failure after factual success does not demote the result', async () => {
    const h = fixture(type);
    h.ctf.getPusdBalance.mockRejectedValueOnce(new Error('rpc'));
    const result = await h.service.rebalance(action(type));
    expect(result).toMatchObject({ success: true, facts: { soldShares: 20 } });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveBeenCalledWith(result);
  });

  it('inline reconciliation refreshes balances only after factual success', async () => {
    const h = fixture(type);
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    expectPending(h, await h.service.rebalance(action(type)));
    expect(h.ctf.getPusdBalance).not.toHaveBeenCalled();
    h.orders.r1 = { ...h.orders.r1, status: 'MATCHED', tradeIds: ['t1'], sizeMatched: '20' };
    await h.flush();
    expect(h.ctf.getPusdBalance).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveBeenCalledTimes(1);
  });
});

/** B2.1: a periodic flush joining an in-flight inline reconciliation must not republish the terminal result. */
describe.each<Side>(['sell_yes', 'sell_no'])('P0.3 B2.1 %s terminal publication under overlapping reconciliation', type => {
  type Overlap = Awaited<ReturnType<typeof overlap>>;
  const terminalEvents = (h: H) => h.events.mock.calls.filter(([r]) => !r.pending);

  /** Start an inline rebalance, hold its order lookup, and let periodic flushes (and optionally a
   *  rebalancer tick) join the same reconciliation flight before the facts arrive. */
  async function overlap(h: H, row: OrderRow, tick = false) {
    let release!: (row: OrderRow) => void;
    h.trading.getOrderFillDetails.mockImplementationOnce(() => new Promise<OrderRow>(resolve => { release = resolve; }));
    const inline = h.service.rebalance(action(type));
    await vi.waitFor(() => expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(1));
    const record = h.pending.get('rebalance-sell-1')!;
    expect(record.flight).toBeDefined();
    const joiners = [h.flush(), ...(tick ? [h.check()] : []), h.flush()];
    release({ ...row, tradeIds: [...row.tradeIds] });
    const settled = await Promise.allSettled([inline, ...joiners]);
    return { record, settled, inline: settled[0] };
  }

  const op1Events = (h: H) => h.events.mock.calls.filter(([r]) => r.operationId === 'rebalance-sell-1');

  function expectPublishedOnce(h: H, o: Overlap) {
    expect(h.sells()).toHaveLength(1);
    expect(terminalEvents(h)).toHaveLength(1);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.pending.size).toBe(0);
    expect(o.record.published).toBe(true);
    expect(o.record.terminal).toBe(h.events.mock.calls[0][0]);
  }

  it('SUCCESS overlap publishes one event, one Sold log, one cooldown write', async () => {
    const h = fixture(type);
    const before = Date.now();
    const o = await overlap(h, h.orders.r1, true);
    expect(o.inline).toMatchObject({ status: 'fulfilled', value: { success: true, facts: { soldShares: 20 } } });
    expectPublishedOnce(h, o);
    expect(successEvents(h)).toHaveLength(1);
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.service['lastRebalanceTime']).toBeGreaterThanOrEqual(before);
    // Every joiner observed the same factual object; none replayed it.
    for (const s of o.settled) if (s.status === 'fulfilled' && s.value) expect(s.value).toBe(o.record.terminal);
  });

  it('PARTIAL terminal overlap publishes exactly one partial failure', async () => {
    const h = fixture(type);
    h.trades.t1.size = '12';
    const o = await overlap(h, { ...h.orders.r1, status: 'CANCELED', sizeMatched: '12' });
    expect(o.inline).toMatchObject({ status: 'fulfilled', value: { success: false, facts: { soldShares: 12, requestedShares: 20 } } });
    expectPublishedOnce(h, o);
    expect(successEvents(h)).toHaveLength(0);
    expect(soldLogs(h)).toHaveLength(0);
    expect(h.logs.filter(m => /❌ Failed/.test(m))).toHaveLength(1);
    expect(h.service['lastRebalanceTime']).toBe(0);
  });

  it('ZERO-FILL terminal overlap publishes exactly one failure', async () => {
    const h = fixture(type);
    const o = await overlap(h, { ...h.orders.r1, status: 'CANCELED', tradeIds: [], sizeMatched: '0' });
    expect(o.inline).toMatchObject({ status: 'fulfilled', value: { success: false, facts: { soldShares: 0 } } });
    expectPublishedOnce(h, o);
    expect(successEvents(h)).toHaveLength(0);
    expect(soldLogs(h)).toHaveLength(0);
    expect(h.logs.filter(m => /❌ Failed/.test(m))).toHaveLength(1);
  });

  it('a rebalancer tick joining a terminal-partial flight publishes it once; any further SELL is a distinct operation from a fresh balance read', async () => {
    const h = fixture(type);
    h.trades.t1.size = '12';
    const o = await overlap(h, { ...h.orders.r1, status: 'CANCELED', sizeMatched: '12' }, true);
    expect(o.inline).toMatchObject({ status: 'fulfilled', value: { success: false, operationId: 'rebalance-sell-1', facts: { soldShares: 12 } } });
    expect(op1Events(h)).toHaveLength(1);
    expect(soldLogs(h)).toHaveLength(0);
    expect(successEvents(h)).toHaveLength(0);
    // The tick acted only after op 1 was terminal and released: it re-read inventory (static in this
    // fixture, so still imbalanced) and opened op 2. It never re-sent op 1's order while unresolved.
    const balanceReads = h.ctf.getPositionBalanceByTokenIds.mock.invocationCallOrder;
    const submissions = h.trading.createMarketOrder.mock.invocationCallOrder;
    expect(submissions).toHaveLength(2);
    expect(balanceReads.some(read => read > submissions[0] && read < submissions[1])).toBe(true);
    expect(h.pending.get('rebalance-sell-2')).toBeDefined();
    expect(h.pending.get('rebalance-sell-2')?.published).toBeFalsy();
  });

  it('a throwing listener under overlap cannot cause a replay or a resubmission', async () => {
    const h = fixture(type);
    h.events.mockImplementationOnce(() => { throw new Error('listener'); });
    const o = await overlap(h, h.orders.r1);
    expectPublishedOnce(h, o);
    expect(soldLogs(h)).toHaveLength(1);
    // Whichever caller claimed publication saw the throw; the others returned the same fact quietly.
    const rejected = o.settled.filter(s => s.status === 'rejected');
    expect(rejected.length).toBeLessThanOrEqual(1);
    for (const s of rejected) expect((s as PromiseRejectedResult).reason).toEqual(new Error('listener'));
    await h.flush(); await h.check();
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.sells()).toHaveLength(1);
  });

  it('repeated flushes after the overlapped completion never replay', async () => {
    const h = fixture(type);
    const o = await overlap(h, h.orders.r1);
    expectPublishedOnce(h, o);
    for (let i = 0; i < 3; i++) { await h.flush(); await h.check(); }
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.sells()).toHaveLength(1);
  });
});

describe('P0.3 B2 rebalance non-SELL actions and short interplay', () => {
  it('split and merge rebalances keep their existing shape', async () => {
    const h = fixture();
    h.ctf.split.mockResolvedValue({ txHash: 'split-tx' });
    h.ctf.mergeByTokenIds.mockResolvedValue({ txHash: 'merge-tx' });
    expect(await h.service.rebalance({ type: 'split', amount: 5, reason: 'r', priority: 1 })).toEqual({ success: true, action: { type: 'split', amount: 5, reason: 'r', priority: 1 }, txHash: 'split-tx' });
    expect(await h.service.rebalance({ type: 'merge', amount: 5, reason: 'r', priority: 1 })).toEqual({ success: true, action: { type: 'merge', amount: 5, reason: 'r', priority: 1 }, txHash: 'merge-tx' });
    expect(h.events).toHaveBeenCalledTimes(2);
    expect(h.pending.size).toBe(0);
  });

  it('an unresolved rebalance SELL does not alter short-arb submission', async () => {
    const h = fixture();
    h.orders.r1 = { ...h.orders.r1, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    expectPending(h, await h.service.rebalance(action('sell_yes')));
    h.trading.createMarketOrder.mockResolvedValueOnce(accepted('sa')).mockResolvedValueOnce(accepted('sb'));
    const short: ArbitrageOpportunity = {
      type: 'short', profitRate: 0.1, profitPercent: 10,
      effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
      priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
      maxOrderbookSize: 20, maxBalanceSize: 20, recommendedSize: 10, estimatedProfit: 1, description: 's', timestamp: 1,
    };
    const ack = await h.service.execute(short);
    expect(ack).toMatchObject({ type: 'SHORT_SUBMISSION', status: 'SUBMITTED_PENDING' });
    expect(h.sells()).toHaveLength(3);
  });
});
