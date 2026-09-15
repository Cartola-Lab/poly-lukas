import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type ShortArbSubmissionAck } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type Pending = Parameters<ArbitrageService['reconcilePendingShortArb']>[0];
const services: ArbitrageService[] = [];
const accepted = (orderId: string): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId });
const rejected: Reply = { success: false, submissionState: 'REJECTED', errorMsg: 'venue rejection' };
const uncertain: Reply = { success: false, submissionState: 'UNCERTAIN' };
const opportunity: ArbitrageOpportunity = {
  type: 'short', profitRate: 0.1, profitPercent: 10,
  effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
  priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
  maxOrderbookSize: 20, maxBalanceSize: 20, recommendedSize: 10,
  estimatedProfit: 1, description: 'submission test', timestamp: 1,
};

function deferred() {
  let resolve!: (reply: Reply) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Reply>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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

function noEconomy(h: ReturnType<typeof fixture>, attempts = 1, timestamp = h.pending.size ? 100000 : 0, refreshes = attempts, settledSuccesses = 0) {
  expect(h.service.getStats()).toMatchObject({ executionsAttempted: attempts, executionsSucceeded: settledSuccesses, totalProfit: 0 });
  expect(h.execution).not.toHaveBeenCalled();
  expect(h.recovery).not.toHaveBeenCalled();
  expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  expect(h.ctf.split).not.toHaveBeenCalled();
  expect(h.service['lastExecutionTime']).toBe(timestamp);
  expect(h.service['isExecuting']).toBe(false);
  expect(h.ctf.getPusdBalance).toHaveBeenCalledTimes(refreshes);
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

describe('P0.3e-3b real short submission lifecycle', () => {
  it('registers NOT_SUBMITTED legs before A starts, then marks A UNCERTAIN before awaiting', async () => {
    const h = fixture();
    const a = deferred();
    h.trading.createMarketOrder.mockReset().mockReturnValueOnce(a.promise);
    const set = h.pending.set.bind(h.pending);
    let captured!: Pending;
    vi.spyOn(h.pending, 'set').mockImplementation((id, record) => {
      captured = record;
      expect(record).toMatchObject({ id, conditionId: 'condition',
        legA: { tokenId: 'yes', submission: 'NOT_SUBMITTED' },
        legB: { tokenId: 'no', submission: 'NOT_SUBMITTED' } });
      expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
      return set(id, record);
    });
    const result = submit(h);
    expect(h.pending.get(captured.id)).toBe(captured);
    expect(captured.legA.submission).toBe('UNCERTAIN');
    expect(captured.legB.submission).toBe('NOT_SUBMITTED');
    expect(h.service['isExecuting']).toBe(true);
    a.resolve(rejected);
    expect((await result).status).toBe('SUBMISSION_REJECTED');
    expect(h.pending.size).toBe(0);
    expect(captured.legA.submission).toBe('REJECTED');
    expect(captured.legB.submission).toBe('NOT_SUBMITTED');
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    noEconomy(h);
  });

  it('stores accepted A before calling B and keeps B UNCERTAIN while deferred', async () => {
    const h = fixture();
    const a = deferred(); const b = deferred();
    h.trading.createMarketOrder.mockReset().mockReturnValueOnce(a.promise).mockImplementationOnce(async () => {
      expect([...h.pending.values()][0].legA).toMatchObject({ submission: 'SUBMITTED', orderId: 'a' });
      expect([...h.pending.values()][0].legB.submission).toBe('UNCERTAIN');
      return b.promise;
    });
    const result = submit(h);
    const record = [...h.pending.values()][0];
    a.resolve(accepted(' a '));
    await Promise.resolve();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(record.finalized).toBe(false);
    await h.flush();
    expect(record.terminalResult).toBeUndefined();
    b.resolve(accepted('b'));
    expect((await result).status).toBe('SUBMITTED_PENDING');
    expect(record.legB).toMatchObject({ submission: 'SUBMITTED', orderId: 'b' });
    noEconomy(h);
  });

  it.each(['A', 'B'] as const)('%s uncertainty preserves the operation without recovery', async leg => {
    const h = fixture();
    h.trading.createMarketOrder.mockReset();
    if (leg === 'B') h.trading.createMarketOrder.mockResolvedValueOnce(accepted('a'));
    h.trading.createMarketOrder.mockResolvedValueOnce(uncertain);
    const result = await submit(h);
    expect(result.status).toBe('SUBMISSION_UNCERTAIN');
    const record = h.pending.get(result.operationId)!;
    expect(record.legA.submission).toBe(leg === 'A' ? 'UNCERTAIN' : 'SUBMITTED');
    expect(record.legB.submission).toBe(leg === 'A' ? 'NOT_SUBMITTED' : 'UNCERTAIN');
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(leg === 'A' ? 1 : 2);
    await h.flush();
    expect(record.finalized).toBe(false);
    expect(record.terminalResult).toBeUndefined();
    noEconomy(h);
  });

  it.each(['A', 'B'] as const)('%s SDK throw is uncertainty, not rejection', async leg => {
    const h = fixture(); const gate = deferred();
    h.trading.createMarketOrder.mockReset();
    if (leg === 'B') h.trading.createMarketOrder.mockResolvedValueOnce(accepted('a'));
    h.trading.createMarketOrder.mockReturnValueOnce(gate.promise);
    const result = submit(h);
    await Promise.resolve();
    gate.reject(new Error('transport disconnected'));
    const ack = await result;
    expect(ack.status).toBe('SUBMISSION_UNCERTAIN');
    const record = h.pending.get(ack.operationId)!;
    expect(record.legA).toMatchObject(leg === 'A' ? { submission: 'UNCERTAIN' } : { submission: 'SUBMITTED', orderId: 'a' });
    expect(record.legB.submission).toBe(leg === 'A' ? 'NOT_SUBMITTED' : 'UNCERTAIN');
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(leg === 'A' ? 1 : 2);
    noEconomy(h);
  });

  it('B rejection retains submitted A and waits for factual settlement without recovery', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(rejected);
    const ack = await submit(h);
    expect(ack.status).toBe('SUBMITTED_PENDING');
    const record = h.pending.get(ack.operationId)!;
    expect(record.legA).toMatchObject({ submission: 'SUBMITTED', orderId: 'a' });
    expect(record.legB.submission).toBe('REJECTED');
    expect(record.terminalResult).toBeUndefined();
    expect(h.trading.getOrderFillDetails).not.toHaveBeenCalled();
    await h.flush();
    expect(record.terminalResult).toMatchObject({ state: 'IMBALANCED', legB: { state: 'REJECTED' } });
    expect(h.pending.get(ack.operationId)).toBe(record);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    noEconomy(h);
  });

  for (const leg of ['A', 'B'] as const) {
    it.each([
      ['missing ID', { success: true, submissionState: 'ACCEPTED' }],
      ['empty ID', { success: true, submissionState: 'ACCEPTED', orderId: '' }],
      ['whitespace ID', { success: true, submissionState: 'ACCEPTED', orderId: ' \t ' }],
      ['numeric ID', { success: true, submissionState: 'ACCEPTED', orderId: 123 }],
      ['null ID', { success: true, submissionState: 'ACCEPTED', orderId: null }],
      ['bare success', { success: true }],
      ['success and ID without provenance', { success: true, orderId: 'unproven' }],
    ])(`${leg} %s cannot become SUBMITTED`, async (_name, raw) => {
      const h = fixture();
      h.trading.createMarketOrder.mockReset();
      if (leg === 'B') h.trading.createMarketOrder.mockResolvedValueOnce(accepted('a'));
      // Deliberately malformed boundary payloads must not acquire accepted provenance.
      h.trading.createMarketOrder.mockResolvedValueOnce(raw as Reply);
      const ack = await submit(h);
      expect(ack.status).toBe('SUBMISSION_UNCERTAIN');
      const record = h.pending.get(ack.operationId)!;
      expect(record[leg === 'A' ? 'legA' : 'legB'].submission).toBe('UNCERTAIN');
      expect(record.legA.submission).toBe(leg === 'A' ? 'UNCERTAIN' : 'SUBMITTED');
      if (leg === 'A') expect(record.legB.submission).toBe('NOT_SUBMITTED');
      expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(leg === 'A' ? 1 : 2);
      await h.flush();
      expect(record.finalized).toBe(false);
      expect(record.terminalResult).toBeUndefined();
      expect(h.trading.getOrderFillDetails.mock.calls.map(call => call[0])).toEqual(leg === 'A' ? [] : ['a']);
      noEconomy(h);
    });
  }

  it('both accepted returns pending, then real flush stores facts without consuming the record', async () => {
    const h = fixture(); const ack = await submit(h);
    expect(ack.status).toBe('SUBMITTED_PENDING');
    const record = h.pending.get(ack.operationId)!;
    expect(record.legA.submission).toBe('SUBMITTED');
    expect(record.legB.submission).toBe('SUBMITTED');
    expect(record.terminalResult).toBeUndefined();
    expect(h.trading.getOrderFillDetails).not.toHaveBeenCalled();
    await h.flush();
    expect(record.finalized).toBe(true);
    expect(record.terminalResult).toMatchObject({ state: 'BALANCED_SUCCESS',
      legA: { successShares: 10, successUnits: 1000n, weightedPrice: 0.6, txHashes: ['tx-a'] },
      legB: { successShares: 10, successUnits: 1000n, weightedPrice: 0.5, txHashes: ['tx-b'] } });
    const terminal = record.terminalResult;
    await h.flush();
    expect(h.pending.get(ack.operationId)).toBe(record);
    expect(record.terminalResult).toBe(terminal);
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(2);
    noEconomy(h);
  });

  it('snapshots condition and token IDs instead of using a future market for B', async () => {
    const h = fixture(); const a = deferred();
    h.trading.createMarketOrder.mockReset().mockReturnValueOnce(a.promise).mockResolvedValueOnce(accepted('b'));
    const result = submit(h);
    Object.assign(h.market, { conditionId: 'future-condition', yesTokenId: 'future-yes', noTokenId: 'future-no' });
    a.resolve(accepted('a'));
    const ack = await result;
    expect(h.pending.get(ack.operationId)).toMatchObject({ conditionId: 'condition',
      legA: { tokenId: 'yes' }, legB: { tokenId: 'no' } });
    expect(h.trading.createMarketOrder).toHaveBeenNthCalledWith(1, { tokenId: 'yes', side: 'SELL', amount: 10, price: 0.59, orderType: 'FOK' });
    expect(h.trading.createMarketOrder).toHaveBeenNthCalledWith(2, { tokenId: 'no', side: 'SELL', amount: 10, price: 0.49, orderType: 'FOK' });
  });

  it('acknowledges equivalent in-flight execution before the lock without another attempt', async () => {
    const h = fixture(); const a = deferred();
    h.trading.createMarketOrder.mockReset().mockReturnValueOnce(a.promise);
    const first = submit(h);
    const blocked = await h.service.execute(opportunity);
    expect(blocked).toEqual({ type: 'SHORT_SUBMISSION', status: 'SUBMISSION_UNCERTAIN', operationId: [...h.pending.keys()][0] });
    expect(h.service['lastExecutionTime']).toBe(0);
    expect(h.service['nextShortArbId']).toBe(1);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    const long = await h.service.execute({ ...opportunity, type: 'long' });
    expect(long).toMatchObject({ success: false, error: 'Another execution in progress' });
    a.resolve(rejected);
    expect((await first).operationId).toBe(blocked.type === 'SHORT_SUBMISSION' && blocked.operationId);
    noEconomy(h);
    h.trading.createMarketOrder.mockResolvedValueOnce(rejected);
    await submit(h);
    expect(h.service.getStats().executionsAttempted).toBe(2);
    expect(h.service['isExecuting']).toBe(false);
  });

  it.each([
    ['both accepted', [accepted('a'), accepted('b')], 'SUBMITTED_PENDING'],
    ['A uncertain', [uncertain], 'SUBMISSION_UNCERTAIN'],
    ['A missing ID', [{ success: true, submissionState: 'ACCEPTED' }], 'SUBMISSION_UNCERTAIN'],
    ['B uncertain', [accepted('a'), uncertain], 'SUBMISSION_UNCERTAIN'],
    ['B rejected', [accepted('a'), rejected], 'SUBMITTED_PENDING'],
  ] as const)('reuses %s without orders or new attempts even after cooldown', async (_name, replies, status) => {
    const h = fixture();
    h.trading.createMarketOrder.mockReset();
    for (const reply of replies) h.trading.createMarketOrder.mockResolvedValueOnce(reply);
    const first = await submit(h);
    expect(first.status).toBe(status);
    for (const elapsed of [1000, 6000, 60000]) {
      vi.setSystemTime(100000 + elapsed);
      expect(await submit(h)).toEqual(first);
      expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(replies.length);
      expect(h.pending.size).toBe(1);
      expect(h.service['nextShortArbId']).toBe(1);
      noEconomy(h);
    }
    expect(fixture().pending.size).toBe(0);
    const source = readFileSync(new URL('./arbitrage-service.ts', import.meta.url), 'utf8');
    const short = source.slice(source.indexOf('private async executeShortArb('), source.indexOf('private log('));
    expect(short).not.toMatch(/writeFile|appendFile|localStorage|persist|createUnifiedCache/);
  });

  it.each(['conditionId', 'yesTokenId', 'noTokenId'] as const)('does not block a different %s', async key => {
    const h = fixture(); const first = await submit(h);
    h.market[key] = 'unrelated';
    h.trading.createMarketOrder.mockResolvedValue(accepted('a'));
    vi.setSystemTime(100001);
    const second = await submit(h);
    expect(second.operationId).not.toBe(first.operationId);
    expect(h.pending.size).toBe(2);
    expect(h.service['nextShortArbId']).toBe(2);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    noEconomy(h, 2, 100001);
  });

  it('real flush finalization requires a successful refresh before a fresh manual short', async () => {
    const h = fixture();
    h.service.on('error', vi.fn());
    const first = await submit(h);
    vi.setSystemTime(100001);
    await h.flush();
    const record = h.pending.get(first.operationId)!;
    expect(record.finalized).toBe(true);
    expect(record.inventoryReconciled).toBe(false);
    expect(await submit(h)).toEqual(first);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.service.getStats().executionsAttempted).toBe(1);
    noEconomy(h);
    await h.service['updateBalance']();
    expect(record.inventoryReconciled).toBe(true);
    h.trading.createMarketOrder.mockResolvedValue(accepted('a'));
    const second = await submit(h);
    expect(second.operationId).not.toBe(first.operationId);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    noEconomy(h, 2, 100001, 3);
  });

  it('A rejection preserves an existing timestamp and permits retry', async () => {
    const h = fixture();
    Object.assign(h.service, { lastExecutionTime: 99999 });
    h.trading.createMarketOrder.mockReset().mockResolvedValue(rejected);
    expect((await submit(h)).status).toBe('SUBMISSION_REJECTED');
    vi.setSystemTime(100001);
    expect((await submit(h)).status).toBe('SUBMISSION_REJECTED');
    expect(h.pending.size).toBe(0);
    noEconomy(h, 2, 99999);
  });

  it('rejects insufficient held pairs without submitting or registering', async () => {
    const h = fixture(); const ack = await submit(h, { ...opportunity, recommendedSize: 21 });
    expect(ack.status).toBe('SUBMISSION_REJECTED');
    expect(h.pending.size).toBe(0);
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    noEconomy(h);
  });
});

