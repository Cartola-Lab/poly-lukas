import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmartMoneyService } from './smart-money-service.js';
import { CopyPnlTracker } from './copy-pnl-tracker.js';
const hash = '0x' + '12'.repeat(32);
const wallet = '0x' + 'ab'.repeat(20);
const taker = (side: 'BUY' | 'SELL', patch: any = {}) => ({ id: 'a', status: 'CONFIRMED', transactionHash: hash,
  size: '10', price: '0.5', asset_id: 'token', side, taker_order_id: 'order', trader_side: 'TAKER', maker_orders: [], ...patch });
async function fixture(side: 'BUY' | 'SELL', guarded = true) {
  let incoming: any;
  const trading = { getAddress: () => wallet,
    createMarketOrder: vi.fn(async (): Promise<any> => ({ success: true, submissionState: 'ACCEPTED', orderId: 'order' })),
    getOrderFillDetails: vi.fn(async (): Promise<any> => ({ id: 'order', asset_id: 'token', side, sizeMatched: '10', tradeIds: ['a'] })),
    getTradeStatuses: vi.fn(async (): Promise<any[]> => [taker(side)]),
  };
  const service = new SmartMoneyService({} as any, {} as any, trading as any);
  vi.spyOn(service, 'subscribeSmartMoneyTrades').mockImplementation(cb => { incoming = cb; return { id: 'sub', unsubscribe() {} }; });
  const onCopyPnl = vi.fn();
  const sub = await service.startAutoCopyTrading({ targetAddresses: ['whale'], minTradeSize: 1, delay: 0, feeRateBps: 100,
    inventoryAdmissionGuard: guarded ? () => undefined : undefined, onCopyPnl });
  // SELL parser/lifecycle scenarios start with inventory established by a real factual BUY.
  if (side === 'SELL') {
    trading.createMarketOrder.mockResolvedValueOnce({ success: true, submissionState: 'ACCEPTED', orderId: 'seed' });
    await incoming({ traderAddress: 'whale', side: 'BUY', tokenId: 'token', size: 100, price: .4, timestamp: Date.now() });
    trading.getOrderFillDetails.mockResolvedValueOnce({ id: 'seed', asset_id: 'token', side: 'BUY',
      status: 'CANCELED', tradeEnumerationPresent: true, sizeMatched: '10', tradeIds: ['seed-trade'] });
    trading.getTradeStatuses.mockResolvedValueOnce([taker('BUY', { id: 'seed-trade', taker_order_id: 'seed' })]);
    await sub.reconcile();
    trading.createMarketOrder.mockClear(); trading.getOrderFillDetails.mockClear(); trading.getTradeStatuses.mockClear();
    sub.stats.tradesExecuted = 0; sub.stats.totalUsdcSpent = 0; sub.stats.totalFeesEstimateUsd = 0;
  }
  const record = vi.spyOn(CopyPnlTracker.prototype, 'recordFill');
  await incoming({ traderAddress: 'whale', side, tokenId: 'token', size: 100, price: .4, timestamp: Date.now() });
  return { trading, sub, record, onCopyPnl, flush: () => sub.reconcile(), incoming };
}
beforeEach(() => { vi.stubEnv('DRY_RUN', 'false'); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.each(['BUY', 'SELL'] as const)('P0.3j.1 %s factual authority', side => {
  it.each([
    { status: 'FAILED', transactionHash: 'not-a-hash', asset_id: 'wrong', taker_order_id: 'wrong' },
    { status: 'FAILED' }, { status: 'UNKNOWN' }, { status: 'MATCHED' }, { status: 'RETRYING' }, { status: undefined },
    { transactionHash: 'not-a-hash' }, { transactionHash: undefined }, { asset_id: 'wrong' },
    { side: side === 'BUY' ? 'SELL' : 'BUY' }, { taker_order_id: 'wrong' }, { trader_side: 'MAKER' },
    { maker_orders: undefined }, { price: '1.1' },
  ])('withholds FIFO for invalid trade %j and retains pending', async patch => {
    const h = await fixture(side); h.trading.getTradeStatuses.mockResolvedValue([taker(side, patch)]);
    await h.flush(); await h.flush(); expect(h.record).not.toHaveBeenCalled(); expect(h.onCopyPnl).not.toHaveBeenCalled();
    expect(h.sub.stats.realizedPnlUsd).toBe(0);
    h.trading.getTradeStatuses.mockResolvedValue([taker(side)]); await h.flush();
    expect(h.record).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('valid taker books once (guard=%s), preserving sizing and acceptance metrics', async guard => {
    const h = await fixture(side, guard);
    expect(h.record).not.toHaveBeenCalled(); expect(h.sub.stats.tradesExecuted).toBe(1);
    expect(h.sub.stats.totalUsdcSpent).toBe(4); expect(h.sub.stats.totalFeesEstimateUsd).toBe(.04);
    expect(h.trading.createMarketOrder.mock.calls[0]).toEqual([expect.objectContaining({ side, amount: side === 'BUY' ? 4 : 10 })]);
    await h.flush(); await h.flush();
    expect(h.record).toHaveBeenCalledTimes(1); expect(h.record).toHaveBeenCalledWith('token', side, 10, .5, .05);
  });
  it('maker uses exclusively the local allocation and its price among several makers', async () => {
    const h = await fixture(side);
    h.trading.getTradeStatuses.mockResolvedValue([taker(side, { trader_side: 'MAKER', taker_order_id: 'other',
      side: side === 'BUY' ? 'SELL' : 'BUY', size: '100', price: '.9', maker_orders: [
        { order_id: 'other-maker', asset_id: 'token', side, matched_amount: '90', price: '0.9' },
        { order_id: 'order', asset_id: 'token', side, matched_amount: '10', price: '0.4' },
      ] })]);
    await h.flush(); expect(h.record).toHaveBeenCalledWith('token', side, 10, .4, .04);
  });
  it.each(['missing', 'duplicate', 'wrong-token', 'wrong-side'])('rejects %s maker allocation', async kind => {
    const h = await fixture(side);
    const local = { order_id: 'order', asset_id: kind === 'wrong-token' ? 'wrong' : 'token',
      side: kind === 'wrong-side' ? (side === 'BUY' ? 'SELL' : 'BUY') : side, matched_amount: '10', price: '0.4' };
    h.trading.getTradeStatuses.mockResolvedValue([taker(side, { trader_side: 'MAKER', taker_order_id: 'other',
      side: side === 'BUY' ? 'SELL' : 'BUY', maker_orders: kind === 'missing' ? [] : kind === 'duplicate' ? [local, local] : [local] })]);
    await h.flush(); expect(h.record).not.toHaveBeenCalled();
  });
  it('partial 4/10 is retained conservatively, then accumulated once after complete evidence', async () => {
    const h = await fixture(side); h.trading.getTradeStatuses.mockResolvedValue([taker(side, { size: '4' })]);
    await h.flush(); await h.flush(); expect(h.record).not.toHaveBeenCalled();
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: 'token', side, sizeMatched: '10', tradeIds: ['a', 'b'] });
    h.trading.getTradeStatuses.mockResolvedValue([taker(side, { size: '4' }), taker(side, { id: 'b', size: '6', price: '0.4' })]);
    await h.flush(); await h.flush(); expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0][2]).toBe(10); expect(h.record.mock.calls[0][3]).toBeCloseTo(.44);
  });
  it('a factual partial amount consistent with matched never uses requested quantity', async () => {
    const h = await fixture(side); h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: 'token', side, sizeMatched: '4', tradeIds: ['a'] });
    h.trading.getTradeStatuses.mockResolvedValue([taker(side, { size: '4' })]);
    await h.flush(); expect(h.record).toHaveBeenCalledWith('token', side, 4, .5, .02);
  });
  it('conflicting metadata after a partial observation cannot replace known facts', async () => {
    const h = await fixture(side); h.trading.getTradeStatuses.mockResolvedValue([taker(side, { size: '4' })]); await h.flush();
    h.trading.getTradeStatuses.mockResolvedValue([taker(side, { size: '10' })]); await h.flush(); await h.flush();
    expect(h.record).not.toHaveBeenCalled();
  });
  it('lookup failure and missing children preserve pending', async () => {
    const h = await fixture(side); h.trading.getTradeStatuses.mockRejectedValueOnce(new Error('RPC')); await h.flush();
    h.trading.getTradeStatuses.mockResolvedValue([]); await h.flush(); expect(h.record).not.toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([taker(side)]); await h.flush(); expect(h.record).toHaveBeenCalledTimes(1);
  });
  it('duplicate trade records cannot double FIFO', async () => {
    const h = await fixture(side); h.trading.getTradeStatuses.mockResolvedValue([taker(side), taker(side)]); await h.flush();
    expect(h.record).not.toHaveBeenCalled();
  });
  it.each([{ id: 'wrong' }, { asset_id: 'wrong' }, { side: side === 'BUY' ? 'SELL' : 'BUY' }])('rejects contradictory order %j', async patch => {
    const h = await fixture(side); h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: 'token', side, sizeMatched: '10', tradeIds: ['a'], ...patch });
    await h.flush(); expect(h.record).not.toHaveBeenCalled();
  });
});


