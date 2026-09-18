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
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: true });
  services.push(service);
  const market = { name: 'original', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const trades: Record<string, TradeStatus> = {
    a: { id: 'a', status: 'MINED', size: '10', price: '0.6', transactionHash: '0x' + '11'.repeat(32) },
    b: { id: 'b', status: 'MINED', size: '10', price: '0.5', transactionHash: '0x' + '22'.repeat(32) },
  };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>()
      .mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(accepted('b')),
    getOrderFillDetails: vi.fn(async (id: string) => ({ id, asset_id: ({a:'yes',b:'no',c:'x',d:'y'} as Record<string,string>)[id], side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: [id], sizeMatched: trades[id].size! })),
    getTradeStatuses: vi.fn(async (ids: string[]) => ids.map(id => ({ asset_id: ({a:'yes',b:'no',c:'x',d:'y'} as Record<string,string>)[id], side: 'SELL' as const, taker_order_id:id, trader_side:'TAKER' as const, maker_orders:[], ...trades[id] }))),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue('wallet'),
    getPusdBalance: vi.fn().mockResolvedValue('100'),
    // An imbalance makes an accidental recovery call observable as an extra order.
    getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '40', noBalance: '20' }),
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

const consume = (h: ReturnType<typeof fixture>) => h.service['consumeTerminalShortArbs']();
describe('P0.3k.1 Short SELL factual authority', () => {
  it.each([
    {status:'FAILED',transactionHash:'not-a-hash',asset_id:'wrong',taker_order_id:'wrong'},
    {status:'FAILED'}, {status:'UNKNOWN'}, {status:undefined}, {transactionHash:'not-a-hash'},
    {asset_id:'wrong'}, {side:'BUY'}, {taker_order_id:'wrong'}, {trader_side:'MAKER'},
    {maker_orders:undefined}, {price:'1.1'},
  ])('invalid %j never finalizes or emits, and can be observed again', async patch => {
    const h=fixture();const ack=await submit(h);const event=vi.fn();h.service.on('shortArbSettled',event);
    Object.assign(h.trades.a,patch);await h.flush();consume(h);await h.flush();consume(h);
    const record=h.pending.get(ack.operationId)!;
    expect(record.finalized).not.toBe(true);expect(record.legA.settlement?.state ?? 'PENDING').toBe('PENDING');
    expect(record.legA.facts?.size??0).toBe(0);expect(event).not.toHaveBeenCalled();
    expect(h.service.getStats().shortArbTerminals.BALANCED_SUCCESS).toBe(0);
  });
  it('real submission preserves expected token/shares, taker facts settle exactly once under concurrency',async()=>{
    const h=fixture();const event=vi.fn();h.service.on('shortArbSettled',event);const ack=await submit(h);
    const record=h.pending.get(ack.operationId)!;expect(record.legA.requestedShares).toBe(10);
    expect(event).not.toHaveBeenCalled();await Promise.all([h.flush(),h.flush()]);
    await h.service['updateBalance']();consume(h);consume(h);await h.flush();
    expect(event).toHaveBeenCalledTimes(1);expect(event.mock.calls[0][0].legA).toMatchObject({successShares:10,weightedPrice:.6});
    expect(h.service.getStats().shortArbTerminals.BALANCED_SUCCESS).toBe(1);
    expect(h.pending.size).toBe(0);expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
  });
  it('maker partial counts only local allocation then later local fills complete weighted facts',async()=>{
    const h=fixture();const ack=await submit(h);const record=h.pending.get(ack.operationId)!;
    const details=h.trading.getOrderFillDetails.getMockImplementation()!;
    let full=false;
    h.trading.getOrderFillDetails.mockImplementation(async id=>id==='a'?{...(await details(id)),tradeIds:full?['a','c','d']:['a'],sizeMatched:full?'10':'4'}:details(id));
    Object.assign(h.trades.a,{trader_side:'MAKER',taker_order_id:'other',side:'BUY',size:'20',price:'0.9',maker_orders:[
      {order_id:'a',asset_id:'yes',side:'SELL',matched_amount:'4',price:'0.4'},
      {order_id:'other-maker',asset_id:'yes',side:'SELL',matched_amount:'16',price:'0.9'}]});
    const read=h.trading.getTradeStatuses.getMockImplementation()!;
    h.trading.getTradeStatuses.mockImplementation(async ids=>ids[0]==='a'&&full?[...(await read(['a'])),
      ...['c','d'].map((id,i)=>({id,asset_id:'yes',side:'SELL' as const,taker_order_id:'a',trader_side:'TAKER' as const,maker_orders:[],
        size:'3',price:i?'0.6':'0.5',status:'CONFIRMED',transactionHash:'0x'+'11'.repeat(32)}))]:read(ids));
    await h.flush();consume(h);expect(record.finalized).not.toBe(true);expect(record.legA.facts?.size).toBe(1);
    await h.flush();expect(record.legA.facts?.size).toBe(1);full=true;await h.flush();
    expect(record.terminalResult?.legA).toMatchObject({successShares:10,successUnits:1000n});
    const fact=record.terminalResult!.legA;if(fact.state!=='TERMINAL_SUCCESS')throw Error('not success');expect(fact.weightedPrice).toBeCloseTo(.49);
    expect(fact.txHashes).toHaveLength(1);
  });
  it.each(['quantity','price','token','order','side'])('conflicting prior %s stays pending without rewriting retained fact',async kind=>{
    const h=fixture();const ack=await submit(h);h.trades.a.size='4';await h.flush();
    const record=h.pending.get(ack.operationId)!;const prior=record.legA.facts!.get('a');
    Object.assign(h.trades.a,kind==='quantity'?{size:'10'}:kind==='price'?{price:'0.9'}:kind==='token'?{asset_id:'wrong'}:kind==='order'?{taker_order_id:'other'}:{side:'BUY'});
    await h.flush();consume(h);expect(record.finalized).not.toBe(true);expect(record.legA.facts!.get('a')).toBe(prior);
  });
  it('lookup failure and missing enumeration retain pending until factual recovery',async()=>{
    const h=fixture();const ack=await submit(h);h.trading.getOrderFillDetails.mockRejectedValueOnce(Error('RPC'));await h.flush();
    expect(h.pending.get(ack.operationId)?.finalized).not.toBe(true);
    const read=h.trading.getOrderFillDetails.getMockImplementation()!;
    h.trading.getOrderFillDetails.mockImplementationOnce(async id=>({...await read(id),tradeEnumerationPresent:false}));await h.flush();
    expect(h.pending.get(ack.operationId)?.finalized).not.toBe(true);await h.flush();expect(h.pending.get(ack.operationId)?.finalized).toBe(true);
  });
  it('listener exception cannot replay counters or terminal notification',async()=>{
    const h=fixture();await submit(h);const event=vi.fn(()=>{throw Error('observer')});h.service.on('shortArbSettled',event);
    await h.flush();await h.service['updateBalance']();consume(h);consume(h);await h.flush();consume(h);
    expect(event).toHaveBeenCalledTimes(1);expect(h.service.getStats().shortArbTerminals.BALANCED_SUCCESS).toBe(1);expect(h.pending.size).toBe(0);
  });
});
