import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageExecutionResult, type ArbitrageOpportunity, type RebalanceResult } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
type Excess = 'YES' | 'NO';
const services: ArbitrageService[] = [];
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const rejected: Reply = { success: false, submissionState: 'REJECTED', errorMsg: 'venue rejection' };
const HASH = (n: string) => '0x' + n.repeat(32);
const MERGE_TX = HASH('ab');

/** Raw CLOB trade rows as the service receives them; string literals stand in for the SDK enums. */
type Trade = {
  id: string; status: string; size?: string; price?: string; transactionHash?: string; asset_id?: string; side?: string;
  taker_order_id?: string; trader_side?: string;
  maker_orders?: Array<{ order_id: string; asset_id?: string; side?: string; matched_amount?: string; price?: string }>;
};
const taker = (id: string, orderId: string, asset: string, size: string, price: string, side: 'BUY' | 'SELL', hash = HASH('11')): Trade =>
  ({ id, status: 'MINED', size, price, transactionHash: hash, asset_id: asset, side, taker_order_id: orderId, trader_side: 'TAKER', maker_orders: [] });

const token = (excess: Excess) => excess === 'YES' ? 'yes' : 'no';

/**
 * Cached inventory 40 / 20 (or mirrored): the rebalancer would SELL 20 of the
 * excess token and the corrective path would SELL 90% of the 20 imbalance = 18.
 * The chain reader returns the same figures until a test makes it fail.
 */
function fixture(excess: Excess = 'YES', options: { autoFixImbalance?: boolean } = {}) {
  const service = new ArbitrageService({ enableLogging: false, enableRebalancer: true, autoFixImbalance: options.autoFixImbalance ?? true });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const trades: Record<string, Trade> = {
    r1: taker('r1', 'sell', token(excess), '20', '0.55', 'SELL', HASH('11')),
    ty: taker('ty', 'ly', 'yes', '10', '0.4', 'BUY', HASH('22')),
    tn: taker('tn', 'ln', 'no', '10', '0.5', 'BUY', HASH('33')),
  };
  const orders: Record<string, OrderRow> = {
    sell: { id: 'sell', asset_id: token(excess), side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['r1'], sizeMatched: '20' },
    ly: { id: 'ly', asset_id: 'yes', side: 'BUY', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['ty'], sizeMatched: '10' },
    ln: { id: 'ln', asset_id: 'no', side: 'BUY', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['tn'], sizeMatched: '10' },
  };
  const balances = excess === 'YES' ? { yesBalance: '40', noBalance: '20' } : { yesBalance: '20', noBalance: '40' };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>().mockResolvedValue(accepted('sell')),
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
    getPositionBalanceByTokenIds: vi.fn(async () => ({ ...balances })),
    mergeByTokenIds: vi.fn(async (_c: string, _t: unknown, amount: string) =>
      ({ success: true, txHash: MERGE_TX, amount, usdcReceived: amount, provenance: { state: 'CONFIRMED', transactionHash: MERGE_TX } })),
    split: vi.fn(),
  };
  const realtime = { connect: vi.fn(), disconnect: vi.fn(), subscribeMarkets: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) };
  const cached = { usdc: 100, pUsdBalance: 100, yesTokens: Number(balances.yesBalance), noTokens: Number(balances.noBalance), lastUpdate: 0 };
  Object.assign(service, { market, tradingService: trading, ctf, realtimeService: realtime, isRunning: true, totalCapital: 120, balance: cached });
  const events = vi.fn<(result: RebalanceResult) => void>();
  service.on('rebalance', events);
  const balanceUpdates = vi.fn();
  service.on('balanceUpdate', balanceUpdates);
  const errors = vi.fn<(error: Error) => void>();
  service.on('error', errors);
  const execution = vi.fn();
  service.on('execution', execution);
  const logs: string[] = [];
  vi.spyOn(service as unknown as { log: (m: string) => void }, 'log').mockImplementation(m => { logs.push(m); });
  const pending = service['pendingRebalanceSells'];
  const check = () => service['checkAndRebalance']();
  const fix = () => service['fixImbalanceIfNeeded']();
  const flush = () => service['flushPendingRebalanceSells']();
  const refresh = () => service['updateBalance']();
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  const failPositions = (message = 'RPC read failed') => ctf.getPositionBalanceByTokenIds.mockRejectedValue(new Error(message));
  const failPusd = (message = 'pUSD read failed') => ctf.getPusdBalance.mockRejectedValue(new Error(message));
  const restoreReads = () => {
    ctf.getPositionBalanceByTokenIds.mockReset().mockImplementation(async () => ({ ...balances }));
    ctf.getPusdBalance.mockReset().mockImplementation(async () => '100');
  };
  return { service, market, excess, trades, orders, balances, cached, trading, ctf, events, balanceUpdates, errors, execution, logs,
    pending, check, fix, flush, refresh, sells, failPositions, failPusd, restoreReads };
}
type H = ReturnType<typeof fixture>;

