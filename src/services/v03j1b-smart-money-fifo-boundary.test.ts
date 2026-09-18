import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmartMoneyService } from './smart-money-service.js';
import { CopyPnlTracker } from './copy-pnl-tracker.js';
const wallet = '0x' + 'ab'.repeat(20), hash = '0x' + '12'.repeat(32);
beforeEach(() => { vi.stubEnv('DRY_RUN', 'false'); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture(feeRateBps = 0, guarded = true) {
  let incoming: any, next = 0;
  const orders = new Map<string, any>();
  const trackerSpy = vi.spyOn(CopyPnlTracker.prototype, 'recordFill');
  const trading = { getAddress: () => wallet,
    createMarketOrder: vi.fn(async (params: any) => {
      const id = String(++next); orders.set(id, { params, sizes: [], price: '0.4', status: 'MATCHED' });
      return { success: true, submissionState: 'ACCEPTED', orderId: id };
    }),
    getOrderFillDetails: vi.fn(async (id: string) => {
      const o = orders.get(id); return { id, asset_id: o.params.tokenId, side: o.params.side,
        status: o.status, tradeEnumerationPresent: true, sizeMatched: String(o.sizes.reduce((a: number,b: number) => a+b,0)),
        tradeIds: o.sizes.map((_: any, i: number) => id + ':' + i) };
    }),
    getTradeStatuses: vi.fn(async (ids: string[]) => ids.map(id => {
      const [order, index] = id.split(':'), o = orders.get(order);
      return { id, status: o.invalid ? 'UNKNOWN' : 'CONFIRMED', transactionHash: hash,
        asset_id: o.params.tokenId, side: o.maker ? 'BUY' : o.params.side,
        taker_order_id: o.maker ? 'other' : order, trader_side: o.maker ? 'MAKER' : 'TAKER',
        size: o.maker ? '100' : String(o.sizes[Number(index)]), price: o.price,
        maker_orders: o.maker ? [{ order_id: order, asset_id: o.params.tokenId, side: 'SELL',
          matched_amount: String(o.sizes[Number(index)]), price: o.price }] : [] };
    })) };
  const service = new SmartMoneyService({} as any, {} as any, trading as any);
  vi.spyOn(service, 'subscribeSmartMoneyTrades').mockImplementation(cb => { incoming = cb; return { id: 's', unsubscribe() {} }; });
  const sub = await service.startAutoCopyTrading({ targetAddresses: ['whale'], minTradeSize: 1, delay: 0,
    feeRateBps, inventoryAdmissionGuard: guarded ? () => undefined : undefined });
  const submit = async (side: string, token = 'token') => {
    await incoming({ traderAddress: 'whale', side, tokenId: token, size: 100, price: .4, timestamp: Date.now() });
    return String(next);
  };
  const observe = async (id: string, sizes: number[], price = '0.5', patch = {}) => {
    Object.assign(orders.get(id), { sizes, price, ...patch }); await sub.reconcile();
  };
  const tracker = () => trackerSpy.mock.contexts[0] as CopyPnlTracker;
  const protection = () => service.getInventoryProtection({ walletAddress: wallet, tokenIds: ['token'] });
  return { submit, observe, sub, tracker, trackerSpy, protection, trading, orders };
}
describe('P0.3j.1b FIFO authority', () => {
  it.each([{buy:4,sell:10,remaining:0,excess:6,pnl:.4}, {buy:10,sell:4,remaining:6,excess:0,pnl:.4},
    {buy:10,sell:10,remaining:0,excess:0,pnl:1}, {buy:0,sell:5,remaining:0,excess:5,pnl:0}])('%j', async c => {
    const h = await fixture();
    if (c.buy) await h.observe(await h.submit('BUY'), [c.buy], '0.4', {status:'CANCELED'});
    await h.observe(await h.submit('SELL'), [c.sell], '0.5', {status:'CANCELED'});
    await h.sub.reconcile(); await h.sub.reconcile();
    if (!c.buy) expect(h.trackerSpy).not.toHaveBeenCalled();
    const lots = c.buy ? h.tracker().openLots('token') : [];
    expect(lots.every(l => l.qty >= 0)).toBe(true);
    expect(lots.reduce((a,l) => a+l.qty,0)).toBe(c.remaining);
    expect(h.sub.stats.realizedPnlUsd).toBeCloseTo(c.pnl);
    expect(h.protection()?.unresolvedSellShares ?? 0).toBe(c.excess);
  });
  it.each([false,true])('maker=%s retains excess and proportionate fees, not synthetic short', async maker => {
    const h = await fixture(100); await h.observe(await h.submit('BUY'), [4], '0.4', {status:'CANCELED'});
    await h.observe(await h.submit('SELL'), [10], '0.5', {status:'CANCELED',maker});
    expect(h.tracker().openLots('token')).toEqual([]);
    expect(h.sub.stats.realizedPnlUsd).toBeCloseTo(.4-.016-.02);
    expect(h.protection()?.unresolvedSellShares).toBe(6);
  });
  it('partial BUY and incremental SELL preserve facts once; late BUY does not auto-consume excess', async () => {
    const h = await fixture(0, false); const buy = await h.submit('BUY'); await h.observe(buy,[4],'0.4');
    // Optional guard disabled allows concurrent orders whose BUY facts arrive late.
    const sell = await h.submit('SELL'); await h.observe(sell,[4]);
    await h.observe(sell,[4,6]); await Promise.all([h.sub.reconcile(), h.sub.reconcile()]);
    expect(h.sub.stats.realizedPnlUsd).toBeCloseTo(.4);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.tracker().openLots('token')).toEqual([]);
    await h.observe(buy,[4,6],'0.4',{status:'CANCELED'});
    expect(h.tracker().openLots('token').map(l=>l.qty)).toEqual([6]);
    await h.observe(sell,[4,6],'0.5',{status:'CANCELED'});
    h.trading.getOrderFillDetails.mockClear(); await h.sub.reconcile();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledWith(sell);
    expect(h.sub.stats.realizedPnlUsd).toBeCloseTo(.4);
    expect(h.tracker().openLots('token').map(l=>l.qty)).toEqual([6]);
  });
  it('multiple FIFO lots use only their known cost and preserve other token', async () => {
    const h = await fixture(); await h.observe(await h.submit('BUY'),[2,3],'0.3',{status:'CANCELED'});
    // Separate prices within the FIFO use a late delta on the same BUY.
    expect(h.tracker().openLots('token').every(l=>l.qty>0)).toBe(true);
    await h.observe(await h.submit('BUY','other'),[20],'0.1',{status:'CANCELED'});
    await h.observe(await h.submit('SELL'),[8],'0.7',{status:'CANCELED'});
    expect(h.tracker().openLots('token')).toEqual([]);
    expect(h.tracker().openLots('other').map(l=>l.qty)).toEqual([20]);
    expect(h.protection()?.unresolvedSellShares).toBe(3);
    expect(h.sub.stats.realizedPnlUsd).toBeCloseTo(2);
  });
  it('two cost lots 2 at .30 and 3 at .40 retain FIFO accounting', async () => {
    const h = await fixture(); const buy=await h.submit('BUY'); await h.observe(buy,[2],'0.3');
    // Return each factual child with its own price; the previous identity stays unchanged.
    const read = h.trading.getTradeStatuses.getMockImplementation()!;
    h.trading.getTradeStatuses.mockImplementation(async ids => (await read(ids)).map(t=>({...t,price:t.id===buy+':0'?'0.3':t.price})));
    await h.observe(buy,[2,3],'0.4',{status:'CANCELED'});
    await h.observe(await h.submit('SELL'),[8],'0.5',{status:'CANCELED'});
    expect(h.tracker().openLots('token')).toEqual([]);
    expect(h.sub.stats.realizedPnlUsd).toBeCloseTo(.7);
    expect(h.protection()?.unresolvedSellShares).toBe(3);
  });
  it('incremental oversell accumulates only new excess and survives terminal cancellation', async () => {
    const h = await fixture(); await h.observe(await h.submit('BUY'),[4],'0.4',{status:'CANCELED'});
    const sell=await h.submit('SELL'); await h.observe(sell,[4]);
    await h.observe(sell,[4,3]); expect(h.protection()?.unresolvedSellShares).toBe(3);
    await h.sub.reconcile(); expect(h.protection()?.unresolvedSellShares).toBe(3);
    await h.observe(sell,[4,3,3],'0.5',{status:'CANCELED'});
    await Promise.all([h.sub.reconcile(),h.sub.reconcile()]);
    expect(h.protection()?.unresolvedSellShares).toBe(6);
    expect(h.tracker().openLots('token')).toEqual([]);
    expect(h.sub.stats.realizedPnlUsd).toBeCloseTo(.4);
    expect(h.trackerSpy.mock.calls.filter(c=>c[1]==='SELL').map(c=>c[2])).toEqual([4]);
  });
  it('different token inventory cannot fund a SELL and different orders keep independent facts', async () => {
    const h=await fixture(0,false); await h.observe(await h.submit('BUY','other'),[20],'0.4',{status:'CANCELED'});
    const a=await h.submit('SELL'), b=await h.submit('SELL');
    await h.observe(a,[5],'0.5',{status:'CANCELED'}); await h.observe(b,[6],'0.5',{status:'CANCELED'});
    h.trading.getOrderFillDetails.mockClear(); await h.sub.reconcile();
    expect(h.trading.getOrderFillDetails.mock.calls.map(c=>c[0])).toEqual([a,b]);
    expect(h.trackerSpy.mock.calls.filter(c=>c[1]==='SELL')).toEqual([]);
    expect(h.tracker().openLots('other').map(l=>l.qty)).toEqual([20]);
    expect(h.tracker().openLots('token')).toEqual([]);
    expect(h.sub.stats.realizedPnlUsd).toBe(0);
  });

});
