import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type RebalanceAction, type RebalanceResult } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
const services: ArbitrageService[] = [];
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const rejected: Reply = { success: false, submissionState: 'REJECTED', errorMsg: 'venue rejection' };
const HASH = (n: string) => '0x' + n.repeat(32);

type Inventory = { pusd: number; yes: number; no: number };
const inv = (pusd: number, yes: number, no: number): Inventory => ({ pusd, yes, no });
const act = (type: RebalanceAction['type'], amount: number): RebalanceAction => Object.freeze({ type, amount, reason: 'explicit', priority: 1 }) as RebalanceAction;

/** 0.40 + 0.50 on 5 pairs: a valid long that spends 4.5 pUSD. */
const longOpp: ArbitrageOpportunity = Object.freeze({
  type: 'long', profitRate: 0.1, profitPercent: 10,
  effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
  priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
  maxOrderbookSize: 20, maxBalanceSize: 10, recommendedSize: 5, estimatedProfit: 0.5, description: 'h5', timestamp: 1,
}) as ArbitrageOpportunity;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Every refresh reports `fresh`. Venue replies are ACCEPTED; whether an accepted order exposes
 * factual fills is controlled per side (`sellMode` / `buyMode`) so pending records are created
 * through the real public paths and released through the real reconciliation paths.
 */
