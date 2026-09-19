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

const shortOpp: ArbitrageOpportunity = Object.freeze({
  type: 'short', profitRate: 0.1, profitPercent: 10,
  effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
  priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
  maxOrderbookSize: 20, maxBalanceSize: 10, recommendedSize: 5, estimatedProfit: 1, description: 'h3', timestamp: 1,
}) as ArbitrageOpportunity;
const longOpp: ArbitrageOpportunity = Object.freeze({ ...shortOpp, type: 'long' }) as ArbitrageOpportunity;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * `cached` is what the service believes; `fresh` is what the chain reports on every refresh
 * (overridable per read). Accepted SELLs fill factually so "allowed" paths are proven through a
 * real reconciliation, not a stubbed result.
 */
function fixture(cached: Inventory, fresh: Inventory) {
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: false, enableRebalancer: true, rebalanceCooldown: 0 });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const orders: Record<string, OrderRow> = {};
  const trades: Record<string, TradeStatus> = {};
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>().mockImplementation(async o => {
      // Each accepted SELL is a fully matched factual fill of the requested size; BUYs are refused.
      if (o.side === 'BUY') return rejected;
      const id = `r${Object.keys(orders).length + 1}`;
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
  const reads = () => ctf.getPusdBalance.mock.calls.length;
  const sells = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'SELL');
  const buys = () => trading.createMarketOrder.mock.calls.filter(([o]) => o.side === 'BUY');
  const writers = service['rebalancerInventoryWrites'];
  const check = () => service['checkAndRebalance']();
  return { service, market, trading, ctf, cachedBalance, events, execution, reads, sells, buys, writers, check };
}
type H = ReturnType<typeof fixture>;

