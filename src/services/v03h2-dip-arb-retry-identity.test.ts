import { describe, it, expect, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';
const wallet = '0x' + 'ab'.repeat(20), other = '0x' + 'cd'.repeat(20);
function fixture(guarded: boolean) {
  let submits = 0, reads = 0, address = wallet;
  const trading = { getAddress: () => address,
    createMarketOrder: vi.fn(async (): Promise<any> => ({ success: true, submissionState: 'ACCEPTED', orderId: `sell-${++submits}`, tradeIds: [] })),
    getOrderFillDetails: vi.fn(async (): Promise<any> => ({ id: 'sell-1', asset_id: 'up', side: 'SELL', status: 'LIVE', sizeMatched: '0', tradeIds: [], tradeEnumerationPresent: true })),
    getTradeStatuses: vi.fn(async () => []) };
  let onRead: (() => void | Promise<void>) | undefined;
  const ctf = { getAddress: () => address, getPositionBalanceByTokenIds: vi.fn(async () => {
    reads++; if (reads === 3) await onRead?.();
    return { yesBalance: '10', noBalance: '7' };
  }) };
  const round: any = { roundId: 'r', phase: 'leg1_filled', leg1: { tokenId: 'up', side: 'UP', shares: 10, cost: 4, price: .4 } };
  const service = new DipArbService({} as any, trading as any, {} as any);
  const market = { conditionId: 'c', upTokenId: 'up', downTokenId: 'down' };
  Object.assign(service, { currentRound: round, market, ctf, isRunning: true, upAsks: [{ price: .6 }] });
  service.updateConfig({ debug: false, feeRateBps: 0 });
  const guard = vi.fn((): string | undefined => undefined); if (guarded) service.setInventoryAdmissionGuard(guard);
  const events = { execution: vi.fn(), settled: vi.fn(), roundComplete: vi.fn() };
  for (const [name, fn] of Object.entries(events)) service.on(name, fn);
  const exit = () => service['emergencyExitLeg1']();
  const proof = () => trading.getOrderFillDetails.mockResolvedValue({ id: 'sell-1', asset_id: 'up', side: 'SELL', status: 'CANCELED', sizeMatched: '0', tradeIds: [], tradeEnumerationPresent: true });
  return { service, round, market, trading, ctf, guard, events, exit, proof,
    duringRead: (fn: () => void | Promise<void>) => { onRead = fn; }, changeWallet: () => { address = other; } };
}
describe.each([false, true])('P0.3h.2 retry transport identity guard=%s', guarded => {
  it.each(['opposite', 'token', 'shares', 'round', 'wallet', 'removed', 'new-object', 'side', 'round-id'])('aborts %s mutation after safe proof during pre-submit balance await', async kind => {
    const h = fixture(guarded); await h.exit(); h.proof();
    const oldLeg = h.round.leg1, prior = h.service['emergencySells'].get(oldLeg);
    h.duringRead(() => {
      expect(h.service['emergencySells'].get(oldLeg)).toBe(prior);
      expect(oldLeg.exitPending).toBe(true);
      if (kind === 'opposite') h.round.leg1 = { tokenId: 'down', side: 'DOWN', shares: 7, cost: 3.5, price: .5 };
      if (kind === 'token') oldLeg.tokenId = 'other-token';
      if (kind === 'shares') oldLeg.shares = 7;
      if (kind === 'round') h.service['currentRound'] = { ...h.round, roundId: 'next' };
      if (kind === 'wallet') h.changeWallet();
      if (kind === 'removed') h.round.leg1 = undefined;
      if (kind === 'new-object') h.round.leg1 = { ...oldLeg };
      if (kind === 'side') oldLeg.side = 'DOWN';
      if (kind === 'round-id') h.round.roundId = 'changed';
    });
    expect(await h.exit()).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service['emergencySells'].get(oldLeg)).toBe(prior);
    expect(h.service.getStats().totalProfit).toBe(0);
    for (const fn of Object.values(h.events)) expect(fn).not.toHaveBeenCalled();
  });
  it('stable identity permits exactly one concurrent retry, removing the old attempt only at transport', async () => {
    const h = fixture(guarded); await h.exit(); h.proof();
    const old = h.service['emergencySells'].get(h.round.leg1);
    h.duringRead(() => { expect(h.service['emergencySells'].get(h.round.leg1)).toBe(old); });
    await Promise.all([h.exit(), h.exit()]);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.service['emergencySells'].get(h.round.leg1)?.settlement.legs[0].orderId).toBe('sell-2');
    expect(h.service['emergencySells'].get(h.round.leg1)).not.toBe(old);
  });
  it('concurrent callers waiting in the real post-proof window both abort on mutation', async () => {
    const h = fixture(guarded); await h.exit(); h.proof();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), waiting = new Promise<void>(r => { release = r; });
    h.duringRead(async () => { enter(); await waiting; });
    const one = h.exit(); await entered; const two = h.exit();
    h.round.leg1 = { tokenId: 'down', side: 'DOWN', shares: 7 }; release();
    for (const result of await Promise.all([one, two])) expect(result).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('mutation from logging after balance read is caught at the final transport boundary', async () => {
    const h = fixture(guarded); await h.exit(); h.proof();
    vi.spyOn(h.service as any, 'log').mockImplementation((message: unknown) => {
      if (String(message).startsWith('Selling ')) h.round.leg1.shares = 7;
    });
    expect(await h.exit()).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('changed observed balance cannot silently resize the authorized retry', async () => {
    const h = fixture(guarded); await h.exit(); h.proof();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValueOnce({ yesBalance: '10', noBalance: '7' })
      .mockResolvedValueOnce({ yesBalance: '6', noBalance: '7' });
    expect(await h.exit()).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.round.leg1.shares).toBe(10);
  });
  it('failed post-proof balance lookup retains prior attempt', async () => {
    const h = fixture(guarded); await h.exit(); h.proof();
    const prior = h.service['emergencySells'].get(h.round.leg1);
    h.duringRead(() => { throw new Error('RPC'); });
    expect((await h.exit())?.success).toBe(false);
    expect(h.service['emergencySells'].get(h.round.leg1)).toBe(prior);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  if (guarded) it('admission callback cannot mutate quantity after the outer validation', async () => {
    const h = fixture(true); await h.exit(); h.proof();
    h.guard.mockImplementation(() => { h.round.leg1.shares = 7; return undefined; });
    expect(await h.exit()).toMatchObject({ success: false, sellState: 'PENDING' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
});
