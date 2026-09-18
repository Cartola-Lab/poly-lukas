import { describe, expect, it, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';

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

describe.each([false, true])('P0.3g.2 BUY factual cost (guard=%s)', guard => {
  it.each([1, 2] as const)('Leg%s aggregates prices from the same factual fills', async leg => {
    const h = fixture(leg, guard);
    h.signal.targetPrice = .5;
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: h.token, side: 'BUY', tradeIds: ['fill', 'later'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade('fill', '4'), price: '0.40' }, { ...h.trade('later', '6'), price: '0.45' }]);
    expect(await h.run()).toMatchObject({ success: true, shares: 10, price: .43 });
    expect(h.round[`leg${leg}`]).toMatchObject({ shares: 10, price: .43, cost: 4.3 });
    await h.run();
    expect(h.round[`leg${leg}`].cost).toBe(4.3);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2] as const)('Leg%s accumulates partial cost exactly once', async leg => {
    const h = fixture(leg, guard);
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade('fill', '4'), price: '0.52' }]);
    expect(await h.run()).toMatchObject({ success: false, shares: 4 });
    expect(h.round[`leg${leg}`]).toMatchObject({ shares: 4, cost: 2.08, price: .52 });
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: h.token, side: 'BUY', tradeIds: ['fill', 'later'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade('fill', '4'), price: '0.52' }, { ...h.trade('later', '6'), price: '0.48' }]);
    expect(await h.run()).toMatchObject({ success: true, shares: 10, price: .496 });
    await h.run();
    expect(h.round[`leg${leg}`].cost).toBe(4.96);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it.each(['0.40', '0.42'])('single fill %s overrides target', async price => {
    const h = fixture(1, guard); h.signal.targetPrice = .5;
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade(), price }]);
    expect(await h.run()).toMatchObject({ success: true, price: Number(price) });
    expect(h.round.leg1.cost).toBe(Number(price) * 10);
  });
  it.each([undefined, 'NaN', '-1', '0', '1.01'])('unknown price %s preserves shares without invented cost', async price => {
    const h = fixture(1, guard);
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade(), price }]);
    expect(await h.run()).toMatchObject({ success: false, shares: 10 });
    expect(h.round.leg1.price).toBeUndefined(); expect(h.round.leg1.cost).toBeUndefined();
    expect(h.round.phase).toBe('waiting'); expect(h.events.execution).not.toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade(), price: '0.42' }]);
    expect(await h.run()).toMatchObject({ success: true, shares: 10, price: .42 });
    expect(h.round.leg1.cost).toBe(4.2);
  });
  it('maker uses only local allocation price and amount', async () => {
    const h = fixture(1, guard);
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade(), size: '100', price: '0.9', side: 'SELL', trader_side: 'MAKER', taker_order_id: 'other',
      maker_orders: [{ order_id: 'order', asset_id: 'up', side: 'BUY', matched_amount: '10', price: '0.42' }] }]);
    expect(await h.run()).toMatchObject({ success: true, shares: 10, price: .42 });
    expect(h.round.leg1.cost).toBe(4.2);
  });
  it('invalid sibling never contributes cost and contradictory price cannot overwrite history', async () => {
    const h = fixture(1, guard);
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: h.token, side: 'BUY', tradeIds: ['fill', 'bad'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade('fill', '4'), price: '0.52' }, { ...h.trade('bad', '6'), asset_id: 'wrong', price: '0.9' }]);
    expect(await h.run()).toMatchObject({ success: false, shares: 4 });
    expect(h.round.leg1.cost).toBe(2.08);
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade('fill', '4'), price: '0.9' }]);
    expect(await h.run()).toMatchObject({ success: false, shares: 4 });
    expect(h.round.leg1.cost).toBe(2.08);
  });
});