describe('long wrapper and real execution remain legacy results', () => {
  it.each([false, true])('runs real buys and merge with existing short pending=%s', async existing => {
    const h = fixture();
    if (existing) {
      await submit(h);
      h.trading.createMarketOrder.mockClear().mockResolvedValue(accepted('long'));
    }
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '10', noBalance: '10' });
    const result = await h.service.execute({ ...opportunity, type: 'long' });
    if (result.type === 'SHORT_SUBMISSION') throw new Error('Long must retain execution result contract');
    expect(result).toMatchObject({ type: 'long', success: true, size: 10, profit: 1, txHashes: ['merge-tx'] });
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(h.trading.createMarketOrder).toHaveBeenNthCalledWith(1, { tokenId: 'yes', side: 'BUY', amount: 4, price: 0.41, orderType: 'FOK' });
    expect(h.trading.createMarketOrder).toHaveBeenNthCalledWith(2, { tokenId: 'no', side: 'BUY', amount: 5, price: 0.51, orderType: 'FOK' });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('condition', { yesTokenId: 'yes', noTokenId: 'no' }, '10', { negRisk: false });
    expect(h.service.getStats()).toMatchObject({ executionsAttempted: existing ? 2 : 1, executionsSucceeded: 1, totalProfit: 1 });
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution).toHaveBeenCalledWith(result);
    expect(h.pending.size).toBe(existing ? 1 : 0);
    expect(h.service['nextShortArbId']).toBe(existing ? 1 : 0);
    if (existing) expect([...h.pending.values()][0].finalized).toBe(false);
    expect(h.service['isExecuting']).toBe(false);
    expect(h.service['lastExecutionTime']).toBeGreaterThan(0);
  });

  it('real long A failure returns and emits failure without creating short state', async () => {
    const h = fixture(); h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(rejected);
    const result = await h.service.execute({ ...opportunity, type: 'long' });
    if (result.type === 'SHORT_SUBMISSION') throw new Error('Expected long result');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Leg 1 (YES) failed');
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution).toHaveBeenCalledWith(result);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
    expect(h.service.getStats()).toMatchObject({ executionsAttempted: 1, executionsSucceeded: 0, totalProfit: 0 });
    expect(h.service['isExecuting']).toBe(false);
    expect(h.ctf.getPusdBalance).toHaveBeenCalledTimes(1);
  });
});

