import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type ArbitrageExecutionResult } from './arbitrage-service.js';
import { MergeProvenanceError } from '../clients/ctf-client.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
const services: ArbitrageService[] = [];
const accepted = (orderId: string, tradeIds?: string[]): Reply => ({ success: true, submissionState: 'ACCEPTED', orderId, tradeIds });
const rejected: Reply = { success: false, submissionState: 'REJECTED', errorMsg: 'venue rejection' };
const HASH = (n: string) => '0x' + n.repeat(32);
const MERGE_TX = HASH('ab');
/** Book snapshot implies 0.40 + 0.50 → 10% edge on 10 pairs ($1). */
const opportunity: ArbitrageOpportunity = {
  type: 'long', profitRate: 0.1, profitPercent: 10,
  effectivePrices: { buyYes: 0.4, buyNo: 0.5, sellYes: 0.6, sellNo: 0.5 },
  priceCaps: { buyYes: 0.41, buyNo: 0.51, sellYes: 0.59, sellNo: 0.49 },
  maxOrderbookSize: 20, maxBalanceSize: 20, recommendedSize: 10,
  estimatedProfit: 1, description: 'long factual authority', timestamp: 1,
};

/** Raw CLOB trade rows as the service receives them; string literals stand in for the SDK enums. */
type Trade = {
  id: string; status: string; size?: string; price?: string; transactionHash?: string; asset_id?: string; side?: string;
  taker_order_id?: string; trader_side?: string;
  maker_orders?: Array<{ order_id: string; asset_id?: string; side?: string; matched_amount?: string; price?: string }>;
};
type Merge = { success?: boolean; txHash?: string; amount?: string; usdcReceived?: string;
  provenance?: { state: 'NOT_SUBMITTED' | 'SUBMITTED' | 'CONFIRMED' | 'UNCERTAIN'; transactionHash?: string } };
const taker = (id: string, orderId: string, asset: string, size: string, price: string, hash = HASH('11'), status = 'MINED'): Trade =>
  ({ id, status, size, price, transactionHash: hash, asset_id: asset, side: 'BUY', taker_order_id: orderId, trader_side: 'TAKER', maker_orders: [] });

function fixture(options: { yes?: string; no?: string } = {}) {
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: false });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const trades: Record<string, Trade> = {
    ty: taker('ty', 'ly', 'yes', '10', '0.4', HASH('11')),
    tn: taker('tn', 'ln', 'no', '10', '0.5', HASH('22')),
  };
  const orders: Record<string, OrderRow> = {
    ly: { id: 'ly', asset_id: 'yes', side: 'BUY', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['ty'], sizeMatched: '10' },
    ln: { id: 'ln', asset_id: 'no', side: 'BUY', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['tn'], sizeMatched: '10' },
  };
  const balances = { yesBalance: options.yes ?? '10', noBalance: options.no ?? '10' };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>()
      .mockResolvedValueOnce(accepted('ly')).mockResolvedValueOnce(accepted('ln')),
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
    getPusdBalance: vi.fn().mockResolvedValue('100'),
    getPositionBalanceByTokenIds: vi.fn(async () => ({ ...balances })),
    mergeByTokenIds: vi.fn(async (_c: string, _t: unknown, amount: string): Promise<Merge> =>
      ({ success: true, txHash: MERGE_TX, amount, usdcReceived: amount, provenance: { state: 'CONFIRMED', transactionHash: MERGE_TX } })),
    split: vi.fn(),
  };
  const realtime = { connect: vi.fn(), disconnect: vi.fn(), subscribeMarkets: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) };
  Object.assign(service, { market, tradingService: trading, ctf, realtimeService: realtime,
    balance: { usdc: 100, pUsdBalance: 100, yesTokens: Number(balances.yesBalance), noTokens: Number(balances.noBalance), lastUpdate: 0 } });
  const execution = vi.fn<(result: ArbitrageExecutionResult) => void>();
  service.on('execution', execution);
  const recovery = vi.spyOn(service as unknown as { fixImbalanceIfNeeded: ArbitrageService['fixImbalanceIfNeeded'] }, 'fixImbalanceIfNeeded');
  const pending = service['pendingLongArbs'];
  const flush = () => service['flushPendingLongArbs']();
  return { service, market, trades, orders, balances, trading, ctf, execution, recovery, pending, flush };
}
type H = ReturnType<typeof fixture>;

