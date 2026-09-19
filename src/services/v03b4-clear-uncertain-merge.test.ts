import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageMarketConfig, type ClearAction, type ClearPositionResult } from './arbitrage-service.js';
import { MergeProvenanceError, type MergeProvenance, type TransactionStatus } from '../clients/ctf-client.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
type Balances = { yesBalance: string; noBalance: string };
const services: ArbitrageService[] = [];
const HASH = (n: string) => '0x' + n.repeat(32);
const MERGE_TX = HASH('ab');
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const tick = () => new Promise<void>(r => setImmediate(r));

const provenanceError = (state: MergeProvenance['state'], transactionHash?: string, message = 'tx.wait timeout') =>
  new MergeProvenanceError(new Error(message), { state, ...(transactionHash ? { transactionHash } : {}) });
const txStatus = (status: TransactionStatus['status'], txHash = MERGE_TX, extra: Partial<TransactionStatus> = {}): TransactionStatus =>
  ({ txHash, status, confirmations: status === 'confirmed' || status === 'reverted' ? 3 : 0, ...extra });

const taker = (id: string, orderId: string, asset: string, size: string, price: string, hash = HASH('11')) => ({
  id, status: 'MINED', size, price, transactionHash: hash, asset_id: asset, side: 'SELL', taker_order_id: orderId, trader_side: 'TAKER', maker_orders: [],
});

/**
 * Active market, YES 10 / NO 10 by default. A residual SELL of YES fills as `cy`, of NO as `cn`;
 * sizes are set by tests. `getTransactionStatus` answers from `statuses` (default: pending).
 */
function fixture(options: { yes?: string; no?: string; resolved?: boolean } = {}) {
  const service = new ArbitrageService({ enableLogging: false, minTradeSize: 1 });
  services.push(service);
  const marketA: ArbitrageMarketConfig = { name: 'A', conditionId: 'cond-a', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const marketB: ArbitrageMarketConfig = { name: 'B', conditionId: 'cond-b', yesTokenId: 'yes-b', noTokenId: 'no-b', negRisk: false };
  const balances: Record<string, Balances> = {
    'cond-a': { yesBalance: options.yes ?? '10', noBalance: options.no ?? '10' },
    'cond-b': { yesBalance: '4', noBalance: '4' },
  };
  const trades: Record<string, ReturnType<typeof taker>> = {
    ty: taker('ty', 'cy', 'yes', '10', '0.55', HASH('11')),
    tn: taker('tn', 'cn', 'no', '10', '0.45', HASH('22')),
  };
  const orders: Record<string, OrderRow> = {
    cy: { id: 'cy', asset_id: 'yes', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['ty'], sizeMatched: '10' },
    cn: { id: 'cn', asset_id: 'no', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['tn'], sizeMatched: '10' },
  };
  const statuses: Record<string, TransactionStatus> = {};
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>(async order => accepted(order.tokenId === 'yes' ? 'cy' : 'cn')),
    getOrderFillDetails: vi.fn(async (id: string) => {
      const row = orders[id];
      if (!row) throw new Error(`unknown order ${id}`);
      return { ...row, tradeIds: [...row.tradeIds] };
    }),
    getTradeStatuses: vi.fn(async (ids: string[]): Promise<TradeStatus[]> =>
      ids.map(id => (trades[id] ?? { id, status: 'UNKNOWN' }) as unknown as TradeStatus)),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue('wallet'),
    getPusdBalance: vi.fn(async () => '100'),
    getPositionBalanceByTokenIds: vi.fn(async (conditionId: string) => ({ ...balances[conditionId] })),
    getMarketResolution: vi.fn(async (_conditionId: string): Promise<{ isResolved: boolean; winningOutcome?: string }> =>
      options.resolved ? { isResolved: true, winningOutcome: 'YES' } : { isResolved: false }),
    mergeByTokenIds: vi.fn(async (_c: string, _t: unknown, amount: string) => ({ success: true, txHash: MERGE_TX, amount })),
    redeemByTokenIds: vi.fn(async () => ({
      success: true, provenance: { state: 'CONFIRMED', txHash: HASH('cd') }, txHash: HASH('cd'), outcome: 'YES', tokensRedeemed: '10', usdcReceived: '9.75',
    })),
    getTransactionStatus: vi.fn(async (txHash: string): Promise<TransactionStatus> => statuses[txHash] ?? txStatus('pending', txHash)),
    split: vi.fn(),
  };
  Object.assign(service, { tradingService: trading, ctf });
  const settles = vi.fn<(result: ClearPositionResult) => void>();
  service.on('settle', settles);
  const logs: string[] = [];
  vi.spyOn(service as unknown as { log: (m: string) => void }, 'log').mockImplementation(m => { logs.push(m); });
  const pendingMerges = service['pendingClearMerges'];
  const pendingSells = service['pendingClearSells'];
  const active = service['activeClearMarkets'];
  const clear = (market: ArbitrageMarketConfig = marketA, execute = true) => service.clearPositions(market, execute);
  const merges = () => ctf.mergeByTokenIds.mock.calls;
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  const reads = () => ctf.getPositionBalanceByTokenIds.mock.calls;
  return { service, marketA, marketB, balances, trades, orders, statuses, trading, ctf, settles, logs, pendingMerges, pendingSells, active, clear, merges, sells, reads };
}
type H = ReturnType<typeof fixture>;

