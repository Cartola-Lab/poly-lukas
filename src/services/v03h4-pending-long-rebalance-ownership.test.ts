import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type RebalanceAction, type RebalanceResult } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
const services: ArbitrageService[] = [];
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const HASH = (n: string) => '0x' + n.repeat(32);
const MERGE_TX = HASH('ab');

type Inventory = { pusd: number; yes: number; no: number };
const inv = (pusd: number, yes: number, no: number): Inventory => ({ pusd, yes, no });
const act = (type: RebalanceAction['type'], amount: number): RebalanceAction => Object.freeze({ type, amount, reason: 'explicit', priority: 1 }) as RebalanceAction;

/** 0.40 + 0.50 on 5 pairs: a valid long that spends 4.5 pUSD. */
const longOpp: ArbitrageOpportunity = Object.freeze({
  type: 'long', profitRate: 0.1, profitPercent: 10,
  effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
  priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
  maxOrderbookSize: 20, maxBalanceSize: 10, recommendedSize: 5, estimatedProfit: 0.5, description: 'h4', timestamp: 1,
}) as ArbitrageOpportunity;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

/**
 * Every refresh reports `fresh`. Accepted BUYs are ACCEPTED at the venue but expose no fills until
 * `fillLongLegs()` is called, so `execute(long)` leaves a genuinely reachable PendingLongArb behind.
 * Accepted SELLs fill factually so allowed rebalance paths are proven through real reconciliation.
 */
function fixture(cached: Inventory, fresh: Inventory) {
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: false, enableRebalancer: true, rebalanceCooldown: 0 });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const orders: Record<string, OrderRow> = {};
  const trades: Record<string, TradeStatus> = {};
  let buyCount = 0, sellCount = 0;
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>().mockImplementation(async o => {
      if (o.side === 'BUY') {
        const id = `l${++buyCount}`;
        orders[id] = { id, asset_id: o.tokenId, side: 'BUY', status: 'LIVE', tradeEnumerationPresent: true, tradeIds: [], sizeMatched: '0' };
        return accepted(id);
      }
      const id = `r${++sellCount}`;
      orders[id] = { id, asset_id: o.tokenId, side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: [`t-${id}`], sizeMatched: String(o.amount) };
      trades[`t-${id}`] = { id: `t-${id}`, status: 'MINED', size: String(o.amount), price: '0.55', transactionHash: HASH('11'),
        asset_id: o.tokenId, side: 'SELL', taker_order_id: id, trader_side: 'TAKER', maker_orders: [] } as unknown as TradeStatus;
      return accepted(id);
    }),
    getOrderFillDetails: vi.fn(async (id: string) => ({ ...orders[id], tradeIds: [...orders[id].tradeIds] })),
    getTradeStatuses: vi.fn(async (ids: string[]) => ids.map(id => trades[id])),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue('wallet'),
    getPusdBalance: vi.fn(async () => String(fresh.pusd)),
    getPositionBalanceByTokenIds: vi.fn(async () => ({ yesBalance: String(fresh.yes), noBalance: String(fresh.no) })),
    mergeByTokenIds: vi.fn(async (_c: string, _t: unknown, amount: string) =>
      ({ success: true, txHash: MERGE_TX, amount, usdcReceived: amount, provenance: { state: 'CONFIRMED', transactionHash: MERGE_TX } })),
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
  const reads = () => ctf.getPusdBalance.mock.calls.length;
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  const buys = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'BUY');
  const pendingLongs = service['pendingLongArbs'];
  const writers = service['rebalancerInventoryWrites'];
  const check = () => service['checkAndRebalance']();
  const flushLongs = () => service['flushPendingLongArbs']();
  /** Both BUY legs become factual MINED fills of the requested size at the quoted prices. */
  const fillLongLegs = () => {
    for (const id of Object.keys(orders)) {
      const row = orders[id];
      if (row.side !== 'BUY') continue;
      const price = row.asset_id === 'yes' ? '0.4' : '0.5';
      const size = String(longOpp.recommendedSize);
      Object.assign(row, { status: 'MATCHED', tradeIds: [`t-${id}`], sizeMatched: size });
      trades[`t-${id}`] = { id: `t-${id}`, status: 'MINED', size, price, transactionHash: HASH(row.asset_id === 'yes' ? '33' : '44'),
        asset_id: row.asset_id, side: 'BUY', taker_order_id: id, trader_side: 'TAKER', maker_orders: [] } as unknown as TradeStatus;
    }
  };
  /** Both BUY legs end as canceled FOKs with zero matched volume: a terminal non-fill. */
  const cancelLongLegs = () => {
    for (const row of Object.values(orders)) {
      if (row.side === 'BUY') Object.assign(row, { status: 'CANCELED', tradeIds: [], sizeMatched: '0' });
    }
  };
  /** Reachable production state: execute(long) submitted both BUYs and returned pending. */
  const openPendingLong = async () => {
    const ack = await service.execute(longOpp);
    expect(ack).toMatchObject({ pending: true, operationId: 'long-1', success: false });
    expect(buys()).toHaveLength(2);
    expect(pendingLongs.size).toBe(1);
    expect(service['isExecuting']).toBe(false);
    ctf.getPusdBalance.mockClear();
    return pendingLongs.get('long-1')!;
  };
  return { service, market, trading, ctf, cachedBalance, events, execution, reads, sells, buys, pendingLongs, writers, check, flushLongs, fillLongLegs, cancelLongLegs, openPendingLong };
}
type H = ReturnType<typeof fixture>;

