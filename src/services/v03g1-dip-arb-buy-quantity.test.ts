import { describe, expect, it, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';
import { TradingService } from './trading-service.js';

const wallet = '0x' + 'ab'.repeat(20), hash = '0x' + '12'.repeat(32);
function fixture(leg: 1 | 2 = 1, guard = true) {
  const token = leg === 1 ? 'up' : 'down';
  const trade = (id = 'fill', size = '10'): any => ({ id, size, price: '0.3', status: 'CONFIRMED',
    transactionHash: hash, asset_id: token, side: 'BUY', taker_order_id: 'order', trader_side: 'TAKER', maker_orders: [] });
  const trading = { getAddress: () => wallet,
    createMarketOrder: vi.fn(async (): Promise<any> => ({ success: true, submissionState: 'ACCEPTED', orderId: 'order', tradeIds: ['fill'] })),
    getOrderFillDetails: vi.fn(async (): Promise<any> => ({ id: 'order', asset_id: token, side: 'BUY', tradeIds: ['fill'], sizeMatched: '10' })),
    getTradeStatuses: vi.fn(async (): Promise<any[]> => [trade()]) };
  const ctf = { getAddress: () => wallet, getPositionBalanceByTokenIds: vi.fn(async () => ({ yesBalance: '0', noBalance: '0' })) };
  const service = new DipArbService({} as any, trading as any, {} as any);
  const round: any = { roundId: 'r', phase: leg === 1 ? 'waiting' : 'leg1_filled', startTime: Date.now(),
    ...(leg === 2 ? { leg1: { tokenId: 'up', side: 'UP', shares: 10, price: .4, timestamp: Date.now() } } : {}) };
  const market = { conditionId: 'c', upTokenId: 'up', downTokenId: 'down', slug: 'm', endTime: new Date(Date.now() + 60000) };
  Object.assign(service, { market, currentRound: round, ctf, isRunning: true });
  service.updateConfig({ debug: false, autoMerge: false, autoExecute: true, splitOrders: 1, orderIntervalMs: 0, executionCooldown: 0 });
  if (guard) service.setInventoryAdmissionGuard(() => undefined);
  const signal: any = { type: leg === 1 ? 'leg1' : 'leg2', roundId: 'r', tokenId: token,
    dipSide: 'UP', hedgeSide: 'DOWN', shares: 10, targetPrice: .4, currentPrice: .4, source: 'test' };
  const run = () => leg === 1 ? service.executeLeg1(signal) : service.executeLeg2(signal);
  const events = { roundComplete: vi.fn(), execution: vi.fn(), settled: vi.fn() };
  for (const [name, fn] of Object.entries(events)) service.on(name, fn);
  return { service, round, trading, ctf, run, trade, signal, events, token };
}

describe.each([false, true])('P0.3g.1 BUY quantity (guard=%s)', guard => {
  it.each([1, 2] as const)('Leg%s owns one event across signals and orderbook reconciliation', async leg => {
    const h = fixture(leg, guard);
    h.trading.getTradeStatuses.mockResolvedValueOnce([]);
    await h.run();
    let release!: (trades: any[]) => void;
    h.trading.getTradeStatuses.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const book = { tokenId: h.token, asks: [{ price: .4, size: 10 }], bids: [] } as any;
    h.service['handleOrderbookUpdate'](book);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(h.service['isExecuting']).toBe(true);
    if (leg === 1) {
      expect((await h.service.executeLeg2({ ...h.signal, type: 'leg2', tokenId: 'down' })).success).toBe(false);
      expect(h.service['isExecuting']).toBe(true);
    }
    const signal = h.service['handleSignal'](h.signal);
    const joined = h.run();
    h.service['handleOrderbookUpdate'](book);
    release([h.trade()]);
    await Promise.all([signal, joined]);
    await vi.waitFor(() => expect(h.service['isExecuting']).toBe(false));
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()[leg === 1 ? 'leg1Filled' : 'leg2Filled']).toBe(1);
    expect(h.events.execution).toHaveBeenCalledTimes(1);
    await h.run();
    expect(h.events.execution).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2] as const)('Leg%s concurrent signals publish once', async leg => {
    const h = fixture(leg, guard);
    await Promise.all([h.service['handleSignal'](h.signal), h.service['handleSignal'](h.signal)]);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.events.execution).toHaveBeenCalledTimes(1);
    expect(h.service['isExecuting']).toBe(false);
  });

  it('throwing listener is never replayed and distinct operation can publish', async () => {
    const h = fixture(1, guard);
    const throwing = () => { throw new Error('listener'); };
    h.service.on('execution', throwing);
    await expect(h.service['handleSignal'](h.signal)).rejects.toThrow('listener');
    h.service.off('execution', throwing);
    await h.run();
    expect(h.events.execution).toHaveBeenCalledTimes(1);
    Object.assign(h.service, { currentRound: { roundId: 'next', phase: 'waiting', startTime: Date.now() } });
    h.signal.roundId = 'next';
    h.signal.tokenId = 'next-up';
    Object.assign(h.service, { market: { ...h.service['market'], conditionId: 'next-c', upTokenId: 'next-up', downTokenId: 'next-down' } });
    h.trading.createMarketOrder.mockResolvedValue({ success: true, submissionState: 'ACCEPTED', orderId: 'next-order', tradeIds: ['next-fill'] });
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'next-order', asset_id: 'next-up', side: 'BUY', tradeIds: ['next-fill'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade('next-fill'), asset_id: 'next-up', taker_order_id: 'next-order' }]);
    await h.service['handleSignal'](h.signal);
    expect(h.events.execution).toHaveBeenCalledTimes(2);
  });

  it.each(['partial', 'unknown'])('%s never publishes execution', async state => {
    const h = fixture(1, guard);
    h.trading.getTradeStatuses.mockResolvedValue(state === 'partial' ? [h.trade('fill', '8')] : []);
    await h.service['handleSignal'](h.signal);
    await h.run();
    expect(h.events.execution).not.toHaveBeenCalled();
  });

  it.each([1, 2] as const)('Leg%s acceptance is not a fill; later evidence reconciles once', async leg => {
    const h = fixture(leg, guard);
    h.trading.getTradeStatuses.mockResolvedValueOnce([{ ...h.trade(), status: 'MATCHED', transactionHash: undefined }]);
    expect(await h.run()).toMatchObject({ success: false, shares: 0 });
    expect(h.round[`leg${leg}`]).toBeUndefined();
    expect(h.round.phase).toBe(leg === 1 ? 'waiting' : 'leg1_filled');
    expect(h.events.roundComplete).not.toHaveBeenCalled();
    expect(await h.run()).toMatchObject({ success: true, shares: 10, price: .4 });
    const stats = h.service.getStats();
    await h.run();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()).toMatchObject({ leg1Filled: stats.leg1Filled, leg2Filled: stats.leg2Filled, totalProfit: stats.totalProfit });
    expect(h.events.roundComplete).toHaveBeenCalledTimes(leg === 2 ? 1 : 0);
  });

  it.each(['zero', 'invalid', 'error', 'absent'])('balance %s never supplies requested shares', async balance => {
    const h = fixture(1, guard);
    h.trading.getTradeStatuses.mockResolvedValue([]);
    if (balance === 'invalid') h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: 'NaN', noBalance: '0' });
    if (balance === 'error') h.ctf.getPositionBalanceByTokenIds.mockRejectedValue(new Error('RPC failed'));
    if (balance === 'absent') Object.assign(h.service, { ctf: null });
    expect(await h.run()).toMatchObject({ success: false, shares: 0 });
    expect(h.round.leg1).toBeUndefined();
    expect(h.ctf.getPositionBalanceByTokenIds).not.toHaveBeenCalled();
    const hedge = await h.service.executeLeg2({ ...h.signal, type: 'leg2', tokenId: 'down', hedgeSide: 'DOWN' });
    expect(hedge.success).toBe(false);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2] as const)('Leg%s partial quantity stays pending and accumulates without another BUY', async leg => {
    const h = fixture(leg, guard);
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ id: 'order', asset_id: h.token, side: 'BUY', tradeIds: ['fill'], sizeMatched: '4' });
    h.trading.getTradeStatuses.mockResolvedValueOnce([h.trade('fill', '4')]);
    expect(await h.run()).toMatchObject({ success: false, shares: 4 });
    expect(h.round[`leg${leg}`].shares).toBe(4);
    expect(h.round.phase).toBe(leg === 1 ? 'waiting' : 'leg1_filled');
    expect(h.service.getStats().totalProfit).toBe(0);
    expect(h.events.roundComplete).not.toHaveBeenCalled();
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: h.token, side: 'BUY', tradeIds: ['fill', 'later'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([h.trade('fill', '4'), h.trade('later', '6')]);
    expect(await h.run()).toMatchObject({ success: true, shares: 10 });
    await h.run();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.events.roundComplete).toHaveBeenCalledTimes(leg === 2 ? 1 : 0);
  });

  it.each([
    { asset_id: 'wrong' }, { side: 'SELL' }, { taker_order_id: 'other' }, { trader_side: 'MAKER' },
    { transactionHash: 'tx' }, { status: 'FAILED' }, { status: 'RETRYING' }, { status: 'MATCHED' },
  ])('contradictory child %j cannot form a leg', async change => {
    const h = fixture(1, guard);
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade(), ...change }]);
    expect(await h.run()).toMatchObject({ success: false, shares: 0 });
    expect(h.round.leg1).toBeUndefined();
  });

  it.each([1, 2] as const)('Leg%s preserves 8 of matched 10, then accumulates 2 without resubmission', async leg => {
    const h = fixture(leg, guard);
    h.trading.getTradeStatuses.mockResolvedValue([h.trade('fill', '8')]);
    const stats = h.service.getStats();
    for (let i = 0; i < 2; i++) {
      expect(await h.run()).toMatchObject({ success: false, shares: 8, orderId: 'order', error: expect.stringContaining('BUY_PENDING') });
      expect(h.round[`leg${leg}`].shares).toBe(8);
      expect(h.round.phase).toBe(leg === 1 ? 'waiting' : 'leg1_filled');
      expect(h.events.roundComplete).not.toHaveBeenCalled();
      expect(h.service.getStats()).toMatchObject({ leg1Filled: stats.leg1Filled, leg2Filled: stats.leg2Filled, totalProfit: stats.totalProfit });
    }
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: h.token, side: 'BUY', tradeIds: ['fill', 'later'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([h.trade('fill', '8'), h.trade('later', '2')]);
    expect(await h.run()).toMatchObject({ success: true, shares: 10, orderId: 'order' });
    expect(await h.run()).toMatchObject({ success: true, shares: 10, orderId: 'order' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.events.roundComplete).toHaveBeenCalledTimes(leg === 2 ? 1 : 0);
  });

  it.each([1, 2] as const)('Leg%s preserves confirmed 10 with matched 8 but cannot complete', async leg => {
    const h = fixture(leg, guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: h.token, side: 'BUY', tradeIds: ['fill'], sizeMatched: '8' });
    expect(await h.run()).toMatchObject({ success: false, shares: 10 });
    expect(await h.run()).toMatchObject({ success: false, shares: 10 });
    expect(h.round[`leg${leg}`].shares).toBe(10);
    expect(h.round.phase).toBe(leg === 1 ? 'waiting' : 'leg1_filled');
    expect(h.events.roundComplete).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service.getStats().totalProfit).toBe(0);
  });

  it('sizeMatched 10 alone supplies zero factual shares', async () => {
    const h = fixture(1, guard);
    h.trading.getTradeStatuses.mockResolvedValue([]);
    expect(await h.run()).toMatchObject({ success: false, shares: 0 });
    expect(h.round.leg1).toBeUndefined();
  });

  it.each([false, true])('valid child survives invalid sibling in either order (invalid first=%s)', async first => {
    const h = fixture(1, guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: 'up', side: 'BUY', tradeIds: ['fill', 'bad'], sizeMatched: '10' });
    const valid = h.trade('fill', '8'), invalid = { ...h.trade('bad', '2'), asset_id: 'wrong' };
    h.trading.getTradeStatuses.mockResolvedValue(first ? [invalid, valid] : [valid, invalid]);
    expect(await h.run()).toMatchObject({ success: false, shares: 8 });
    expect(await h.run()).toMatchObject({ success: false, shares: 8 });
    expect(h.round.leg1.shares).toBe(8);
    expect(h.round.phase).toBe('waiting');
    expect(h.events.roundComplete).not.toHaveBeenCalled();
  });

  it('missing discovered child preserves returned factual sibling', async () => {
    const h = fixture(1, guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: 'up', side: 'BUY', tradeIds: ['fill', 'later'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([h.trade('fill', '8')]);
    expect(await h.run()).toMatchObject({ success: false, shares: 8 });
    expect(h.round.phase).toBe('waiting');
  });

  it('conflicting duplicate is excluded without discarding a valid sibling', async () => {
    const h = fixture(1, guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: 'up', side: 'BUY', tradeIds: ['fill', 'bad'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([h.trade('bad', '2'), h.trade('fill', '8'), h.trade('bad', '3')]);
    expect(await h.run()).toMatchObject({ success: false, shares: 8 });
    expect(h.round.phase).toBe('waiting');
  });

  it('order lookup error preserves identity for a later read', async () => {
    const h = fixture(1, guard);
    h.trading.getOrderFillDetails.mockRejectedValueOnce(new Error('RPC'));
    expect(await h.run()).toMatchObject({ success: false, shares: 0 });
    expect(await h.run()).toMatchObject({ success: true, shares: 10 });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });

  it('unknown transport without order identity is never retried blindly', async () => {
    const h = fixture(1, guard);
    h.trading.createMarketOrder.mockRejectedValueOnce(new Error('transport'));
    await h.run(); await h.run();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.round.leg1).toBeUndefined();
  });

  it('concurrent calls share one submission and one transition', async () => {
    const h = fixture(1, guard);
    const results = await Promise.all([h.run(), h.run()]);
    expect(results.every(r => r.success && r.shares === 10)).toBe(true);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service.getStats().leg1Filled).toBe(1);
  });

  it('maker quantity uses only the local allocation, with real TradingService readers', async () => {
    const h = fixture(1, guard);
    const client = { getOrder: vi.fn(async () => ({ id: 'order', asset_id: 'up', side: 'BUY', size_matched: '10', associate_trades: ['fill'] })),
      getTrades: vi.fn(async () => [{ ...h.trade(), transaction_hash: hash, trader_side: 'MAKER', taker_order_id: 'other', side: 'SELL', size: '100',
        maker_orders: [{ order_id: 'order', asset_id: 'up', side: 'BUY', matched_amount: '10', price: '.4' },
          { order_id: 'another', asset_id: 'up', side: 'BUY', matched_amount: '90', price: '.4' }] }]) };
    Object.assign(h.trading, { ensureInitialized: async () => client,
      getOrderFillDetails: TradingService.prototype.getOrderFillDetails, getTradeStatuses: TradingService.prototype.getTradeStatuses });
    expect(await h.run()).toMatchObject({ success: true, shares: 10 });
  });

  it('orderbook cycle reconciles pending BUY without a fresh trading signal', async () => {
    const h = fixture(1, guard);
    h.trading.getTradeStatuses.mockResolvedValueOnce([]);
    await h.run();
    h.service['handleOrderbookUpdate']({ tokenId: 'up', asks: [{ price: .4, size: 10 }], bids: [] } as any);
    await vi.waitFor(() => expect(h.round.phase).toBe('leg1_filled'));
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.events.execution).toHaveBeenCalledTimes(1);
  });
});
