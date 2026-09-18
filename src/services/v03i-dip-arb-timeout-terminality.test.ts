import { describe, it, expect, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';

function fixture(trigger: 'timeout' | 'stop-loss') {
  const wallet = '0x' + 'ab'.repeat(20);
  let balance = '10', trades: any[] = [], matched = '10';
  const trading = {
    getAddress: () => wallet,
    createMarketOrder: vi.fn(async (): Promise<any> => ({ success: true, submissionState: 'ACCEPTED', orderId: 'sell', tradeIds: ['a'] })),
    getOrderFillDetails: vi.fn(async () => ({ id: 'sell', asset_id: 'up', side: 'SELL', tradeIds: trades.length ? trades.map(t => t.id) : ['a'], sizeMatched: matched })),
    getTradeStatuses: vi.fn(async () => trades),
  };
  const ctf = { getAddress: () => wallet, getPositionBalanceByTokenIds: vi.fn(async () => ({ yesBalance: balance, noBalance: '0' })) };
  const service = new DipArbService({} as any, trading as any, {} as any);
  const round: any = { roundId: 'r', phase: 'leg1_filled', startTime: Date.now() - (trigger === 'timeout' ? 100_000 : 0),
    leg1: { tokenId: 'up', side: 'UP', shares: 10, cost: 4, price: .4 } };
  Object.assign(service, { currentRound: round, market: { conditionId: 'c', upTokenId: 'up', downTokenId: 'down', endTime: new Date(0) },
    ctf, isRunning: true, upAsks: [{ price: trigger === 'stop-loss' ? .2 : .6 }] });
  service.updateConfig({ debug: false, feeRateBps: 0, leg2TimeoutSeconds: 60, stopLossPct: .25 });
  const terminal = vi.fn(); service.on('roundComplete', terminal);
  const facts = (sizes: string[], residual: string) => {
    trades = sizes.map((size, i) => ({ id: String.fromCharCode(97 + i), size, price: '0.5', status: 'CONFIRMED',
      transactionHash: '0x' + '12'.repeat(32), asset_id: 'up', side: 'SELL', taker_order_id: 'sell', trader_side: 'TAKER', maker_orders: [] }));
    matched = String(sizes.reduce((n, s) => n + Number(s), 0)); balance = residual;
  };
  return { service, round, trading, ctf, terminal, facts, tick: () => service['checkAndStartNewRound']() };
}

describe.each(['timeout', 'stop-loss'] as const)('P0.3i %s terminal authority', trigger => {
  it.each(['pending', 'unknown', 'failure', 'throw'] as const)('%s cannot notify terminal listeners or clear the round', async state => {
    const h = fixture(trigger);
    if (state === 'unknown') h.trading.createMarketOrder.mockResolvedValue({ success: false, submissionState: 'UNCERTAIN' });
    if (state === 'failure') h.trading.createMarketOrder.mockResolvedValue({ success: false, submissionState: 'REJECTED' });
    if (state === 'throw') h.trading.createMarketOrder.mockRejectedValue(new Error('transport'));
    await h.tick(); await h.tick(); await h.tick();
    expect(h.terminal).not.toHaveBeenCalled();
    expect(h.round.phase).toBe('leg1_filled'); expect(h.round.leg1.shares).toBe(10);
    expect(h.service.getStats().roundsCompleted).toBe(0); expect(h.service.getStats().totalProfit).toBe(0);
    if (state !== 'failure') expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('pending then partial then full reconciles the same SELL and emits factual payload once', async () => {
    const h = fixture(trigger); await h.tick(); expect(h.terminal).not.toHaveBeenCalled();
    h.facts(['6'], '4'); await h.tick(); await h.tick();
    expect(h.round.leg1.shares).toBe(4); expect(h.round.phase).toBe('leg1_filled');
    expect(h.terminal).not.toHaveBeenCalled(); expect(h.service.getStats().totalProfit).toBe(0);
    h.facts(['6', '4'], '0'); await Promise.all([h.tick(), h.tick()]); await h.tick();
    expect(h.terminal).toHaveBeenCalledTimes(1); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.terminal.mock.calls[0][0]).toMatchObject({ status: 'expired', exitResult: { success: true, sellState: 'COMPLETE', residual: 0, amountReceived: 5, price: .5 } });
    expect(h.round.phase).toBe('expired'); expect(h.service.getStats().roundsCompleted).toBe(1);
    expect(h.service.getStats().roundsExpired).toBe(1); expect(h.service.getStats().totalProfit).toBe(1);
  });
  it('immediate factual completion emits once even with concurrent checks', async () => {
    const h = fixture(trigger);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValueOnce({ yesBalance: '10', noBalance: '0' }); h.facts(['10'], '0');
    await Promise.all([h.tick(), h.tick()]); await h.tick();
    expect(h.terminal).toHaveBeenCalledTimes(1); expect(h.service.getStats().roundsCompleted).toBe(1);
  });
  it.each([['6', '1'], ['10', '4']])('inconsistent fills %s / residual %s cannot complete', async (sold, residual) => {
    const h = fixture(trigger); await h.tick(); h.facts([sold], residual); await h.tick();
    expect(h.terminal).not.toHaveBeenCalled(); expect(h.round.phase).toBe('leg1_filled'); expect(h.service.getStats().totalProfit).toBe(0);
  });
  it('throwing terminal listener cannot cause replay', async () => {
    const h = fixture(trigger); await h.tick(); h.facts(['10'], '0');
    h.service.on('roundComplete', () => { throw new Error('listener'); });
    await expect(h.tick()).rejects.toThrow('listener'); await h.tick();
    expect(h.terminal).toHaveBeenCalledTimes(1); expect(h.service.getStats().roundsCompleted).toBe(1);
  });
  it('replacement while awaiting exit cannot terminalize either round', async () => {
    const h = fixture(trigger); await h.tick(); h.facts(['10'], '0');
    const next = { ...h.round, roundId: 'next', leg1: { ...h.round.leg1 } };
    h.trading.getTradeStatuses.mockImplementation(async () => { h.service['currentRound'] = next; return []; });
    await h.tick(); expect(h.terminal).not.toHaveBeenCalled();
    expect(h.round.phase).toBe('leg1_filled'); expect(next.phase).toBe('leg1_filled');
  });
});
