import { afterEach, describe, expect, it, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';
import type { DipArbPendingRedemption } from './dip-arb-types.js';
import { MergeProvenanceError, RedeemProvenanceError, type MergeProvenance } from '../clients/ctf-client.js';

const wallet = '0x' + 'ab'.repeat(20), other = '0x' + '22'.repeat(20);
const hash = '0x' + '11'.repeat(32);
type Writer = 'merge' | 'redeem';
const confirmed = () => ({ success: true, txHash: hash, amount: '10', usdcReceived: '10',
  provenance: Object.freeze({ state: 'CONFIRMED' as const, transactionHash: hash }) });
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture(owned = false) {
  const trading = { getAddress: () => other };
  const service = new DipArbService({} as any, trading as any, {} as any);
  const market: any = { conditionId: 'condition', upTokenId: 'up', downTokenId: 'down',
    slug: 'market', negRisk: false, endTime: new Date(Date.now() - 600_000) };
  const round: any = { roundId: 'r1', phase: 'completed', startTime: Date.now(),
    leg1: { tokenId: 'up', shares: 10, side: 'UP', price: .4 },
    leg2: { tokenId: 'down', shares: 10, side: 'DOWN', price: .5 } };
  const ctf = { getAddress: vi.fn(() => wallet),
    getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '10', noBalance: '10' }),
    getMarketResolution: vi.fn().mockResolvedValue({ isResolved: true, winningOutcome: 'YES' }),
    mergeByTokenIds: vi.fn().mockResolvedValue(confirmed()),
    redeemByTokenIds: vi.fn().mockResolvedValue(confirmed()),
    getRedeemPayout: vi.fn().mockResolvedValue({ state: 'PAYOUT_UNKNOWN', transactionHash: hash,
      pusdReceived: undefined, cause: new Error('missing receipt evidence') }) };
  Object.assign(service, { ctf, market, currentRound: round, isRunning: true });
  service.updateConfig({ debug: false });
  // Admission without pre-existing legs, unless explicitly testing self-continuation.
  if (owned) trading.getAddress = () => wallet;
  else Object.assign(service, { currentRound: null });
  const guard = vi.fn((): string | undefined => undefined);
  service.setInventoryAdmissionGuard(guard);
  Object.assign(service, { currentRound: round });
  const events = { execution: vi.fn(), settled: vi.fn(), roundComplete: vi.fn(), inventoryBlocked: vi.fn() };
  for (const [name, fn] of Object.entries(events)) service.on(name, fn);
  const protection = (token = 'up', address = wallet) => service.getInventoryProtection({ walletAddress: address, tokenIds: [token] });
  const write = (writer: Writer) => writer === 'merge' ? service.merge() : service.settle('redeem');
  const transport = (writer: Writer) => writer === 'merge' ? ctf.mergeByTokenIds : ctf.redeemByTokenIds;
  const queue = (retryCount = 0) => {
    const pending: DipArbPendingRedemption = { market, round, marketEndTime: Date.now() - 600_000, addedAt: Date.now(), retryCount };
    service['pendingRedemptions'].push(pending);
    return pending;
  };
  const stats = () => { const { startTime, runningTimeMs, ...value } = service.getStats(); return value; };
  return { service, ctf, market, round, guard, events, protection, write, transport, queue, stats };
}
afterEach(() => vi.restoreAllMocks());