describe.each(['BUY', 'SELL'] as const)('P0.3j.1a %s incremental pending lifecycle', side => {
  const observe = (h: Awaited<ReturnType<typeof fixture>>, sizes: string[], status: string | undefined = 'MATCHED', maker = false) => {
    h.trading.getOrderFillDetails.mockResolvedValue({ id: 'order', asset_id: 'token', side, status,
      tradeEnumerationPresent: true, sizeMatched: String(sizes.reduce((n, v) => n + Number(v), 0)),
      tradeIds: sizes.map((_, i) => String(i)) });
    h.trading.getTradeStatuses.mockResolvedValue(sizes.map((size, i) => taker(side, { id: String(i), size, price: '0.4',
      ...(maker ? { trader_side: 'MAKER', taker_order_id: 'other', side: side === 'BUY' ? 'SELL' : 'BUY', size: '20',
        maker_orders: [{ order_id: 'order', asset_id: 'token', side, matched_amount: size, price: '0.4' },
          { order_id: 'other-maker', asset_id: 'token', side, matched_amount: String(20 - Number(size)), price: '0.8' }] } : {}) })));
  };
  it.each([false, true])('4 then +6 books only new facts and retains MATCHED even at full requested (maker=%s)', async maker => {
    const h = await fixture(side); observe(h, ['4'], 'MATCHED', maker);
    await h.flush(); await h.flush(); expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0][2]).toBe(4);
    observe(h, ['4', '6'], 'MATCHED', maker); await h.flush(); await h.flush();
    expect(h.record.mock.calls.map(c => c[2])).toEqual([4, 6]);
    const queried = h.trading.getOrderFillDetails.mock.calls.length; await h.flush();
    expect(h.trading.getOrderFillDetails.mock.calls.length).toBe(queried + 1);
    observe(h, ['4', '6'], 'CANCELED', maker); await h.flush();
    const terminalQueries = h.trading.getOrderFillDetails.mock.calls.length; await h.flush();
    expect(h.trading.getOrderFillDetails.mock.calls.length).toBe(terminalQueries);
    expect(h.record.mock.calls.map(c => c[2])).toEqual([4, 6]);
  });
  it('4 to 7 to 10 books 4, 3, 3 exactly once under concurrent reads', async () => {
    const h = await fixture(side);
    for (const sizes of [['4'], ['4', '3'], ['4', '3', '3']]) {
      observe(h, sizes); await Promise.all([h.flush(), h.flush()]);
    }
    expect(h.record.mock.calls.map(c => c[2])).toEqual([4, 3, 3]);
  });
  it.each([undefined, 'LIVE', 'MATCHED', 'UNKNOWN'])('status %s keeps factual partial pending', async status => {
    const h = await fixture(side); observe(h, ['4'], status);
    if (status === undefined) {
      const details = await h.trading.getOrderFillDetails(); delete details.status;
      h.trading.getOrderFillDetails.mockResolvedValue(details).mockClear();
    }
    await h.flush();
    h.trading.getOrderFillDetails.mockClear(); await h.flush();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls.map(c => c[2])).toEqual([4]);
  });
  it('lookup failure after partial retains prior accounting and discovers later fills', async () => {
    const h = await fixture(side); observe(h, ['4']); await h.flush();
    h.trading.getOrderFillDetails.mockRejectedValueOnce(new Error('RPC')); await h.flush();
    observe(h, ['4', '6'], 'CANCELED'); await h.flush();
    expect(h.record.mock.calls.map(c => c[2])).toEqual([4, 6]);
  });
  it('terminal status with missing child cannot remove pending', async () => {
    const h = await fixture(side); observe(h, ['4']); await h.flush();
    observe(h, ['4', '6'], 'CANCELED'); h.trading.getTradeStatuses.mockResolvedValue([taker(side, { id: '0', size: '4', price: '0.4' })]);
    await h.flush(); await h.flush(); expect(h.record.mock.calls.map(c => c[2])).toEqual([4]);
    observe(h, ['4', '6'], 'CANCELED'); await h.flush(); expect(h.record.mock.calls.map(c => c[2])).toEqual([4, 6]);
  });
  it('terminal status with conflicting consumed metadata cannot rewrite or release', async () => {
    const h = await fixture(side); observe(h, ['4']); await h.flush();
    observe(h, ['10'], 'CANCELED'); await h.flush(); await h.flush();
    expect(h.record.mock.calls.map(c => c[2])).toEqual([4]);
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(3);
  });
});