function expectNoEconomicWrite(h: H) {
  expect(h.sells()).toHaveLength(0);
  expect(h.buys()).toHaveLength(0);
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

describe('P0.3H3 rebalance() fresh authority', () => {
  it('rebalance(): cached imbalance 20/10 but fresh 10/10 → action none, zero SELL', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 10, 10));
    // The cached snapshot alone would plan sell_yes 10.
    expect(h.service.calculateRebalanceAction()).toMatchObject({ type: 'sell_yes', amount: 10 });
    const result = await h.service.rebalance();
    expect(result).toEqual({ success: true, action: { type: 'none', amount: 0, reason: 'Balanced', priority: 0 } });
    expectNoEconomicWrite(h);
    expect(h.reads()).toBe(1);
    expect(h.service.getBalance()).toMatchObject({ yesTokens: 10, noTokens: 10 });
  });

  it('rebalance(): fresh refresh fails → zero SELL / SPLIT / MERGE, no action derived from the cache', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    h.ctf.getPositionBalanceByTokenIds.mockRejectedValue(new Error('RPC read failed'));
    const result = await h.service.rebalance();
    expect(result).toEqual({ success: false, action: { type: 'none', amount: 0, reason: 'Rebalance withheld', priority: 0 },
      error: 'Fresh balance refresh failed; rebalance withheld' });
    expectNoEconomicWrite(h);
    expect(h.service['balance']).toBe(h.cachedBalance);
  });

  it.each([
    ['sell_yes', inv(10, 2, 10), 'YES 2'],
    ['sell_no', inv(10, 10, 2), 'NO 2'],
  ] as const)('explicit %s 5 with fresh %o → withheld, zero order, action preserved', async (type, fresh, label) => {
    const h = fixture(inv(10, 10, 10), fresh);
    const action = act(type, 5);
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, action, error: `Rebalance withheld: ${type} 5 exceeds fresh ${label}` });
    expect(result.action).toBe(action);
    expectNoEconomicWrite(h);
  });

  it.each(['sell_yes', 'sell_no'] as const)('explicit %s equal to fresh holding → reaches the existing factual SELL path', async type => {
    const h = fixture(inv(10, 1, 1), type === 'sell_yes' ? inv(10, 5, 20) : inv(10, 20, 5));
    const result = await h.service.rebalance(act(type, 5));
    expect(result).toMatchObject({ success: true, operationId: 'rebalance-sell-1', facts: { soldShares: 5, requestedShares: 5 } });
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: type === 'sell_yes' ? 'yes' : 'no', amount: 5 });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.writers.size).toBe(0);
  });

  it('explicit split above fresh pUSD → zero split', async () => {
    const h = fixture(inv(100, 10, 10), inv(4, 10, 10));
    const action = act('split', 5);
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, action, error: 'Rebalance withheld: split 5 exceeds fresh pUSD 4' });
    expectNoEconomicWrite(h);
  });

  it('explicit split equal to fresh pUSD → allowed, existing split path unchanged', async () => {
    const h = fixture(inv(100, 10, 10), inv(5, 10, 10));
    const result = await h.service.rebalance(act('split', 5));
    expect(result).toMatchObject({ success: true, txHash: 'split-tx', action: { type: 'split', amount: 5 } });
    expect(h.ctf.split).toHaveBeenCalledTimes(1);
    expect(h.ctf.split).toHaveBeenCalledWith('condition', '5', expect.anything());
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveBeenCalledWith(result);
    expect(h.reads()).toBe(2); // fresh authorization + post-write refresh
    expect(h.writers.size).toBe(0);
  });

  it('explicit merge above fresh paired inventory → zero merge', async () => {
    const h = fixture(inv(10, 10, 10), inv(10, 10, 4));
    const action = act('merge', 5);
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: false, action, error: 'Rebalance withheld: merge 5 exceeds fresh paired tokens 4' });
    expectNoEconomicWrite(h);
  });

  it('explicit merge equal to fresh paired inventory → allowed, existing merge return path unchanged', async () => {
    const h = fixture(inv(10, 10, 10), inv(10, 5, 9));
    const result = await h.service.rebalance(act('merge', 5));
    expect(result).toMatchObject({ success: true, txHash: 'merge-tx', action: { type: 'merge', amount: 5 } });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('condition', { yesTokenId: 'yes', noTokenId: 'no' }, '5', expect.anything());
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.writers.size).toBe(0);
  });

  it('an explicit action is never resized or replaced when fresh inventory cannot support it', async () => {
    // Fresh YES 4 could support a smaller SELL and the fresh snapshot would itself plan sell_no; neither happens.
    const h = fixture(inv(10, 10, 10), inv(10, 4, 30));
    const action = act('sell_yes', 8);
    const result = await h.service.rebalance(action);
    expect(result.action).toBe(action);
    expect(action).toMatchObject({ type: 'sell_yes', amount: 8 });
    expect(result.success).toBe(false);
    expectNoEconomicWrite(h);
  });

  it('non-finite / non-positive explicit SELL amounts keep their existing failure path', async () => {
    const h = fixture(inv(10, 10, 10), inv(10, 10, 10));
    const result = await h.service.rebalance(act('sell_yes', -1));
    expect(result).toMatchObject({ success: false, error: 'Invalid SELL YES amount' });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.sells()).toHaveLength(0);
  });
});