async function run(h: H): Promise<ArbitrageExecutionResult> {
  const result = await h.service.execute(opportunity);
  if (result.type === 'SHORT_SUBMISSION') throw new Error('Expected long result');
  return result;
}

function expectNoEconomics(h: H) {
  expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  expect(h.execution).not.toHaveBeenCalled();
  expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3 B1 long-arb BUY factual authority', () => {
  it('books realized profit only from factual fills and a confirmed merge, exactly once', async () => {
    const h = fixture();
    const result = await run(h);
    expect(result).toMatchObject({ success: true, type: 'long', size: 10, profit: 1, txHashes: [MERGE_TX], operationId: 'long-1' });
    expect(result.facts).toEqual({
      yesOrderId: 'ly', noOrderId: 'ln', yesShares: 10, yesCost: 4, noShares: 10, noCost: 5,
      mergedShares: 10, mergeValue: 10, feeUsd: 0, fillTxHashes: [HASH('11'), HASH('22')],
    });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('condition', { yesTokenId: 'yes', noTokenId: 'no' }, '10', { negRisk: false });
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution).toHaveBeenCalledWith(result);
    expect(h.service.getStats()).toMatchObject({ executionsAttempted: 1, executionsSucceeded: 1, totalProfit: 1 });
    expect(h.pending.size).toBe(0);
    await h.flush(); await h.flush();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 1, totalProfit: 1 });
  });

  it('accepted submissions with zero factual fills never merge or book', async () => {
    const h = fixture();
    for (const id of ['ly', 'ln']) Object.assign(h.orders[id], { status: 'CANCELED', tradeIds: [], sizeMatched: '0' });
    const result = await run(h);
    expect(result).toMatchObject({ success: false, profit: 0, txHashes: [] });
    expect(result.error).toContain('No paired factual fills (YES 0 / NO 0');
    expect(result.pending).toBeUndefined();
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution.mock.calls[0][0].success).toBe(false);
    expect(h.service.getStats()).toMatchObject({ executionsAttempted: 1, executionsSucceeded: 0, totalProfit: 0 });
    expect(h.pending.size).toBe(0);
  });

  it('accepted submissions with no fill evidence yet stay pending without claims', async () => {
    const h = fixture();
    for (const id of ['ly', 'ln']) Object.assign(h.orders[id], { status: 'LIVE', tradeIds: [], sizeMatched: '0' });
    const result = await run(h);
    expect(result).toMatchObject({ success: false, pending: true, operationId: 'long-1', profit: 0 });
    expect(result.error).toContain('BUY_PENDING');
    expectNoEconomics(h);
    expect(h.pending.get('long-1')?.legYes.settlement).toEqual({ state: 'PENDING' });
  });

  it('YES factual fill with NO unknown yields no terminal success; completes exactly once when NO resolves', async () => {
    const h = fixture();
    h.trades.tn = { id: 'tn', status: 'UNKNOWN' };
    const result = await run(h);
    expect(result).toMatchObject({ success: false, pending: true, operationId: 'long-1' });
    expectNoEconomics(h);
    const op = h.pending.get('long-1')!;
    expect(op.legYes.settlement).toMatchObject({ state: 'TERMINAL', shares: 10, cost: 4 });
    expect(op.legNo.settlement).toEqual({ state: 'PENDING' });
    // A repeated opportunity is acknowledged, never resubmitted.
    expect(await run(h)).toMatchObject({ success: false, pending: true, operationId: 'long-1' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.service.getStats().executionsAttempted).toBe(1);
    await h.flush();
    expectNoEconomics(h);
    h.trades.tn = taker('tn', 'ln', 'no', '10', '0.5', HASH('22'));
    await Promise.all([h.flush(), h.flush()]);
    await h.flush();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution.mock.calls[0][0]).toMatchObject({ success: true, profit: 1, size: 10, operationId: 'long-1' });
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 1, totalProfit: 1 });
    expect(h.pending.size).toBe(0);
  });

  it.each([
    ['pre-existing', '500', '500'],
    ['zero-visible', '0', '0'],
  ])('%s wallet inventory (%s/%s) never changes merge quantity or profit', async (_label, yes, no) => {
    const h = fixture({ yes, no });
    const result = await run(h);
    expect(result).toMatchObject({ success: true, size: 10, profit: 1 });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('condition', expect.anything(), '10', expect.anything());
  });

  it('concurrent unrelated inventory arriving after submission is not attributed', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockReset()
      .mockImplementationOnce(async () => { Object.assign(h.balances, { yesBalance: '40', noBalance: '40' }); return accepted('ly'); })
      .mockResolvedValueOnce(accepted('ln'));
    const result = await run(h);
    expect(result).toMatchObject({ success: true, size: 10, profit: 1 });
    expect(result.facts).toMatchObject({ yesShares: 10, noShares: 10, mergedShares: 10 });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('condition', expect.anything(), '10', expect.anything());
    expect(h.service.getStats().totalProfit).toBe(1);
  });

  it('realized economics use factual fill prices, not the book snapshot', async () => {
    const h = fixture();
    h.trades.ty.price = '0.46';
    h.trades.tn.price = '0.53';
    const result = await run(h);
    expect(result.success).toBe(true);
    expect(result.profit).toBeCloseTo(10 - 4.6 - 5.3, 10);
    expect(result.facts).toMatchObject({ yesCost: expect.closeTo(4.6, 10), noCost: expect.closeTo(5.3, 10), mergeValue: 10 });
    expect(h.service.getStats().totalProfit).toBeCloseTo(0.1, 10);
  });

  it('applies the configured taker fee to factual cost', async () => {
    const h = fixture();
    h.service.updateConfig({ feeRateBps: 100 });
    const result = await run(h);
    expect(result.profit).toBeCloseTo(10 - 9 - 0.09, 10);
    expect(result.facts?.feeUsd).toBeCloseTo(0.09, 10);
  });

  it('multiple fills at different prices produce weighted factual cost', async () => {
    const h = fixture();
    h.trades.t1 = taker('t1', 'ly', 'yes', '4', '0.4', HASH('11'));
    h.trades.t2 = taker('t2', 'ly', 'yes', '6', '0.45', HASH('33'));
    h.orders.ly.tradeIds = ['t1', 't2'];
    const result = await run(h);
    expect(result.success).toBe(true);
    expect(result.facts).toMatchObject({ yesShares: 10, yesCost: expect.closeTo(4.3, 10), fillTxHashes: [HASH('11'), HASH('33'), HASH('22')] });
    expect(result.profit).toBeCloseTo(10 - 4.3 - 5, 10);
  });

  it('partial NO fill merges only the attributable pairs with exact uniform-price cost', async () => {
    const h = fixture();
    h.trades.tn.size = '6';
    h.orders.ln = { ...h.orders.ln, status: 'CANCELED', sizeMatched: '6' };
    const result = await run(h);
    expect(result).toMatchObject({ success: true, size: 6, txHashes: [MERGE_TX] });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('condition', expect.anything(), '6', expect.anything());
    expect(result.facts).toMatchObject({ yesShares: 10, noShares: 6, mergedShares: 6, yesCost: expect.closeTo(2.4, 10), noCost: 3 });
    expect(result.profit).toBeCloseTo(6 - 2.4 - 3, 10);
  });

  it('withholds realized profit when a partially merged leg has no exact cost attribution', async () => {
    const h = fixture();
    h.trades.t1 = taker('t1', 'ly', 'yes', '4', '0.4', HASH('11'));
    h.trades.t2 = taker('t2', 'ly', 'yes', '6', '0.45', HASH('33'));
    h.orders.ly.tradeIds = ['t1', 't2'];
    h.trades.tn.size = '6';
    h.orders.ln = { ...h.orders.ln, status: 'CANCELED', sizeMatched: '6' };
    const result = await run(h);
    expect(result).toMatchObject({ success: false, profit: 0 });
    expect(result.error).toMatch(/cost attribution is not exact/);
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
    await h.flush();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.execution).toHaveBeenCalledTimes(1);
  });

  it('partial factual evidence is preserved and never completed by sizeMatched alone', async () => {
    const h = fixture();
    h.trades.t1 = taker('t1', 'ly', 'yes', '4', '0.4', HASH('11'));
    h.orders.ly.tradeIds = ['t1'];      // sizeMatched still claims 10
    const result = await run(h);
    expect(result).toMatchObject({ success: false, pending: true });
    expectNoEconomics(h);
    const leg = h.pending.get('long-1')!.legYes;
    expect(leg.settlement).toEqual({ state: 'PENDING' });
    expect(leg.facts?.size).toBe(1);
    // Later discovery of the remaining child completes the leg from facts.
    h.trades.t2 = taker('t2', 'ly', 'yes', '6', '0.4', HASH('33'));
    h.orders.ly.tradeIds = ['t1', 't2'];
    await h.flush();
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution.mock.calls[0][0]).toMatchObject({ success: true, profit: 1 });
  });

  it.each([
    ['order identity', (h: H) => { h.orders.ly.id = 'other'; }],
    ['order token', (h: H) => { h.orders.ly.asset_id = 'no'; }],
    ['order side', (h: H) => { h.orders.ly.side = 'SELL'; }],
    ['enumeration missing', (h: H) => { h.orders.ly.tradeEnumerationPresent = false; }],
    ['unlisted child', (h: H) => { h.orders.ly.tradeIds = ['ghost']; }],
    ['trade token', (h: H) => { h.trades.ty.asset_id = 'no'; }],
    ['trade side', (h: H) => { h.trades.ty.side = 'SELL'; }],
    ['foreign taker without local maker', (h: H) => { h.trades.ty.taker_order_id = 'other'; }],
    ['taker with local maker rows', (h: H) => { h.trades.ty.maker_orders = [{ order_id: 'ly' }]; }],
    ['association unavailable', (h: H) => { h.trades.ty.maker_orders = undefined; }],
    ['unconfirmed status', (h: H) => { h.trades.ty.status = 'MATCHED'; }],
    ['unknown status', (h: H) => { h.trades.ty.status = 'UNKNOWN'; }],
    ['invalid hash', (h: H) => { h.trades.ty.transactionHash = 'not-a-hash'; }],
    ['children exceed matched', (h: H) => { h.trades.ty.size = '12'; }],
    ['children below matched', (h: H) => { h.trades.ty.size = '8'; }],
  ])('invalid or ambiguous evidence (%s) never counts as a fill', async (_label, corrupt) => {
    const h = fixture();
    corrupt(h);
    const result = await run(h);
    expect(result).toMatchObject({ success: false, pending: true, profit: 0 });
    expectNoEconomics(h);
    // Anomalies (children exceeding sizeMatched) throw and leave the leg unsettled; both are pending.
    expect(h.pending.get('long-1')?.legYes.settlement?.state ?? 'PENDING').toBe('PENDING');
  });

  it('a failed child without a hash is a terminal non-fill, not a pending one', async () => {
    const h = fixture();
    h.trades.ty = { ...h.trades.ty, status: 'FAILED', transactionHash: undefined };
    h.orders.ly = { ...h.orders.ly, status: 'CANCELED', sizeMatched: '0' };
    const result = await run(h);
    expect(result).toMatchObject({ success: false, profit: 0 });
    expect(result.error).toContain('No paired factual fills (YES 0 / NO 10');
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
  });

  it('maker allocation counts only the local matched_amount and maker price', async () => {
    const h = fixture();
    h.trades.ty = {
      id: 'ty', status: 'CONFIRMED', size: '20', price: '0.9', transactionHash: HASH('11'),
      asset_id: 'yes', side: 'SELL', taker_order_id: 'other-taker', trader_side: 'MAKER',
      maker_orders: [
        { order_id: 'ly', asset_id: 'yes', side: 'BUY', matched_amount: '10', price: '0.4' },
        { order_id: 'someone-else', asset_id: 'yes', side: 'BUY', matched_amount: '10', price: '0.9' },
      ],
    };
    const result = await run(h);
    expect(result).toMatchObject({ success: true, size: 10, profit: 1 });
    expect(result.facts).toMatchObject({ yesShares: 10, yesCost: 4 });
  });

  it.each([
    ['maker allocation exceeds trade size', { size: '5' }],
    ['maker side contradicts BUY', { maker_orders: [{ order_id: 'ly', asset_id: 'yes', side: 'SELL', matched_amount: '10', price: '0.4' }] }],
    ['maker token mismatch', { maker_orders: [{ order_id: 'ly', asset_id: 'no', side: 'BUY', matched_amount: '10', price: '0.4' }] }],
    ['taker bought the same token', { side: 'BUY' }],
    ['two local maker rows', { maker_orders: [{ order_id: 'ly', asset_id: 'yes', matched_amount: '5', price: '0.4' }, { order_id: 'ly', asset_id: 'yes', matched_amount: '5', price: '0.4' }] }],
  ])('contradictory maker evidence (%s) never counts', async (_label, patch) => {
    const h = fixture();
    h.trades.ty = {
      id: 'ty', status: 'CONFIRMED', size: '20', price: '0.9', transactionHash: HASH('11'),
      asset_id: 'yes', side: 'SELL', taker_order_id: 'other-taker', trader_side: 'MAKER',
      maker_orders: [{ order_id: 'ly', asset_id: 'yes', side: 'BUY', matched_amount: '10', price: '0.4' }],
      ...patch,
    };
    const result = await run(h);
    expect(result).toMatchObject({ success: false, pending: true });
    expectNoEconomics(h);
  });

  it('taker execution counts only the local factual size and price', async () => {
    const h = fixture();
    h.trades.ty = taker('ty', 'ly', 'yes', '10', '0.4', HASH('11'), 'CONFIRMED');
    const result = await run(h);
    expect(result.facts).toMatchObject({ yesShares: 10, yesCost: 4 });
    expect(result.profit).toBe(1);
  });

  it('concurrent reconciliation of one operation submits a single merge and books once', async () => {
    const h = fixture();
    h.trades.tn = { id: 'tn', status: 'UNKNOWN' };
    await run(h);
    const op = h.pending.get('long-1')!;
    h.trades.tn = taker('tn', 'ln', 'no', '10', '0.5', HASH('22'));
    const results = await Promise.all([
      h.service['reconcileLongArb'](op), h.service['reconcileLongArb'](op), h.service['reconcileLongArb'](op),
    ]);
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toMatchObject({ success: true, profit: 1 });
    expect(h.execution).not.toHaveBeenCalled();
    await Promise.all([h.flush(), h.flush()]);
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 1, totalProfit: 1 });
    expect(h.pending.size).toBe(0);
  });

  it('a throwing execution listener cannot replay booking', async () => {
    const h = fixture();
    h.service.on('execution', () => { throw new Error('observer'); });
    await expect(run(h)).rejects.toThrow('observer');
    await h.flush();
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 1, totalProfit: 1 });
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.pending.size).toBe(0);
  });

  it.each([
    ['unconfirmed provenance returned', (h: H) => h.ctf.mergeByTokenIds.mockResolvedValue(
      { success: true, txHash: MERGE_TX, amount: '10', usdcReceived: '10', provenance: { state: 'SUBMITTED', transactionHash: MERGE_TX } })],
    ['success flag missing', (h: H) => h.ctf.mergeByTokenIds.mockResolvedValue({ success: false, txHash: MERGE_TX, amount: '10', usdcReceived: '10' })],
    ['non-hash tx', (h: H) => h.ctf.mergeByTokenIds.mockResolvedValue({ success: true, txHash: 'merge-tx', amount: '10', usdcReceived: '10' })],
    ['reported amount disagrees', (h: H) => h.ctf.mergeByTokenIds.mockResolvedValue({ success: true, txHash: MERGE_TX, amount: '9', usdcReceived: '9' })],
    ['uncertain provenance thrown', (h: H) => h.ctf.mergeByTokenIds.mockRejectedValue(
      new MergeProvenanceError(new Error('timeout'), { state: 'UNCERTAIN', transactionHash: MERGE_TX }))],
    ['submitted provenance thrown', (h: H) => h.ctf.mergeByTokenIds.mockRejectedValue(
      new MergeProvenanceError(new Error('receipt lost'), { state: 'SUBMITTED', transactionHash: MERGE_TX }))],
    ['plain error thrown', (h: H) => h.ctf.mergeByTokenIds.mockRejectedValue(new Error('rpc'))],
  ])('merge without confirmation (%s) books nothing and is never blindly retried', async (_label, arrange) => {
    const h = fixture();
    arrange(h);
    const result = await run(h);
    expect(result).toMatchObject({ success: false, profit: 0, txHashes: [] });
    expect(result.error).toMatch(/Merge outcome uncertain/);
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution.mock.calls[0][0].success).toBe(false);
    await h.flush();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.pending.size).toBe(0);
  });

  it('a proven non-broadcast merge is retried later and books exactly once when confirmed', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValueOnce(new MergeProvenanceError(new Error('gas'), { state: 'NOT_SUBMITTED' }));
    const result = await run(h);
    expect(result).toMatchObject({ success: false, pending: true });
    expect(h.execution).not.toHaveBeenCalled();
    expect(h.service.getStats().totalProfit).toBe(0);
    await h.flush();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(2);
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.execution.mock.calls[0][0]).toMatchObject({ success: true, profit: 1, txHashes: [MERGE_TX] });
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 1, totalProfit: 1 });
  });

  it('confirmed provenance thrown after the receipt still counts exactly once', async () => {
    const h = fixture();
    h.ctf.mergeByTokenIds.mockRejectedValue(new MergeProvenanceError(new Error('late'), { state: 'CONFIRMED', transactionHash: MERGE_TX }));
    const result = await run(h);
    expect(result).toMatchObject({ success: true, profit: 1, txHashes: [MERGE_TX] });
    await h.flush();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.execution).toHaveBeenCalledTimes(1);
  });

  it('rejected YES leg fails without state, without a NO order, and without economics', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(rejected);
    const result = await run(h);
    expect(result).toMatchObject({ success: false, profit: 0 });
    expect(result.error).toContain('Leg 1 (YES) failed');
    expect(result.pending).toBeUndefined();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.execution).toHaveBeenCalledTimes(1);
    expect(h.pending.size).toBe(0);
  });

  it('uncertain YES submission withholds the NO leg and blocks resubmission', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockReset().mockRejectedValueOnce(new Error('socket hang up'));
    const result = await run(h);
    expect(result).toMatchObject({ success: false, pending: true, operationId: 'long-1' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expectNoEconomics(h);
    expect(h.pending.get('long-1')?.legYes.submission).toBe('UNCERTAIN');
    expect(await run(h)).toMatchObject({ pending: true, operationId: 'long-1' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    await h.flush();
    expectNoEconomics(h);
  });

  it('uncertain YES submission with an order identity reconciles the YES side only', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce({ success: true, submissionState: 'UNCERTAIN', orderId: 'ly' });
    const result = await run(h);
    expect(result).toMatchObject({ success: false, profit: 0 });
    expect(result.error).toContain('No paired factual fills (YES 10 / NO 0');
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
  });

  it('rejected NO leg keeps existing remediation and finalizes from YES facts without profit', async () => {
    const h = fixture();
    h.service.updateConfig({ autoFixImbalance: true });
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('ly')).mockResolvedValueOnce(rejected)
      .mockResolvedValue({ success: true, submissionState: 'ACCEPTED', orderId: 'recovery' });
    const result = await run(h);
    expect(h.recovery).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, profit: 0 });
    expect(result.error).toContain('No paired factual fills (YES 10 / NO 0');
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.service.getStats()).toMatchObject({ executionsSucceeded: 0, totalProfit: 0 });
  });

  it('short submission remains a factual-settlement acknowledgement with no long state', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockReset().mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(accepted('b'));
    const result = await h.service.execute({ ...opportunity, type: 'short' });
    expect(result).toEqual({ type: 'SHORT_SUBMISSION', operationId: 'short-1', status: 'SUBMITTED_PENDING' });
    expect(h.pending.size).toBe(0);
    expect(h.service['pendingShortArbs'].size).toBe(1);
    expectNoEconomics(h);
  });
});
