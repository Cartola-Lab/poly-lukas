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
async function terminal(a = 'SUCCESS', b = 'SUCCESS', sizeB = '10') {
  const h = fixture();
  if (b === 'REJECTED') h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(rejected);
  for (const [id, state] of [['a', a], ['b', b]]) {
    if (state !== 'SUCCESS') Object.assign(h.trades[id], { status: state, transactionHash: undefined });
  }
  h.trades.b.size = sizeB;
  const ack = await submit(h);
  const record = h.pending.get(ack.operationId)!;
  await h.flush();
  return { ...h, record };
}

describe('P0.3e-3c factual terminal consumption', () => {
  it.each([
    ['SUCCESS', 'SUCCESS', '10', 'BALANCED_SUCCESS'],
    ['SUCCESS', 'SUCCESS', '8', 'IMBALANCED'],
    ['SUCCESS', 'FAILED', '10', 'IMBALANCED'],
    ['FAILED', 'SUCCESS', '10', 'IMBALANCED'],
    ['SUCCESS', 'REJECTED', '10', 'IMBALANCED'],
    ['FAILED', 'FAILED', '10', 'NO_FILL'],
    ['FAILED', 'REJECTED', '10', 'SUBMISSION_REJECTED'],
  ])('%s/%s size %s consumes %s once with only permitted counters', async (a,b,size,classification) => {
    const h = await terminal(a,b,size);
    if (a === 'SUCCESS' || b === 'SUCCESS') await h.service['updateBalance']();
    Object.assign(h.service['stats'], { totalProfit: 17, executionsSucceeded: 3, executionsAttempted: 7 });
    h.service['lastExecutionTime'] = 123;
    const before = h.service.getStats();
    const event = vi.fn(); h.service.on('shortArbSettled', event);
    consume(h); consume(h); await h.flush(); consume(h);
    expect(h.record.consumed).toBe(true); expect(h.pending.size).toBe(0);
    expect(event).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()).toEqual({ ...before,
      executionsSucceeded: 3 + Number(classification === 'BALANCED_SUCCESS'),
      shortArbTerminals: { ...before.shortArbTerminals, [classification]: 1 } });
    expect(h.service['lastExecutionTime']).toBe(123);
    expect(h.execution).not.toHaveBeenCalled(); expect(h.recovery).not.toHaveBeenCalled();
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled(); expect(h.ctf.split).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    const payload = event.mock.calls[0][0];
    expect(payload.classification).toBe(classification);
    expect(Object.keys(payload).sort()).toEqual(['classification','conditionId','inventoryReconciled','legA','legB','operationId']);
    expect(JSON.stringify(payload)).not.toMatch(/profit|realizedPnL|grossRevenue|edgeVsMerge/);
    if (b === 'REJECTED') expect(payload.legB).toEqual({ tokenId: 'no', submission: 'REJECTED', state: 'REJECTED' });
    if (a === 'FAILED') expect(payload.legA).toEqual({ tokenId:'yes', orderId:'a', submission:'SUBMITTED', state:'TERMINAL_FAILED' });
  });

  it.each(['10', '8'])('retains successful terminal size %s until inventory is reconciled', async size => {
    const h = await terminal('SUCCESS','SUCCESS',size); const before = h.service.getStats();
    const event=vi.fn(); h.service.on('shortArbSettled',event);
    consume(h); expect(h.record.consumed).toBe(false); expect(h.pending.get(h.record.id)).toBe(h.record);
    expect(h.service.getStats()).toEqual(before); expect(event).not.toHaveBeenCalled();
    await h.service['updateBalance'](); consume(h); expect(event).toHaveBeenCalledTimes(1);
  });

  it.each(['UNCERTAIN','NOT_SUBMITTED','PENDING'])('does not consume %s', async state => {
    const h=fixture(); const ack=await submit(h); const record=h.pending.get(ack.operationId)!;
    if(state==='PENDING') record.legA.settlement={state:'PENDING'};
    else record.legA.submission=state as 'UNCERTAIN'|'NOT_SUBMITTED';
    consume(h); expect(record.consumed).toBe(false); expect(h.pending.size).toBe(1);
  });

  it('claims before reentry, and defers records inserted by listener to the next pass', async () => {
    const h=await terminal('FAILED','FAILED');
    const other: Pending={...h.record,id:'next',consumed:false};
    let claimed = false;
    const event=vi.fn(() => { claimed = h.record.consumed; h.pending.set('next',other); consume(h); });
    h.service.once('shortArbSettled',event);
    consume(h); expect(claimed).toBe(true); expect(event).toHaveBeenCalledTimes(1); expect(other.consumed).toBe(false);
    consume(h); expect(other.consumed).toBe(true); expect(h.service.getStats().shortArbTerminals.NO_FILL).toBe(2);
  });

  it('throwing listener and diagnostic cannot duplicate or block another operation', async () => {
    const h=await terminal('FAILED','FAILED'); const other:Pending={...h.record,id:'other',consumed:false};
    h.pending.set(other.id,other);
    const event=vi.fn(()=>{throw Error('listener');}); h.service.on('shortArbSettled',event);
    const later=vi.fn(); h.service.on('shortArbSettled',later);
    vi.spyOn(h.service as any,'log').mockImplementation(()=>{throw Error('log');});
    consume(h); consume(h);
    expect(event).toHaveBeenCalledTimes(2); expect(later).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0); expect(h.record.consumed).toBe(true); expect(other.consumed).toBe(true);
    expect(h.service.getStats().shortArbTerminals.NO_FILL).toBe(2);
  });

  it('removes without listeners and returns independent terminal stats', async () => {
    const h=await terminal('FAILED','FAILED'); consume(h); expect(h.pending.size).toBe(0);
    const stats=h.service.getStats(); stats.shortArbTerminals.NO_FILL=900;
    expect(h.service.getStats().shortArbTerminals.NO_FILL).toBe(1);
  });

  it('publishes deeply frozen independent facts with exact string units', async () => {
    const h=await terminal(); await h.service['updateBalance']();
    const fact=h.record.terminalResult!.legA;
    const event=vi.fn(); h.service.on('shortArbSettled',event);
    consume(h);
    const payload=event.mock.calls[0][0];
    expect(Object.isFrozen(payload)).toBe(true); expect(Object.isFrozen(payload.legA)).toBe(true);
    expect(payload.legA.successUnits).toBe('1000'); expect(payload.legA.txHashes).not.toBe((fact as any).txHashes);
    expect(Object.isFrozen(payload.legA.txHashes)).toBe(true);
    expect(()=>{payload.legA.txHashes.push('bad');}).toThrow();
    expect(()=>{payload.legA.weightedPrice=9;}).toThrow();
    consume(h); expect(fact).toMatchObject({weightedPrice:0.6,txHashes:['tx-a']});
  });

  it.each(['classification','units','price','hashes','missing','submission','id'])('retains inconsistent %s and continues valid records', async kind => {
    const h=await terminal(); await h.service['updateBalance']();
    const other:Pending={...h.record,id:'valid',consumed:false};
    // Independent terminal facts for the unaffected operation.
    other.legA={...h.record.legA,settlement:{...h.record.legA.settlement!}};
    other.terminalResult={...h.record.terminalResult!,legA:other.legA.settlement as any};
    h.pending.set(other.id,other);
    if(kind==='classification') h.record.terminalResult!.state='NO_FILL';
    if(kind==='units') (h.record.terminalResult!.legA as any).successUnits=0n;
    if(kind==='price') (h.record.terminalResult!.legA as any).weightedPrice=NaN;
    if(kind==='hashes') (h.record.terminalResult!.legA as any).txHashes=[];
    if(kind==='missing') h.record.terminalResult=undefined;
    if(kind==='submission') h.record.legA.submission='UNCERTAIN';
    if(kind==='id') h.record.id='wrong';
    consume(h); expect(h.record.consumed).toBe(false); expect(h.pending.size).toBe(1);
    expect(other.consumed).toBe(true); expect(h.service.getStats().shortArbTerminals.BALANCED_SUCCESS).toBe(1);
  });

  it.each(['SUCCESS','FAILED'])('30s failed refresh with %s then valid refresh consumes safely', async state => {
    const h=fixture(); await h.service.start(h.market);
    if(state==='FAILED') for(const t of Object.values(h.trades)) Object.assign(t,{status:'FAILED',transactionHash:undefined});
    const ack=await submit(h); const record=h.pending.get(ack.operationId)!;
    h.ctf.getPusdBalance.mockRejectedValueOnce(Error('refresh'));
    const event=vi.fn(); h.service.on('shortArbSettled',event);
    await vi.advanceTimersByTimeAsync(30000);
    expect(record.consumed).toBe(state==='FAILED');
    expect(h.pending.size).toBe(state==='FAILED'?0:1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(record.consumed).toBe(true); expect(event).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1); expect(h.recovery).not.toHaveBeenCalled();
  });

  it('flush alone leaves eligible NO_FILL unconsumed', async()=>{
    const h=await terminal('FAILED','FAILED'); expect(h.record.finalized).toBe(true);
    expect(h.record.consumed).toBe(false); expect(h.service.getStats().shortArbTerminals.NO_FILL).toBe(0);
  });

  it('early A rejection remains ack only',async()=>{
    const h=fixture(); h.trading.createMarketOrder.mockReset().mockResolvedValue(rejected);
    const event=vi.fn();h.service.on('shortArbSettled',event);
    expect((await submit(h)).status).toBe('SUBMISSION_REJECTED'); await h.flush();consume(h);
    expect(h.pending.size).toBe(0);expect(event).not.toHaveBeenCalled();expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('listener mutation fails without changing internal facts or retaining the record', async()=>{
    const h=await terminal(); await h.service['updateBalance']();
    const fact=h.record.terminalResult!.legA;
    const event=vi.fn(payload=>{payload.legA.txHashes.push('injected');});
    h.service.on('shortArbSettled',event); consume(h);
    expect(event).toHaveBeenCalledTimes(1);expect(fact).toMatchObject({txHashes:['tx-a']});
    expect(h.pending.size).toBe(0);expect(h.record.consumed).toBe(true);
  });

});
