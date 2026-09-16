import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type ShortArbSubmissionAck } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type Pending = Parameters<ArbitrageService['reconcilePendingShortArb']>[0];
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
function unchanged(h: Awaited<ReturnType<typeof pending>>) {
  const state=structuredClone(h.record),stats=h.service.getStats(),orders=h.trading.createMarketOrder.mock.calls.length;
  const emit=vi.spyOn(h.service,'emit');const refresh=h.ctf.getPusdBalance.mock.calls.length;
  return ()=>{
    expect(h.record).toEqual(state);expect(h.pending.get(h.record.id)).toBe(h.record);
    expect(h.service.getStats()).toEqual(stats);expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(orders);
    expect(h.ctf.getPusdBalance).toHaveBeenCalledTimes(refresh);
    expect(h.recovery).not.toHaveBeenCalled();expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.ctf.split).not.toHaveBeenCalled();expect(emit).not.toHaveBeenCalled();
    expect(h.service['lastRebalanceTime']).toBe(0);
  };
}
describe('P0.3e rebalancer inventory interlock',()=>{
  it.each([['ACCEPTED','REJECTED'],['ACCEPTED','ACCEPTED'],['UNCERTAIN','ACCEPTED']])('%s/%s blocks corrective orders without effects',async(a,b)=>{
    const h=await pending(a,b);const verify=unchanged(h);
    expect(h.service.getBalance()).toMatchObject({yesTokens:10,noTokens:20});
    await check(h);verify();
    if(b==='REJECTED') expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
  });
  it.each(['BALANCED_SUCCESS','IMBALANCED'])('%s waits for post-terminal inventory',async classification=>{
    const h=await pending();if(classification==='IMBALANCED') h.trades.b.size='8';
    await h.flush();expect(h.record.terminalResult?.state).toBe(classification);
    const verify=unchanged(h);await check(h);verify();
    await h.service['updateBalance']();await check(h);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(3);
  });
  it.each(['conditionId','yesTokenId','noTokenId'])('different %s does not block',async key=>{
    const h=await pending();Object.assign(h.market,{[key]:'different'});
    await check(h);expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(3);
    expect(h.record.finalized).toBe(false);
  });
  it.each(['NO_FILL','SUBMISSION_REJECTED'])('%s does not require a refresh gate',async state=>{
    const h=await pending('ACCEPTED',state==='NO_FILL'?'ACCEPTED':'REJECTED');
    for(const trade of Object.values(h.trades)) Object.assign(trade,{status:'FAILED',transactionHash:undefined});
    await h.flush();expect(h.record.terminalResult?.state).toBe(state);
    h.record.inventoryReconciled=false; // The exemption depends on facts, not this flag.
    await check(h);expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(3);
  });
  it('preserves normal rebalancing with no short',async()=>{
    const h=fixture();Object.assign(h.service,{isRunning:true,totalCapital:120});
    await check(h);expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.trading.createMarketOrder).toHaveBeenCalledWith({tokenId:'no',side:'SELL',amount:10,orderType:'FOK'});
  });
  it('rechecks after awaited balance read when a short appears',async()=>{
    const h=fixture();Object.assign(h.service,{isRunning:true,totalCapital:120});
    let release!:(value:string)=>void;
    h.ctf.getPusdBalance.mockImplementationOnce(()=>new Promise<string>(resolve=>{release=resolve;}));
    const rebalancing=check(h);
    const ack=await submit(h);const record=h.pending.get(ack.operationId)!;
    release('100');await rebalancing;
    expect(record.finalized).toBe(false);expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
  });
  it('existing automatic rebalancer timer cannot send a third order',async()=>{
    const h=fixture();await h.service.start(h.market);
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(rejected);
    await submit(h);await vi.advanceTimersByTimeAsync(10000);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.recovery).not.toHaveBeenCalled();
  });
});