describe('short pacing through real automatic and scheduled paths', () => {
  it('detects from books, respects automatic cooldown, and reuses unresolved work after expiration', async () => {
    const h = fixture();
    h.service.updateConfig({ autoExecute: true });
    h.service.on('error', vi.fn());
    const execute = vi.spyOn(h.service, 'execute');
    const book = (assetId: string, price: number) => h.service['handleBookUpdate']({
      assetId, bids: [{ price, size: 20 }], asks: [{ price: price + 0.05, size: 20 }], timestamp: Date.now(),
    });
    book('yes', 0.6); book('no', 0.5);
    expect(execute).toHaveBeenCalledTimes(1);
    const first = await execute.mock.results[0].value;
    expect(first).toMatchObject({ type: 'SHORT_SUBMISSION', status: 'SUBMITTED_PENDING' });
    vi.setSystemTime(104999);
    h.service['checkAndHandleOpportunity']();
    expect(execute).toHaveBeenCalledTimes(1);
    vi.setSystemTime(105000);
    book('yes', 0.6);
    expect(await execute.mock.results[1].value).toEqual(first);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.service['nextShortArbId']).toBe(1);
    noEconomy(h);
    await h.flush();
    expect(h.pending.get(first.operationId)).toMatchObject({ finalized: true, inventoryReconciled: false });
    h.service['checkAndHandleOpportunity']();
    expect(await execute.mock.results[2].value).toEqual(first);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    noEconomy(h);
    await h.service['updateBalance']();
    h.trading.createMarketOrder.mockResolvedValue(accepted('a'));
    h.service['checkAndHandleOpportunity']();
    const next = await execute.mock.results[3].value;
    expect(next.operationId).not.toBe(first.operationId);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    noEconomy(h, 2, 105000, 3);
    vi.setSystemTime(109999);
    book('no', 0.5);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('uses only the existing 30s timer, awaits real flush, isolates operations and retries next cycle', async () => {
    const h = fixture();
    const interval = vi.spyOn(globalThis, 'setInterval');
    const flush = vi.spyOn(h.service as unknown as { flushPendingShortArbs: () => Promise<void> }, 'flushPendingShortArbs');
    await h.service.start(h.market);
    const first = await submit(h);
    h.market.conditionId = 'other';
    h.trading.createMarketOrder.mockResolvedValue(accepted('b'));
    const second = await submit(h);
    h.trading.getOrderFillDetails.mockRejectedValueOnce(new Error('operation query failed'));
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls[0][1]).toBe(30000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29999);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(h.pending.get(first.operationId)?.finalized).toBe(false);
    expect(h.pending.has(second.operationId)).toBe(false);
    expect(h.service['shortArbFlushPromise']).toBeNull();
    expect(h.trading.getTradeStatuses.mock.invocationCallOrder.at(-1)).toBeLessThan(h.ctf.getPusdBalance.mock.invocationCallOrder.at(-1)!);
    noEconomy(h, 2, 100000, 4, 1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.pending.get(first.operationId)?.finalized).toBe(true);
    noEconomy(h, 2, 100000, 5, 1);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    await h.service.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.realtime.disconnect).toHaveBeenCalledTimes(1);
    expect(h.realtime.subscribeMarkets.mock.results[0].value.unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('recovers subsequent scheduler cycles after flush and balance exceptions', async () => {
    const h = fixture();
    await h.service.start(h.market);
    const ack = await submit(h);
    const flush = vi.spyOn(h.service as unknown as { flushPendingShortArbs: () => Promise<void> }, 'flushPendingShortArbs')
      .mockRejectedValueOnce(new Error('flush cycle failed'));
    // With no error listener, the real updateBalance rethrows the SDK error via emit.
    h.ctf.getPusdBalance.mockRejectedValueOnce(new Error('balance cycle failed'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(h.ctf.getPusdBalance).toHaveBeenCalledTimes(3);
    expect(h.pending.get(ack.operationId)?.finalized).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(h.pending.has(ack.operationId)).toBe(false);
    noEconomy(h, 1, 100000, 4, 1);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
  });
});

describe('post-terminal inventory release', () => {
  it('BALANCED_SUCCESS finalized but refresh pending blocks an equivalent short', async () => {
    const h = fixture(); const first = await submit(h);
    await h.flush();
    const record = h.pending.get(first.operationId)!;
    expect(record.terminalResult).toMatchObject({ state: 'BALANCED_SUCCESS' });
    expect(record.inventoryReconciled).toBe(false);
    expect(await submit(h)).toEqual(first);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.service.getStats().executionsAttempted).toBe(1);
    expect(h.service['nextShortArbId']).toBe(1);
    noEconomy(h);
  });

  it('IMBALANCED uneven fills finalized but refresh pending blocks an equivalent short', async () => {
    const h = fixture();
    h.trades.b.size = '8';
    const first = await submit(h);
    await h.flush();
    const record = h.pending.get(first.operationId)!;
    expect(record.terminalResult).toMatchObject({ state: 'IMBALANCED' });
    expect(record.inventoryReconciled).toBe(false);
    expect(await submit(h)).toEqual(first);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.service.getStats().executionsAttempted).toBe(1);
    noEconomy(h);
  });

  it('a book event during an in-flight refresh cannot start a new SELL until it completes', async () => {
    const h = fixture();
    h.service.updateConfig({ autoExecute: true });
    h.service.on('error', vi.fn());
    const execute = vi.spyOn(h.service, 'execute');
    const book = (assetId: string, price: number) => h.service['handleBookUpdate']({
      assetId, bids: [{ price, size: 20 }], asks: [{ price: price + 0.05, size: 20 }], timestamp: Date.now(),
    });
    book('yes', 0.6); book('no', 0.5);
    const first = await execute.mock.results[0].value;
    await h.flush();
    expect(h.pending.get(first.operationId)).toMatchObject({ finalized: true, inventoryReconciled: false });
    let resolveBalance!: (value: string) => void;
    h.ctf.getPusdBalance.mockImplementationOnce(() => new Promise<string>(resolve => { resolveBalance = resolve; }));
    const refreshing = h.service['updateBalance']();
    vi.setSystemTime(105000);
    book('yes', 0.6);
    expect(await execute.mock.results[1].value).toEqual(first);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.pending.get(first.operationId)?.inventoryReconciled).toBe(false);
    resolveBalance('100');
    await refreshing;
    expect(h.pending.get(first.operationId)?.inventoryReconciled).toBe(true);
    h.trading.createMarketOrder.mockResolvedValue(accepted('a'));
    vi.setSystemTime(110000);
    book('no', 0.5);
    const next = await execute.mock.results[2].value;
    expect(next.operationId).not.toBe(first.operationId);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    noEconomy(h, 2, 110000, 3);
  });

  it('a failed refresh keeps the block until a later refresh succeeds', async () => {
    const h = fixture();
    const errors = vi.fn();
    h.service.on('error', errors);
    const first = await submit(h);
    await h.flush();
    const record = h.pending.get(first.operationId)!;
    expect(record).toMatchObject({ finalized: true, inventoryReconciled: false });
    h.ctf.getPusdBalance.mockRejectedValueOnce(new Error('refresh failed'));
    await h.service['updateBalance']();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(record.inventoryReconciled).toBe(false);
    expect(await submit(h)).toEqual(first);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    noEconomy(h, 1, 100000, 2);
    await h.service['updateBalance']();
    expect(record.inventoryReconciled).toBe(true);
    h.trading.createMarketOrder.mockResolvedValue(accepted('a'));
    const second = await submit(h);
    expect(second.operationId).not.toBe(first.operationId);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    noEconomy(h, 2, 100000, 4);
  });

  it('the next 30s cycle retries the refresh and releases after an earlier failure', async () => {
    const h = fixture();
    h.service.on('error', vi.fn());
    await h.service.start(h.market);
    const first = await submit(h);
    await h.flush();
    const record = h.pending.get(first.operationId)!;
    expect(record).toMatchObject({ finalized: true, inventoryReconciled: false });
    h.ctf.getPusdBalance.mockRejectedValueOnce(new Error('refresh failed'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(record.inventoryReconciled).toBe(false);
    h.trading.createMarketOrder.mockResolvedValue(accepted('a'));
    expect(await submit(h)).toEqual(first);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30000);
    expect(record.inventoryReconciled).toBe(true);
    const releasedAt = Date.now();
    const second = await submit(h);
    expect(second.operationId).not.toBe(first.operationId);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(2);
    noEconomy(h, 2, releasedAt, 5, 1);
  });

  it('a refresh before terminalization does not release the operation', async () => {
    const h = fixture(); const first = await submit(h);
    await h.service['updateBalance']();
    const record = h.pending.get(first.operationId)!;
    expect(record.finalized).toBe(false);
    expect(record.inventoryReconciled).toBeUndefined();
    await h.flush();
    expect(record).toMatchObject({ finalized: true, inventoryReconciled: false });
    expect(await submit(h)).toEqual(first);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    noEconomy(h, 1, 100000, 2);
    await h.service['updateBalance']();
    expect(record.inventoryReconciled).toBe(true);
    h.trading.createMarketOrder.mockResolvedValue(accepted('a'));
    const second = await submit(h);
    expect(second.operationId).not.toBe(first.operationId);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    noEconomy(h, 2, 100000, 4);
  });

  it('NO_FILL releases immediately without an extra refresh', async () => {
    const h = fixture();
    h.trades.a = { ...h.trades.a, status: 'FAILED', transactionHash: undefined };
    h.trades.b = { ...h.trades.b, status: 'FAILED', transactionHash: undefined };
    const first = await submit(h);
    await h.flush();
    const record = h.pending.get(first.operationId)!;
    expect(record.terminalResult).toMatchObject({ state: 'NO_FILL' });
    expect(record.inventoryReconciled).toBe(true);
    h.trading.createMarketOrder.mockResolvedValue(accepted('a'));
    const second = await submit(h);
    expect(second.operationId).not.toBe(first.operationId);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    noEconomy(h, 2, 100000);
  });

  it('SUBMISSION_REJECTED with a failed submitted leg releases immediately', async () => {
    const h = fixture();
    h.trades.a = { ...h.trades.a, status: 'FAILED', transactionHash: undefined };
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(rejected);
    const first = await submit(h);
    await h.flush();
    const record = h.pending.get(first.operationId)!;
    expect(record.terminalResult).toMatchObject({ state: 'SUBMISSION_REJECTED', legB: { state: 'REJECTED' } });
    expect(record.inventoryReconciled).toBe(true);
    h.trading.createMarketOrder.mockResolvedValue(accepted('a'));
    const second = await submit(h);
    expect(second.operationId).not.toBe(first.operationId);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(4);
    noEconomy(h, 2, 100000);
  });

  it('long arb executes normally while a finalized refresh-pending short exists', async () => {
    const h = fixture();
    const first = await submit(h);
    await h.flush();
    expect(h.pending.get(first.operationId)).toMatchObject({ finalized: true, inventoryReconciled: false });
    h.trading.createMarketOrder.mockClear().mockResolvedValue(accepted('long'));
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '10', noBalance: '10' });
    const result = await h.service.execute({ ...opportunity, type: 'long' });
    if (result.type === 'SHORT_SUBMISSION') throw new Error('Long must retain execution result contract');
    expect(result).toMatchObject({ type: 'long', success: true, size: 10, profit: 1, txHashes: ['merge-tx'] });
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()).toMatchObject({ executionsAttempted: 2, executionsSucceeded: 1, totalProfit: 1 });
    expect(h.pending.get(first.operationId)?.inventoryReconciled).toBe(true);
  });
});