function expectNoRebalanceWrite(h: H) {
  expect(h.sells()).toHaveLength(0);
  expect(h.ctf.split).not.toHaveBeenCalled();
  expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  expect(h.service['pendingRebalanceSells'].size).toBe(0);
  expect(h.events).not.toHaveBeenCalled();
  expect(h.writers.size).toBe(0);
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3H4 unresolved long owns inventory against rebalance()', () => {
  it('pending LONG + rebalance(): zero balance reads, zero SELL / SPLIT / MERGE, success:false', async () => {
    // Cached and fresh both plan sell_yes 10; the pending long must refuse before either is consulted.
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    const op = await h.openPendingLong();
    expect(h.service.calculateRebalanceAction()).toMatchObject({ type: 'sell_yes', amount: 10 });
    const result = await h.service.rebalance();
    expect(result).toEqual({ success: false, action: { type: 'none', amount: 0, reason: 'Rebalance withheld', priority: 0 },
      error: 'Rebalance withheld: long arb long-1 pending factual reconciliation' });
    expect(h.reads()).toBe(0);
    expectNoRebalanceWrite(h);
    expect(h.pendingLongs.get('long-1')).toBe(op);
    expect(op.published).toBeUndefined();
  });

  it.each([
    ['sell_yes', act('sell_yes', 5)],
    ['sell_no', act('sell_no', 5)],
    ['split', act('split', 5)],
    ['merge', act('merge', 5)],
  ])('pending LONG + explicit %s: zero balance read, zero economic write, action preserved', async (_type, action) => {
    // Fresh inventory would authorize every one of these amounts; the long's ownership still wins.
    const h = fixture(inv(100, 20, 20), inv(100, 20, 20));
    await h.openPendingLong();
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, action, error: 'Rebalance withheld: long arb long-1 pending factual reconciliation' });
    expect(result.action).toBe(action);
    expect(result.pending).toBeUndefined();
    expect(result.txHash).toBeUndefined();
    expect(result.facts).toBeUndefined();
    expect(h.reads()).toBe(0);
    expectNoRebalanceWrite(h);
  });

  it('the refusal names the exact unresolved long operation', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    const op = await h.openPendingLong();
    const result = await h.service.rebalance(act('merge', 5));
    expect(result.error).toBe(`Rebalance withheld: long arb ${op.id} pending factual reconciliation`);
    expect(op.id).toBe('long-1');
  });

  it('a pending LONG on a different market does not block this market', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingLong();
    // The unresolved long belongs to `condition`; the service now trades another market.
    Object.assign(h.service, { market: { name: 'other', conditionId: 'other', yesTokenId: 'oy', noTokenId: 'on', negRisk: false } });
    const result = await h.service.rebalance(act('sell_yes', 5));
    expect(result).toMatchObject({ success: true, facts: { soldShares: 5 } });
    expect(h.reads()).toBe(2); // fresh authorization + post-success refresh
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: 'oy', side: 'SELL', amount: 5 });
    expect(h.pendingLongs.size).toBe(1);
  });

  it('rebalance() is available again only after the existing long reconciliation releases the operation', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingLong();
    // Fills are now known, but until reconciliation runs the long still owns the inventory.
    h.fillLongLegs();
    expect(await h.service.rebalance()).toMatchObject({ success: false, error: /long arb long-1 pending/ });
    expect(h.reads()).toBe(0);

    await h.flushLongs();
    expect(h.pendingLongs.size).toBe(0);
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution.mock.calls[0][0]).toMatchObject({ success: true, type: 'long', operationId: 'long-1', txHashes: [MERGE_TX] });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1); // the long's own merge, not a rebalance

    h.ctf.getPusdBalance.mockClear();
    const result = await h.service.rebalance();
    expect(result).toMatchObject({ success: true, action: { type: 'sell_yes', amount: 10 }, facts: { soldShares: 10 } });
    expect(h.reads()).toBe(2); // fresh authorization + post-success refresh
    expect(h.sells()).toHaveLength(1);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.writers.size).toBe(0);
  });

  it('a long that fails terminally releases ownership too, and rebalance proceeds', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingLong();
    h.cancelLongLegs();
    await h.flushLongs();
    expect(h.pendingLongs.size).toBe(0);
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution.mock.calls[0][0]).toMatchObject({ success: false, operationId: 'long-1', error: /No paired factual fills/ });
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    const result = await h.service.rebalance();
    expect(result).toMatchObject({ success: true, action: { type: 'sell_yes', amount: 10 }, facts: { soldShares: 10 } });
    expect(h.sells()).toHaveLength(1);
  });
});

