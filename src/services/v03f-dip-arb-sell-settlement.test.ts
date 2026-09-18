import { describe, expect, it, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';
import { TradingService } from './trading-service.js';

const wallet = '0x' + 'ab'.repeat(20);
const tx = '0x' + '12'.repeat(32);
const fill = (id = 't1', size = '10', price = '0.55') => ({ id, size, price, status: 'CONFIRMED', transactionHash: tx,
  asset_id: id === 'down' ? 'down' : 'up', side: 'SELL', taker_order_id: id === 'down' ? 'down' : 'up',
  maker_orders: [], trader_side: 'TAKER' });
function fixture(guard: boolean, second = false) {
  const trading = {
    getAddress: vi.fn(() => wallet),
    createMarketOrder: vi.fn(async (p: any): Promise<any> => ({ success: true, submissionState: 'ACCEPTED', orderId: p.tokenId, tradeIds: ['t1'] })),
    getOrderFillDetails: vi.fn(async (_id: string): Promise<any> => ({ tradeIds: ['t1'], sizeMatched: '10' })),
    getTradeStatuses: vi.fn(async (_ids: string[]): Promise<any[]> => [fill()]),
  };
  const ctf = { getAddress: vi.fn(() => wallet), getPositionBalanceByTokenIds: vi.fn(async (): Promise<any> => ({ yesBalance: '0', noBalance: '0' })) };
  const service = new DipArbService({} as any, trading as any, {} as any);
  const round: any = { roundId: 'r', phase: 'completed', startTime: Date.now(),
    leg1: { tokenId: 'up', side: 'UP', shares: 10, price: .4 },
    ...(second ? { leg2: { tokenId: 'down', side: 'DOWN', shares: 10, price: .4 } } : {}) };
  const market = { upTokenId: 'up', downTokenId: 'down', conditionId: 'c', slug: 'm', endTime: new Date(Date.now() - 1000) };
  Object.assign(service, { currentRound: round, market, ctf, upAsks: [{ price: .6 }], downAsks: [{ price: .7 }], isRunning: true });
  service.updateConfig({ debug: false });
  if (guard) service.setInventoryAdmissionGuard(() => undefined);
  const settled = vi.fn(); service.on('settled', settled);
  const stop = vi.spyOn(service, 'stop').mockImplementation(async () => {});
  vi.spyOn(service as any, 'findNextMarket').mockResolvedValue(null);
  const stats = service.getStats();
  const sell = () => service.settle('sell');
  const rotate = async () => {
    Object.assign(service['autoRotateConfig'], { enabled: true, autoSettle: true, settleStrategy: 'sell' });
    await service['checkRotation']();
  };
  return { service, trading, ctf, round, market, settled, stop, stats, sell, rotate };
}

describe.each([false, true])('P0.3f factual SELL settlement (guard=%s)', guard => {
  it('acceptance alone supplies no proceeds or final settlement, even with zero balance', async () => {
    const h = fixture(guard);
    h.trading.getTradeStatuses.mockResolvedValue([{ id: 't1', status: 'MATCHED', size: '10', price: '.6' }]);
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: undefined });
    expect(h.ctf.getPositionBalanceByTokenIds).toHaveBeenCalledTimes(1);
    await h.rotate();
    expect(h.settled).not.toHaveBeenCalled(); expect(h.stop).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('rejection is not successful settlement', async () => {
    const h = fixture(guard);
    h.trading.createMarketOrder.mockResolvedValue({ success: false, submissionState: 'REJECTED' });
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'NO_FILL', amountReceived: undefined });
    expect(h.trading.getOrderFillDetails).not.toHaveBeenCalled();
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
  });
  it('uses confirmed execution price rather than cached ask', async () => {
    const h = fixture(guard);
    expect(await h.sell()).toMatchObject({ success: true, sellState: 'COMPLETE', amountReceived: 5.5,
      sellLegs: [{ orderId: 'up', requestedShares: 10, realizedShares: 10, executionPrice: .55, proceeds: 5.5, residual: 0 }] });
    expect(h.service.getStats()).toMatchObject({ totalProfit: h.stats.totalProfit, leg1Filled: h.stats.leg1Filled });
  });
  it('partial execution preserves factual proceeds and positive residual', async () => {
    const h = fixture(guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['t1'], sizeMatched: '4' });
    h.trading.getTradeStatuses.mockResolvedValue([fill('t1', '4')]);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '6', noBalance: '0' });
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'RESIDUAL', amountReceived: 2.2,
      sellLegs: [{ realizedShares: 4, residual: 6 }] });
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled(); expect(h.stop).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it.each(['REJECTED', 'UNCERTAIN'])('one filled leg and another %s never complete the round', async state => {
    const h = fixture(guard, true);
    h.trading.createMarketOrder.mockImplementation(async p => p.tokenId === 'up'
      ? { success: true, submissionState: 'ACCEPTED', orderId: 'up', tradeIds: ['t1'] }
      : { success: false, submissionState: state });
    const result = await h.sell();
    expect(result.success).toBe(false); expect(result.amountReceived).toBe(5.5);
    expect(result.sellLegs?.[0].realizedShares).toBe(10);
    expect(result.sellLegs?.[1].realizedShares).toBeUndefined();
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
  });
  it('no orderbook does not imply a 0.5 execution price', async () => {
    const h = fixture(guard); Object.assign(h.service, { upAsks: [], downAsks: [] });
    expect((await h.sell()).amountReceived).toBe(5.5);
  });
  it('full fills with positive residual do not complete', async () => {
    const h = fixture(guard); h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '1', noBalance: '0' });
    expect(await h.sell()).toMatchObject({ success: false, amountReceived: 5.5, sellLegs: [{ residual: 1 }] });
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
  });
  it('failed trades prove zero proceeds, never a full exit', async () => {
    const h = fixture(guard); h.trading.getTradeStatuses.mockResolvedValue([{ ...fill(), status: 'FAILED', transactionHash: undefined }]);
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'NO_FILL', amountReceived: 0, sellLegs: [{ realizedShares: 0 }] });
  });
  it('empty matched set is insufficient proof of terminal zero fill', async () => {
    const h = fixture(guard); h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: [], sizeMatched: '0' });
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: undefined });
  });
  it('aggregates multiple fills exactly and returns a cumulative copy on repeated calls', async () => {
    const h = fixture(guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['t1', 't2', 't2'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([fill('t1', '4', '0.5'), fill('t2', '6', '0.6')]);
    const first = await h.sell(); expect(first.amountReceived).toBe(5.6);
    first.amountReceived = 999; first.sellLegs![0].proceeds = 999;
    expect(await h.sell()).toMatchObject({ amountReceived: 5.6, sellLegs: [{ proceeds: 5.6 }] });
    await h.rotate(); await h.rotate();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1); expect(h.settled).toHaveBeenCalledTimes(1);
    expect(h.service.getStats().totalProfit).toBe(h.stats.totalProfit);
  });
  it('UNKNOWN later reconciles without another submission', async () => {
    const h = fixture(guard); h.trading.getTradeStatuses.mockResolvedValueOnce([{ id: 't1', status: 'UNKNOWN' }]);
    expect((await h.sell()).success).toBe(false);
    expect(await h.sell()).toMatchObject({ success: true, amountReceived: 5.5 });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('late children are unioned, repeated facts never added twice', async () => {
    const h = fixture(guard);
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: ['t1'], sizeMatched: '4' });
    h.trading.getTradeStatuses.mockResolvedValueOnce([fill('t1', '4', '0.5')]);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValueOnce({ yesBalance: '6', noBalance: '0' });
    expect((await h.sell()).amountReceived).toBe(2);
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['t1', 't2'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([fill('t1', '4', '0.5'), fill('t2', '6', '0.6')]);
    expect(await h.sell()).toMatchObject({ success: true, amountReceived: 5.6 });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('concurrent public calls and rotation share a single submission', async () => {
    const h = fixture(guard);
    await Promise.all([h.sell(), h.sell(), h.rotate()]);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1); expect(h.settled).toHaveBeenCalledTimes(1);
  });
  it('listener failure cannot replay finalization', async () => {
    const h = fixture(guard); h.service.on('settled', () => { throw new Error('telemetry'); });
    await h.rotate(); await h.rotate();
    expect(h.settled).toHaveBeenCalledTimes(1); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'duplicate', 'mismatch', 'price', 'balance', 'rpc', 'wallet'])('insufficient %s evidence remains pending', async reason => {
    const h = fixture(guard);
    if (reason === 'missing') h.trading.getTradeStatuses.mockResolvedValue([]);
    if (reason === 'duplicate') h.trading.getTradeStatuses.mockResolvedValue([fill(), fill('t1', '10', '0.8')]);
    if (reason === 'mismatch') h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['t1'], sizeMatched: '11' });
    if (reason === 'price') h.trading.getTradeStatuses.mockResolvedValue([fill('t1', '10', 'NaN')]);
    if (reason === 'balance') h.ctf.getPositionBalanceByTokenIds.mockRejectedValue(new Error('RPC'));
    if (reason === 'rpc') h.trading.getOrderFillDetails.mockRejectedValue(new Error('RPC'));
    if (reason === 'wallet') h.ctf.getAddress.mockReturnValue('0x' + 'cd'.repeat(20));
    expect((await h.sell()).success).toBe(false);
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
  });
  it('transport failure remains ambiguous without blind retry', async () => {
    const h = fixture(guard); h.trading.createMarketOrder.mockRejectedValue(new Error('timeout'));
    expect((await h.sell()).success).toBe(false); expect((await h.sell()).success).toBe(false);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('two full legs preserve independent facts', async () => {
    const h = fixture(guard, true);
    h.trading.createMarketOrder.mockImplementation(async p => ({ success: true, submissionState: 'ACCEPTED', orderId: p.tokenId }));
    h.trading.getOrderFillDetails.mockImplementation(async id => ({ tradeIds: [id], sizeMatched: '10' }));
    h.trading.getTradeStatuses.mockImplementation(async ids => ids.map(id => fill(id, '10', id === 'up' ? '0.55' : '0.35')));
    expect(await h.sell()).toMatchObject({ success: true, amountReceived: 9,
      sellLegs: [{ proceeds: 5.5 }, { proceeds: 3.5 }] });
  });
  it('duplicate factual order cannot double proceeds across legs', async () => {
    const h = fixture(guard, true);
    h.trading.createMarketOrder.mockResolvedValue({ success: true, submissionState: 'ACCEPTED', orderId: 'same', tradeIds: ['t1'] });
    h.trading.getTradeStatuses.mockResolvedValue([{ ...fill(), taker_order_id: 'same' }]);
    expect(await h.sell()).toMatchObject({ success: false, amountReceived: 5.5 });
    expect((await h.sell()).amountReceived).toBe(5.5);
  });
  it('duplicate factual trade under distinct orders cannot double proceeds', async () => {
    const h = fixture(guard, true);
    expect(await h.sell()).toMatchObject({ success: false, amountReceived: 5.5 });
  });
  it('balance retry retains fills and never resubmits', async () => {
    const h = fixture(guard);
    h.ctf.getPositionBalanceByTokenIds.mockRejectedValueOnce(new Error('RPC'));
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: 5.5, sellLegs: [{ residual: undefined }] });
    expect(await h.sell()).toMatchObject({ success: true, amountReceived: 5.5 });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('conflicting repeated fill cannot authorize completion', async () => {
    const h = fixture(guard);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValueOnce({ yesBalance: '1', noBalance: '0' });
    expect((await h.sell()).success).toBe(false);
    h.trading.getTradeStatuses.mockResolvedValue([fill('t1', '10', '0.8')]);
    expect(await h.sell()).toMatchObject({ success: false, amountReceived: 5.5 });
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
  });
  it('leg created during reconciliation prevents finalization (real executeLeg2)', async () => {
    const h = fixture(guard);
    h.service.updateConfig({ autoMerge: false, splitOrders: 1, orderIntervalMs: 0 });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.trading.getTradeStatuses.mockImplementationOnce(async () => { entered(); await gate; return [fill()]; });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '10' });
    const pending = h.sell();
    await started;
    h.trading.createMarketOrder.mockResolvedValueOnce({ success: true, submissionState: 'ACCEPTED', orderId: 'buy-down', tradeIds: ['buy-fill'] });
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ id: 'buy-down', asset_id: 'down', side: 'BUY', tradeIds: ['buy-fill'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValueOnce([{ ...fill('buy-fill'), asset_id: 'down', side: 'BUY', taker_order_id: 'buy-down' }]);
    const bought = await h.service.executeLeg2({ type: 'leg2', roundId: 'r', hedgeSide: 'DOWN',
      tokenId: 'down', shares: 10, targetPrice: .5, currentPrice: .5, source: 'test' } as any);
    expect(bought.success).toBe(true); expect(h.round.leg2.shares).toBe(10);
    release();
    expect(await pending).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: 5.5 });
    expect(h.service['sellSettlements'].get(h.round)?.finalized).toBeUndefined();
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING' });
    await h.rotate();
    expect(h.settled).not.toHaveBeenCalled(); expect(h.stop).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder.mock.calls.filter(([p]) => p.side === 'SELL')).toHaveLength(1);
  });
  it('a newly added leg with factual zero balance does not block forever', async () => {
    const h = fixture(guard);
    h.trading.getTradeStatuses.mockImplementationOnce(async () => {
      h.round.leg2 = { tokenId: 'down', side: 'DOWN', shares: 10, price: .4 };
      return [fill()];
    });
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.service['sellSettlements'].get(h.round)?.finalized).toBeUndefined();
    expect(await h.sell()).toMatchObject({ success: true, sellState: 'COMPLETE', amountReceived: 5.5 });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    await h.rotate(); await h.rotate(); expect(h.settled).toHaveBeenCalledTimes(1);
  });
  it('leg size changed during reconciliation prevents completion of the old snapshot', async () => {
    const h = fixture(guard, true); h.round.leg2.shares = 5;
    h.trading.createMarketOrder.mockImplementation(async p => ({ success: true, submissionState: 'ACCEPTED', orderId: p.tokenId }));
    h.trading.getOrderFillDetails.mockImplementation(async id => ({ tradeIds: [id], sizeMatched: id === 'up' ? '10' : '5' }));
    h.trading.getTradeStatuses.mockImplementation(async ids => {
      if (ids[0] === 'down') h.round.leg2.shares = 10;
      return ids.map(id => fill(id, id === 'up' ? '10' : '5', '0.5'));
    });
    // Even zero balances cannot bypass a mutation in the current pass.
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: 7.5 });
    expect(h.service['sellSettlements'].get(h.round)?.finalized).toBeUndefined();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '5' });
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
  });
  it.each(['reference', 'token', 'side', 'shares'] as const)('revalidates leg %s before completion', async field => {
    const h = fixture(guard);
    h.ctf.getPositionBalanceByTokenIds.mockImplementationOnce(async () => {
      if (field === 'reference') h.round.leg1 = { ...h.round.leg1 };
      if (field === 'token') h.round.leg1.tokenId = 'down';
      if (field === 'side') h.round.leg1.side = 'DOWN';
      if (field === 'shares') h.round.leg1.shares = 12;
      return { yesBalance: '0', noBalance: '0' };
    });
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.service['sellSettlements'].get(h.round)?.finalized).toBeUndefined();
  });
  it('revalidates again after the additional changed-composition balance read', async () => {
    const h = fixture(guard);
    h.trading.getTradeStatuses.mockImplementationOnce(async () => {
      h.round.leg2 = { tokenId: 'down', side: 'DOWN', shares: 10, price: .4 };
      return [fill()];
    });
    await h.sell();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValueOnce({ yesBalance: '0', noBalance: '0' })
      .mockImplementationOnce(async () => { h.round.leg2.shares = 20; return { yesBalance: '0', noBalance: '0' }; });
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.service['sellSettlements'].get(h.round)?.finalized).toBeUndefined();
  });
  it('a cached final result is not reused for changed exposure', async () => {
    const h = fixture(guard); expect((await h.sell()).success).toBe(true);
    h.round.leg2 = { tokenId: 'down', side: 'DOWN', shares: 10, price: .4 };
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '10' });
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING' });
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('a failed changed-composition balance read stays pending', async () => {
    const h = fixture(guard);
    h.trading.getTradeStatuses.mockImplementationOnce(async () => {
      h.round.leg2 = { tokenId: 'down', side: 'DOWN', shares: 10, price: .4 };
      return [fill()];
    });
    await h.sell();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValueOnce({ yesBalance: '0', noBalance: '0' })
      .mockRejectedValueOnce(new Error('RPC'));
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('rotation revalidates composition at the emission boundary', async () => {
    const h = fixture(guard);
    const settle = h.service.settle.bind(h.service);
    vi.spyOn(h.service, 'settle').mockImplementationOnce(async strategy => {
      const result = await settle(strategy);
      h.round.leg2 = { tokenId: 'down', side: 'DOWN', shares: 10, price: .4 };
      return result;
    });
    await h.rotate();
    expect(h.settled).not.toHaveBeenCalled(); expect(h.stop).not.toHaveBeenCalled();
  });
  it.each([
    ['token', { asset_id: 'OTHER' }],
    ['side', { side: 'BUY' }],
    ['order', { taker_order_id: 'OTHER_ORDER' }],
    ['missing token', { asset_id: undefined }],
    ['missing side', { side: undefined }],
    ['missing order', { taker_order_id: undefined }],
    ['missing role', { trader_side: undefined }],
    ['missing maker relationship', { maker_orders: undefined }],
    ['incompatible role', { trader_side: 'MAKER' }],
    ['invalid hash', { transactionHash: 'not-a-transaction' }],
    ['missing hash', { transactionHash: undefined }],
    ['not mined', { status: 'MATCHED' }],
    ['token case', { asset_id: 'UP' }],
    ['order case', { taker_order_id: 'UP' }],
  ])('rejects %s identity as economic authority', async (_label, overrides) => {
    const h = fixture(guard);
    h.trading.getTradeStatuses.mockResolvedValue([{ ...fill(), ...overrides as object }]);
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: undefined,
      sellLegs: [{ realizedShares: undefined }] });
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('valid taker identity is sufficient for 10 shares at 0.55', async () => {
    const h = fixture(guard);
    expect(await h.sell()).toMatchObject({ success: true, amountReceived: 5.5, sellLegs: [{ realizedShares: 10 }] });
  });
  it.each([true, false])('uses maker allocation, not total taker size/price (maker side present=%s)', async explicitSide => {
    const h = fixture(guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'up', asset_id: 'up', side: 'SELL', tradeIds: ['t1'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([{ ...fill(), side: 'BUY', trader_side: 'MAKER',
      taker_order_id: 'taker', size: '100', price: '0.9', maker_orders: [
        { order_id: 'up', asset_id: 'up', matched_amount: '10', price: '0.55', ...(explicitSide ? { side: 'SELL' } : {}) },
        { order_id: 'other', asset_id: 'up', matched_amount: '90', price: '0.6', side: 'SELL' },
      ] }]);
    expect(await h.sell()).toMatchObject({ success: true, amountReceived: 5.5,
      sellLegs: [{ realizedShares: 10, executionPrice: .55 }] });
  });
  it.each(['token', 'side', 'order', 'duplicate', 'ambiguous', 'self', 'taker side'])('rejects contradictory maker %s', async reason => {
    const h = fixture(guard);
    const maker: any = { order_id: 'up', asset_id: 'up', matched_amount: '10', price: '0.55', side: 'SELL' };
    if (reason === 'token') maker.asset_id = 'other';
    if (reason === 'side') maker.side = 'BUY';
    if (reason === 'order') maker.order_id = 'other';
    if (reason === 'ambiguous') delete maker.side;
    h.trading.getTradeStatuses.mockResolvedValue([{ ...fill(), trader_side: 'MAKER',
      side: reason === 'taker side' ? 'SELL' : 'BUY', taker_order_id: reason === 'self' ? 'up' : 'taker',
      maker_orders: reason === 'duplicate' ? [maker, { ...maker }] : [maker] }]);
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: undefined });
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
  });
  it.each(['id', 'asset_id', 'side'])('rejects contradictory order metadata %s', async field => {
    const h = fixture(guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'up', asset_id: 'up', side: 'SELL',
      tradeIds: ['t1'], sizeMatched: '10', [field]: 'WRONG' });
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: undefined });
  });
  it('counts only the valid part of mixed evidence; correction later is cumulative', async () => {
    const h = fixture(guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['t1', 't2'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([fill('t1', '4', '0.52'), { ...fill('t2', '6', '0.48'), asset_id: 'OTHER' }]);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '6', noBalance: '0' });
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: 2.08,
      sellLegs: [{ realizedShares: 4, residual: 6 }] });
    await h.rotate(); expect(h.settled).not.toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([fill('t1', '4', '0.52'), fill('t2', '6', '0.48')]);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    expect(await h.sell()).toMatchObject({ success: true, amountReceived: 4.96 });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('identical duplicate trade IDs and equivalent hash casing are counted once', async () => {
    const h = fixture(guard);
    h.trading.getTradeStatuses.mockResolvedValue([fill(), { ...fill(), transactionHash: tx.toUpperCase() }]);
    expect(await h.sell()).toMatchObject({ success: true, amountReceived: 5.5 });
    expect((await h.sell()).amountReceived).toBe(5.5);
    await h.rotate(); await h.rotate(); expect(h.settled).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('real TradingService readers preserve and enforce trade identity (valid=%s)', async valid => {
    const h = fixture(guard);
    const raw = { id: 't1', status: 'CONFIRMED', transaction_hash: tx, size: '10', price: '0.55',
      asset_id: valid ? 'up' : 'OTHER_TOKEN', side: valid ? 'SELL' : 'BUY',
      taker_order_id: valid ? 'up' : 'OTHER_ORDER', trader_side: 'TAKER', maker_orders: [] };
    const client = { getOrder: vi.fn(async () => ({ id: 'up', asset_id: 'up', side: 'SELL', associate_trades: ['t1'], size_matched: '10' })),
      getTrades: vi.fn(async () => [raw]) };
    Object.assign(h.trading, { ensureInitialized: async () => client,
      getOrderFillDetails: TradingService.prototype.getOrderFillDetails,
      getTradeStatuses: TradingService.prototype.getTradeStatuses });
    const result = await h.sell();
    expect(result.success).toBe(valid); expect(result.amountReceived).toBe(valid ? 5.5 : undefined);
    await h.rotate(); expect(h.settled).toHaveBeenCalledTimes(valid ? 1 : 0);
    expect(client.getOrder).toHaveBeenCalledWith('up');
    expect(client.getTrades).toHaveBeenCalledWith({ id: 't1' }, true);
  });
  it('real TradingService preserves maker metadata and uses the local allocation', async () => {
    const h = fixture(guard);
    const rawMaker = { order_id: 'up', asset_id: 'up', side: 'SELL', matched_amount: '10', price: '0.55' };
    const client = { getOrder: async () => ({ id: 'up', asset_id: 'up', side: 'SELL', associate_trades: ['t1'], size_matched: '10' }),
      getTrades: async () => [{ id: 't1', status: 'MINED', transaction_hash: tx, size: '100', price: '0.9',
        asset_id: 'up', side: 'BUY', taker_order_id: 'taker', trader_side: 'MAKER', maker_orders: [rawMaker] }] };
    Object.assign(h.trading, { ensureInitialized: async () => client,
      getOrderFillDetails: TradingService.prototype.getOrderFillDetails,
      getTradeStatuses: TradingService.prototype.getTradeStatuses });
    expect(await h.sell()).toMatchObject({ success: true, amountReceived: 5.5 });
  });
  it('maker allocation cannot exceed total trade size', async () => {
    const h = fixture(guard);
    h.trading.getTradeStatuses.mockResolvedValue([{ ...fill(), size: '5', side: 'BUY', trader_side: 'MAKER',
      taker_order_id: 'taker', maker_orders: [{ order_id: 'up', asset_id: 'up', side: 'SELL', matched_amount: '10', price: '0.55' }] }]);
    expect(await h.sell()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: undefined });
  });
});
