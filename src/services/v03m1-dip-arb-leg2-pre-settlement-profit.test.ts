import { describe, expect, it, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';
import { MergeProvenanceError } from '../clients/ctf-client.js';

const wallet = '0x' + 'ab'.repeat(20), hash = '0x' + '12'.repeat(32), mergeHash = '0x' + '34'.repeat(32);

function fixture(opts: { autoMerge?: boolean; leg1Cost?: number } = {}) {
  const trade = (id = 'fill', size = '10'): any => ({ id, size, price: '0.3', status: 'CONFIRMED',
    transactionHash: hash, asset_id: 'down', side: 'BUY', taker_order_id: 'order', trader_side: 'TAKER', maker_orders: [] });
  const trading = { getAddress: () => wallet,
    createMarketOrder: vi.fn(async (): Promise<any> => ({ success: true, submissionState: 'ACCEPTED', orderId: 'order', tradeIds: ['fill'] })),
    getOrderFillDetails: vi.fn(async (): Promise<any> => ({ id: 'order', asset_id: 'down', side: 'BUY', tradeIds: ['fill'], sizeMatched: '10' })),
    getTradeStatuses: vi.fn(async (): Promise<any[]> => [trade()]) };
  const ctf = { getAddress: () => wallet,
    getPositionBalanceByTokenIds: vi.fn(async () => ({ yesBalance: '10', noBalance: '10' })),
    mergeByTokenIds: vi.fn(async (..._args: any[]): Promise<any> => ({ success: true, txHash: mergeHash, amount: '10', usdcReceived: '10',
      provenance: { state: 'CONFIRMED', transactionHash: mergeHash } })) };
  const service = new DipArbService({} as any, trading as any, {} as any);
  const round: any = { roundId: 'r', phase: 'leg1_filled', startTime: Date.now(),
    leg1: { tokenId: 'up', side: 'UP', shares: 10, price: .4, timestamp: Date.now(), ...(opts.leg1Cost !== undefined ? { cost: opts.leg1Cost } : {}) } };
  const market = { conditionId: 'c', upTokenId: 'up', downTokenId: 'down', slug: 'm', negRisk: false, endTime: new Date(Date.now() + 60000) };
  Object.assign(service, { market, currentRound: round, ctf, isRunning: true });
  service.updateConfig({ debug: false, autoMerge: opts.autoMerge ?? false, autoExecute: true, splitOrders: 1, orderIntervalMs: 0, executionCooldown: 0 });
  service.setInventoryAdmissionGuard(() => undefined);
  const signal: any = { type: 'leg2', roundId: 'r', tokenId: 'down', dipSide: 'UP', hedgeSide: 'DOWN',
    shares: 10, targetPrice: .3, currentPrice: .3, source: 'test' };
  const events = { roundComplete: vi.fn(), execution: vi.fn(), settled: vi.fn() };
  for (const [name, fn] of Object.entries(events)) service.on(name, fn);
  const before = service.getStats();
  const run = () => service.executeLeg2(signal);
  return { service, round, trading, ctf, run, trade, signal, events, before };
}

function expectNoRealizedProfit(h: ReturnType<typeof fixture>) {
  const stats = h.service.getStats();
  expect(stats.totalProfit).toBe(h.before.totalProfit);
  expect(stats.totalProfit).toBe(0);
  expect(h.round.profit).toBeUndefined();
  expect(h.events.roundComplete).toHaveBeenCalledTimes(1);
  const result = h.events.roundComplete.mock.calls[0][0];
  expect(result.profit).toBeUndefined();
  expect(result.profitRate).toBeUndefined();
  expect('profit' in result).toBe(false);
  expect('profitRate' in result).toBe(false);
  return result;
}

describe('P0.3 DipArb B1: factual Leg2 completion books no pre-settlement profit', () => {
  it('autoMerge=false keeps factual legs/cost and withholds realized profit', async () => {
    const h = fixture({ autoMerge: false });
    const exec = await h.run();
    expect(exec).toMatchObject({ success: true, leg: 'leg2', roundId: 'r', side: 'DOWN', shares: 10, price: .3, cost: 3, orderId: 'order' });
    expect(h.round.phase).toBe('completed');
    expect(h.round.leg1).toMatchObject({ tokenId: 'up', shares: 10, price: .4 });
    expect(h.round.leg2).toMatchObject({ tokenId: 'down', side: 'DOWN', shares: 10, price: .3, cost: 3 });
    expect(h.round.totalCost).toBeCloseTo(.7, 12);
    expect(h.service.getStats().totalSpent).toBeCloseTo(4 + 3, 12);
    const result = expectNoRealizedProfit(h);
    expect(result).toMatchObject({ roundId: 'r', status: 'completed', totalCost: h.round.totalCost, merged: false,
      leg1: h.round.leg1, leg2: h.round.leg2 });
    expect(result.mergeTxHash).toBeUndefined();
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  });

  it('signal-driven Leg2 publishes a factual execution result without realized profit', async () => {
    const h = fixture({ autoMerge: false });
    await h.service['handleSignal'](h.signal);
    expect(h.events.execution).toHaveBeenCalledTimes(1);
    expect(h.events.execution.mock.calls[0][0]).toMatchObject({ success: true, leg: 'leg2', shares: 10, price: .3, cost: 3 });
    expect(h.events.execution.mock.calls[0][0].profit).toBeUndefined();
    expectNoRealizedProfit(h);
  });

  it('autoMerge=true with a failed merge books no Leg2 profit and publishes none', async () => {
    const h = fixture({ autoMerge: true });
    h.ctf.mergeByTokenIds.mockResolvedValue({ success: false, error: 'merge failed' });
    expect((await h.run()).success).toBe(true);
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    const result = expectNoRealizedProfit(h);
    expect(result.merged).toBe(false);
    expect(result.mergeTxHash).toBeUndefined();
    expect(h.round.phase).toBe('completed');
    expect(h.service.getStats().totalSpent).toBeCloseTo(7, 12);
  });

  it.each(['UNCERTAIN', 'SUBMITTED', 'UNKNOWN'] as const)('autoMerge=true with %s merge provenance books no realized profit', async state => {
    const h = fixture({ autoMerge: true });
    h.ctf.mergeByTokenIds.mockRejectedValue(new MergeProvenanceError(new Error('receipt unavailable'),
      { state, transactionHash: state === 'UNKNOWN' ? undefined : mergeHash } as any));
    expect((await h.run()).success).toBe(true);
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    const result = expectNoRealizedProfit(h);
    expect(result.merged).toBe(false);
    expect(h.round.phase).toBe('completed');
  });

  it('autoMerge=true with a plain merge throw books no realized profit', async () => {
    const h = fixture({ autoMerge: true });
    h.ctf.mergeByTokenIds.mockRejectedValue(new Error('rpc down'));
    expect((await h.run()).success).toBe(true);
    const result = expectNoRealizedProfit(h);
    expect(result.merged).toBe(false);
  });

  it('autoMerge=true with a confirmed merge keeps merge flow unchanged and adds no settlement accounting here', async () => {
    const h = fixture({ autoMerge: true });
    expect((await h.run()).success).toBe(true);
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.ctf.mergeByTokenIds.mock.calls[0][0]).toBe('c');
    const result = expectNoRealizedProfit(h);
    expect(result.merged).toBe(true);
    expect(result.mergeTxHash).toBe(mergeHash);
    expect(h.service.getStats()).toMatchObject({ leg2Filled: 1, roundsSuccessful: 1, totalProfit: 0 });
    expect(h.service.getStats().totalSpent).toBeCloseTo(7, 12);
  });

  it('totalSpent grows only from factual Leg1 + Leg2 BUY costs', async () => {
    const withCost = fixture({ leg1Cost: 4.2 });
    expect((await withCost.run()).success).toBe(true);
    expect(withCost.service.getStats().totalSpent).toBeCloseTo(4.2 + 3, 12);
    const fallback = fixture();
    expect((await fallback.run()).success).toBe(true);
    expect(fallback.service.getStats().totalSpent).toBeCloseTo(.4 * 10 + 3, 12);
    for (const h of [withCost, fallback]) {
      expect(h.service.getStats().totalProfit).toBe(0);
      expect(h.round.profit).toBeUndefined();
    }
  });

  it('leg2Filled and roundsSuccessful count factual two-leg completion, not settlement', async () => {
    const h = fixture({ autoMerge: false });
    expect(h.before).toMatchObject({ leg2Filled: 0, roundsSuccessful: 0, roundsCompleted: 0 });
    expect((await h.run()).success).toBe(true);
    expect(h.service.getStats()).toMatchObject({ leg2Filled: 1, roundsSuccessful: 1, totalProfit: 0 });
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.events.settled).not.toHaveBeenCalled();
    await h.run();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()).toMatchObject({ leg2Filled: 1, roundsSuccessful: 1, totalProfit: 0 });
    expect(h.events.roundComplete).toHaveBeenCalledTimes(1);
  });

  it('roundComplete remains a pair-formation event for existing consumers', async () => {
    const h = fixture({ autoMerge: false });
    const seen: any[] = [];
    h.service.on('roundComplete', result => seen.push({ ...result }));
    expect((await h.run()).success).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ roundId: 'r', status: 'completed', leg1: h.round.leg1, leg2: h.round.leg2,
      totalCost: h.round.totalCost, merged: false });
  });

  it('incomplete Leg2 stays pending: no roundComplete, no profit, phase unchanged', async () => {
    const h = fixture({ autoMerge: true });
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ id: 'order', asset_id: 'down', side: 'BUY', tradeIds: ['fill'], sizeMatched: '4' });
    h.trading.getTradeStatuses.mockResolvedValueOnce([h.trade('fill', '4')]);
    expect(await h.run()).toMatchObject({ success: false, shares: 4 });
    expect(h.round.phase).toBe('leg1_filled');
    expect(h.round.leg2.shares).toBe(4);
    expect(h.round.totalCost).toBeUndefined();
    expect(h.round.profit).toBeUndefined();
    expect(h.service.getStats()).toMatchObject({ leg2Filled: 0, roundsSuccessful: 0, totalProfit: 0, totalSpent: 0 });
    expect(h.events.roundComplete).not.toHaveBeenCalled();
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: 'down', side: 'BUY', tradeIds: ['fill', 'later'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([h.trade('fill', '4'), h.trade('later', '6')]);
    expect(await h.run()).toMatchObject({ success: true, shares: 10 });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expectNoRealizedProfit(h);
    expect(h.service.getStats()).toMatchObject({ leg2Filled: 1, roundsSuccessful: 1 });
    expect(h.service.getStats().totalSpent).toBeCloseTo(7, 12);
  });

  it('accepted-but-unfilled Leg2 books nothing', async () => {
    const h = fixture({ autoMerge: true });
    h.trading.getTradeStatuses.mockResolvedValueOnce([{ ...h.trade(), status: 'MATCHED', transactionHash: undefined }]);
    expect(await h.run()).toMatchObject({ success: false, shares: 0 });
    expect(h.round.leg2).toBeUndefined();
    expect(h.round.profit).toBeUndefined();
    expect(h.service.getStats()).toMatchObject({ leg2Filled: 0, roundsSuccessful: 0, totalProfit: 0, totalSpent: 0 });
    expect(h.events.roundComplete).not.toHaveBeenCalled();
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  });
});