/** No economic inventory write of any kind reached the venue or the chain. */
function expectNoEconomicWrite(h: H) {
  expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  expect(h.ctf.split).not.toHaveBeenCalled();
  expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  expect(h.events).not.toHaveBeenCalled();
  expect(h.pending.size).toBe(0);
  expect(h.service['lastRebalanceTime']).toBe(0);
}

/** The previously cached balance is still there for display, but was not refreshed. */
function expectCachedTelemetryUnchanged(h: H) {
  expect(h.service['balance']).toBe(h.cached);
  expect(h.service.getBalance()).toEqual({ usdc: 100, pUsdBalance: 100,
    yesTokens: Number(h.balances.yesBalance), noTokens: Number(h.balances.noBalance), lastUpdate: 0 });
  expect(h.balanceUpdates).not.toHaveBeenCalled();
}

const soldLogs = (h: H) => h.logs.filter(m => /Sold .*excess/.test(m));

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3 fresh balance gate: updateBalance() reports freshness', () => {
  it('returns true only when pUSD and both position balances were freshly read and applied', async () => {
    const h = fixture();
    await expect(h.refresh()).resolves.toBe(true);
    expect(h.balanceUpdates).toHaveBeenCalledTimes(1);
    expect(h.service.getBalance()).toMatchObject({ pUsdBalance: 100, yesTokens: 40, noTokens: 20 });
    expect(h.service.getBalance().lastUpdate).toBeGreaterThan(0);
  });

  it.each<[string, (h: H) => void]>([
    ['position read fails', h => { h.failPositions(); }],
    ['pUSD read fails', h => { h.failPusd(); }],
    ['both reads fail', h => { h.failPositions(); h.failPusd(); }],
    ['pUSD read succeeds but position payload is invalid', h => { h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: 'n/a', noBalance: '20' } as never); }],
    ['positions succeed but pUSD payload is invalid', h => { h.ctf.getPusdBalance.mockResolvedValue('' as never); }],
    ['positions succeed but pUSD is negative', h => { h.ctf.getPusdBalance.mockResolvedValue('-1' as never); }],
    ['position payload is missing a side', h => { h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '40' } as never); }],
  ])('returns false and keeps the cached value when the %s', async (_label, breakRead) => {
    const h = fixture();
    breakRead(h);
    await expect(h.refresh()).resolves.toBe(false);
    expectCachedTelemetryUnchanged(h);
    expect(h.errors).toHaveBeenCalledTimes(1);
  });

  it('returns false without a market or CTF client', async () => {
    const h = fixture();
    Object.assign(h.service, { market: null });
    await expect(h.refresh()).resolves.toBe(false);
    Object.assign(h.service, { market: h.market, ctf: null });
    await expect(h.refresh()).resolves.toBe(false);
    expect(h.errors).not.toHaveBeenCalled();
  });

  it('a read superseded by a newer refresh is not reported as fresh authority to its caller', async () => {
    const h = fixture();
    let releaseFirst!: (v: { yesBalance: string; noBalance: string }) => void;
    h.ctf.getPositionBalanceByTokenIds
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockImplementationOnce(async () => ({ yesBalance: '30', noBalance: '30' }));
    const first = h.refresh();
    const second = h.refresh();
    await expect(second).resolves.toBe(true);
    releaseFirst({ yesBalance: '1', noBalance: '1' });
    await expect(first).resolves.toBe(false);
    expect(h.service.getBalance()).toMatchObject({ yesTokens: 30, noTokens: 30 });
    expect(h.balanceUpdates).toHaveBeenCalledTimes(1);
  });

  it('still emits the error so a failed refresh stays visible', async () => {
    const h = fixture();
    h.failPositions('RPC timeout');
    await h.refresh();
    expect(h.errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'RPC timeout' }));
  });
});

