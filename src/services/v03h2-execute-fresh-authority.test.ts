import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity } from './arbitrage-service.js';
import type { TradingService } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const rejected: Reply = { success: false, submissionState: 'REJECTED', errorMsg: 'venue rejection' };
const services: ArbitrageService[] = [];

/** Sized from a cached snapshot: 10 pairs; LONG needs 10 × (0.4 + 0.5) = 9 pUSD, SHORT needs 10 held pairs. */
const short: Readonly<ArbitrageOpportunity> = Object.freeze({
  type: 'short', profitRate: 0.1, profitPercent: 10,
  effectivePrices: Object.freeze({ buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 }),
  priceCaps: Object.freeze({ buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 }),
  maxOrderbookSize: 20, maxBalanceSize: 10, recommendedSize: 10,
  estimatedProfit: 1, description: 'fresh authority', timestamp: 1,
}) as ArbitrageOpportunity;
const long: Readonly<ArbitrageOpportunity> = Object.freeze({ ...short, type: 'long' }) as ArbitrageOpportunity;
const LONG_REQUIRED_USDC = 9;

type Inventory = { pusd: string; yes: string; no: string };
const chain = (pusd: number, yes: number, no: number): Inventory => ({ pusd: String(pusd), yes: String(yes), no: String(no) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Cached balance is what sized the opportunity; `fresh` is what the chain reports when execute()
 * refreshes. Orders are rejected by default so any submission is observable without fill facts.
 */
function fixture(cached: { pusd: number; yes: number; no: number }, fresh: Inventory) {
  const service = new ArbitrageService({ enableLogging: false, enableRebalancer: true, autoFixImbalance: false });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>().mockResolvedValue(rejected),
    // Accepted BUYs stay LIVE with no fills: a long becomes pending, never terminal, never merges.
    getOrderFillDetails: vi.fn(async (id: string) => ({ id, asset_id: id.endsWith('y') ? 'yes' : 'no', side: 'BUY',
      status: 'LIVE', tradeEnumerationPresent: true, tradeIds: [], sizeMatched: '0' })),
    getTradeStatuses: vi.fn(async () => []),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue('wallet'),
    getPusdBalance: vi.fn(async () => fresh.pusd),
    getPositionBalanceByTokenIds: vi.fn(async () => ({ yesBalance: fresh.yes, noBalance: fresh.no })),
    mergeByTokenIds: vi.fn(),
    split: vi.fn(),
  };
  const realtime = { connect: vi.fn(), disconnect: vi.fn(), subscribeMarkets: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) };
  const cachedBalance = { usdc: cached.pusd, pUsdBalance: cached.pusd, yesTokens: cached.yes, noTokens: cached.no, lastUpdate: 0 };
  Object.assign(service, { market, tradingService: trading, ctf, realtimeService: realtime, balance: cachedBalance });
  const execution = vi.fn();
  service.on('execution', execution);
  const errors = vi.fn();
  service.on('error', errors);
  const balanceUpdates = vi.fn();
  service.on('balanceUpdate', balanceUpdates);
  const failRefresh = () => ctf.getPositionBalanceByTokenIds.mockRejectedValue(new Error('RPC read failed'));
  const reads = () => ctf.getPusdBalance.mock.calls.length;
  const orders = (side?: 'BUY' | 'SELL') =>
    trading.createMarketOrder.mock.calls.filter(([o]) => !side || o.side === side);
  return { service, market, trading, ctf, cachedBalance, execution, errors, balanceUpdates, failRefresh, reads, orders };
}
type H = ReturnType<typeof fixture>;

const WITHHELD = 'Fresh balance refresh failed; execution withheld';

/** Withheld before authority: no writes, no attempt, no event, cached telemetry untouched. */
function expectWithheldWithoutAuthority(h: H, result: Awaited<ReturnType<ArbitrageService['execute']>>, type: 'long' | 'short') {
  expect(result).toEqual({ success: false, type, size: 0, profit: 0, txHashes: [], error: WITHHELD, executionTimeMs: expect.any(Number) });
  expect(result).not.toHaveProperty('pending');
  expect(h.orders()).toHaveLength(0);
  expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  expect(h.ctf.split).not.toHaveBeenCalled();
  expect(h.execution).not.toHaveBeenCalled();
  expect(h.service.getStats()).toMatchObject({ executionsAttempted: 0, executionsSucceeded: 0, totalProfit: 0 });
  expect(h.service['lastExecutionTime']).toBe(0);
  expect(h.service['isExecuting']).toBe(false);
  expect(h.service['balance']).toBe(h.cachedBalance);
  expect(h.balanceUpdates).not.toHaveBeenCalled();
  expect(h.reads()).toBe(1); // the failed entry read only; no post-attempt refresh for a non-attempt
}