const mergeActions = (r: ClearPositionResult) => r.actions.filter(a => a.type === 'merge');
const sellActions = (r: ClearPositionResult) => r.actions.filter(a => a.type === 'sell_yes' || a.type === 'sell_no');

/** The initial call whose merge is unresolved: nothing sold, nothing booked, one record installed. */
function expectUnresolvedInitial(h: H, result: ClearPositionResult, txHash?: string) {
  expect(h.sells()).toEqual([]);
  expect(sellActions(result)).toEqual([]);
  expect(result.totalUsdcRecovered).toBe(0);
  expect(result.success).toBe(false);
  expect(result.withheld).toBeUndefined();
  const [merge] = mergeActions(result);
  expect(merge).toMatchObject({ type: 'merge', amount: 0, usdcResult: 0, success: false, pending: true, operationId: 'clear-merge-1',
    error: expect.stringMatching(/^MERGE_PENDING: 10 pairs unresolved/) });
  if (txHash) expect(merge.txHash).toBe(txHash); else expect(merge.txHash).toBeUndefined();
  expect(h.pendingMerges.size).toBe(1);
  const record = h.pendingMerges.get('cond-a');
  expect(record).toMatchObject({ id: 'clear-merge-1', pairs: 10, market: { conditionId: 'cond-a' } });
  expect(record?.txHash).toBe(txHash);
  expect(h.pendingSells.size).toBe(0);
  expect(h.active.size).toBe(0);
}