describe.each<Excess>(['YES', 'NO'])('P0.3 fresh balance gate: checkAndRebalance() (%s excess cached)', excess => {
  it('cached imbalance + failed fresh position read → no economic write', async () => {
    const h = fixture(excess);
    h.failPositions();
    await h.check();
    expectNoEconomicWrite(h);
    expectCachedTelemetryUnchanged(h);
    expect(h.errors).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(expect.stringMatching(/Rebalance cycle skipped: fresh balance refresh failed/));
  });

  it('cached imbalance + failed fresh pUSD read → no economic write', async () => {
    const h = fixture(excess);
    h.failPusd();
    await h.check();
    expectNoEconomicWrite(h);
    expectCachedTelemetryUnchanged(h);
    expect(h.errors).toHaveBeenCalledTimes(1);
  });

  it('a partial refresh (positions fresh, pUSD invalid) is not authority either', async () => {
    const h = fixture(excess);
    h.ctf.getPusdBalance.mockResolvedValue('not-a-number' as never);
    await h.check();
    expectNoEconomicWrite(h);
    expectCachedTelemetryUnchanged(h);
  });

  it('the cached telemetry value survives a failed refresh but does not authorize a write', async () => {
    const h = fixture(excess);
    h.failPositions();
    await h.check(); await h.check(); await h.check();
    expectCachedTelemetryUnchanged(h);
    // The cached figures would have produced this action; it was never taken.
    expect(h.service.calculateRebalanceAction()).toMatchObject({ type: excess === 'YES' ? 'sell_yes' : 'sell_no', amount: 20 });
    expectNoEconomicWrite(h);
    expect(h.errors).toHaveBeenCalledTimes(3);
  });

  it('the next tick with a successful refresh executes the normal action exactly once', async () => {
    const h = fixture(excess);
    h.failPositions();
    await h.check();
    expectNoEconomicWrite(h);
    h.restoreReads();
    await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: token(excess), side: 'SELL', amount: 20 });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: true, action: { type: excess === 'YES' ? 'sell_yes' : 'sell_no', amount: 20 },
      facts: { soldShares: 20, requestedShares: 20 } });
    expect(h.service['lastRebalanceTime']).toBeGreaterThan(0);
    await h.flush(); await h.flush();
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.sells()).toHaveLength(1);
  });

  it('a failed refresh does not permanently disable the rebalancer: fail, succeed, fail, succeed', async () => {
    const h = fixture(excess);
    h.failPositions();
    await h.check();
    h.restoreReads();
    await h.check();
    expect(h.sells()).toHaveLength(1);
    Object.assign(h.service, { lastRebalanceTime: 0 });
    h.failPusd();
    await h.check();
    expect(h.sells()).toHaveLength(1);
    h.restoreReads();
    h.trading.createMarketOrder.mockResolvedValue(accepted('sell'));
    await h.check();
    expect(h.sells()).toHaveLength(2);
    expect(h.events).toHaveBeenCalledTimes(2);
  });

  it('a successful fresh refresh preserves the existing rebalance behavior', async () => {
    const h = fixture(excess);
    await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: token(excess), side: 'SELL', amount: 20, orderType: 'FOK' });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: true, facts: { soldShares: 20, tokenId: token(excess) } });
    expect(h.balanceUpdates).toHaveBeenCalled();
    expect(h.errors).not.toHaveBeenCalled();
  });

  it('a failed refresh does not authorize split or merge either', async () => {
    const h = fixture(excess);
    // Cached state that would call for a split (all capital in pUSD, no tokens).
    Object.assign(h.cached, { usdc: 100, pUsdBalance: 100, yesTokens: 0, noTokens: 0 });
    Object.assign(h.service, { totalCapital: 100 });
    expect(h.service.calculateRebalanceAction()).toMatchObject({ type: 'split' });
    h.failPositions();
    await h.check();
    expect(h.ctf.split).not.toHaveBeenCalled();
    // Cached state that would call for a merge (no pUSD, paired tokens).
    Object.assign(h.cached, { usdc: 0, pUsdBalance: 0, yesTokens: 50, noTokens: 50 });
    Object.assign(h.service, { totalCapital: 50 });
    expect(h.service.calculateRebalanceAction()).toMatchObject({ type: 'merge' });
    await h.check();
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    expect(h.events).not.toHaveBeenCalled();
  });

  it('cooldown and pending-SELL gates are preserved around the freshness gate', async () => {
    const h = fixture(excess);
    Object.assign(h.service, { lastRebalanceTime: Date.now() });
    await h.check();
    expect(h.ctf.getPositionBalanceByTokenIds).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    Object.assign(h.service, { lastRebalanceTime: 0 });
    h.orders.sell = { ...h.orders.sell, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.pending.size).toBe(1);
    h.failPositions();
    await h.check();
    await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.events).not.toHaveBeenCalled();
  });

  it('concurrent ticks during a failed refresh cannot use the cached balance to write', async () => {
    const h = fixture(excess);
    h.failPositions();
    await Promise.all([h.check(), h.check(), h.check(), h.fix(), h.fix()]);
    expectNoEconomicWrite(h);
    expectCachedTelemetryUnchanged(h);
  });
});