function expectNoWrites(h: H) {
  expect(h.orders()).toHaveLength(0);
  expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  expect(h.ctf.split).not.toHaveBeenCalled();
  expect(h.service['pendingShortArbs'].size).toBe(0);
  expect(h.service['pendingLongArbs'].size).toBe(0);
}

/** Opportunities are frozen, so a resize would throw; this also proves the stored fields never moved. */
function expectOpportunityIntact() {
  expect(long).toMatchObject({ recommendedSize: 10, maxBalanceSize: 10 });
  expect(short).toMatchObject({ recommendedSize: 10, maxBalanceSize: 10 });
}

async function submitShort(h: H) {
  const result = await h.service.execute(short);
  if (result.type !== 'SHORT_SUBMISSION') throw new Error('Expected short acknowledgment');
  return result;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); });
afterEach(async () => {
  try {
    for (const service of services.splice(0)) await service.stop();
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('P0.3H2 execute() fresh balance authority: LONG', () => {
  it('stale pUSD: cached 100 authorizes 9 but fresh 5 does not → zero BUY submissions, no resize', async () => {
    const h = fixture({ pusd: 100, yes: 0, no: 0 }, chain(5, 0, 0));
    const result = await h.service.execute(long);
    if (result.type === 'SHORT_SUBMISSION') throw new Error('Expected long result');
    expect(result).toMatchObject({ success: false, type: 'long', profit: 0, txHashes: [] });
    expect(result.error).toBe(`Insufficient pUSD: have 5.00, need ${LONG_REQUIRED_USDC.toFixed(2)}`);
    expectNoWrites(h);
    expectOpportunityIntact();
    // The executor's collateral check ran against the freshly applied balance, not the cache.
    expect(h.service.getBalance()).toMatchObject({ pUsdBalance: 5, yesTokens: 0, noTokens: 0 });
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
  });

  it('fresh refresh fails → zero BUY submissions, ordinary non-pending failure', async () => {
    const h = fixture({ pusd: 100, yes: 0, no: 0 }, chain(100, 0, 0));
    h.failRefresh();
    const result = await h.service.execute(long);
    expectWithheldWithoutAuthority(h, result, 'long');
    expect(h.errors).toHaveBeenCalledTimes(1);
  });

  it('fresh pUSD sufficient → the existing BUY path is reached with the unchanged size', async () => {
    const h = fixture({ pusd: 100, yes: 0, no: 0 }, chain(100, 0, 0));
    const result = await h.service.execute(long);
    if (result.type === 'SHORT_SUBMISSION') throw new Error('Expected long result');
    expect(h.orders('BUY')).toHaveLength(1);
    // Existing long-arb BUY notional: unchanged size 10 × buyYes 0.4 = 4 pUSD.
    expect(h.orders('BUY')[0][0]).toMatchObject({ tokenId: 'yes', side: 'BUY', amount: 10 * 0.4 });
    expect(result).toMatchObject({ success: false, type: 'long', size: 10 });
    expect(result.error).toContain('Leg 1 (YES) failed');
    expect(h.service.getStats()).toMatchObject({ executionsAttempted: 1, executionsSucceeded: 0, totalProfit: 0 });
    expect(h.reads()).toBe(2); // entry read + post-attempt refresh
    expectOpportunityIntact();
  });

  it('a stale LONG that fresh pUSD only partially covers is rejected, never resized to what fits', async () => {
    // Fresh 6 pUSD would fund 6 pairs at 0.9 each; the 10-pair opportunity must be refused outright.
    const h = fixture({ pusd: 100, yes: 0, no: 0 }, chain(6, 0, 0));
    const result = await h.service.execute(long);
    if (result.type === 'SHORT_SUBMISSION') throw new Error('Expected long result');
    expect(result.error).toBe('Insufficient pUSD: have 6.00, need 9.00');
    expect(h.orders()).toHaveLength(0);
    expectOpportunityIntact();
  });
});

describe('P0.3H2 execute() fresh balance authority: SHORT', () => {
  it('stale holdings: cached 10/10 sufficient, fresh 4/4 insufficient → zero SELL submissions, no resize', async () => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 4, 4));
    const ack = await submitShort(h);
    expect(ack.status).toBe('SUBMISSION_REJECTED');
    expectNoWrites(h);
    expectOpportunityIntact();
    expect(h.service.getBalance()).toMatchObject({ yesTokens: 4, noTokens: 4 });
    expect(h.service['lastExecutionTime']).toBe(0);
  });

  it('asymmetric fresh inventory: cached 10/10, fresh 10/6, size 10 → zero SELL submissions before leg A', async () => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 10, 6));
    const ack = await submitShort(h);
    expect(ack.status).toBe('SUBMISSION_REJECTED');
    expectNoWrites(h);
    expectOpportunityIntact();
  });

  it('fresh refresh fails → zero SELL submissions, ordinary non-pending failure', async () => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 10, 10));
    h.failRefresh();
    const result = await h.service.execute(short);
    expectWithheldWithoutAuthority(h, result, 'short');
    expect(h.service['pendingShortArbs'].size).toBe(0);
  });

  it('fresh holdings sufficient → the existing SELL path submits both legs at the unchanged size', async () => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 10, 10));
    h.trading.createMarketOrder.mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(accepted('b'));
    const ack = await submitShort(h);
    expect(ack.status).toBe('SUBMITTED_PENDING');
    expect(h.orders('SELL').map(([o]) => [o.tokenId, o.amount])).toEqual([['yes', 10], ['no', 10]]);
    expect(h.service.getStats()).toMatchObject({ executionsAttempted: 1, executionsSucceeded: 0, totalProfit: 0 });
    expect(h.reads()).toBe(2);
    expectOpportunityIntact();
  });
});