describe('P0.3H3 rebalance() ownership', () => {
  it('execute already active (paused in its fresh read) → rebalance withheld with zero reads of its own', async () => {
    const h = fixture(inv(10, 10, 10), inv(10, 10, 10));
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const arb = h.service.execute(shortOpp);
    expect(h.reads()).toBe(1);
    const result = await h.service.rebalance(act('sell_yes', 5));
    expect(result).toEqual({ success: false, action: act('sell_yes', 5), error: 'Rebalance withheld: arbitrage execution in progress' });
    expect(h.reads()).toBe(1);
    expect(h.sells()).toHaveLength(0);
    gate.resolve('10');
    await arb;
  });

  it('unresolved short owns inventory → rebalance withheld before any read', async () => {
    const h = fixture(inv(10, 10, 10), inv(10, 10, 10));
    h.trading.createMarketOrder.mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(accepted('b'));
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'a', asset_id: 'yes', side: 'SELL', status: 'LIVE', tradeEnumerationPresent: true, tradeIds: [], sizeMatched: '0' });
    const ack = await h.service.execute(shortOpp);
    expect(ack).toMatchObject({ type: 'SHORT_SUBMISSION', status: 'SUBMITTED_PENDING' });
    h.ctf.getPusdBalance.mockClear();
    const result = await h.service.rebalance(act('merge', 5));
    expect(result).toEqual({ success: false, action: act('merge', 5), error: 'Rebalance withheld: inventory owned by short short-1' });
    expect(h.reads()).toBe(0);
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  });

  it('rebalance A paused in its fresh read → rebalance B same market withheld with zero reads / writes', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const a = h.service.rebalance(act('sell_yes', 5));
    expect(h.writers.size).toBe(1);
    const b = await h.service.rebalance(act('sell_yes', 5));
    expect(b).toEqual({ success: false, action: act('sell_yes', 5), error: 'Rebalance withheld: another rebalance owns this market' });
    expect(h.reads()).toBe(1);
    expect(h.sells()).toHaveLength(0);
    gate.resolve('10');
    expect(await a).toMatchObject({ success: true, facts: { soldShares: 5 } });
    expect(h.sells()).toHaveLength(1);
    expect(h.writers.size).toBe(0);
  });

  it.each([['LONG', longOpp], ['SHORT', shortOpp]] as const)('rebalance writer active → execute %s withheld before its fresh read', async (_label, opp) => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const reb = h.service.rebalance(act('sell_yes', 5));
    await expect(h.service.execute(opp)).rejects.toThrow('Inventory write blocked by active rebalancer');
    expect(h.reads()).toBe(1); // the rebalance's read only
    expect(h.buys()).toHaveLength(0);
    expect(h.service.getStats().executionsAttempted).toBe(0);
    gate.resolve('10');
    await reb;
    expect(h.sells()).toHaveLength(1);
  });

  it.each([['LONG', longOpp], ['SHORT', shortOpp]] as const)('execute %s active → rebalance withheld', async (_label, opp) => {
    const h = fixture(inv(10, 10, 10), inv(10, 10, 10));
    const gate = deferred<string>();
    h.ctf.getPusdBalance.mockReturnValueOnce(gate.promise);
    const arb = h.service.execute(opp);
    const result = await h.service.rebalance();
    expect(result).toMatchObject({ success: false, error: 'Rebalance withheld: arbitrage execution in progress' });
    expect(h.reads()).toBe(1);
    gate.resolve('10');
    await arb;
    expect(h.writers.size).toBe(0);
  });

  it.each([
    ['an execution claim', (h: H) => { h.service['isExecuting'] = true; }],
    ['an unresolved short', (h: H) => h.service['pendingShortArbs'].set('short-9', {
      id: 'short-9', conditionId: 'condition', consumed: false, finalized: false,
      legA: { tokenId: 'yes', submission: 'SUBMITTED', orderId: 'a' }, legB: { tokenId: 'no', submission: 'SUBMITTED', orderId: 'b' } })],
  ])('%s appearing during the fresh read → recheck withholds before any write', async (_label, arm) => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    h.service.once('balanceUpdate', () => arm(h));
    const result = await h.service.rebalance(act('sell_yes', 5));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Rebalance withheld: (arbitrage execution in progress|inventory owned by short short-9)$/);
    expect(h.reads()).toBe(1);
    expect(h.sells()).toHaveLength(0);
    expect(h.events).not.toHaveBeenCalled();
    expect(h.writers.size).toBe(0);
    h.service['isExecuting'] = false;
  });

  it('a writer on a different market does not block this market', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    h.writers.add({ conditionId: 'other', yesTokenId: 'oy', noTokenId: 'on' });
    const result = await h.service.rebalance(act('sell_yes', 5));
    expect(result).toMatchObject({ success: true, facts: { soldShares: 5 } });
    expect(h.sells()).toHaveLength(1);
    expect([...h.writers]).toEqual([{ conditionId: 'other', yesTokenId: 'oy', noTokenId: 'on' }]);
  });

  it('the writer claim is released on every exit, including an executor throw', async () => {
    const h = fixture(inv(10, 10, 10), inv(10, 10, 10));
    h.ctf.split.mockRejectedValueOnce(new Error('chain reverted'));
    const failed = await h.service.rebalance(act('split', 5));
    expect(failed).toMatchObject({ success: false, error: 'chain reverted' });
    expect(h.writers.size).toBe(0);
    h.ctf.getPositionBalanceByTokenIds.mockRejectedValueOnce(new Error('rpc'));
    await h.service.rebalance();
    expect(h.writers.size).toBe(0);
    await h.service.rebalance(act('merge', 50));
    expect(h.writers.size).toBe(0);
  });
});

