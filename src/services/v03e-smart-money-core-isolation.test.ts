import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmartMoneyService, type SmartMoneyTrade, type AutoCopyTradingOptions } from './smart-money-service.js';
import { CopyPnlTracker } from './copy-pnl-tracker.js';

const wallet = '0x' + 'ab'.repeat(20);
const whale = '0x' + '11'.repeat(20);
const otherWallet = '0x' + '22'.repeat(20);
const accepted = (orderId: string) => ({ success: true, submissionState: 'ACCEPTED', orderId });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(guard: AutoCopyTradingOptions['inventoryAdmissionGuard'] | null = () => undefined) {
  let nextId = 0;
  const trading = {
    getAddress: vi.fn().mockReturnValue(wallet),
    createMarketOrder: vi.fn().mockImplementation(async () => accepted(`order-${++nextId}`)),
    getOrderFillDetails: vi.fn().mockResolvedValue({ tradeIds: ['child'], sizeMatched: '10' }),
    getTradeStatuses: vi.fn().mockResolvedValue([{ id: 'child', status: 'MATCHED', size: '10', price: '0.4' }]),
  };
  // V2 transport fixture: retain the actual submitted order identity.
  const submitted = new Map<string, any>();
  let queriedOrder = '';
  const factualTrading = { ...trading,
    createMarketOrder: async (params: any) => {
      const result = await (trading.createMarketOrder as any)(params);
      if (result.orderId) submitted.set(result.orderId, params);
      return result;
    },
    getOrderFillDetails: async (id: string) => {
      queriedOrder = id;
      return { id, status: 'CANCELED', tradeEnumerationPresent: true, asset_id: submitted.get(id)?.tokenId, side: submitted.get(id)?.side,
        ...await (trading.getOrderFillDetails as any)(id) };
    },
    getTradeStatuses: async (ids: string[]) => (await (trading.getTradeStatuses as any)(ids)).map((row: any) => ({
      asset_id: submitted.get(queriedOrder)?.tokenId, side: submitted.get(queriedOrder)?.side,
      taker_order_id: queriedOrder, trader_side: 'TAKER', maker_orders: [], ...row,
    })),
  };
  type Dependencies = ConstructorParameters<typeof SmartMoneyService>;
  const service = new SmartMoneyService({} as Dependencies[0], {} as Dependencies[1], factualTrading as unknown as Dependencies[2]);
  let incoming!: (trade: SmartMoneyTrade) => Promise<void>;
  vi.spyOn(service, 'subscribeSmartMoneyTrades').mockImplementation(callback => {
    incoming = callback as typeof incoming;
    return { id: 'sub', unsubscribe: vi.fn() };
  });
  const onTrade = vi.fn(), onCopyPnl = vi.fn(), onError = vi.fn();
  const sub = await service.startAutoCopyTrading({ targetAddresses: [whale], minTradeSize: 1,
    sizeScale: .1, inventoryAdmissionGuard: guard ?? undefined, onTrade, onCopyPnl, onError });
  const emit = (side: 'BUY' | 'SELL' = 'BUY', tokenId = 'token', traderAddress = whale) => incoming({
    traderAddress, tokenId, side, size: 100, price: .4, timestamp: Date.now(), isSmartMoney: true,
  });
  const flush = () => emit('BUY', 'ignored', otherWallet);
  const terminal = (size = '10', failed = false) => {
    trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['child'], sizeMatched: size });
    trading.getTradeStatuses.mockResolvedValue([{ id: 'child', status: failed ? 'FAILED' : 'MINED', size,
      price: '0.4', ...(failed ? {} : { transactionHash: '0x' + '12'.repeat(32) }) }]);
  };
  const protection = (tokenId = 'token', address = wallet) => service.getInventoryProtection({ walletAddress: address, tokenIds: [tokenId] });
  return { service, trading, emit, flush, terminal, protection, sub, onTrade, onCopyPnl, onError };
}
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('P0.3e Smart Money core inventory isolation', () => {
  it.each(['BUY', 'SELL'] as const)('external guard blocks %s operationally without accounting', async side => {
    const guard = vi.fn<NonNullable<AutoCopyTradingOptions['inventoryAdmissionGuard']>>(() => 'short protected');
    const h = await fixture(guard);
    const record = vi.spyOn(CopyPnlTracker.prototype, 'recordFill');
    await h.emit(side);
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    expect(h.onTrade).not.toHaveBeenCalled(); expect(h.onCopyPnl).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    expect(h.sub.stats).toMatchObject({ tradesExecuted: 0, tradesFailed: 0, totalUsdcSpent: 0,
      totalFeesEstimateUsd: 0, realizedPnlUsd: 0 });
    expect(h.protection()).toBeUndefined();
    expect(guard).toHaveBeenCalledWith({ walletAddress: wallet, tokenIds: ['token'], side, source: 'SMART_MONEY' });
    expect(Object.isFrozen(guard.mock.calls[0][0])).toBe(true);
  });
  it.each(['token', 'wallet'])('external protection for another %s permits writing', async kind => {
    const h = await fixture(q => q.walletAddress === wallet && q.tokenIds.includes('token') ? 'blocked' : undefined);
    if (kind === 'wallet') h.trading.getAddress.mockReturnValue(otherWallet);
    await h.emit('BUY', kind === 'token' ? 'other' : 'token');
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.protection('token', kind === 'wallet' ? wallet : otherWallet)).toBeUndefined();
  });
  it.each(['', 'invalid'])('invalid executor identity %s fails closed', async address => {
    const h = await fixture(); h.trading.getAddress.mockReturnValue(address); await h.emit();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled(); expect(h.sub.stats.tradesFailed).toBe(0);
  });
  it('normalizes the factual signer, never the watched whale', async () => {
    const guard = vi.fn<NonNullable<AutoCopyTradingOptions['inventoryAdmissionGuard']>>(() => undefined);
    const h = await fixture(guard); h.trading.getAddress.mockReturnValue('0x' + 'AB'.repeat(20));
    await h.emit(); expect(guard.mock.calls[0][0].walletAddress).toBe(wallet);
    expect(h.protection('token', whale)).toBeUndefined(); expect(h.protection()).toBeDefined();
  });
  it('guard exception is operational, not a failed trade', async () => {
    const h = await fixture(() => { throw new Error('unavailable'); }); await h.emit();
    expect(h.sub.stats.tradesFailed).toBe(0); expect(h.onError).not.toHaveBeenCalled();
  });
  it.each(['BUY', 'SELL'] as const)('%s writer owns token before transport and through pending', async side => {
    const h = await fixture(), finish = deferred<any>();
    h.trading.createMarketOrder.mockImplementationOnce(() => {
      expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_ACTIVE' }); return finish.promise;
    });
    const running = h.emit(side);
    expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_ACTIVE' });
    await h.emit(side); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    finish.resolve(accepted('first')); await running;
    expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_PENDING', operationId: 'first' });
    await h.flush(); expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_PENDING' });
  });
  it('ACCEPTED registers pending before active deletion even under reentrant observation', async () => {
    const h = await fixture();
    const contexts = (h.service as any).inventoryContexts as Set<any>;
    const context = [...contexts][0];
    const original = context.pending.set.bind(context.pending);
    context.pending.set = (id: string, value: unknown) => {
      expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_ACTIVE' });
      return original(id, value);
    };
    h.onTrade.mockImplementation(() => expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_PENDING' }));
    await h.emit(); expect(h.onTrade).not.toHaveBeenCalled();
    h.terminal(); await h.flush(); expect(h.onTrade).toHaveBeenCalledTimes(1);
  });
  it('REJECTED releases only the attempt', async () => {
    const h = await fixture(); h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'REJECTED' });
    await h.emit(); expect(h.protection()).toBeUndefined();
  });
  it.each([
    { success: false, submissionState: 'UNCERTAIN' },
    { success: true, submissionState: 'UNCERTAIN', orderId: 'maybe' },
    { success: true, submissionState: 'ACCEPTED', orderId: ' ' },
    { success: true },
    { success: true, orderId: 'legacy' },
  ])('ambiguous result %j retains protection', async result => {
    const h = await fixture(); h.trading.createMarketOrder.mockResolvedValueOnce(result);
    await h.emit(); expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_UNCERTAIN' });
    await h.emit('SELL'); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('submission exception retains protection regardless of text', async () => {
    const h = await fixture(); h.trading.createMarketOrder.mockRejectedValueOnce(new Error('REJECTED'));
    await h.emit(); expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_UNCERTAIN' });
  });
  it('pending-to-lot handoff remains protected inside recordFill', async () => {
    const h = await fixture(); await h.emit(); h.terminal();
    const original = CopyPnlTracker.prototype.recordFill;
    vi.spyOn(CopyPnlTracker.prototype, 'recordFill').mockImplementation(function(this: CopyPnlTracker, ...args) {
      expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_PENDING' });
      return original.apply(this, args);
    });
    await h.flush(); expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_OPEN_LOT' });
  });
  it('BUY lot blocks a second BUY, allows partial SELL and releases after full factual close', async () => {
    const h = await fixture(); await h.emit(); h.terminal(); await h.flush();
    const stats = { ...h.sub.stats }; await h.emit();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.sub.stats.tradesFailed).toBe(stats.tradesFailed);
    await h.emit('SELL'); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    h.terminal('4'); await h.flush(); expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_OPEN_LOT' });
    await h.emit('SELL'); h.terminal('6'); await h.flush();
    expect(h.protection()).toBeUndefined(); expect(h.onCopyPnl).toHaveBeenCalledTimes(2);
    expect(h.onCopyPnl.mock.calls.map(c => c[0].closedSize)).toEqual([4, 6]);
  });
  it('SELL without known inventory stays pending and cannot be cleared by a new BUY', async () => {
    const h = await fixture(); await h.emit('SELL'); h.terminal(); await h.flush();
    expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_PENDING', unresolvedSellShares: 10 });
    await h.emit('SELL'); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    await h.emit('BUY'); h.terminal(); await h.flush();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_PENDING', unresolvedSellShares: 10 });
  });
  it('all FAILED terminal tombstone alone releases', async () => {
    const h = await fixture(); await h.emit(); h.terminal('10', true); await h.flush();
    expect(h.protection()).toBeUndefined(); expect(h.onCopyPnl).not.toHaveBeenCalled();
    await h.emit(); expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_PENDING', operationId: 'order-2' });
  });
  it('rejected exit does not release the earlier open lot', async () => {
    const h = await fixture(); await h.emit(); h.terminal(); await h.flush();
    h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'REJECTED' });
    await h.emit('SELL'); expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_OPEN_LOT' });
  });
  it('terminal failure of an exit preserves the original lot', async () => {
    const h = await fixture(); await h.emit(); h.terminal(); await h.flush();
    await h.emit('SELL'); h.terminal('10', true); await h.flush();
    expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_OPEN_LOT' });
  });
  it('reentrant admission cannot clear the first operation on the same token', async () => {
    let h!: Awaited<ReturnType<typeof fixture>>, nested!: Promise<void>, once = false;
    h = await fixture(() => { if (!once) { once = true; nested = h.emit(); } return undefined; });
    const finish = deferred<any>(); h.trading.createMarketOrder.mockReturnValueOnce(finish.promise);
    await h.emit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_ACTIVE' });
    finish.resolve(accepted('first')); await nested;
    expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_PENDING' });
  });
  it('operation on another token does not clear an ambiguous writer', async () => {
    const h = await fixture(); h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'UNCERTAIN' });
    await h.emit(); await h.emit('BUY', 'other'); h.terminal('10', true); await h.flush();
    expect(h.protection('other')).toBeUndefined(); expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_UNCERTAIN' });
  });
  it('read-only snapshot is frozen and contains no mutable lifecycle objects', async () => {
    const h = await fixture(); await h.emit(); const snapshot = h.protection()!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.keys(snapshot).sort()).toEqual(['blocked', 'operationId', 'reason']);
    expect(() => { (snapshot as any).reason = 'free'; }).toThrow();
    expect(h.protection()).toEqual(snapshot); expect(h.protection()).not.toBe(snapshot);
  });
  it.each(['BUY', 'SELL'] as const)('%s sizing remains unchanged', async side => {
    const h = await fixture(); await h.emit(side);
    expect(h.trading.createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      side, amount: side === 'BUY' ? 4 : 10, orderType: 'FOK', tokenId: 'token',
    }));
  });
  it('without the guard preserves legacy submission behavior', async () => {
    const h = await fixture(null);
    h.trading.createMarketOrder.mockResolvedValue({ success: true, orderId: 'legacy' });
    await h.emit(); await h.emit();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.trading.getAddress).not.toHaveBeenCalled();
    expect(h.protection()).toBeUndefined();
    h.terminal(); await h.flush();
    expect(h.sub.stats.tradesExecuted).toBe(1);
  });
  it('admission runs after asynchronous quote preparation', async () => {
    const guard = vi.fn<NonNullable<AutoCopyTradingOptions['inventoryAdmissionGuard']>>(() => undefined);
    const h = await fixture(guard), quote = deferred<any>();
    h.service.setMarketService({ getTokenOrderbook: () => quote.promise } as any);
    const running = h.emit(); expect(guard).not.toHaveBeenCalled();
    guard.mockReturnValue('short started during quote');
    quote.resolve({ asks: [{ price: .4, size: 100 }], bids: [{ price: .4, size: 100 }] });
    await running; expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  });
  it('failed accounting transition remains protected without replay', async () => {
    const h = await fixture(); await h.emit(); h.terminal();
    const record = vi.spyOn(CopyPnlTracker.prototype, 'recordFill').mockImplementation(() => { throw new Error('accounting'); });
    await h.flush(); await h.flush();
    expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_PENDING' });
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('duplicate accepted order identity cannot release a new attempt', async () => {
    const h = await fixture(); await h.emit(); h.terminal('10', true); await h.flush();
    h.trading.createMarketOrder.mockResolvedValueOnce(accepted('order-1'));
    await h.emit(); expect(h.protection()).toMatchObject({ reason: 'SMART_MONEY_UNCERTAIN' });
  });
  it('onTrade exception after factual execution does not orphan its lifecycle', async () => {
    const h = await fixture(); h.onTrade.mockImplementation(() => { throw new Error('callback'); });
    await h.emit(); expect(h.onTrade).not.toHaveBeenCalled(); h.terminal(); await h.flush();
    expect(h.onTrade).toHaveBeenCalledTimes(1); expect(h.protection()?.reason).toBe('SMART_MONEY_OPEN_LOT');
  });
  it('onCopyPnl exception after full close does not retain a stale lock or replay accounting', async () => {
    const h = await fixture(); await h.emit(); h.terminal(); await h.flush(); await h.emit('SELL');
    h.onCopyPnl.mockImplementation(() => { throw new Error('callback'); });
    await h.flush(); expect(h.protection()).toBeUndefined(); await h.flush();
    expect(h.onCopyPnl).toHaveBeenCalledTimes(1);
  });
});