function fixture(cached: Inventory, fresh: Inventory, options: { autoFixImbalance?: boolean } = {}) {
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: options.autoFixImbalance ?? false,
    enableRebalancer: true, rebalanceCooldown: 0 });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const orders: Record<string, OrderRow> = {};
  const trades: Record<string, TradeStatus> = {};
  const modes = { sell: 'pending' as 'pending' | 'filled', buy: 'pending' as 'pending' | 'yesFilledNoRejected' };
  let buyCount = 0, sellCount = 0;
  const fill = (id: string, tokenId: string, side: 'BUY' | 'SELL', size: string, price: string, hash: string) => {
    Object.assign(orders[id], { status: 'MATCHED', tradeIds: [`t-${id}`], sizeMatched: size });
    trades[`t-${id}`] = { id: `t-${id}`, status: 'MINED', size, price, transactionHash: hash,
      asset_id: tokenId, side, taker_order_id: id, trader_side: 'TAKER', maker_orders: [] } as unknown as TradeStatus;
  };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>().mockImplementation(async o => {
      if (o.side === 'BUY') {
        if (modes.buy === 'yesFilledNoRejected' && o.tokenId === 'no') return rejected;
        const id = `l${++buyCount}`;
        orders[id] = { id, asset_id: o.tokenId, side: 'BUY', status: 'LIVE', tradeEnumerationPresent: true, tradeIds: [], sizeMatched: '0' };
        if (modes.buy === 'yesFilledNoRejected') fill(id, o.tokenId, 'BUY', String(longOpp.recommendedSize), '0.4', HASH('33'));
        return accepted(id);
      }
      const id = `r${++sellCount}`;
      orders[id] = { id, asset_id: o.tokenId, side: 'SELL', status: 'LIVE', tradeEnumerationPresent: true, tradeIds: [], sizeMatched: '0' };
      if (modes.sell === 'filled') fill(id, o.tokenId, 'SELL', String(o.amount), '0.55', HASH('11'));
      return accepted(id);
    }),
    getOrderFillDetails: vi.fn(async (id: string) => ({ ...orders[id], tradeIds: [...orders[id].tradeIds] })),
    getTradeStatuses: vi.fn(async (ids: string[]) => ids.map(id => trades[id])),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue('wallet'),
    getPusdBalance: vi.fn(async () => String(fresh.pusd)),
    getPositionBalanceByTokenIds: vi.fn(async () => ({ yesBalance: String(fresh.yes), noBalance: String(fresh.no) })),
    mergeByTokenIds: vi.fn(async () => ({ txHash: 'merge-tx' })),
    split: vi.fn(async () => ({ txHash: 'split-tx' })),
  };
  const realtime = { connect: vi.fn(), disconnect: vi.fn(), subscribeMarkets: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) };
  const cachedBalance = { usdc: cached.pusd, pUsdBalance: cached.pusd, yesTokens: cached.yes, noTokens: cached.no, lastUpdate: 0 };
  Object.assign(service, { market, tradingService: trading, ctf, realtimeService: realtime, isRunning: true, totalCapital: 20, balance: cachedBalance });
  const events = vi.fn<(result: RebalanceResult) => void>();
  service.on('rebalance', events);
  service.on('error', vi.fn());
  const execution = vi.fn();
  service.on('execution', execution);
  const reads = () => ctf.getPusdBalance.mock.calls.length + ctf.getPositionBalanceByTokenIds.mock.calls.length;
  const clearReads = () => { ctf.getPusdBalance.mockClear(); ctf.getPositionBalanceByTokenIds.mockClear(); };
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  const buys = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'BUY');
  const pendingSells = service['pendingRebalanceSells'];
  const pendingLongs = service['pendingLongArbs'];
  const writers = service['rebalancerInventoryWrites'];
  const check = () => service['checkAndRebalance']();
  const flushSells = () => service['flushPendingRebalanceSells']();
  /** The accepted SELL becomes a full factual MINED fill of the shares its record requested. */
  const fillSell = (orderId: string) => {
    const record = [...pendingSells.values()].find(r => r.leg.orderId === orderId);
    if (!record) throw new Error(`no pending SELL record for ${orderId}`);
    fill(orderId, record.leg.tokenId, 'SELL', String(record.leg.requestedShares), '0.55', HASH('11'));
  };
  const cancelSell = (id: string) => Object.assign(orders[id], { status: 'CANCELED', tradeIds: [], sizeMatched: '0' });
  /** Real public path: rebalance(explicit SELL) accepted at the venue, fills not yet enumerable. */
  const openPendingSell = async (type: 'sell_yes' | 'sell_no' = 'sell_yes', amount = 5) => {
    const ack = await service.rebalance(act(type, amount));
    expect(ack).toMatchObject({ success: false, pending: true, operationId: 'rebalance-sell-1' });
    expect(sells()).toHaveLength(1);
    const record = pendingSells.get('rebalance-sell-1')!;
    expect(record).toMatchObject({ kind: 'rebalance', leg: { orderId: 'r1', submission: 'SUBMITTED' } });
    expect(writers.size).toBe(0);
    clearReads();
    return record;
  };
  /**
   * Real economic path for kind:'corrective': execute(long) fills YES, the NO leg is rejected, the
   * existing single-sided remediation submits a corrective SELL whose fills stay pending, and the
   * long itself reconciles to a terminal failure (no paired fills) and is published/released.
   */
  const openPendingCorrectiveSell = async () => {
    modes.buy = 'yesFilledNoRejected';
    const result = await service.execute(longOpp);
    if (result.type === 'SHORT_SUBMISSION') throw new Error('Expected long result');
    expect(result).toMatchObject({ success: false, type: 'long', operationId: 'long-1', error: /No paired factual fills/ });
    expect(result.pending).toBeUndefined();
    expect(pendingLongs.size).toBe(0);
    expect(execution).toHaveBeenCalledTimes(1);
    expect(sells()).toHaveLength(1);
    const record = pendingSells.get('corrective-sell-1')!;
    expect(record).toMatchObject({ kind: 'corrective', action: { type: 'sell_yes' }, leg: { orderId: 'r1', submission: 'SUBMITTED' } });
    expect(service['isExecuting']).toBe(false);
    expect(writers.size).toBe(0);
    clearReads();
    return record;
  };
  return { service, market, trading, ctf, modes, cachedBalance, events, execution, reads, clearReads, sells, buys,
    pendingSells, pendingLongs, writers, check, flushSells, fillSell, cancelSell, openPendingSell, openPendingCorrectiveSell };
}
type H = ReturnType<typeof fixture>;