describe('P0.3H3 scheduled path', () => {
  it('checkAndRebalance no longer self-blocks: the planned SELL is written under the inner claim', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    await h.check();
    expect(h.sells()).toHaveLength(1);
    expect(h.sells()[0][0]).toMatchObject({ tokenId: 'yes', amount: 10 });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0][0]).toMatchObject({ success: true, action: { type: 'sell_yes', amount: 10 } });
    expect(h.service['lastRebalanceTime']).toBeGreaterThan(0);
    expect(h.writers.size).toBe(0);
  });

  it('scheduled path performs a planning read and a separate authorization read before the write', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    const order = () => h.trading.createMarketOrder.mock.invocationCallOrder[0];
    await h.check();
    // planning read, authorization read, then the SELL, then the post-success refresh
    expect(h.reads()).toBe(3);
    const readOrders = h.ctf.getPusdBalance.mock.invocationCallOrder;
    expect(readOrders[0]).toBeLessThan(order());
    expect(readOrders[1]).toBeLessThan(order());
    expect(readOrders[2]).toBeGreaterThan(order());
  });

  it('action valid at planning but invalid at the authorization read → zero write, no resize', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    h.ctf.getPositionBalanceByTokenIds
      .mockResolvedValueOnce({ yesBalance: '20', noBalance: '10' })   // planning: sell_yes 10
      .mockResolvedValue({ yesBalance: '4', noBalance: '4' });        // authorization: YES 4 < 10
    await h.check();
    expectNoEconomicWrite(h);
    expect(h.reads()).toBe(2);
    expect(h.service.getBalance()).toMatchObject({ yesTokens: 4, noTokens: 4 });
  });

  it('two concurrent scheduled checks still submit exactly one SELL', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    await Promise.all([h.check(), h.check()]);
    expect(h.sells()).toHaveLength(1);
    expect(h.writers.size).toBe(0);
  });
});

describe('P0.3H3 regression neighbours', () => {
  it('factual rebalance SELL result and event are unchanged when fresh-authorized', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    const action = act('sell_yes', 10);
    const result = await h.service.rebalance(action);
    expect(result).toEqual({ success: true, action, operationId: 'rebalance-sell-1',
      facts: { orderId: 'r1', tokenId: 'yes', requestedShares: 10, soldShares: 10, weightedPrice: 0.55, txHashes: [HASH('11')] } });
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveBeenCalledWith(result);
    expect(h.service['pendingRebalanceSells'].size).toBe(0);
  });

  it('pending rebalance SELL duplicate protection is unchanged and acknowledged without a read', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    h.trading.getOrderFillDetails.mockImplementation(async (id: string) => ({ id, asset_id: 'yes', side: 'SELL', status: 'LIVE', tradeEnumerationPresent: true, tradeIds: [], sizeMatched: '0' }));
    const first = await h.service.rebalance(act('sell_yes', 10));
    expect(first).toMatchObject({ success: false, pending: true, operationId: 'rebalance-sell-1' });
    h.ctf.getPusdBalance.mockClear();
    const again = await h.service.rebalance(act('sell_yes', 10));
    expect(again).toMatchObject({ success: false, pending: true, operationId: 'rebalance-sell-1' });
    expect(h.reads()).toBe(0);
    expect(h.sells()).toHaveLength(1);
    expect(h.events).not.toHaveBeenCalled();
    expect(h.writers.size).toBe(0);
  });

  it('a pending ack from the SELL path during a concurrent direct rebalance is preserved once the SELL is in flight', async () => {
    const h = fixture(inv(10, 20, 10), inv(10, 20, 10));
    const gate = deferred<Reply>();
    h.trading.createMarketOrder.mockReturnValueOnce(gate.promise);
    const first = h.service.rebalance(act('sell_yes', 10));
    await macrotask();
    const second = await h.service.rebalance(act('sell_yes', 10));
    expect(second).toMatchObject({ success: false, pending: true, operationId: 'rebalance-sell-1' });
    gate.resolve(rejected);
    expect(await first).toMatchObject({ success: false });
    expect(h.sells()).toHaveLength(1);
    expect(h.writers.size).toBe(0);
  });
});