/** A later call that finds the merge still unresolved: no read, no write, no recovery, record retained. */
function expectStillPending(h: H, result: ClearPositionResult, readsBefore: number, mergesBefore = 1) {
  expect(h.reads()).toHaveLength(readsBefore);
  expect(h.merges()).toHaveLength(mergesBefore);
  expect(h.sells()).toEqual([]);
  expect(result).toMatchObject({ yesBalance: 0, noBalance: 0, totalUsdcRecovered: 0, success: false });
  expect(result.withheld).toBeUndefined();
  expect(result.actions).toHaveLength(1);
  expect(result.actions[0]).toMatchObject({ type: 'merge', amount: 0, usdcResult: 0, success: false, pending: true, operationId: 'clear-merge-1' });
  expect(h.pendingMerges.get('cond-a')?.id).toBe('clear-merge-1');
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3 clearPositions uncertain merge: initial classification', () => {
  it('UNCERTAIN with tx hash: no residual SELL from the 10/10 snapshot, one unresolved record, zero recovery', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', MERGE_TX));
    const result = await h.clear();
    expectUnresolvedInitial(h, result, MERGE_TX);
    expect(h.pendingMerges.get('cond-a')).toMatchObject({ provenance: 'UNCERTAIN', error: 'tx.wait timeout' });
    expect(result).toMatchObject({ yesBalance: 10, noBalance: 10, marketStatus: 'active' });
    expect(h.logs).toContainEqual(expect.stringMatching(/⏳ Merge outcome uncertain \(clear-merge-1, tx 0xab/));
    expect(h.settles).toHaveBeenCalledTimes(1);
  });

  it('SUBMITTED provenance: identical conservative behaviour', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('SUBMITTED', MERGE_TX, 'rpc dropped after send'));
    const result = await h.clear();
    expectUnresolvedInitial(h, result, MERGE_TX);
    expect(h.pendingMerges.get('cond-a')).toMatchObject({ provenance: 'SUBMITTED', error: 'rpc dropped after send' });
  });

  it('UNCERTAIN without tx hash: no SELL now, no second merge later, remains unresolved', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN'));
    const first = await h.clear();
    expectUnresolvedInitial(h, first, undefined);
    expect(first.actions[0].error).toMatch(/merge outcome uncertain/);

    const readsBefore = h.reads().length;
    const later = await h.clear();
    expectStillPending(h, later, readsBefore);
    expect(h.ctf.getTransactionStatus).not.toHaveBeenCalled();
    expect(later.actions[0].error).toMatch(/no transaction identity; cannot be proven/);
    const again = await h.clear();
    expectStillPending(h, again, readsBefore);
  });

  it('a malformed provenance hash is treated as no identity', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', '0x1234'));
    const result = await h.clear();
    expectUnresolvedInitial(h, result, undefined);
  });

  it('plain untyped throw: no stale SELL, no blind merge retry, unresolved without identity', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(new Error('socket hang up'));
    const first = await h.clear();
    expectUnresolvedInitial(h, first, undefined);
    expect(h.pendingMerges.get('cond-a')).toMatchObject({ provenance: 'UNKNOWN', error: 'socket hang up' });
    expect(first.actions[0].error).toMatch(/merge outcome unknown: socket hang up/);

    const later = await h.clear();
    expectStillPending(h, later, 1);
    expect(h.merges()).toHaveLength(1);
  });

  it('a non-Error throw is also unresolved', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce('boom');
    const first = await h.clear();
    expectUnresolvedInitial(h, first, undefined);
    expect(h.pendingMerges.get('cond-a')?.error).toBe('boom');
  });

  it('NOT_SUBMITTED: no pending record and the existing fallback SELLs from the call\'s own read', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('NOT_SUBMITTED', undefined, 'Insufficient token balance'));
    const result = await h.clear();
    expect(h.pendingMerges.size).toBe(0);
    expect(mergeActions(result)[0]).toEqual({ type: 'merge', amount: 10, usdcResult: 0, success: false, error: 'Insufficient token balance' });
    expect(h.sells().map(([o]) => [o.tokenId, o.amount])).toEqual([['yes', 10], ['no', 10]]);
    const [yes, no] = sellActions(result);
    expect(yes).toMatchObject({ type: 'sell_yes', success: true, amount: 10, usdcResult: 5.5, facts: { orderId: 'cy' } });
    expect(no).toMatchObject({ type: 'sell_no', success: true, amount: 10, usdcResult: 4.5, facts: { orderId: 'cn' } });
    expect(result.totalUsdcRecovered).toBeCloseTo(10, 12);
    expect(h.logs).toContainEqual(expect.stringMatching(/❌ Merge failed: Insufficient token balance/));

    // The next call is a normal fresh flow.
    h.balances['cond-a'] = { yesBalance: '0', noBalance: '0' };
    const next = await h.clear();
    expect(next).toMatchObject({ success: true, actions: [], yesBalance: 0, noBalance: 0 });
    expect(h.reads()).toHaveLength(2);
  });

  it('CONFIRMED provenance with a valid hash thrown after receipt: merge booked, no SELL from the pre-merge snapshot', async () => {
    const h = fixture({ yes: '13', no: '10' });
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('CONFIRMED', MERGE_TX, 'formatUnits failed'));
    const result = await h.clear();
    expect(h.pendingMerges.size).toBe(0);
    expect(mergeActions(result)[0]).toEqual({ type: 'merge', amount: 10, usdcResult: 10, txHash: MERGE_TX, success: true });
    expect(h.sells()).toEqual([]);
    expect(sellActions(result)).toEqual([]);
    expect(result.totalUsdcRecovered).toBe(10);
    expect(result.success).toBe(true);
    expect(h.logs).toContainEqual(expect.stringMatching(/✅ Merged: 10\.0000 pairs → \$10\.00 USDC \(confirmed; client error after receipt: formatUnits failed\)/));

    // Residual 3 YES is handled by a later call from a fresh read.
    h.balances['cond-a'] = { yesBalance: '3', noBalance: '0' };
    h.orders.cy = { ...h.orders.cy, sizeMatched: '3' }; h.trades.ty.size = '3';
    const next = await h.clear();
    expect(h.reads()).toHaveLength(2);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells().map(([o]) => [o.tokenId, o.amount])).toEqual([['yes', 3]]);
    expect(sellActions(next)[0]).toMatchObject({ type: 'sell_yes', success: true, amount: 3 });
  });

  it('CONFIRMED provenance without a valid hash is unresolved, not booked', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('CONFIRMED'));
    const result = await h.clear();
    expectUnresolvedInitial(h, result, undefined);
    expect(h.pendingMerges.get('cond-a')?.provenance).toBe('UNCERTAIN');
  });

  it('the pending record is installed before the interlock releases', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', MERGE_TX));
    const a = h.clear();
    await tick(); await tick(); await tick();
    const ra = await a;
    expect(ra.actions[0].pending).toBe(true);
    expect(h.pendingMerges.has('cond-a')).toBe(true);
    expect(h.active.size).toBe(0);
  });
});