/** No new economic write beyond the `priorSells` already on the venue. */
function expectNoNewWrite(h: H, priorSells: number) {
  expect(h.sells()).toHaveLength(priorSells);
  expect(h.ctf.split).not.toHaveBeenCalled();
  expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  expect(h.writers.size).toBe(0);
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3H5 unresolved rebalance SELL owns inventory against rebalance()', () => {
  it('pending SELL + rebalance(): zero balance reads, zero SELL / SPLIT / MERGE, success:false', async () => {
    // Cached and fresh both plan sell_yes 10; the unresolved SELL must refuse before either is consulted.
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    const record = await h.openPendingSell();
    expect(h.service.calculateRebalanceAction()).toMatchObject({ type: 'sell_yes', amount: 10 });
    const result = await h.service.rebalance();
    expect(result).toEqual({ success: false, action: { type: 'none', amount: 0, reason: 'Rebalance withheld', priority: 0 },
      error: 'Rebalance withheld: SELL rebalance-sell-1 pending factual reconciliation' });
    expect(h.reads()).toBe(0);
    expectNoNewWrite(h, 1);
    expect(h.pendingSells.size).toBe(1);
    expect(h.pendingSells.get('rebalance-sell-1')).toBe(record);
    expect(h.events).not.toHaveBeenCalled();
  });

  it.each(['sell_yes', 'sell_no'] as const)('pending SELL + explicit %s: the existing pending acknowledgement is preserved exactly', async type => {
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.openPendingSell();
    const action = act(type, 5);
    const again = await h.service.rebalance(action);
    expect(again).toEqual({ success: false, action, operationId: 'rebalance-sell-1', pending: true,
      error: 'Rebalance SELL rebalance-sell-1 pending factual reconciliation' });
    expect(again.action).toBe(action);
    expect(h.reads()).toBe(0);
    expectNoNewWrite(h, 1);
    expect(h.pendingSells.size).toBe(1);
    expect(h.events).not.toHaveBeenCalled();
  });

  it.each([
    ['split', act('split', 5)],
    ['merge', act('merge', 5)],
  ])('pending SELL + explicit %s: zero balance read, zero write, action preserved, no pending flag', async (_type, action) => {
    // Fresh inventory would authorize the amount; the unresolved SELL's ownership still wins.
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.openPendingSell();
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, action, error: 'Rebalance withheld: SELL rebalance-sell-1 pending factual reconciliation' });
    expect(result.action).toBe(action);
    expect(result.pending).toBeUndefined();
    expect(result.operationId).toBeUndefined();
    expect(result.txHash).toBeUndefined();
    expect(h.reads()).toBe(0);
    expectNoNewWrite(h, 1);
    expect(h.events).not.toHaveBeenCalled();
  });

  it('the refusal identifies the existing operation and the record stays untouched', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    const record = await h.openPendingSell('sell_no', 4);
    const before = { ...record, leg: { ...record.leg } };
    h.trading.getOrderFillDetails.mockClear(); // the submission's own inline reconciliation read r1 once
    const result = await h.service.rebalance(act('merge', 5));
    expect(result.error).toBe(`Rebalance withheld: SELL ${record.id} pending factual reconciliation`);
    expect(record.id).toBe('rebalance-sell-1');
    expect(h.pendingSells.get(record.id)).toBe(record);
    expect(record.terminal).toBeUndefined();
    expect(record.published).toBeUndefined();
    expect(record.flight).toBeUndefined();
    expect({ ...record, leg: { ...record.leg } }).toEqual(before);
    expect(h.trading.getOrderFillDetails).not.toHaveBeenCalled(); // rebalance() never reconciles the SELL itself
  });

  it('a pending SELL on a different market does not block this market', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingSell();
    Object.assign(h.service, { market: { name: 'other', conditionId: 'other', yesTokenId: 'oy', noTokenId: 'on', negRisk: false } });
    const result = await h.service.rebalance(act('split', 5));
    expect(result).toMatchObject({ success: true, txHash: 'split-tx', action: { type: 'split', amount: 5 } });
    expect(h.ctf.split).toHaveBeenCalledWith('other', '5', expect.anything());
    expect(h.reads()).toBe(4); // fresh authorization + post-write refresh (2 RPCs each)
    expect(h.pendingSells.size).toBe(1);
    expect(h.writers.size).toBe(0);
  });
});