describe('P0.3H4 scheduled path', () => {
  it('checkAndRebalance() with a pending LONG: planning read may happen, zero economic write', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingLong();
    await h.check();
    expect(h.reads()).toBe(1); // planning read only; the inner rebalance refused before its own read
    expectNoRebalanceWrite(h);
    expect(h.pendingLongs.size).toBe(1);
    // Existing pacing semantics: the scheduler consumed its attempt; not part of this patch.
    expect(h.service['lastRebalanceTime']).toBeGreaterThan(0);
  });

  it('checkAndRebalance() writes normally once the long is released', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingLong();
    h.fillLongLegs();
    await h.flushLongs();
    expect(h.pendingLongs.size).toBe(0);
    h.ctf.getPusdBalance.mockClear();
    await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: 'yes', amount: 10 });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: true, action: { type: 'sell_yes', amount: 10 } });
  });
});

describe('P0.3H4 neighbours unchanged', () => {
  it('H3 writer semantics: rebalance A paused in its fresh read → rebalance B withheld, writer released after A', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const a = h.service.rebalance(act('sell_yes', 5));
    expect(h.writers.size).toBe(1);
    const b = await h.service.rebalance(act('sell_yes', 5));
    expect(b).toEqual({ success: false, action: act('sell_yes', 5), error: 'Rebalance withheld: another rebalance owns this market' });
    expect(h.reads()).toBe(1);
    gate.resolve('100');
    expect(await a).toMatchObject({ success: true, facts: { soldShares: 5 } });
    expect(h.sells()).toHaveLength(1);
    expect(h.writers.size).toBe(0);
  });

  it('H3 admission precedence: an execution claim is still reported ahead of a pending long', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingLong();
    h.service['isExecuting'] = true;
    try {
      const result = await h.service.rebalance(act('sell_yes', 5));
      expect(result.error).toBe('Rebalance withheld: arbitrage execution in progress');
      expect(h.reads()).toBe(0);
    } finally {
      h.service['isExecuting'] = false;
    }
  });

  it('H2 execute semantics: a failed fresh refresh withholds execute(long) without a BUY or an attempt', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    h.ctf.getPositionBalanceByTokenIds.mockRejectedValueOnce(new Error('rpc'));
    const result = await h.service.execute(longOpp);
    expect(result).toMatchObject({ success: false, error: 'Fresh balance refresh failed; execution withheld' });
    expect(h.buys()).toHaveLength(0);
    expect(h.service.getStats().executionsAttempted).toBe(0);
    expect(h.pendingLongs.size).toBe(0);
  });

  it('H2 execute semantics: execute(long) while its own long is pending is acknowledged without a read or BUY', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    await h.openPendingLong();
    const again = await h.service.execute(longOpp);
    expect(again).toMatchObject({ success: false, pending: true, operationId: 'long-1' });
    expect(h.reads()).toBe(0);
    expect(h.buys()).toHaveLength(2);
    expect(h.service.getStats().executionsAttempted).toBe(1);
  });

  it('H2/H3 exclusion: rebalance writer active → execute(long) refused before its fresh read', async () => {
    const h = fixture(inv(100, 20, 10), inv(100, 20, 10));
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const reb = h.service.rebalance(act('sell_yes', 5));
    await expect(h.service.execute(longOpp)).rejects.toThrow('Inventory write blocked by active rebalancer');
    expect(h.reads()).toBe(1);
    expect(h.buys()).toHaveLength(0);
    expect(h.pendingLongs.size).toBe(0);
    gate.resolve('100');
    await reb;
    expect(h.sells()).toHaveLength(1);
  });
});
