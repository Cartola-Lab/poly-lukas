import { describe, it, expect, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';
const wallet = '0x' + 'ab'.repeat(20), hash = '0x' + '12'.repeat(32);
const fill = (id = 'a', size = '10', price = '0.50'): any => ({ id, size, price, status: 'CONFIRMED',
  transactionHash: hash, asset_id: 'up', side: 'SELL', taker_order_id: 'sell', trader_side: 'TAKER', maker_orders: [] });
function fixture(guard: boolean) {
  const trading = { getAddress: () => wallet,
    createMarketOrder: vi.fn(async (): Promise<any> => ({ success: true, submissionState: 'ACCEPTED', orderId: 'sell', tradeIds: ['a'] })),
    getOrderFillDetails: vi.fn(async (): Promise<any> => ({ id: 'sell', asset_id: 'up', side: 'SELL', sizeMatched: '10', tradeIds: ['a'] })),
    getTradeStatuses: vi.fn(async (): Promise<any[]> => [fill()]) };
  const ctf = { getAddress: () => wallet, getPositionBalanceByTokenIds: vi.fn(async (): Promise<any> => ({ yesBalance: '0', noBalance: '0' })) };
  ctf.getPositionBalanceByTokenIds.mockResolvedValueOnce({ yesBalance: '10', noBalance: '0' });
  const service = new DipArbService({} as any, trading as any, {} as any);
  const round: any = { roundId: 'r', phase: 'leg1_filled', startTime: Date.now(), leg1: { tokenId: 'up', side: 'UP', shares: 10, price: .4, cost: 4 } };
  Object.assign(service, { currentRound: round, market: { upTokenId: 'up', downTokenId: 'down', conditionId: 'c' }, ctf, isRunning: true, upAsks: [{ price: .60 }] });
  service.updateConfig({ debug: false, feeRateBps: 0 });
  if (guard) service.setInventoryAdmissionGuard(() => undefined);
  const events = { execution: vi.fn(), roundComplete: vi.fn(), settled: vi.fn() };
  for (const [name, handler] of Object.entries(events)) service.on(name, handler);
  return { service, trading, ctf, round, events, exit: () => service['emergencyExitLeg1']() };
}
describe.each([false, true])('P0.3h emergency factual SELL guard=%s', guard => {
  it.each(['10', '0'])('acceptance and balance %s never invent fills', async balance => {
    const h = fixture(guard); h.trading.getTradeStatuses.mockResolvedValue([]);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: balance, noBalance: '0' });
    expect(await h.exit()).toMatchObject({ success: false, sellState: 'PENDING', amountReceived: undefined, price: undefined });
    await h.exit(); expect(h.round.leg1.shares).toBe(10); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service.getStats().totalProfit).toBe(0);
    for (const event of Object.values(h.events)) expect(event).not.toHaveBeenCalled();
  });
  it('single full fill closes only from attributed price and accounts once', async () => {
    const h = fixture(guard);
    const first = await h.exit(); expect(first).toMatchObject({ success: true, shares: 10, amountReceived: 5, price: .5, residual: 0, profit: 1 });
    expect(h.round.leg1.shares).toBe(0); await h.exit(); await h.exit();
    expect(h.service.getStats().totalProfit).toBe(1); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('multiple fills and snapshot independence', async () => {
    const h = fixture(guard); h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([fill('a', '4', '0.50'), fill('b', '6', '0.48')]);
    expect(await h.exit()).toMatchObject({ success: true, amountReceived: 4.88, price: .488 });
    expect(h.service.getStats().totalProfit).toBeCloseTo(.88);
  });
  it('partial remains visible; cumulative completion and concurrent reads never duplicate', async () => {
    const h = fixture(guard); h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a'], sizeMatched: '6' });
    h.trading.getTradeStatuses.mockResolvedValue([fill('a', '6', '0.48')]);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '4', noBalance: '0' });
    expect(await h.exit()).toMatchObject({ success: false, shares: 6, amountReceived: 2.88, residual: 4, sellState: 'RESIDUAL' });
    expect(h.round.leg1.shares).toBe(4); expect(h.service.getStats().currentRound?.leg1?.shares).toBe(4);
    await h.exit(); expect(h.round.leg1.shares).toBe(4); expect(h.service.getStats().totalProfit).toBe(0);
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([fill('a', '6', '0.48'), fill('b', '4', '0.50')]);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    const results = await Promise.all([h.exit(), h.exit()]);
    for (const result of results) expect(result).toMatchObject({ success: true, shares: 10, amountReceived: 4.88, residual: 0 });
    expect(h.service.getStats().totalProfit).toBeCloseTo(.88); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it.each([{ side: 'BUY' }, { asset_id: 'other' }, { transactionHash: 'bad' }, { status: 'MATCHED' }, { taker_order_id: 'other' }])('rejects invalid attribution %j', async patch => {
    const h = fixture(guard); h.trading.getTradeStatuses.mockResolvedValue([{ ...fill(), ...patch }]);
    expect(await h.exit()).toMatchObject({ success: false, amountReceived: undefined }); expect(h.round.leg1.shares).toBe(10);
  });
  it('maker uses only our matched amount and price', async () => {
    const h = fixture(guard); h.trading.getTradeStatuses.mockResolvedValue([{ ...fill(), trader_side: 'MAKER', taker_order_id: 'other',
      side: 'BUY', size: '100', price: '0.9', maker_orders: [{ order_id: 'sell', asset_id: 'up', side: 'SELL', matched_amount: '10', price: '0.48' }] }]);
    expect(await h.exit()).toMatchObject({ success: true, shares: 10, price: .48, amountReceived: 4.8 });
  });
  it('unknown entry cost preserves exit proceeds without PnL', async () => {
    const h = fixture(guard); h.round.leg1.price = undefined; h.round.leg1.cost = undefined;
    expect(await h.exit()).toMatchObject({ success: true, amountReceived: 5, profit: undefined });
    expect(h.service.getStats().totalProfit).toBe(0);
  });
  it('mutation while observing cannot close or mutate the replacement position', async () => {
    const h = fixture(guard); h.trading.getTradeStatuses.mockImplementation(async () => {
      h.round.leg1 = { tokenId: 'up', side: 'UP', shares: 20, price: .4, cost: 8 }; return [fill()];
    });
    expect(await h.exit()).toMatchObject({ success: false }); expect(h.round.leg1.shares).toBe(20);
    expect(h.service.getStats().totalProfit).toBe(0);
  });
  it('snapshot 0.60 never replaces a factual exit of 0.48', async () => {
    const h = fixture(guard); h.trading.getTradeStatuses.mockResolvedValue([fill('a', '10', '0.48')]);
    expect(await h.exit()).toMatchObject({ success: true, price: .48, amountReceived: 4.8 });
    expect(h.service.getStats().totalProfit).toBeCloseTo(.8);
  });
  it('valid partial siblings survive invalid trade evidence without completing', async () => {
    const h = fixture(guard); h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([fill('a', '6'), { ...fill('b', '4'), asset_id: 'wrong' }]);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '4', noBalance: '0' });
    expect(await h.exit()).toMatchObject({ success: false, shares: 6, amountReceived: 3, residual: 4 });
    expect(h.round.leg1.shares).toBe(4); await h.exit(); expect(h.round.leg1.shares).toBe(4);
    expect(h.service.getStats().totalProfit).toBe(0);
  });
  it('full attributed fills without a residual observation stay nonterminal', async () => {
    const h = fixture(guard); h.ctf.getPositionBalanceByTokenIds.mockRejectedValue(new Error('RPC'));
    expect(await h.exit()).toMatchObject({ success: false, shares: 10, amountReceived: 5, residual: undefined });
    expect(h.round.leg1.shares).toBe(10); expect(h.service.getStats().totalProfit).toBe(0);
  });
  it('captured composition survives a replacement during pre-submit observation', async () => {
    const h = fixture(guard);
    h.ctf.getPositionBalanceByTokenIds.mockReset().mockImplementation(async () => {
      h.round.leg1 = { tokenId: 'up', side: 'UP', shares: 20, cost: 8, price: .4 };
      return { yesBalance: h.trading.createMarketOrder.mock.calls.length ? '0' : '10', noBalance: '0' };
    });
    expect(await h.exit()).toMatchObject({ success: false }); expect(h.round.leg1.shares).toBe(20);
    expect(h.service.getStats().totalProfit).toBe(0);
  });
  it('completion logs and economics occur once; changed composition cannot reuse success', async () => {
    const h = fixture(guard), log = vi.spyOn(h.service as any, 'log');
    await h.exit(); await h.exit();
    expect(log.mock.calls.filter(([message]) => String(message).startsWith('Emergency SELL confirmed:'))).toHaveLength(1);
    h.round.leg1.shares = 4;
    expect(await h.exit()).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1); expect(h.service.getStats().totalProfit).toBe(1);
  });
  it.each(['UNCERTAIN', 'throw'])('ambiguous submission %s never blindly retries', async state => {
    const h = fixture(guard);
    if (state === 'throw') h.trading.createMarketOrder.mockRejectedValue(new Error('transport'));
    else h.trading.createMarketOrder.mockResolvedValue({ success: false, submissionState: 'UNCERTAIN' });
    await h.exit(); await h.exit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.round.leg1.shares).toBe(10); expect(h.service.getStats().totalProfit).toBe(0);
  });
});