describe('P0.3H5 unresolved corrective SELL owns inventory against rebalance()', () => {
  it('pending corrective SELL + rebalance(): zero reads, zero new write', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10), { autoFixImbalance: true });
    const record = await h.openPendingCorrectiveSell();
    const result = await h.service.rebalance();
    expect(result).toEqual({ success: false, action: { type: 'none', amount: 0, reason: 'Rebalance withheld', priority: 0 },
      error: 'Rebalance withheld: SELL corrective-sell-1 pending factual reconciliation' });
    expect(h.reads()).toBe(0);
    expectNoNewWrite(h, 1);
    expect(h.pendingSells.get('corrective-sell-1')).toBe(record);
    expect(h.events).not.toHaveBeenCalled(); // corrective records never emit rebalance events; neither does the refusal
  });

  it.each([
    ['split', act('split', 5)],
    ['merge', act('merge', 5)],
  ])('pending corrective SELL + explicit %s: zero read, zero write', async (_type, action) => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10), { autoFixImbalance: true });
    await h.openPendingCorrectiveSell();
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, action, error: 'Rebalance withheld: SELL corrective-sell-1 pending factual reconciliation' });
    expect(h.reads()).toBe(0);
    expectNoNewWrite(h, 1);
  });

  it('pending corrective SELL + explicit SELL: acknowledged against the corrective operation, no new order', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10), { autoFixImbalance: true });
    await h.openPendingCorrectiveSell();
    const result = await h.service.rebalance(act('sell_yes', 5));
    expect(result).toMatchObject({ success: false, pending: true, operationId: 'corrective-sell-1' });
    expect(h.reads()).toBe(0);
    expectNoNewWrite(h, 1);
  });
});

describe('P0.3H5 terminal / publication lifecycle', () => {
  it('terminal-but-unpublished SELL still blocks; publication releases it', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    const record = await h.openPendingSell();
    h.fillSell('r1');
    // Park the flush between its terminal reconciliation and its publication (the post-success refresh).
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const flush = h.flushSells();
    await macrotask();
    expect(record.terminal).toMatchObject({ success: true, facts: { soldShares: 5 } });
    expect(record.published).toBeUndefined();
    expect(h.pendingSells.get('rebalance-sell-1')).toBe(record);
    const readsDuringFlush = h.reads();

    const withheld = await h.service.rebalance(act('split', 5));
    expect(withheld).toEqual({ success: false, action: act('split', 5), error: 'Rebalance withheld: SELL rebalance-sell-1 pending factual reconciliation' });
    expect(h.reads()).toBe(readsDuringFlush); // no read of its own
    expectNoNewWrite(h, 1);
    expect(h.events).not.toHaveBeenCalled();

    gate.resolve('100');
    await flush;
    expect(record.published).toBe(true);
    expect(h.pendingSells.size).toBe(0);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: true, operationId: 'rebalance-sell-1', facts: { soldShares: 5 } });

    const allowed = await h.service.rebalance(act('split', 5));
    expect(allowed).toMatchObject({ success: true, txHash: 'split-tx' });
    expect(h.ctf.split).toHaveBeenCalledTimes(1);
  });

  it('after a factual successful SELL is published, rebalance() regains its normal fresh-authority path', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingSell();
    expect(await h.service.rebalance()).toMatchObject({ success: false, error: /SELL rebalance-sell-1 pending/ });
    expect(h.reads()).toBe(0);

    h.fillSell('r1');
    await h.flushSells();
    expect(h.pendingSells.size).toBe(0);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.service['lastRebalanceTime']).toBeGreaterThan(0);

    h.clearReads();
    h.modes.sell = 'filled';
    const result = await h.service.rebalance();
    expect(result).toMatchObject({ success: true, action: { type: 'sell_yes', amount: 10 }, operationId: 'rebalance-sell-2', facts: { soldShares: 10 } });
    expect(h.reads()).toBe(4); // fresh authorization + post-success refresh
    expect(h.sells()).toHaveLength(2);
    expect(h.events).toHaveBeenCalledTimes(2);
    expect(h.writers.size).toBe(0);
  });

  it('after a terminal non-fill is published, rebalance() regains its normal path', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingSell();
    h.cancelSell('r1');
    await h.flushSells();
    expect(h.pendingSells.size).toBe(0);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: false, operationId: 'rebalance-sell-1', error: /never filled/, facts: { soldShares: 0 } });

    const result = await h.service.rebalance(act('split', 5));
    expect(result).toMatchObject({ success: true, txHash: 'split-tx' });
    expect(h.ctf.split).toHaveBeenCalledTimes(1);
    expect(h.reads()).toBe(4);
  });

  it('a released corrective SELL no longer blocks', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10), { autoFixImbalance: true });
    await h.openPendingCorrectiveSell();
    h.cancelSell('r1');
    await h.flushSells();
    expect(h.pendingSells.size).toBe(0);
    expect(h.events).not.toHaveBeenCalled(); // corrective terminal effects only log
    const result = await h.service.rebalance(act('merge', 5));
    expect(result).toMatchObject({ success: true, txHash: 'merge-tx' });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
  });
});