describe('P0.3 clearPositions uncertain merge: reconciliation by transaction status', () => {
  async function unresolved(h: H) {
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', MERGE_TX));
    const first = await h.clear();
    expectUnresolvedInitial(h, first, MERGE_TX);
    h.settles.mockClear();
    return first;
  }

  it('pending status: later call performs zero writes and zero reads; stays pending', async () => {
    const h = fixture();
    await unresolved(h);
    h.statuses[MERGE_TX] = txStatus('pending');
    const later = await h.clear();
    expectStillPending(h, later, 1);
    expect(h.ctf.getTransactionStatus).toHaveBeenCalledWith(MERGE_TX);
    expect(later.actions[0].error).toMatch(/transaction pending; not proof of execution or non-execution/);
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.settles.mock.calls[0][0].totalUsdcRecovered).toBe(0);
  });

  it('failed status (RPC failure / not found) is NOT non-execution: stays pending, no retry, no SELL', async () => {
    const h = fixture();
    await unresolved(h);
    h.statuses[MERGE_TX] = txStatus('failed', MERGE_TX, { errorReason: 'Transaction not found' });
    const later = await h.clear();
    expectStillPending(h, later, 1);
    expect(later.actions[0].error).toMatch(/transaction failed; not proof/);
    h.statuses[MERGE_TX] = txStatus('failed', MERGE_TX, { errorReason: 'RPC unreachable' });
    const again = await h.clear();
    expectStillPending(h, again, 1);
    expect(h.logs.filter(m => /still unresolved \(transaction failed\)/.test(m))).toHaveLength(2);
  });

  it('status lookup throwing keeps the record pending', async () => {
    const h = fixture();
    await unresolved(h);
    h.ctf.getTransactionStatus.mockRejectedValueOnce(new Error('provider down'));
    const later = await h.clear();
    expectStillPending(h, later, 1);
    expect(later.actions[0].error).toMatch(/status unavailable/);
    expect(h.logs).toContainEqual(expect.stringMatching(/status lookup failed: provider down/));
  });

  it('a status for a different transaction hash is not accepted', async () => {
    const h = fixture();
    await unresolved(h);
    h.ctf.getTransactionStatus.mockResolvedValueOnce(txStatus('confirmed', HASH('ff')));
    const later = await h.clear();
    expectStillPending(h, later, 1);
    expect(later.actions[0].error).toMatch(/status for a different transaction/);
  });

  it('confirmed: the recorded merge is reported factually exactly once with recovery = recorded pairs; no SELL or new merge in that call', async () => {
    const h = fixture();
    await unresolved(h);
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const later = await h.clear();
    expect(h.reads()).toHaveLength(1);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells()).toEqual([]);
    expect(later.actions).toEqual([{ type: 'merge', amount: 10, usdcResult: 10, txHash: MERGE_TX, success: true, operationId: 'clear-merge-1' }]);
    expect(later).toMatchObject({ totalUsdcRecovered: 10, success: true, yesBalance: 0, noBalance: 0 });
    expect(later.withheld).toBeUndefined();
    expect(h.pendingMerges.size).toBe(0);
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.settles).toHaveBeenCalledWith(later);
    expect(h.logs.filter(m => /✅ Merged: 10\.0000 pairs → \$10\.00 USDC \(clear-merge-1 confirmed on-chain\)/.test(m))).toHaveLength(1);
  });

  it('repeated call after the confirmed report: no duplicate recovery; a fresh balance read precedes any new write', async () => {
    const h = fixture();
    await unresolved(h);
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const confirmedCall = await h.clear();
    expect(confirmedCall.totalUsdcRecovered).toBe(10);

    h.balances['cond-a'] = { yesBalance: '0', noBalance: '2' };
    h.orders.cn = { ...h.orders.cn, sizeMatched: '2' }; h.trades.tn.size = '2';
    const next = await h.clear();
    expect(h.reads()).toHaveLength(2);
    expect(mergeActions(next)).toEqual([]);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells().map(([o]) => [o.tokenId, o.amount])).toEqual([['no', 2]]);
    expect(sellActions(next)[0]).toMatchObject({ type: 'sell_no', success: true, amount: 2 });
    expect(next.totalUsdcRecovered).toBeCloseTo(0.9, 12);
    const total = h.settles.mock.calls.reduce((acc, [r]) => acc + r.totalUsdcRecovered, 0);
    expect(total).toBeCloseTo(10.9, 12);
    expect(h.settles.mock.calls.filter(([r]) => r.actions.some(a => a.type === 'merge' && a.success))).toHaveLength(1);
  });

  it('reverted: zero recovery, record released, no write in that call; the following call reads fresh and may act', async () => {
    const h = fixture();
    await unresolved(h);
    h.statuses[MERGE_TX] = txStatus('reverted', MERGE_TX, { errorReason: 'ERC1155: insufficient balance' });
    const later = await h.clear();
    expect(h.reads()).toHaveLength(1);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells()).toEqual([]);
    expect(later.actions).toEqual([{ type: 'merge', amount: 0, usdcResult: 0, txHash: MERGE_TX, success: false, operationId: 'clear-merge-1',
      error: 'Merge reverted on-chain: ERC1155: insufficient balance' }]);
    expect(later).toMatchObject({ totalUsdcRecovered: 0, success: false });
    expect(later.actions[0].pending).toBeUndefined();
    expect(h.pendingMerges.size).toBe(0);

    const next = await h.clear();
    expect(h.reads()).toHaveLength(2);
    expect(h.merges()).toHaveLength(2);
    expect(mergeActions(next)[0]).toMatchObject({ amount: 10, usdcResult: 10, success: true });
    expect(next.totalUsdcRecovered).toBe(10);
  });

  it('concurrent calls while unresolved: outer interlock holds and merge submissions stay at 1', async () => {
    const h = fixture();
    await unresolved(h);
    let release!: (s: TransactionStatus) => void;
    h.ctf.getTransactionStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const a = h.clear();
    await tick(); await tick();
    expect(h.active.has('cond-a')).toBe(true);
    const b = await h.clear();
    expect(b.withheld).toBe(true);
    release(txStatus('confirmed'));
    const ra = await a;
    expect(ra.totalUsdcRecovered).toBe(10);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells()).toEqual([]);
    expect(h.pendingMerges.size).toBe(0);
    expect(h.active.size).toBe(0);
  });

  it('a pending merge on market A does not affect market B', async () => {
    const h = fixture();
    await unresolved(h);
    const rb = await h.clear(h.marketB);
    expect(rb.success).toBe(true);
    expect(mergeActions(rb)[0]).toMatchObject({ amount: 4, usdcResult: 4, success: true });
    expect(h.merges().map(([c]) => c)).toEqual(['cond-a', 'cond-b']);
    expect(h.pendingMerges.size).toBe(1);
    expect(h.pendingMerges.has('cond-b')).toBe(false);
  });

  it('the record survives a lifecycle change: a later call reconciles the transaction before any redeem', async () => {
    const h = fixture();
    await unresolved(h);
    h.ctf.getMarketResolution.mockResolvedValue({ isResolved: true, winningOutcome: 'YES' });
    const later = await h.clear();
    expectStillPending(h, later, 1);
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    h.statuses[MERGE_TX] = txStatus('confirmed');
    const settled = await h.clear();
    expect(settled.totalUsdcRecovered).toBe(10);
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    expect(h.pendingMerges.size).toBe(0);
  });

  it('dry run while a merge is unresolved performs no write and does not touch the record', async () => {
    const h = fixture();
    await unresolved(h);
    const plan = await h.clear(h.marketA, false);
    expect(plan.success).toBe(true);
    expect(h.merges()).toHaveLength(1);
    expect(h.sells()).toEqual([]);
    expect(h.ctf.getTransactionStatus).not.toHaveBeenCalled();
    expect(h.pendingMerges.get('cond-a')?.id).toBe('clear-merge-1');
  });
});

