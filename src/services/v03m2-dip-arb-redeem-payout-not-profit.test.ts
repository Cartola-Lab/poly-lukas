import { describe, expect, it, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';
import type { DipArbPendingRedemption } from './dip-arb-types.js';
import { RedeemProvenanceError } from '../clients/ctf-client.js';

const wallet = '0x' + 'ab'.repeat(20), hash = '0x' + '11'.repeat(32), hashB = '0x' + 'bb'.repeat(32);
const confirmed = (usdcReceived = '10', txHash = hash) => ({ success: true, txHash, amount: '10', usdcReceived,
  provenance: Object.freeze({ state: 'CONFIRMED' as const, transactionHash: txHash }) });

function fixture(opts: { legs?: 1 | 2; seededProfit?: number } = {}) {
  const trading = { getAddress: () => wallet };
  const service = new DipArbService({} as any, trading as any, {} as any);
  const market: any = { conditionId: 'condition', upTokenId: 'up', downTokenId: 'down',
    slug: 'market', negRisk: false, endTime: new Date(Date.now() - 600_000) };
  const round: any = { roundId: 'r1', phase: opts.legs === 1 ? 'leg1_filled' : 'completed', startTime: Date.now(),
    leg1: { tokenId: 'up', shares: 10, side: 'UP', price: .4, cost: 4, timestamp: Date.now() },
    ...(opts.legs === 1 ? {} : { leg2: { tokenId: 'down', shares: 10, side: 'DOWN', price: .3, cost: 3, timestamp: Date.now() }, totalCost: .7 }) };
  const ctf = { getAddress: vi.fn(() => wallet),
    getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '10', noBalance: opts.legs === 1 ? '0' : '10' }),
    getMarketResolution: vi.fn().mockResolvedValue({ isResolved: true, winningOutcome: 'YES' }),
    mergeByTokenIds: vi.fn().mockResolvedValue(confirmed()),
    redeemByTokenIds: vi.fn().mockResolvedValue(confirmed()),
    getRedeemPayout: vi.fn().mockResolvedValue({ state: 'PAYOUT_UNKNOWN', transactionHash: hash,
      pusdReceived: undefined, cause: new Error('missing receipt evidence') }) };
  Object.assign(service, { ctf, market, currentRound: round, isRunning: true });
  service.updateConfig({ debug: false });
  service.setInventoryAdmissionGuard(() => undefined);
  if (opts.seededProfit !== undefined) service['stats'].totalProfit = opts.seededProfit;
  const events = { execution: vi.fn(), settled: vi.fn(), roundComplete: vi.fn() };
  for (const [name, fn] of Object.entries(events)) service.on(name, fn);
  const logs: string[] = [];
  vi.spyOn(service as any, 'log').mockImplementation((message: any) => { logs.push(String(message)); });
  const queue = (retryCount = 0) => {
    const pending: DipArbPendingRedemption = { market, round, marketEndTime: Date.now() - 600_000, addedAt: Date.now(), retryCount };
    service['pendingRedemptions'].push(pending);
    return pending;
  };
  const before = service.getStats();
  const tombstones = () => [...service['accountedRedeemTransactions'].values()];
  return { service, ctf, market, round, events, queue, before, logs, tombstones };
}

function expectProfitUntouched(h: ReturnType<typeof fixture>) {
  const stats = h.service.getStats();
  expect(stats.totalProfit).toBe(h.before.totalProfit);
  expect(stats.totalSpent).toBe(h.before.totalSpent);
  expect(stats.roundsSuccessful).toBe(h.before.roundsSuccessful);
  expect(h.round.profit).toBeUndefined();
}