describe('P0.3H5 scheduled path', () => {
  it('checkAndRebalance() with a pending SELL: flushes, then returns before its planning read', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingSell();
    await h.check();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledWith('r1'); // existing read-only flush
    expect(h.reads()).toBe(0);
    expectNoNewWrite(h, 1);
    expect(h.pendingSells.size).toBe(1);
    expect(h.service['lastRebalanceTime']).toBe(0);
  });
});

describe('P0.3H5 neighbours unchanged', () => {
  it('H4: a pending LONG still refuses rebalance() before any read', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    const ack = await h.service.execute(longOpp);
    expect(ack).toMatchObject({ pending: true, operationId: 'long-1' });
    h.clearReads();
    const result = await h.service.rebalance(act('merge', 5));
    expect(result).toEqual({ success: false, action: act('merge', 5), error: 'Rebalance withheld: long arb long-1 pending factual reconciliation' });
    expect(h.reads()).toBe(0);
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  });

  it('H3: rebalance A paused in its fresh read → rebalance B withheld by the writer, released after A', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    h.modes.sell = 'filled';
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const a = h.service.rebalance(act('sell_yes', 5));
    expect(h.writers.size).toBe(1);
    const b = await h.service.rebalance(act('sell_yes', 5));
    expect(b).toEqual({ success: false, action: act('sell_yes', 5), error: 'Rebalance withheld: another rebalance owns this market' });
    expect(h.sells()).toHaveLength(0);
    gate.resolve('100');
    expect(await a).toMatchObject({ success: true, facts: { soldShares: 5 } });
    expect(h.sells()).toHaveLength(1);
    expect(h.writers.size).toBe(0);
  });

  it('H3: an explicit SELL above fresh inventory is still withheld without resize once no SELL is pending', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 2, 10));
    const action = act('sell_yes', 5);
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, action, error: 'Rebalance withheld: sell_yes 5 exceeds fresh YES 2' });
    expect(h.sells()).toHaveLength(0);
  });

  it('H2: a failed fresh refresh withholds execute(long) without a BUY or an attempt', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    h.ctf.getPositionBalanceByTokenIds.mockRejectedValueOnce(new Error('rpc'));
    const result = await h.service.execute(longOpp);
    expect(result).toMatchObject({ success: false, error: 'Fresh balance refresh failed; execution withheld' });
    expect(h.buys()).toHaveLength(0);
    expect(h.service.getStats().executionsAttempted).toBe(0);
  });

  it('H2/H3: a rebalance writer still refuses execute(long) before its fresh read', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    h.modes.sell = 'filled';
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const reb = h.service.rebalance(act('sell_yes', 5));
    await expect(h.service.execute(longOpp)).rejects.toThrow('Inventory write blocked by active rebalancer');
    expect(h.buys()).toHaveLength(0);
    gate.resolve('100');
    await reb;
    expect(h.sells()).toHaveLength(1);
  });
});
