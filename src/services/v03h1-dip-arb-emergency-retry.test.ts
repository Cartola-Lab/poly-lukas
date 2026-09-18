import { describe, it, expect, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';
import { TradingService } from './trading-service.js';
const wallet = '0x' + 'ab'.repeat(20), hash = '0x' + '12'.repeat(32);
const fill = (size = '10') => ({ id: 'a', size, price: '0.5', status: 'CONFIRMED', transactionHash: hash,
  asset_id: 'up', side: 'SELL', taker_order_id: 'sell-1', trader_side: 'TAKER', maker_orders: [] });
function fixture(guard: boolean, children = ['a']) {
  let n = 0;
  const raw = vi.fn(async (): Promise<any> => ({ id: 'sell-1', asset_id: 'up', side: 'SELL', status: 'LIVE', size_matched: '0', associate_trades: children }));
  const trading = { getAddress: () => wallet,
    createMarketOrder: vi.fn(async (): Promise<any> => ({ success: true, submissionState: 'ACCEPTED', orderId: `sell-${++n}`, tradeIds: children })),
    getOrderFillDetails: (id: string) => TradingService.prototype.getOrderFillDetails.call({ ensureInitialized: async () => ({ getOrder: raw }) } as any, id),
    getTradeStatuses: vi.fn(async (): Promise<any[]> => children.map(id => ({ id, status: 'FAILED' }))) };
  const ctf = { getAddress: () => wallet, getPositionBalanceByTokenIds: vi.fn(async (): Promise<any> => ({ yesBalance: '10', noBalance: '0' })) };
  const service = new DipArbService({} as any, trading as any, {} as any);
  const round: any = { roundId: 'r', phase: 'leg1_filled', leg1: { tokenId: 'up', side: 'UP', shares: 10, cost: 4, price: .4 } };
  Object.assign(service, { currentRound: round, market: { upTokenId: 'up', downTokenId: 'down', conditionId: 'c' }, ctf, isRunning: true, upAsks: [{ price: .6 }] });
  service.updateConfig({ debug: false, feeRateBps: 0 });
  if (guard) service.setInventoryAdmissionGuard(() => undefined);
  const exit = () => service['emergencyExitLeg1']();
  const canceled = () => raw.mockResolvedValue({ id: 'sell-1', asset_id: 'up', side: 'SELL', status: 'CANCELED', size_matched: '0', associate_trades: [] });
  return { service, raw, trading, ctf, round, exit, canceled };
}
describe.each([false, true])('P0.3h.1 retry authority guard=%s', guard => {
  it('lookup failure then known FAILED preserves exact prior attempt through repeated calls', async () => {
    const h = fixture(guard); h.raw.mockRejectedValue(new Error('RPC'));
    await h.exit(); const prior = h.service['emergencySells'].get(h.round.leg1);
    await h.exit(); await h.exit();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service['emergencySells'].get(h.round.leg1)).toBe(prior);
    expect(prior?.settlement.legs[0].orderId).toBe('sell-1');
    expect(h.round.leg1.exitPending).toBe(true);
  });
  it('known failures remain insufficient even with canceled zero snapshot that omits known children', async () => {
    const h = fixture(guard); await h.exit(); h.canceled(); await h.exit();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('late fill reconciles original SELL after lookup failure', async () => {
    const h = fixture(guard); h.raw.mockRejectedValueOnce(new Error('RPC')); await h.exit();
    h.raw.mockResolvedValue({ id: 'sell-1', asset_id: 'up', side: 'SELL', status: 'MATCHED', size_matched: '10', associate_trades: ['a'] });
    h.trading.getTradeStatuses.mockResolvedValue([fill()]); h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    expect(await h.exit()).toMatchObject({ success: true, orderId: 'sell-1', shares: 10, amountReceived: 5 });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('partial factual execution can never be discarded as failed', async () => {
    const h = fixture(guard); h.ctf.getPositionBalanceByTokenIds.mockResolvedValueOnce({ yesBalance: '10', noBalance: '0' }).mockResolvedValue({ yesBalance: '8', noBalance: '0' });
    h.raw.mockResolvedValue({ id: 'sell-1', asset_id: 'up', side: 'SELL', status: 'LIVE', size_matched: '2', associate_trades: ['a'] });
    h.trading.getTradeStatuses.mockResolvedValue([fill('2')]);
    expect(await h.exit()).toMatchObject({ success: false, shares: 2, amountReceived: 1, residual: 8 });
    h.canceled(); h.trading.getTradeStatuses.mockResolvedValue([{ id: 'a', status: 'FAILED' }]); await h.exit();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1); expect(h.round.leg1.shares).toBe(8);
  });
  it.each(['order', 'enumeration', 'trades', 'balance'])('failed %s observation cannot unlock retry', async failure => {
    const h = fixture(guard, failure === 'trades' ? ['a'] : []); await h.exit(); h.canceled();
    if (failure === 'order') h.raw.mockRejectedValue(new Error('RPC'));
    if (failure === 'enumeration') h.raw.mockResolvedValue({ id: 'sell-1', asset_id: 'up', side: 'SELL', status: 'CANCELED', size_matched: '0' });
    if (failure === 'trades') h.trading.getTradeStatuses.mockRejectedValue(new Error('RPC'));
    if (failure === 'balance') h.ctf.getPositionBalanceByTokenIds.mockRejectedValue(new Error('RPC'));
    await h.exit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1); expect(h.round.leg1.exitPending).toBe(true);
  });
  it.each(['LIVE', 'MATCHED', 'INVALID', undefined])('status %s does not prove canceled non-fill', async status => {
    const h = fixture(guard, []); await h.exit(); h.raw.mockResolvedValue({ id: 'sell-1', asset_id: 'up', side: 'SELL', status, size_matched: '0', associate_trades: [] });
    await h.exit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('explicit canceled zero order with empty history allows existing retry exactly once concurrently', async () => {
    const h = fixture(guard, []); await h.exit(); h.canceled();
    const old = h.service['emergencySells'].get(h.round.leg1);
    await Promise.all([h.exit(), h.exit()]);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.service['emergencySells'].get(h.round.leg1)).not.toBe(old);
    expect(h.service['emergencySells'].get(h.round.leg1)?.settlement.legs[0].orderId).toBe('sell-2');
    expect(h.service.getStats().totalProfit).toBe(0);
  });
});