describe.each<Excess>(['YES', 'NO'])('P0.3 fresh balance gate: fixImbalanceIfNeeded() (%s excess cached)', excess => {
  it('cached excess + failed fresh position read → no corrective SELL', async () => {
    const h = fixture(excess);
    h.failPositions();
    await h.fix();
    expectNoEconomicWrite(h);
    expectCachedTelemetryUnchanged(h);
    expect(h.errors).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(expect.stringMatching(/Imbalance correction withheld: fresh balance refresh failed/));
    expect(h.logs).not.toContainEqual(expect.stringMatching(/Imbalance detected/));
  });

  it('cached excess + failed fresh pUSD read → no corrective SELL', async () => {
    const h = fixture(excess);
    h.failPusd();
    await h.fix();
    expectNoEconomicWrite(h);
    expectCachedTelemetryUnchanged(h);
  });

  it('a later successful refresh submits the corrective SELL from fresh inventory exactly once', async () => {
    const h = fixture(excess);
    h.failPositions();
    await h.fix();
    expect(h.sells()).toHaveLength(0);
    h.restoreReads();
    h.orders.sell = { ...h.orders.sell, sizeMatched: '18' };
    h.trades.r1.size = '18';
    await h.fix();
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: token(excess), side: 'SELL', amount: 18 });
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.events).not.toHaveBeenCalled();
    await h.flush();
    expect(soldLogs(h)).toHaveLength(1);
  });

  it('an unresolved corrective SELL still blocks a new one, regardless of refresh outcome', async () => {
    const h = fixture(excess);
    h.orders.sell = { ...h.orders.sell, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await h.fix();
    expect(h.sells()).toHaveLength(1);
    expect(h.pending.size).toBe(1);
    await h.fix();
    expect(h.sells()).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringMatching(/Corrective SELL withheld: corrective-sell-1 pending factual reconciliation/));
    h.failPositions();
    await h.fix(); await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.pending.size).toBe(1);
  });

  it('an unresolved rebalance SELL still blocks a corrective SELL after a successful refresh', async () => {
    const h = fixture(excess);
    h.orders.sell = { ...h.orders.sell, status: 'LIVE', tradeIds: [], sizeMatched: '0' };
    await h.check();
    expect(h.pending.size).toBe(1);
    expect([...h.pending.values()][0].kind).toBe('rebalance');
    await h.fix();
    expect(h.sells()).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringMatching(/Corrective SELL withheld: rebalance-sell-1 pending factual reconciliation/));
  });
});