describe('P0.3H2 execute() concurrency and admission', () => {
  it('execute ∥ execute: the second caller sees the claim during the fresh read and performs no read or write', async () => {
    const h = fixture({ pusd: 100, yes: 0, no: 0 }, chain(100, 0, 0));
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const first = h.service.execute(long);
    expect(h.service['isExecuting']).toBe(true);
    expect(h.reads()).toBe(1);
    const second = await h.service.execute(long);
    expect(second).toEqual({ success: false, type: 'long', size: 0, profit: 0, txHashes: [], error: 'Another execution in progress', executionTimeMs: 0 });
    expect(h.reads()).toBe(1); // no independent read by the loser
    expect(h.orders()).toHaveLength(0);
    gate.resolve('100');
    const result = await first;
    if (result.type === 'SHORT_SUBMISSION') throw new Error('Expected long result');
    expect(result.error).toContain('Leg 1 (YES) failed');
    expect(h.orders('BUY')).toHaveLength(1); // at most one economic execution proceeded
    expect(h.service.getStats().executionsAttempted).toBe(1);
    expect(h.service['isExecuting']).toBe(false);
  });

  it('pending short acknowledgement happens before any fresh read', async () => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 10, 10));
    h.trading.createMarketOrder.mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(accepted('b'));
    const first = await submitShort(h);
    h.ctf.getPusdBalance.mockClear(); h.ctf.getPositionBalanceByTokenIds.mockClear();
    const again = await h.service.execute(short);
    expect(again).toEqual({ type: 'SHORT_SUBMISSION', status: 'SUBMITTED_PENDING', operationId: first.operationId });
    expect(h.reads()).toBe(0);
    expect(h.ctf.getPositionBalanceByTokenIds).not.toHaveBeenCalled();
    expect(h.orders()).toHaveLength(2);
  });

  it('pending long refusal happens before any fresh read', async () => {
    const h = fixture({ pusd: 100, yes: 0, no: 0 }, chain(100, 0, 0));
    h.trading.createMarketOrder.mockResolvedValueOnce(accepted('ly')).mockResolvedValueOnce(accepted('ln'));
    const first = await h.service.execute(long);
    expect(first).toMatchObject({ success: false, pending: true, operationId: 'long-1' });
    h.ctf.getPusdBalance.mockClear(); h.ctf.getPositionBalanceByTokenIds.mockClear();
    const again = await h.service.execute(long);
    expect(again).toMatchObject({ success: false, pending: true, operationId: 'long-1', txHashes: [] });
    expect(h.reads()).toBe(0);
    expect(h.ctf.getPositionBalanceByTokenIds).not.toHaveBeenCalled();
    expect(h.orders()).toHaveLength(2);
  });

  it('short inventory block on a LONG happens before any fresh read', async () => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 10, 10));
    h.trading.createMarketOrder.mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(accepted('b'));
    await submitShort(h);
    h.ctf.getPusdBalance.mockClear();
    await expect(h.service.execute(long)).rejects.toThrow('Inventory write blocked by short short-1');
    expect(h.reads()).toBe(0);
    expect(h.orders('BUY')).toHaveLength(0);
    expect(h.service.getStats().executionsAttempted).toBe(1);
  });

  it('active rebalancer block on a SHORT happens before any fresh read', async () => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 10, 10));
    h.service['rebalancerInventoryWrites'].add({ conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no' });
    await expect(h.service.execute(short)).rejects.toThrow('Inventory write blocked by active rebalancer');
    expect(h.reads()).toBe(0);
    expectNoWrites(h);
    expect(h.service.getStats().executionsAttempted).toBe(0);
  });

  it('ownership acquired by a writer during the fresh read withholds the SHORT after the read', async () => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 10, 10));
    // The refresh notifies listeners synchronously before execute() resumes; a rebalancer claim
    // made there must be honored by the post-read recheck.
    h.service.once('balanceUpdate', () =>
      h.service['rebalancerInventoryWrites'].add({ conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no' }));
    await expect(h.service.execute(short)).rejects.toThrow('Inventory write blocked by active rebalancer');
    expect(h.reads()).toBe(1);
    expectNoWrites(h);
    expect(h.service.getStats().executionsAttempted).toBe(0);
    expect(h.service['isExecuting']).toBe(false);
  });

  it('a short becoming unresolved during the fresh read withholds the LONG after the read', async () => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 10, 10));
    h.service.once('balanceUpdate', () => h.service['pendingShortArbs'].set('short-9', {
      id: 'short-9', conditionId: 'condition', consumed: false, finalized: false,
      legA: { tokenId: 'yes', submission: 'SUBMITTED', orderId: 'a' },
      legB: { tokenId: 'no', submission: 'SUBMITTED', orderId: 'b' },
    }));
    await expect(h.service.execute(long)).rejects.toThrow('Inventory write blocked by short short-9');
    expect(h.reads()).toBe(1);
    expect(h.orders()).toHaveLength(0);
    expect(h.service.getStats().executionsAttempted).toBe(0);
    expect(h.service['isExecuting']).toBe(false);
  });
});