describe('P0.3 clearPositions uncertain merge: unchanged neighbours', () => {
  it('a normally returned merge books exactly as before and residual SELL runs with B4 semantics', async () => {
    const h = fixture({ yes: '13', no: '10' });
    h.orders.cy = { ...h.orders.cy, sizeMatched: '3' }; h.trades.ty.size = '3';
    const result = await h.clear();
    expect(mergeActions(result)[0]).toEqual({ type: 'merge', amount: 10, usdcResult: 10, txHash: MERGE_TX, success: true });
    const [sell] = sellActions(result);
    expect(sell).toMatchObject({ type: 'sell_yes', success: true, amount: 3, operationId: 'clear-sell-1', facts: { orderId: 'cy', soldShares: 3 } });
    expect(result.totalUsdcRecovered).toBeCloseTo(11.65, 12);
    expect(h.pendingMerges.size).toBe(0);
  });

  it('resolved-market factual redeem is unchanged when no merge is unresolved', async () => {
    const h = fixture({ resolved: true });
    const result = await h.clear();
    expect(result.actions).toEqual([{ type: 'redeem', amount: 10, usdcResult: 9.75, txHash: HASH('cd'), success: true }]);
    expect(result.totalUsdcRecovered).toBe(9.75);
    expect(h.pendingMerges.size).toBe(0);
  });

  it('an unresolved merge is never represented as withheld, and a withheld result never as pending', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(provenanceError('UNCERTAIN', MERGE_TX));
    const first = await h.clear();
    expect(first.withheld).toBeUndefined();
    expect(first.actions.some((a: ClearAction) => a.pending)).toBe(true);

    let release!: (s: TransactionStatus) => void;
    h.ctf.getTransactionStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const a = h.clear();
    await tick(); await tick();
    const withheld = await h.clear();
    expect(withheld).toMatchObject({ withheld: true, actions: [], totalUsdcRecovered: 0, success: false });
    release(txStatus('pending'));
    await a;
  });
});