describe('DipArb CTF writer isolation', () => {
  for (const guarded of [false, true]) {
    for (const reverse of [false, true]) {
      it.each(['7.25', '0.0'])(`confirmed hashes coexist guard=${guarded} reversed=${reverse} payout A=%s`, async amountA => {
        const h = fixture(), hashB = '0x' + 'bb'.repeat(32);
        if (!guarded) h.service.setInventoryAdmissionGuard(undefined);
        h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('unknown'),
          { state: 'CONFIRMED', transactionHash: hash }));
        await h.service.settle('redeem');
        const a = h.service.getPendingRedemptions()[0];
        const b: DipArbPendingRedemption = { ...a, state: 'CONFIRMED_PAYOUT_PENDING',
          transactionHash: hashB, historicalWallet: wallet };
        h.service['pendingRedemptions'].push(b);
        if (reverse) h.service['pendingRedemptions'].reverse();
        h.ctf.getRedeemPayout.mockImplementation(async tx => ({ state: 'PAYOUT_KNOWN',
          transactionHash: tx, pusdReceived: tx === hash ? amountA : '12.5' }) as any);
        const queueAtSettlement: string[][] = [];
        h.service.on('settled', () => queueAtSettlement.push(h.service.getPendingRedemptions().map(p =>
          p.state === 'CONFIRMED_PAYOUT_PENDING' ? p.transactionHash : 'RETRYABLE')));
        expect(await h.service.settle('redeem')).toMatchObject({ txHash: hash, error: 'CONFIRMED_PAYOUT_PENDING' });
        await h.service['processPendingRedemptions']();
        await h.service['processPendingRedemptions']();
        expect(h.ctf.getRedeemPayout).toHaveBeenCalledTimes(2);
        expect(h.ctf.getRedeemPayout).toHaveBeenCalledWith(hash, wallet);
        expect(h.ctf.getRedeemPayout).toHaveBeenCalledWith(hashB, wallet);
        expect(h.stats().totalProfit).toBe(Number(amountA) + 12.5);
        expect(h.events.settled).toHaveBeenCalledTimes(2);
        expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: hash, amountReceived: Number(amountA) }));
        expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: hashB, amountReceived: 12.5 }));
        expect(queueAtSettlement.map(q => q.length)).toEqual([1, 0]);
        expect(await h.service.settle('redeem')).toMatchObject({ success: true, txHash: hash, amountReceived: Number(amountA) });
        expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1); // Only initial public submission.
        expect(h.service.getPendingRedemptions()).toHaveLength(0);
        expect(h.service['accountedRedeemTransactions'].size).toBe(2);
      });
    }

    it.each([true, false])(`distinct UNKNOWN/KNOWN transactions remain independent guard=${guarded} A unknown=%s`, async aUnknown => {
      const h = fixture(), hashB = '0x' + 'bb'.repeat(32);
      if (!guarded) h.service.setInventoryAdmissionGuard(undefined);
      h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('unknown'),
        { state: 'CONFIRMED', transactionHash: hash }));
      await h.service.settle('redeem');
      const a = h.service.getPendingRedemptions()[0];
      const b: DipArbPendingRedemption = { ...a, state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: hashB, historicalWallet: wallet };
      h.service['pendingRedemptions'].push(b);
      const unknownHash = aUnknown ? hash : hashB;
      h.ctf.getRedeemPayout.mockImplementation(async tx => (tx === unknownHash
        ? { state: 'PAYOUT_UNKNOWN', transactionHash: tx, pusdReceived: undefined, cause: new Error('unavailable') }
        : { state: 'PAYOUT_KNOWN', transactionHash: tx, pusdReceived: aUnknown ? '12.5' : '7.25' }) as any);
      await h.service['processPendingRedemptions']();
      expect(h.service.getPendingRedemptions()).toEqual([aUnknown ? a : b]);
      expect(h.stats().totalProfit).toBe(aUnknown ? 12.5 : 7.25);
      expect(h.service['accountedRedeemTransactions'].has(unknownHash)).toBe(false);
      expect(await h.service.settle('redeem')).toMatchObject(aUnknown
        ? { txHash: hash, error: 'CONFIRMED_PAYOUT_PENDING' } : { txHash: hash, success: true, amountReceived: 7.25 });
      h.ctf.getRedeemPayout.mockResolvedValue({ state: 'PAYOUT_KNOWN', transactionHash: unknownHash, pusdReceived: aUnknown ? '7.25' : '12.5' } as any);
      await h.service['processPendingRedemptions']();
      expect(h.stats().totalProfit).toBe(19.75);
      expect(h.events.settled).toHaveBeenCalledTimes(2);
      expect(h.events.settled.mock.calls.every(([result]) => result.success)).toBe(true);
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
    });

    it.each([false, true])(`same normalized hash deduplicates guard=${guarded} different metadata=%s`, async different => {
      const h = fixture(), txHash = '0x' + 'ab'.repeat(32);
      if (!guarded) h.service.setInventoryAdmissionGuard(undefined);
      const a = h.queue();
      Object.assign(a, { state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: txHash, historicalWallet: wallet });
      h.service['pendingRedemptions'].push({ ...a, state: 'CONFIRMED_PAYOUT_PENDING',
        transactionHash: '0x' + 'AB'.repeat(32), historicalWallet: wallet,
        market: different ? { ...h.market, conditionId: 'other', slug: 'other' } : h.market });
      h.ctf.getRedeemPayout.mockImplementation(async requested => ({ state: 'PAYOUT_KNOWN', transactionHash: requested, pusdReceived: '7.25' }) as any);
      await h.service['processPendingRedemptions']();
      expect(h.ctf.getRedeemPayout).toHaveBeenCalledTimes(1);
      expect(h.stats().totalProfit).toBe(7.25);
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
    });
  }
  for (const guarded of [false, true]) {
    it.each(['normal', 'error'])(`public guard=${guarded}: %s confirmed finalizes and returns cached factual result`, async mode => {
      const h = fixture();
      if (!guarded) h.service.setInventoryAdmissionGuard(undefined);
      if (mode === 'error') h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(
        new Error('confirmed'), { state: 'CONFIRMED', transactionHash: hash }, '12.5'));
      else h.ctf.redeemByTokenIds.mockResolvedValueOnce({ ...confirmed(), usdcReceived: '12.5' });
      const first = await h.service.settle('redeem');
      expect(first).toMatchObject({ success: true, txHash: hash, amountReceived: 12.5 });
      first.amountReceived = 999; // Public response cannot mutate the accounting receipt.
      expect(await h.service.settle('redeem')).toMatchObject({ success: true, txHash: hash, amountReceived: 12.5 });
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.ctf.getMarketResolution).toHaveBeenCalledTimes(1);
      expect(h.stats().totalProfit).toBe(12.5);
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, amountReceived: 12.5 }));
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
    });

    it(`public guard=${guarded}: unknown stays pending on second call and queue reconciles once`, async () => {
      const h = fixture();
      if (!guarded) h.service.setInventoryAdmissionGuard(undefined);
      h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('unknown'),
        { state: 'CONFIRMED', transactionHash: hash }));
      const first = await h.service.settle('redeem');
      expect(first).toMatchObject({ success: false, txHash: hash, amountReceived: undefined, error: 'CONFIRMED_PAYOUT_PENDING' });
      h.ctf.getRedeemPayout.mockResolvedValue({ state: 'PAYOUT_KNOWN', transactionHash: hash, pusdReceived: '7.25' } as any);
      expect(await h.service.settle('redeem')).toEqual(first);
      expect(h.ctf.getRedeemPayout).not.toHaveBeenCalled();
      const pending = h.service.getPendingRedemptions()[0];
      expect(pending).toMatchObject({ state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: hash, historicalWallet: wallet, retryCount: 0 });
      expect(pending.round).toBe(h.round);
      expect(h.stats().totalProfit).toBe(0);
      expect(h.events.settled).not.toHaveBeenCalled();
      await h.service['processPendingRedemptions']();
      expect(await h.service.settle('redeem')).toMatchObject({ success: true, amountReceived: 7.25, txHash: hash });
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.ctf.getRedeemPayout).toHaveBeenCalledTimes(1);
      expect(h.ctf.getRedeemPayout).toHaveBeenCalledWith(hash, wallet);
      expect(h.stats().totalProfit).toBe(7.25);
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, amountReceived: 7.25 }));
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
    });

    it(`public guard=${guarded}: concurrent public calls and queue cannot resubmit`, async () => {
      const h = fixture(), response = deferred();
      if (!guarded) h.service.setInventoryAdmissionGuard(undefined);
      h.queue();
      h.ctf.redeemByTokenIds.mockReturnValueOnce(response.promise);
      const first = h.service.settle('redeem');
      await vi.waitFor(() => expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1));
      const second = h.service.settle('redeem');
      await h.service['processPendingRedemptions']();
      h.service.on('settled', () => { throw new Error('listener'); });
      response.resolve(confirmed());
      const results = await Promise.all([first, second]);
      expect(results.map(r => r.success)).toEqual([true, true]);
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.stats().totalProfit).toBe(10);
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
    });

    it(`public guard=${guarded}: queue confirmation also blocks public resubmission`, async () => {
      const h = fixture();
      if (!guarded) h.service.setInventoryAdmissionGuard(undefined);
      h.queue();
      await h.service['processPendingRedemptions']();
      expect(await h.service.settle('redeem')).toMatchObject({ success: true, amountReceived: 10, txHash: hash });
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.stats().totalProfit).toBe(10);
    });
  }
  for (const withGuard of [true, false]) {
    const pendingConfirmed = async () => {
      const h = fixture();
      if (!withGuard) h.service.setInventoryAdmissionGuard(undefined);
      const pending = h.queue(20);
      h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('payout unknown'),
        { state: 'CONFIRMED', transactionHash: hash }));
      await h.service['processPendingRedemptions']();
      return { ...h, pending };
    };
    it.each(['none', 'listener', 'logger', 'both'])(`guard=${withGuard}: factual confirmed error survives %s failure`, async failure => {
      const h = fixture();
      if (!withGuard) h.service.setInventoryAdmissionGuard(undefined);
      const pending = h.queue(20), before = h.stats();
      h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('post-confirmation'),
        { state: 'CONFIRMED', transactionHash: hash }, '12.5'));
      if (failure === 'listener' || failure === 'both') h.service.on('settled', () => {
        expect(h.stats().totalProfit).toBe(before.totalProfit + 12.5);
        expect(h.service.getPendingRedemptions()).toHaveLength(0);
        throw new Error('listener');
      });
      if (failure === 'logger' || failure === 'both') vi.spyOn(h.service as any, 'log').mockImplementation((message: any) => {
        if (String(message).startsWith('Redemption successful:')) throw new Error('logger');
      });
      await h.service['processPendingRedemptions']();
      await h.service['processPendingRedemptions']();
      expect(h.stats()).toEqual({ ...before, totalProfit: before.totalProfit + 12.5 });
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, amountReceived: 12.5, txHash: hash }));
      expect(pending.retryCount).toBe(21);
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.ctf.getRedeemPayout).not.toHaveBeenCalled();
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
      expect(h.events.execution).not.toHaveBeenCalled();
      expect(h.events.roundComplete).not.toHaveBeenCalled();
    });

    it(`guard=${withGuard}: unknown remains confirmed beyond retry limit without resubmission`, async () => {
      const h = await pendingConfirmed(), before = h.stats();
      expect(h.pending).toMatchObject({ state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: hash,
        historicalWallet: wallet, retryCount: 21 });
      const retryAt = h.pending.lastRetryAt;
      await h.service['processPendingRedemptions']();
      await h.service['processPendingRedemptions']();
      expect(h.service.getPendingRedemptions()).toEqual([h.pending]);
      expect(h.pending.retryCount).toBe(21);
      expect(h.pending.lastRetryAt).toBe(retryAt);
      expect(h.ctf.getMarketResolution).toHaveBeenCalledTimes(1);
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.ctf.getRedeemPayout).toHaveBeenCalledTimes(2);
      expect(h.stats()).toEqual(before);
      for (const name of ['settled', 'execution', 'roundComplete'] as const) expect(h.events[name]).not.toHaveBeenCalled();
    });

    it.each(['7.25', '0.0'])(`guard=${withGuard}: UNKNOWN then KNOWN %s uses historical context`, async amount => {
      const h = await pendingConfirmed(), before = h.stats();
      await h.service['processPendingRedemptions']();
      Object.assign(h.service, { currentRound: { roundId: 'new' }, market: { conditionId: 'new' } });
      const rotatedStats = h.stats();
      h.ctf.getAddress.mockReturnValue(other);
      h.ctf.getRedeemPayout.mockResolvedValue({ state: 'PAYOUT_KNOWN', transactionHash: hash, pusdReceived: amount } as any);
      await h.service['processPendingRedemptions']();
      await h.service['processPendingRedemptions']();
      expect(h.ctf.getRedeemPayout).toHaveBeenLastCalledWith(hash, wallet);
      expect(h.stats()).toEqual({ ...rotatedStats, totalProfit: before.totalProfit + Number(amount) });
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, market: h.market, amountReceived: Number(amount) }));
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
      expect(h.ctf.getMarketResolution).toHaveBeenCalledTimes(1);
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.pending.retryCount).toBe(21);
    });

    it(`guard=${withGuard}: concurrent reconciliation and duplicate hash finalize once despite listener throw`, async () => {
      const h = await pendingConfirmed(), before = h.stats(), response = deferred();
      h.service['pendingRedemptions'].push({ ...h.service.getPendingRedemptions()[0] });
      h.ctf.getRedeemPayout.mockReturnValueOnce(response.promise);
      h.service.on('settled', () => { throw new Error('consumer failed'); });
      const first = h.service['processPendingRedemptions']();
      const second = h.service['processPendingRedemptions']();
      await Promise.resolve();
      expect(h.ctf.getRedeemPayout).toHaveBeenCalledTimes(1);
      response.resolve({ state: 'PAYOUT_KNOWN', transactionHash: hash, pusdReceived: '7.25' });
      await Promise.all([first, second]);
      await h.service['processPendingRedemptions']();
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, amountReceived: 7.25 }));
      expect(h.stats()).toEqual({ ...before, totalProfit: before.totalProfit + 7.25 });
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.ctf.getRedeemPayout).toHaveBeenCalledTimes(1);
    });
  }
  it('confirmed cleanup leaves another operationId protected', async () => {
    const h = fixture(); h.queue();
    h.ctf.redeemByTokenIds.mockImplementationOnce(async () => {
      h.service['ctfLifecycles'].set('other-operation', { operationId: 'other-operation', wallet,
        tokenIds: ['unrelated-token'], state: 'UNCERTAIN' });
      throw new RedeemProvenanceError(new Error('post-confirmation'),
        { state: 'CONFIRMED', transactionHash: hash }, '12.5');
    });
    await h.service['processPendingRedemptions']();
    expect([...h.service['ctfLifecycles'].keys()]).toEqual(['other-operation']);
    expect(h.events.settled).toHaveBeenCalledTimes(1);
  });

  it('reconciliation failure keeps pending and normalized hash tombstone prevents replay', async () => {
    const h = fixture(), pending = h.queue(30), txHash = '0x' + 'ab'.repeat(32);
    Object.assign(pending, { state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: txHash, historicalWallet: wallet });
    h.ctf.getRedeemPayout.mockRejectedValueOnce(new Error('RPC'));
    await h.service['processPendingRedemptions']();
    expect(h.service.getPendingRedemptions()).toEqual([pending]);
    expect(pending.retryCount).toBe(30);
    h.ctf.getRedeemPayout.mockResolvedValue({ state: 'PAYOUT_KNOWN', transactionHash: txHash, pusdReceived: '7.25' } as any);
    await h.service['processPendingRedemptions']();
    h.service['pendingRedemptions'].push({ ...h.service.getPendingRedemptions()[0], ...pending,
      state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: '0x' + 'AB'.repeat(32), historicalWallet: wallet });
    await h.service['processPendingRedemptions']();
    expect(h.stats().totalProfit).toBe(7.25);
    expect(h.events.settled).toHaveBeenCalledTimes(1);
    expect(h.ctf.getRedeemPayout).toHaveBeenCalledTimes(2);
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    expect(h.ctf.getMarketResolution).not.toHaveBeenCalled();
    expect(h.service.getPendingRedemptions()).toHaveLength(0);
  });

  it('revalidates queue membership after receipt await', async () => {
    const h = fixture(), pending = h.queue(), response = deferred();
    Object.assign(pending, { state: 'CONFIRMED_PAYOUT_PENDING', transactionHash: hash, historicalWallet: wallet });
    h.ctf.getRedeemPayout.mockReturnValueOnce(response.promise);
    const flight = h.service['processPendingRedemptions']();
    await Promise.resolve();
    h.service['pendingRedemptions'] = [];
    response.resolve({ state: 'PAYOUT_KNOWN', transactionHash: hash, pusdReceived: '7.25' });
    await flight;
    expect(h.events.settled).not.toHaveBeenCalled();
    expect(h.stats().totalProfit).toBe(0);
  });
  for (const writer of ['merge', 'redeem'] as const) {
    const TypedError = writer === 'merge' ? MergeProvenanceError : RedeemProvenanceError;
    it(`${writer}: external conflict refuses transport without accounting`, async () => {
      const h = fixture(true), before = h.stats(); h.guard.mockReturnValue('SHORT_PROTECTED');
      expect(await h.write(writer)).toMatchObject({ success: false, status: 'BLOCKED_INVENTORY' });
      expect(h.transport(writer)).not.toHaveBeenCalled(); expect(h.stats()).toEqual(before);
      expect(h.service['ctfLifecycles'].size).toBe(0);
      expect(h.protection()).toBeDefined();
      for (const event of ['execution', 'settled', 'roundComplete'] as const) expect(h.events[event]).not.toHaveBeenCalled();
    });
    it(`${writer}: active lifecycle precedes transport and uses CTF wallet`, async () => {
      const h = fixture(), response = deferred();
      h.transport(writer).mockImplementationOnce(() => {
        expect(h.protection()).toMatchObject({ reason: 'DIP_ARB_CTF_ACTIVE' });
        expect(h.protection('down')).toBeDefined();
        return response.promise;
      });
      const running = h.write(writer);
      await vi.waitFor(() => expect(h.transport(writer)).toHaveBeenCalledTimes(1));
      expect(h.guard).toHaveBeenCalledWith({ walletAddress: wallet, tokenIds: ['up', 'down'], operationType: writer.toUpperCase() });
      expect(h.protection('up', other)).toBeUndefined();
      response.resolve(confirmed()); await running; expect(h.protection()).toBeUndefined();
    });
    for (const state of ['NOT_SUBMITTED', 'SUBMITTED', 'UNCERTAIN', 'CONFIRMED'] as const) {
      it(`${writer}: factual ${state} controls only its attempt`, async () => {
        const h = fixture(), before = h.stats();
        const provenance: MergeProvenance = Object.freeze({ state, ...(state === 'NOT_SUBMITTED' ? {} : { transactionHash: hash }) });
        h.transport(writer).mockImplementationOnce(async (...args: any[]) => {
          args[4](provenance);
          if (state !== 'CONFIRMED') throw new TypedError(new Error('cause'), provenance);
          return confirmed();
        });
        await h.write(writer);
        expect(!!h.protection()).toBe(state === 'SUBMITTED' || state === 'UNCERTAIN');
        if (h.protection()) expect([...h.service['ctfLifecycles'].values()][0]).toMatchObject({ state, transactionHash: hash });
        const finalized = writer === 'redeem' && state === 'CONFIRMED';
        expect(h.stats()).toEqual({ ...before, totalProfit: before.totalProfit + (finalized ? 10 : 0) });
        expect(h.events.settled).toHaveBeenCalledTimes(finalized ? 1 : 0);
        for (const event of ['execution', 'roundComplete'] as const) expect(h.events[event]).not.toHaveBeenCalled();
      });
    }
    it(`${writer}: NOT_SUBMITTED preserves owned position and residual`, async () => {
      const h = fixture(true), before = h.protection();
      h.transport(writer).mockRejectedValueOnce(new TypedError(new Error('approval failed'), { state: 'NOT_SUBMITTED' }));
      await h.write(writer);
      expect(h.service['ctfLifecycles'].size).toBe(0); expect(h.protection()).toEqual(before);
      expect(h.round.leg1.shares).toBe(10); expect(h.round.leg2.shares).toBe(10);
    });
    it(`${writer}: owned position may continue but CONFIRMED does not erase residual`, async () => {
      const h = fixture(true), before = h.protection();
      expect((await h.write(writer)).success).toBe(true);
      expect(h.transport(writer)).toHaveBeenCalledTimes(1); expect(h.protection()).toEqual(before);
    });
    it.each(['SUBMITTED', 'UNCERTAIN'] as const)(`${writer}: %s survives round replacement, queue deletion and retry`, async state => {
      const h = fixture(); h.queue();
      h.transport(writer).mockRejectedValueOnce(new TypedError(new Error('ambiguous'), { state, transactionHash: hash }));
      await h.write(writer); const before = h.protection();
      Object.assign(h.service, { currentRound: { ...h.round, roundId: 'new' }, pendingRedemptions: [] });
      expect(h.protection()).toEqual(before);
      expect(await h.write(writer)).toMatchObject({ status: 'BLOCKED_INVENTORY' });
      expect(h.transport(writer)).toHaveBeenCalledTimes(1);
      expect(() => h.service.setInventoryAdmissionGuard(undefined)).toThrow(/protected/);
    });
    it.each([true, false])(`${writer}: legacy success=%s cannot release or create accounting`, async success => {
      const h = fixture(), before = h.stats(); h.transport(writer).mockResolvedValueOnce({ success, txHash: hash });
      expect((await h.write(writer)).success).toBe(false);
      expect(h.protection()).toMatchObject({ reason: 'DIP_ARB_CTF_UNCERTAIN' }); expect(h.stats()).toEqual(before);
    });
    it(`${writer}: untyped exception retains protection regardless of message`, async () => {
      const h = fixture(); h.transport(writer).mockRejectedValueOnce(new Error('NOT_SUBMITTED'));
      await h.write(writer); expect(h.protection()).toMatchObject({ reason: 'DIP_ARB_CTF_UNCERTAIN' });
    });
    it(`${writer}: observer SUBMITTED protects while promise is unresolved`, async () => {
      const h = fixture(), response = deferred();
      h.transport(writer).mockImplementationOnce((...args: any[]) => { args[4]({ state: 'SUBMITTED', transactionHash: hash }); return response.promise; });
      const running = h.write(writer);
      await vi.waitFor(() => expect(h.protection()).toMatchObject({ reason: 'DIP_ARB_CTF_SUBMITTED' }));
      expect(await h.write(writer === 'merge' ? 'redeem' : 'merge')).toMatchObject({ status: 'BLOCKED_INVENTORY' });
      response.resolve(confirmed()); await running;
    });
    it.each(['wallet', 'token', 'round', 'guard', 'stop'])(`${writer}: reentrant %s change blocks before transport`, async change => {
      const h = fixture();
      h.guard.mockImplementation(() => {
        if (change === 'wallet') h.ctf.getAddress.mockReturnValue(other);
        if (change === 'token') h.market.upTokenId = 'new';
        if (change === 'round') Object.assign(h.service, { currentRound: { ...h.round } });
        if (change === 'guard') h.service.setInventoryAdmissionGuard(() => undefined);
        if (change === 'stop') Object.assign(h.service, { isRunning: false });
        return undefined;
      });
      expect(await h.write(writer)).toMatchObject({ status: 'BLOCKED_INVENTORY' });
      expect(h.transport(writer)).not.toHaveBeenCalled();
    });
  }

  it('startup scan admits merge and creates no ownership during balance read', async () => {
    const h = fixture(), read = deferred(); h.ctf.getPositionBalanceByTokenIds.mockReturnValueOnce(read.promise);
    const scan = h.service['scanAndMergeExistingPairs'](); expect(h.protection()).toBeUndefined();
    h.guard.mockReturnValue('external'); read.resolve({ yesBalance: '10', noBalance: '10' }); await scan;
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled(); expect(h.protection()).toBeUndefined();
    h.guard.mockReturnValue(undefined); await h.service['scanAndMergeExistingPairs']();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
  });
  it('background merge uses same guard and captured routing', async () => {
    const h = fixture(), market = { ...h.market, conditionId: 'old', negRisk: true };
    vi.spyOn(h.service, 'scanUpcomingMarkets').mockResolvedValue([market]);
    h.ctf.getMarketResolution.mockResolvedValue({ isResolved: false }); h.guard.mockReturnValue('external');
    await h.service['scanAndQueueRedeemablePositions'](); expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    h.guard.mockReturnValue(undefined); await h.service['scanAndQueueRedeemablePositions']();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('old', { yesTokenId: 'up', noTokenId: 'down' }, '10', { negRisk: true }, expect.any(Function));
  });
  it('resolved scan only queues; actual redeem performs admission', async () => {
    const h = fixture(); vi.spyOn(h.service, 'scanUpcomingMarkets').mockResolvedValue([{ ...h.market, conditionId: 'old' }]);
    await h.service['scanAndQueueRedeemablePositions']();
    expect(h.guard).not.toHaveBeenCalled(); expect(h.protection()).toBeUndefined();
    expect(h.service.getPendingRedemptions()).toHaveLength(1);
    h.guard.mockReturnValue('external'); const before = h.stats();
    await h.service['processPendingRedemptions']();
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled(); expect(h.events.settled).not.toHaveBeenCalled(); expect(h.stats()).toEqual(before);
    h.guard.mockReturnValue(undefined); await h.service['processPendingRedemptions']();
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1); expect(h.protection()).toBeUndefined();
  });
  it.each(['SUBMITTED', 'UNCERTAIN'] as const)('pending %s survives retry limit and queue removal', async state => {
    const h = fixture(); h.queue(20);
    h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('wait failure'), { state, transactionHash: hash }));
    const before = h.stats(); await h.service['processPendingRedemptions']();
    expect(h.service.getPendingRedemptions()).toHaveLength(0);
    expect(h.protection()).toMatchObject({ reason: `DIP_ARB_CTF_${state}` }); expect(h.stats()).toEqual(before);
    expect(h.events.settled).not.toHaveBeenCalled();
    h.events.settled.mockClear(); h.queue(30); await h.service['processPendingRedemptions']();
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1); expect(h.events.settled).not.toHaveBeenCalled();
  });
  it('pending NOT_SUBMITTED permits independent retry', async () => {
    const h = fixture(); h.queue();
    h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('approval'), { state: 'NOT_SUBMITTED' }));
    await h.service['processPendingRedemptions'](); expect(h.protection()).toBeUndefined();
    await h.service['processPendingRedemptions'](); expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(2);
  });
  it.each(['unresolved market', 'resolution read error'] as const)('%s at retry limit removes queue item without redeem or accounting', async scenario => {
    const h = fixture(), pending = h.queue(20), before = h.stats();
    if (scenario === 'unresolved market') h.ctf.getMarketResolution.mockResolvedValueOnce({ isResolved: false });
    else h.ctf.getMarketResolution.mockRejectedValueOnce(new Error('RPC unavailable'));
    await h.service['processPendingRedemptions']();
    expect(h.ctf.getMarketResolution).toHaveBeenCalledTimes(1);
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    expect(pending.retryCount).toBe(21);
    expect(h.service.getPendingRedemptions()).toHaveLength(0);
    expect(h.protection()).toBeUndefined();
    expect(h.stats()).toEqual(before);
    for (const event of ['settled', 'execution', 'roundComplete'] as const) expect(h.events[event]).not.toHaveBeenCalled();
  });
  for (const withGuard of [true, false]) {
    it.each(['NOT_SUBMITTED', 'SUBMITTED', 'UNCERTAIN'] as const)(`guard=${withGuard}: %s at retry limit never authorizes settlement`, async state => {
      const h = fixture(), pending = h.queue(20), before = h.stats();
      if (!withGuard) h.service.setInventoryAdmissionGuard(undefined);
      h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('CTF failure'),
        { state, ...(state === 'NOT_SUBMITTED' ? {} : { transactionHash: hash }) }));
      await h.service['processPendingRedemptions']();
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(pending.retryCount).toBe(21);
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
      expect(h.stats()).toEqual(before);
      for (const event of ['settled', 'execution', 'roundComplete'] as const) expect(h.events[event]).not.toHaveBeenCalled();
      expect(!!h.protection()).toBe(withGuard && state !== 'NOT_SUBMITTED');
      expect(h.guard.mock.calls.length).toBe(withGuard ? 1 : 0);
    });
    it(`guard=${withGuard}: CONFIRMED at retry limit settles exactly once`, async () => {
      const h = fixture(), pending = h.queue(20), before = h.stats();
      if (!withGuard) h.service.setInventoryAdmissionGuard(undefined);
      await h.service['processPendingRedemptions']();
      await h.service['processPendingRedemptions']();
      expect(pending.retryCount).toBe(21);
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: hash, amountReceived: 10 }));
      expect(h.stats().totalProfit).toBe(before.totalProfit + 10);
    });
    it.each(['listener', 'logger', 'both'] as const)(`guard=${withGuard}: CONFIRMED survives %s failure without economic retry`, async failure => {
      const h = fixture(), pending = h.queue(20), before = h.stats(), result = confirmed();
      if (!withGuard) h.service.setInventoryAdmissionGuard(undefined);
      h.ctf.redeemByTokenIds.mockResolvedValueOnce(result);
      const observed: Array<{ profit: number; lifecycles: number }> = [];
      const listener = vi.fn(() => {
        observed.push({ profit: h.stats().totalProfit, lifecycles: h.service['ctfLifecycles'].size });
        if (failure !== 'logger') throw new Error('consumer failed');
      });
      h.service.on('settled', listener);
      if (failure !== 'listener') vi.spyOn(h.service as any, 'log').mockImplementation((message: any) => {
        if (String(message).startsWith('Redemption successful:')) throw new Error('logger failed');
      });
      await expect(h.service['processPendingRedemptions']()).resolves.toBeUndefined();
      await h.service['processPendingRedemptions']();
      expect(pending.retryCount).toBe(21);
      expect(h.service.getPendingRedemptions()).toHaveLength(0);
      expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(observed).toEqual([{ profit: before.totalProfit + 10, lifecycles: 0 }]);
      expect(h.events.settled).toHaveBeenCalledTimes(1);
      expect(h.events.settled).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: hash, amountReceived: 10 }));
      expect(h.stats()).toEqual({ ...before, totalProfit: before.totalProfit + 10 });
      expect(result.provenance).toEqual({ state: 'CONFIRMED', transactionHash: hash });
      expect(h.service['ctfLifecycles'].size).toBe(0);
      expect(h.protection()).toBeUndefined();
      expect(h.events.execution).not.toHaveBeenCalled();
      expect(h.events.roundComplete).not.toHaveBeenCalled();
    });
  }
  it('NOT_SUBMITTED at retry limit removes queue item without settlement or accounting', async () => {
    const h = fixture(), pending = h.queue(20), before = h.stats();
    h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('approval failed'), { state: 'NOT_SUBMITTED' }));
    await h.service['processPendingRedemptions']();
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
    expect(pending.retryCount).toBe(21);
    expect(h.service.getPendingRedemptions()).toHaveLength(0);
    expect(h.protection()).toBeUndefined();
    expect(h.service['ctfLifecycles'].size).toBe(0);
    expect(h.stats()).toEqual(before);
    for (const event of ['settled', 'execution', 'roundComplete'] as const) expect(h.events[event]).not.toHaveBeenCalled();
  });
  it('resolution retry limit does not report unresolved transaction as settled', async () => {
    const h = fixture(); const pending = h.queue();
    h.ctf.redeemByTokenIds.mockRejectedValueOnce(new RedeemProvenanceError(new Error('unknown'), { state: 'UNCERTAIN', transactionHash: hash }));
    await h.service['processPendingRedemptions'](); pending.retryCount = 20;
    h.ctf.getMarketResolution.mockResolvedValueOnce({ isResolved: false });
    await h.service['processPendingRedemptions']();
    expect(h.service.getPendingRedemptions()).toHaveLength(0);
    expect(h.protection()).toBeDefined(); expect(h.events.settled).not.toHaveBeenCalled();
  });
  it('read-only API is frozen, minimal and scoped to wallet/token', async () => {
    const h = fixture(); h.ctf.mergeByTokenIds.mockRejectedValueOnce(new Error('boundary'));
    await h.service.merge(); const snapshot = h.protection()!;
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.keys(snapshot).sort()).toEqual(['blocked', 'operationId', 'reason']);
    expect(h.protection('different')).toBeUndefined(); expect(h.protection('up', other)).toBeUndefined();
    expect(h.protection('up', '0x' + 'AB'.repeat(20))).toEqual(snapshot);
  });
  it('different token attempt can confirm without deleting unresolved attempt', async () => {
    const h = fixture(); h.ctf.mergeByTokenIds.mockRejectedValueOnce(new Error('boundary')); await h.service.merge();
    const original = h.protection();
    Object.assign(h.service, { market: { ...h.market, upTokenId: 'other-up', downTokenId: 'other-down' } });
    expect((await h.service.merge()).success).toBe(true); expect(h.protection()).toEqual(original);
  });
  it('captured wallet and tokens cannot switch during pre-read', async () => {
    const h = fixture(), read = deferred(); h.ctf.getPositionBalanceByTokenIds.mockReturnValueOnce(read.promise);
    const running = h.service.merge(); h.market.upTokenId = 'replacement'; h.ctf.getAddress.mockReturnValue(other);
    read.resolve({ yesBalance: '10', noBalance: '10' });
    expect(await running).toMatchObject({ status: 'BLOCKED_INVENTORY' }); expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  });
  for (const path of ['startup', 'scan', 'pending'] as const) {
    it.each(['NOT_SUBMITTED', 'SUBMITTED', 'UNCERTAIN', 'CONFIRMED'] as const)(`${path}: %s uses the shared lifecycle`, async state => {
      const h = fixture();
      const transport = path === 'pending' ? h.ctf.redeemByTokenIds : h.ctf.mergeByTokenIds;
      const TypedError = path === 'pending' ? RedeemProvenanceError : MergeProvenanceError;
      if (path === 'scan') {
        vi.spyOn(h.service, 'scanUpcomingMarkets').mockResolvedValue([{ ...h.market, conditionId: 'old' }]);
        h.ctf.getMarketResolution.mockResolvedValue({ isResolved: false });
      }
      if (path === 'pending') h.queue();
      transport.mockImplementationOnce(async (...args: any[]) => {
        expect(h.protection()).toMatchObject({ reason: 'DIP_ARB_CTF_ACTIVE' });
        const provenance: MergeProvenance = { state, ...(state === 'NOT_SUBMITTED' ? {} : { transactionHash: hash }) };
        args[4](provenance);
        if (state !== 'CONFIRMED') throw new TypedError(new Error('transport cause'), provenance);
        return confirmed();
      });
      const before = h.stats();
      await (path === 'startup' ? h.service['scanAndMergeExistingPairs']() :
        path === 'scan' ? h.service['scanAndQueueRedeemablePositions']() : h.service['processPendingRedemptions']());
      expect(transport).toHaveBeenCalledTimes(1);
      expect(!!h.protection()).toBe(state === 'SUBMITTED' || state === 'UNCERTAIN');
      if (path !== 'pending' || state !== 'CONFIRMED') {
        expect(h.stats()).toEqual(before); expect(h.events.settled).not.toHaveBeenCalled();
      } else {
        // Existing confirmed accounting, not an effect synthesized by the registry.
        expect(h.events.settled).toHaveBeenCalledTimes(1);
        expect(h.stats().totalProfit).toBe(before.totalProfit + 10);
      }
    });
  }
  it('background scan continues its own earlier position after round rotation', async () => {
    const h = fixture(true);
    Object.assign(h.service, { market: { ...h.market, conditionId: 'new', upTokenId: 'new-up', downTokenId: 'new-down' }, currentRound: null });
    vi.spyOn(h.service, 'scanUpcomingMarkets').mockResolvedValue([{ ...h.market }]);
    h.ctf.getMarketResolution.mockResolvedValue({ isResolved: false });
    await h.service['scanAndQueueRedeemablePositions'](); expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    h.guard.mockReturnValue('EXTERNAL'); await h.service['scanAndQueueRedeemablePositions']();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
  });
  it('pending redemption continues the captured owned round after replacement', async () => {
    const h = fixture(true); h.queue(); Object.assign(h.service, { currentRound: null, market: null });
    await h.service['processPendingRedemptions'](); expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
  });
  it('overlapping pending processors submit only once while unresolved', async () => {
    const h = fixture(), response = deferred(); h.queue(); h.ctf.redeemByTokenIds.mockReturnValueOnce(response.promise);
    const first = h.service['processPendingRedemptions']();
    await vi.waitFor(() => expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1));
    await h.service['processPendingRedemptions'](); expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
    response.resolve(confirmed()); await first; expect(h.events.settled).toHaveBeenCalledTimes(1);
  });
  it('guard-triggered nested CTF invocation cannot win over the admitted write', async () => {
    const h = fixture(), response = deferred(); let nested: Promise<any> | undefined;
    h.guard.mockImplementationOnce(() => { nested = h.service.settle('redeem'); return undefined; });
    h.ctf.mergeByTokenIds.mockReturnValueOnce(response.promise);
    const first = h.service.merge();
    await vi.waitFor(() => expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1));
    expect(await nested).toMatchObject({ status: 'BLOCKED_INVENTORY' }); expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    response.resolve(confirmed()); await first;
  });
  it('missing factual CTF wallet fails closed without transport', async () => {
    const h = fixture(); h.ctf.getAddress.mockImplementation(() => { throw new Error('unavailable'); });
    expect(await h.service.merge()).toMatchObject({ status: 'BLOCKED_INVENTORY' }); expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  });
  it('guard exception cannot submit or create a lifecycle', async () => {
    const h = fixture(); h.guard.mockImplementation(() => { throw new Error('unavailable'); });
    expect(await h.service.settle('redeem')).toMatchObject({ status: 'BLOCKED_INVENTORY' });
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled(); expect(h.protection()).toBeUndefined();
  });
  it('post-submit confirmation belongs to captured inventory after rotation', async () => {
    const h = fixture(), response = deferred(); h.ctf.mergeByTokenIds.mockReturnValueOnce(response.promise);
    const first = h.service.merge(); await vi.waitFor(() => expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1));
    Object.assign(h.service, { market: { ...h.market, conditionId: 'new', upTokenId: 'new-up', downTokenId: 'new-down' }, currentRound: { ...h.round } });
    h.ctf.redeemByTokenIds.mockRejectedValueOnce(new Error('ambiguous')); await h.service.settle('redeem');
    const second = h.protection('new-up'); response.resolve(confirmed()); await first;
    expect(h.protection()).toBeUndefined(); expect(h.protection('new-up')).toEqual(second);
  });
});