describe('P0.3 fresh balance gate: long-arb interaction', () => {
  const long: ArbitrageOpportunity = {
    type: 'long', profitRate: 0.1, profitPercent: 10,
    effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
    priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
    maxOrderbookSize: 20, maxBalanceSize: 20, recommendedSize: 10, estimatedProfit: 1, description: 'fresh balance gate', timestamp: 1,
  };

  async function runLong(h: H): Promise<ArbitrageExecutionResult> {
    const result = await h.service.execute(long);
    if (result.type === 'SHORT_SUBMISSION') throw new Error('Expected long result');
    return result;
  }

  /** Leg 1 (YES) fills 10, leg 2 (NO) is rejected; cached inventory shows a YES excess. */
  function leg2Fixture() {
    const h = fixture('YES');
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('ly')).mockResolvedValueOnce(rejected).mockResolvedValue(accepted('sell'));
    return h;
  }

  it('leg-2 rejection with a failed refresh inside correction: no stale corrective SELL, no fabricated success', async () => {
    const h = leg2Fixture();
    h.failPositions();
    const result = await runLong(h);
    expect(result).toMatchObject({ type: 'long', success: false, profit: 0 });
    expect(h.sells()).toHaveLength(0);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
    expect(h.events).not.toHaveBeenCalled();
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
    expect(h.logs).toContainEqual(expect.stringMatching(/Imbalance correction withheld: fresh balance refresh failed/));
    expect(soldLogs(h)).toEqual([]);
    expectCachedTelemetryUnchanged(h);
  });

  it('leg-2 rejection with a failed pUSD read behaves the same', async () => {
    const h = leg2Fixture();
    h.failPusd();
    const result = await runLong(h);
    expect(result).toMatchObject({ success: false, profit: 0 });
    expect(h.sells()).toHaveLength(0);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
  });

  it('leg-2 rejection with a successful refresh still runs the existing corrective path', async () => {
    const h = leg2Fixture();
    h.orders.sell = { ...h.orders.sell, sizeMatched: '18' };
    h.trades.r1.size = '18';
    const result = await runLong(h);
    expect(result).toMatchObject({ success: false, profit: 0 });
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: 'yes', amount: 18 });
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
  });

  /** Uneven fills YES 10 / NO 8 merge 8 pairs; the chain would then show a residual YES excess. */
  function residualFixture() {
    const h = fixture('YES');
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('ly')).mockResolvedValueOnce(accepted('ln')).mockResolvedValue(accepted('sell'));
    h.trades.tn.size = '8';
    h.orders.ln = { ...h.orders.ln, status: 'CANCELED', sizeMatched: '8' };
    return h;
  }

  it('post-merge residual correction with a failed refresh: no stale corrective SELL, factual profit unchanged', async () => {
    const h = residualFixture();
    h.failPositions();
    const result = await runLong(h);
    expect(result).toMatchObject({ type: 'long', success: true, size: 8, txHashes: [MERGE_TX] });
    expect(result.facts).toMatchObject({ yesShares: 10, noShares: 8, mergedShares: 8, yesCost: expect.closeTo(3.2, 10), noCost: 4 });
    expect(result.profit).toBeCloseTo(8 - 3.2 - 4, 10);
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('condition', expect.anything(), '8', expect.anything());
    expect(h.sells()).toHaveLength(0);
    expect(h.pending.size).toBe(0);
    expect(h.logs).toContainEqual(expect.stringMatching(/Residual check skipped: fresh balance refresh failed/));
    expect(h.logs).not.toContainEqual(expect.stringMatching(/Residual imbalance after merge/));
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 1, totalProfit: expect.closeTo(0.8, 10) });
    expectCachedTelemetryUnchanged(h);
  });

  it('post-merge residual correction with a successful refresh still submits the corrective SELL', async () => {
    const h = residualFixture();
    // Fresh post-merge chain inventory 30 / 20: residual 10 → corrective sells 90% = 9 YES.
    h.ctf.getPositionBalanceByTokenIds.mockImplementation(async () => ({ yesBalance: '30', noBalance: '20' }));
    h.orders.sell = { ...h.orders.sell, sizeMatched: '9' };
    h.trades.r1.size = '9';
    const result = await runLong(h);
    expect(result).toMatchObject({ success: true, size: 8 });
    expect(result.profit).toBeCloseTo(0.8, 10);
    expect(h.logs).toContainEqual(expect.stringMatching(/Residual imbalance after merge: 10\.00/));
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: 'yes', amount: 9 });
    expect(soldLogs(h)).toHaveLength(1);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 1, totalProfit: expect.closeTo(0.8, 10) });
  });

  it('post-merge residual: refresh fails on the residual check but the correction path is not entered with cached inventory', async () => {
    const h = residualFixture();
    const fix = vi.spyOn(h.service as unknown as { fixImbalanceIfNeeded: ArbitrageService['fixImbalanceIfNeeded'] }, 'fixImbalanceIfNeeded');
    h.failPusd();
    await runLong(h);
    expect(fix).not.toHaveBeenCalled();
    expect(h.sells()).toHaveLength(0);
  });
});