describe('P0.3H2 execute() metrics and result semantics without fresh authority', () => {
  it.each(['long', 'short'] as const)('%s: failed fresh authority emits no execution event and mutates no metric', async type => {
    const h = fixture({ pusd: 100, yes: 10, no: 10 }, chain(100, 10, 10));
    Object.assign(h.service['stats'], { executionsAttempted: 3, executionsSucceeded: 2, totalProfit: 7 });
    const before = h.service.getStats();
    h.failRefresh();
    const result = await h.service.execute(type === 'long' ? long : short);
    expect(result).toMatchObject({ success: false, type, size: 0, profit: 0, txHashes: [], error: WITHHELD });
    expect(h.execution).not.toHaveBeenCalled();
    expect(h.service.getStats()).toEqual(before);
    expect(h.service.getStats()).toMatchObject({ executionsAttempted: 3, executionsSucceeded: 2, totalProfit: 7 });
    expectNoWrites(h);
    expect(h.service['balance']).toBe(h.cachedBalance);
  });

  it('a later call with a working refresh proceeds normally after a withheld one', async () => {
    const h = fixture({ pusd: 100, yes: 0, no: 0 }, chain(100, 0, 0));
    h.ctf.getPositionBalanceByTokenIds.mockRejectedValueOnce(new Error('transient'));
    expect(await h.service.execute(long)).toMatchObject({ error: WITHHELD });
    const result = await h.service.execute(long);
    expect(result.type === 'long' && result.error).toContain('Leg 1 (YES) failed');
    expect(h.orders('BUY')).toHaveLength(1);
    expect(h.service.getStats().executionsAttempted).toBe(1);
  });

  it('withheld result reports factual elapsed time', async () => {
    const h = fixture({ pusd: 100, yes: 0, no: 0 }, chain(100, 0, 0));
    h.ctf.getPusdBalance.mockImplementationOnce(async () => { vi.setSystemTime(100250); throw new Error('slow RPC'); });
    const result = await h.service.execute(long);
    expect(result).toMatchObject({ error: WITHHELD, executionTimeMs: 250 });
  });
});