describe('P0.3 DipArb B2: confirmed redeem payout is recovered collateral, not realized profit', () => {
  it('public settle(redeem) reports the factual payout and leaves totalProfit unchanged', async () => {
    const h = fixture();
    const result = await h.service.settle('redeem');
    expect(result).toMatchObject({ success: true, strategy: 'redeem', txHash: hash, amountReceived: 10, market: h.market });
    expect((result as any).profit).toBeUndefined();
    expect(h.events.settled).toHaveBeenCalledTimes(1);
    expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: hash, amountReceived: 10 }));
    expect(h.tombstones()).toEqual([expect.objectContaining({ success: true, txHash: hash, amountReceived: 10 })]);
    expect(h.service.getPendingRedemptions()).toHaveLength(0);
    expect(h.before.totalProfit).toBe(0);
    expectProfitUntouched(h);
    const success = h.logs.filter(line => line.startsWith('Redemption successful:'));
    expect(success).toEqual([expect.stringContaining('Amount: $10.00')]);
    expect(success[0].toLowerCase()).not.toContain('profit');
  });

  it.each([3.5, -1.25])('already-realized totalProfit %s is neither added to, reset, nor overwritten', async seeded => {
    const h = fixture({ seededProfit: seeded });
    expect(h.before.totalProfit).toBe(seeded);
    expect(await h.service.settle('redeem')).toMatchObject({ success: true, amountReceived: 10 });
    expect(h.service.getStats().totalProfit).toBe(seeded);
    expectProfitUntouched(h);
    expect(await h.service.settle('redeem')).toMatchObject({ success: true, amountReceived: 10, txHash: hash });
    expect(h.service.getStats().totalProfit).toBe(seeded);
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
  });

  it('two-leg round with factual BUY costs books neither payout, payout minus cost, nor 1 - totalCost', async () => {
    const h = fixture({ legs: 2, seededProfit: 2 });
    expect(h.round).toMatchObject({ leg1: { cost: 4 }, leg2: { cost: 3 }, totalCost: .7 });
    expect(await h.service.settle('redeem')).toMatchObject({ success: true, amountReceived: 10 });
    const profit = h.service.getStats().totalProfit;
    expect(profit).toBe(2);
    expect(profit).not.toBe(2 + 10);
    expect(profit).not.toBe(2 + (10 - 7));
    expect(profit).not.toBe(2 + (1 - .7) * 10);
    expectProfitUntouched(h);
    expect(h.round).toMatchObject({ leg1: { cost: 4 }, leg2: { cost: 3 }, totalCost: .7 });
  });

  it('one-leg position reports factual payout with totalProfit unchanged', async () => {
    const h = fixture({ legs: 1, seededProfit: 1 });
    h.ctf.redeemByTokenIds.mockResolvedValue(confirmed('6.5'));
    expect(await h.service.settle('redeem')).toMatchObject({ success: true, amountReceived: 6.5, txHash: hash });
    expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ amountReceived: 6.5 }));
    expect(h.service.getStats().totalProfit).toBe(1);
    expectProfitUntouched(h);
  });

  it.each(['0', '0.0'])('confirmed zero payout %s is a factual successful settlement without profit mutation', async payout => {
    const h = fixture({ seededProfit: 4 });
    h.ctf.redeemByTokenIds.mockResolvedValue(confirmed(payout));
    expect(await h.service.settle('redeem')).toMatchObject({ success: true, amountReceived: 0, txHash: hash });
    expect(h.events.settled).toHaveBeenCalledTimes(1);
    expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, amountReceived: 0 }));
    expect(h.tombstones()).toHaveLength(1);
    expect(h.service.getStats().totalProfit).toBe(4);
    expectProfitUntouched(h);
  });

  it('queued auto-redeem path reports the same factual payout without profit mutation', async () => {
    const h = fixture({ seededProfit: .5 });
    h.queue();
    Object.assign(h.service, { currentRound: null, market: null });
    await h.service['processPendingRedemptions']();
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.events.settled).toHaveBeenCalledTimes(1);
    expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: hash, amountReceived: 10, market: h.market }));
    expect(h.service.getPendingRedemptions()).toHaveLength(0);
    expect(h.tombstones()).toEqual([expect.objectContaining({ amountReceived: 10 })]);
    expect(h.service.getStats().totalProfit).toBe(.5);
    await h.service['processPendingRedemptions']();
    expect(h.events.settled).toHaveBeenCalledTimes(1);
    expect(h.service.getStats().totalProfit).toBe(.5);
  });

  it('RedeemProvenanceError CONFIRMED with payout finalizes factually without profit mutation', async () => {
    const h = fixture({ seededProfit: 9 });
    h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('post-confirmation'),
      { state: 'CONFIRMED', transactionHash: hash }, '12.5'));
    expect(await h.service.settle('redeem')).toMatchObject({ success: true, txHash: hash, amountReceived: 12.5 });
    expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, amountReceived: 12.5 }));
    expect(h.service.getStats().totalProfit).toBe(9);
    expectProfitUntouched(h);
  });

  it('RedeemProvenanceError CONFIRMED with unknown payout resolves later via receipt without profit mutation', async () => {
    const h = fixture({ seededProfit: 9 });
    h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('unknown'),
      { state: 'CONFIRMED', transactionHash: hash }));
    expect(await h.service.settle('redeem')).toMatchObject({ success: false, txHash: hash, amountReceived: undefined, error: 'CONFIRMED_PAYOUT_PENDING' });
    expect(h.events.settled).not.toHaveBeenCalled();
    expect(h.service.getStats().totalProfit).toBe(9);
    h.ctf.getRedeemPayout.mockResolvedValue({ state: 'PAYOUT_KNOWN', transactionHash: hash, pusdReceived: '7.25' } as any);
    await h.service['processPendingRedemptions']();
    expect(h.ctf.getRedeemPayout).toHaveBeenCalledWith(hash, wallet);
    expect(h.events.settled).toHaveBeenCalledTimes(1);
    expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: hash, amountReceived: 7.25 }));
    expect(await h.service.settle('redeem')).toMatchObject({ success: true, txHash: hash, amountReceived: 7.25 });
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.service.getStats().totalProfit).toBe(9);
    expectProfitUntouched(h);
  });

  it('duplicate confirmed hash settles once, tombstones once, and never touches totalProfit', async () => {
    const h = fixture({ seededProfit: 1 });
    const a = h.queue();
    Object.assign(a, { state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: hash, historicalWallet: wallet });
    h.service['pendingRedemptions'].push({ ...a, state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: hash.toUpperCase().replace('0X', '0x'), historicalWallet: wallet });
    h.ctf.getRedeemPayout.mockImplementation(async (tx: string) => ({ state: 'PAYOUT_KNOWN', transactionHash: tx, pusdReceived: '7.25' }) as any);
    await h.service['processPendingRedemptions']();
    await h.service['processPendingRedemptions']();
    expect(h.events.settled).toHaveBeenCalledTimes(1);
    expect(h.tombstones()).toEqual([expect.objectContaining({ amountReceived: 7.25 })]);
    expect(h.service.getPendingRedemptions()).toHaveLength(0);
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    expect(h.service.getStats().totalProfit).toBe(1);
  });

  it('distinct confirmed transactions each report their own payout; totalProfit stays untouched', async () => {
    const h = fixture({ seededProfit: 1 });
    for (const tx of [hash, hashB]) {
      Object.assign(h.queue(), { state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: tx, historicalWallet: wallet });
    }
    h.ctf.getRedeemPayout.mockImplementation(async (tx: string) => ({ state: 'PAYOUT_KNOWN', transactionHash: tx,
      pusdReceived: tx === hash ? '7.25' : '12.5' }) as any);
    await h.service['processPendingRedemptions']();
    expect(h.events.settled).toHaveBeenCalledTimes(2);
    expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ txHash: hash, amountReceived: 7.25 }));
    expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ txHash: hashB, amountReceived: 12.5 }));
    expect(h.tombstones().map(t => t.amountReceived).sort()).toEqual([12.5, 7.25]);
    expect(h.service.getStats().totalProfit).toBe(1);
  });

  it('throwing settled listener does not alter accounting or totalProfit', async () => {
    const h = fixture({ seededProfit: 2 });
    h.service.on('settled', () => { throw new Error('consumer failed'); });
    expect(await h.service.settle('redeem')).toMatchObject({ success: true, amountReceived: 10 });
    expect(h.tombstones()).toHaveLength(1);
    expect(h.service.getPendingRedemptions()).toHaveLength(0);
    expect(h.service.getStats().totalProfit).toBe(2);
  });
});
