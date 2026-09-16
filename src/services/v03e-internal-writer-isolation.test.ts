import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type ShortArbSubmissionAck } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
const services: ArbitrageService[] = [];
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const rejected: Reply = { success: false, submissionState: 'REJECTED', errorMsg: 'venue rejection' };
const opportunity: ArbitrageOpportunity = {
  type: 'short', profitRate: 0.1, profitPercent: 10,
  effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
  priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
  maxOrderbookSize: 20, maxBalanceSize: 20, recommendedSize: 10,
  estimatedProfit: 1, description: 'submission test', timestamp: 1,
};

function fixture() {
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: true, enableRebalancer: true });
  services.push(service);
  const market = { name: 'original', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const trades: Record<string, TradeStatus> = {
    a: { id: 'a', status: 'MINED', size: '10', price: '0.6', transactionHash: 'tx-a' },
    b: { id: 'b', status: 'MINED', size: '10', price: '0.5', transactionHash: 'tx-b' },
  };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>()
      .mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(accepted('b')),
    getOrderFillDetails: vi.fn(async (id: string) => ({ tradeIds: [id], sizeMatched: trades[id].size! })),
    getTradeStatuses: vi.fn(async (ids: string[]) => ids.map(id => trades[id])),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue('wallet'),
    getPusdBalance: vi.fn().mockResolvedValue('100'),
    // An imbalance makes an accidental recovery call observable as an extra order.
    getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '10', noBalance: '20' }),
    mergeByTokenIds: vi.fn().mockResolvedValue({ txHash: 'merge-tx' }),
    split: vi.fn(),
  };
  const realtime = { connect: vi.fn(), disconnect: vi.fn(),
    subscribeMarkets: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) };
  Object.assign(service, { market, tradingService: trading, ctf, realtimeService: realtime,
    balance: { usdc: 100, pUsdBalance: 100, yesTokens: 40, noTokens: 20, lastUpdate: 0 } });
  const execution = vi.fn();
  service.on('execution', execution);
  // These spies observe real methods; none replaces service behavior.
  const recovery = vi.spyOn(service as unknown as {
    fixImbalanceIfNeeded: ArbitrageService['fixImbalanceIfNeeded'];
  }, 'fixImbalanceIfNeeded');
  const pending = service['pendingShortArbs'];
  const flush = () => service['flushPendingShortArbs']();
  return { service, market, trading, ctf, realtime, trades, execution, recovery, pending, flush };
}

async function submit(h: ReturnType<typeof fixture>, op = opportunity): Promise<ShortArbSubmissionAck> {
  const result = await h.service.execute(op);
  expect(result.type).toBe('SHORT_SUBMISSION');
  if (result.type !== 'SHORT_SUBMISSION') throw new Error('Expected submission acknowledgment');
  expect(Object.keys(result).sort()).toEqual(['operationId', 'status', 'type']);
  expect(result.operationId).toEqual(expect.any(String));
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

const check = (h: ReturnType<typeof fixture>) => h.service['checkAndRebalance']();
async function pending(a = 'ACCEPTED', b = 'ACCEPTED') {
  const h=fixture();
  h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(a==='ACCEPTED'?accepted('a'):{success:false,submissionState:'UNCERTAIN'})
    .mockResolvedValueOnce(b==='ACCEPTED'?accepted('b'):rejected).mockResolvedValue(accepted('rebalance'));
  Object.assign(h.service,{isRunning:true,totalCapital:120});
  const ack=await submit(h);return {...h,record:h.pending.get(ack.operationId)!};
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const long = { ...opportunity, type: 'long' as const };
async function blockedLong(h: Awaited<ReturnType<typeof pending>>) {
  const record = structuredClone(h.record), stats = h.service.getStats();
  const orders = h.trading.createMarketOrder.mock.calls.length;
  const pacing = h.service['lastExecutionTime'];
  await expect(h.service.execute(long)).rejects.toThrow('Inventory write blocked');
  expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(orders);
  expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  expect(h.recovery).not.toHaveBeenCalled();
  expect(h.execution).not.toHaveBeenCalled();
  expect(h.service.getStats()).toEqual(stats);
  expect(h.service['lastExecutionTime']).toBe(pacing);
  expect(h.record).toEqual(record);
}

describe('P0.3e internal writer isolation', () => {
  it.each([['ACCEPTED', 'ACCEPTED'], ['ACCEPTED', 'REJECTED'], ['UNCERTAIN', 'ACCEPTED']])(
    'blocks long for unresolved short %s/%s without economic effects', async (a, b) => {
      const h = await pending(a, b);
      await blockedLong(h);
      vi.setSystemTime(10000000);
      await blockedLong(h);
    });

  it.each(['BALANCED_SUCCESS', 'IMBALANCED'])('holds %s until factual inventory refresh', async state => {
    const h = await pending();
    if (state === 'IMBALANCED') h.trades.b.size = '5';
    await h.flush();
    expect(h.record.terminalResult?.state).toBe(state);
    expect(h.record.inventoryReconciled).toBe(false);
    await blockedLong(h);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '10', noBalance: '10' });
    await h.service['updateBalance']();
    expect(h.record.inventoryReconciled).toBe(true);
    expect(await h.service.execute(long)).toMatchObject({ success: true, type: 'long', profit: 1 });
  });

  it.each(['conditionId', 'yesTokenId', 'noTokenId'] as const)('allows long for different %s', async key => {
    const h = await pending();
    h.market[key] = 'other';
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '10', noBalance: '10' });
    expect(await h.service.execute(long)).toMatchObject({ success: true, profit: 1 });
    expect(h.record.finalized).toBe(false);
    expect(h.execution).toHaveBeenCalledTimes(1);
  });

  it('releases consumed IMBALANCED without consumer recovery or residual lock', async () => {
    const h = await pending();
    h.trades.b.size = '5';
    await h.flush();
    await h.service['updateBalance']();
    h.service['consumeTerminalShortArbs']();
    expect(h.pending.size).toBe(0);
    expect(h.recovery).not.toHaveBeenCalled();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '10', noBalance: '10' });
    expect(await h.service.execute(long)).toMatchObject({ success: true, profit: 1 });
  });

  it.each(['BUY', 'merge'])('existing execution lock holds short while long awaits %s', async phase => {
    const h = fixture();
    const started = deferred<void>(), finish = deferred<Reply & { txHash?: string }>();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '10', noBalance: '10' });
    if (phase === 'BUY') h.trading.createMarketOrder.mockReset()
      .mockImplementationOnce(() => { started.resolve(); return finish.promise; }).mockResolvedValue(accepted('b'));
    else h.ctf.mergeByTokenIds.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const running = h.service.execute(long);
    await started.promise;
    const orders = h.trading.createMarketOrder.mock.calls.length;
    expect(h.service['isExecuting']).toBe(true);
    expect(await h.service.execute(opportunity)).toMatchObject({ error: 'Another execution in progress' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(orders);
    expect(h.pending.size).toBe(0);
    expect(h.service.getStats().executionsAttempted).toBe(1);
    finish.resolve(phase === 'BUY' ? accepted('a') : { success: true, txHash: 'merge-tx' });
    expect(await running).toMatchObject({ success: true, profit: 1 });
    expect(h.service['isExecuting']).toBe(false);
  });

  it('holds the existing long lock through the corrective SELL', async () => {
    const h = fixture();
    const started = deferred<void>(), finish = deferred<Reply>();
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('a'))
      .mockResolvedValueOnce(rejected).mockImplementationOnce(() => {
        started.resolve(); return finish.promise;
      });
    const running = h.service.execute(long);
    await started.promise;
    expect(h.recovery).toHaveBeenCalledTimes(1);
    expect(h.trading.createMarketOrder.mock.calls[2][0].side).toBe('SELL');
    expect(await h.service.execute(opportunity)).toMatchObject({ error: 'Another execution in progress' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(3);
    expect(h.pending.size).toBe(0);
    expect(h.service.getStats().executionsAttempted).toBe(1);
    finish.resolve(accepted('recovery'));
    expect(await running).toMatchObject({ success: false, profit: 0 });
    expect(h.service['isExecuting']).toBe(false);
  });

  it.each([true, false])('holds short across actual rebalancer await and releases (success=%s)', async success => {
    const h = fixture();
    Object.assign(h.service, { isRunning: true, totalCapital: 120 });
    const started = deferred<void>(), finish = deferred<Reply>();
    h.trading.createMarketOrder.mockReset().mockImplementationOnce(() => {
      started.resolve(); return finish.promise;
    }).mockResolvedValue(accepted('a'));
    const running = check(h);
    await started.promise;
    const stats = h.service.getStats();
    await expect(h.service.execute(opportunity)).rejects.toThrow('active rebalancer');
    await check(h);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.pending.size).toBe(0);
    expect(h.service['nextShortArbId']).toBe(0);
    expect(h.service.getStats()).toEqual(stats);
    expect(h.execution).not.toHaveBeenCalled();
    finish.resolve(success ? accepted('rebalance') : rejected);
    await running;
    expect(h.service['rebalancerInventoryWrites'].size).toBe(0);
    await submit(h);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(3);
  });

  it.each(['conditionId', 'yesTokenId', 'noTokenId'] as const)('active rebalancer permits short of different %s', async key => {
    const h = fixture();
    Object.assign(h.service, { isRunning: true, totalCapital: 120 });
    const started = deferred<void>(), finish = deferred<Reply>();
    h.trading.createMarketOrder.mockReset().mockImplementationOnce(() => {
      started.resolve(); return finish.promise;
    }).mockResolvedValue(accepted('a'));
    const running = check(h);
    await started.promise;
    h.market[key] = 'other';
    await submit(h);
    expect(h.pending.size).toBe(1);
    finish.resolve(accepted('rebalance'));
    await running;
    expect(h.service['rebalancerInventoryWrites'].size).toBe(0);
  });
});
