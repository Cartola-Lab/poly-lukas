import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SmartMoneyService, type AutoCopyTradingOptions, type SmartMoneyTrade } from './smart-money-service.js';
import { CopyPnlTracker } from './copy-pnl-tracker.js';
const wallet = '0x' + '11'.repeat(20), whale = 'whale';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(extra: AutoCopyTradingOptions = {}) {
  let id = 0;
  const trading = {
    getAddress: () => wallet,
    createMarketOrder: vi.fn().mockImplementation(async () => ({ success: true, submissionState: 'ACCEPTED', orderId: `order-${++id}` })),
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
  type D = ConstructorParameters<typeof SmartMoneyService>;
  const service = new SmartMoneyService({} as D[0], {} as D[1], factualTrading as unknown as D[2]);
  const listeners = new Set<(t: SmartMoneyTrade) => void>();
  const captured: Array<(t: SmartMoneyTrade) => void> = [];
  const subscribe = vi.spyOn(service, 'subscribeSmartMoneyTrades').mockImplementation(callback => {
    captured.push(callback); listeners.add(callback);
    return { id: 'listener', unsubscribe: () => { listeners.delete(callback); } };
  });
  const onTrade = vi.fn(), onCopyPnl = vi.fn(), onError = vi.fn();
  const options: AutoCopyTradingOptions = { targetAddresses: [whale], minTradeSize: 1,
    inventoryAdmissionGuard: () => undefined, onTrade, onCopyPnl, onError, ...extra };
  const start = () => service.startAutoCopyTrading(options);
  const session = await start();
  const trade = (side: 'BUY' | 'SELL' = 'BUY'): SmartMoneyTrade => ({ traderAddress: whale, side,
    tokenId: 'token', size: 100, price: .4, timestamp: Date.now(), isSmartMoney: true });
  const emit = async (side: 'BUY' | 'SELL' = 'BUY') => { await Promise.all([...listeners].map(fn => fn(trade(side)))); };
  const protection = () => service.getInventoryProtection({ walletAddress: wallet, tokenIds: ['token'] });
  const terminal = (failed = false) => trading.getTradeStatuses.mockResolvedValue([{ id: 'child', status: failed ? 'FAILED' : 'MINED',
    size: '10', price: '0.4', ...(failed ? {} : { transactionHash: '0x' + '12'.repeat(32) }) }]);
  return { service, trading, listeners, captured, subscribe, options, session, start, trade, emit, protection, terminal,
    onTrade, onCopyPnl, onError };
}
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Smart Money single economic session pause/resume', () => {
  it('retains the same tracker and lot across pause/resume, then SELL closes it', async () => {
    const contexts: CopyPnlTracker[] = [];
    const original = CopyPnlTracker.prototype.recordFill;
    vi.spyOn(CopyPnlTracker.prototype, 'recordFill').mockImplementation(function(this: CopyPnlTracker, ...args) {
      contexts.push(this); return original.apply(this, args);
    });
    const h = await fixture(); await h.emit(); h.terminal(); await h.session.reconcile();
    const stats = JSON.stringify(h.session.stats);
    h.session.stop(); expect(h.session.isActive).toBe(false); expect(h.listeners.size).toBe(0);
    expect(h.protection()?.reason).toBe('SMART_MONEY_OPEN_LOT');
    await h.session.resume(); expect(JSON.stringify(h.session.stats)).toBe(stats);
    await h.emit('SELL'); await h.session.reconcile();
    expect(contexts).toHaveLength(2); expect(contexts[1]).toBe(contexts[0]);
    expect(h.protection()).toBeUndefined(); expect(h.onCopyPnl).toHaveBeenCalledTimes(1);
    expect(h.onCopyPnl.mock.calls[0][0].closedSize).toBe(10);
  });
  it.each(['pending', 'uncertain'])('%s survives stop and repeated start with the same handle', async kind => {
    const h = await fixture();
    if (kind === 'uncertain') h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'UNCERTAIN' });
    await h.emit(); const before = h.protection(); h.session.stop(); expect(h.protection()).toEqual(before);
    expect(await h.start()).toBe(h.session); expect(h.protection()).toEqual(before);
    await h.emit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('finalized identities survive resume and do not replay fills', async () => {
    const h = await fixture(); const fill = vi.spyOn(CopyPnlTracker.prototype, 'recordFill');
    await h.emit(); h.terminal(); await h.session.reconcile();
    h.session.stop(); await h.session.resume(); await h.session.reconcile();
    expect(fill).toHaveBeenCalledTimes(1);
    await h.emit('SELL'); await h.session.reconcile(); expect(h.protection()).toBeUndefined();
    h.trading.createMarketOrder.mockResolvedValueOnce({ success: true, submissionState: 'ACCEPTED', orderId: 'order-1' });
    await h.emit(); expect(h.protection()?.reason).toBe('SMART_MONEY_UNCERTAIN');
    expect(fill).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])('stale delay callback cannot execute after resume (dryRun=%s)', async dryRun => {
    vi.useFakeTimers(); const h = await fixture({ delay: 100, dryRun });
    const old = h.emit(); h.session.stop(); await h.session.resume();
    await vi.advanceTimersByTimeAsync(100); await old;
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled(); expect(h.onTrade).not.toHaveBeenCalled();
    expect(h.session.stats.tradesFailed).toBe(0); expect(h.protection()).toBeUndefined();
    const fresh = h.emit(); await vi.advanceTimersByTimeAsync(100); await fresh;
    expect(h.onTrade).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    if (!dryRun) { h.terminal(); await h.session.reconcile(); expect(h.onTrade).toHaveBeenCalledTimes(1); }
  });
  it('stale quote callback cannot register a writer or submit', async () => {
    const h = await fixture(), quote = deferred<any>();
    h.service.setMarketService({ getTokenOrderbook: () => quote.promise } as any);
    const old = h.emit(); h.session.stop(); await h.session.resume();
    quote.resolve({ asks: [{ price: .4, size: 100 }], bids: [{ price: .4, size: 100 }] }); await old;
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled(); expect(h.protection()).toBeUndefined();
    expect(h.session.stats.tradesFailed).toBe(0);
    await h.emit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('stale callback awaiting reconciliation cannot submit after resume', async () => {
    const h = await fixture(); await h.emit(); const details = deferred<any>();
    h.trading.getOrderFillDetails.mockReturnValueOnce(details.promise); h.terminal(true);
    const old = h.emit(); await Promise.resolve(); h.session.stop(); await h.session.resume();
    details.resolve({ tradeIds: ['child'], sizeMatched: '10' }); await old;
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1); expect(h.protection()).toBeUndefined();
    await h.emit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
  });
  it('reentrant inventory guard pause invalidates registration even if it returns allow', async () => {
    let pause = () => {};
    const h = await fixture({ inventoryAdmissionGuard: () => { pause(); return undefined; } });
    pause = () => h.session.stop(); await h.emit();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled(); expect(h.protection()).toBeUndefined();
    expect(h.session.stats.tradesFailed).toBe(0); expect(h.onTrade).not.toHaveBeenCalled();
  });
  it('reentrant risk guard pause prevents submission without failures', async () => {
    let pause = () => {};
    const h = await fixture({ preExecutionGuard: () => { pause(); return null; } });
    pause = () => h.session.stop(); await h.emit();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled(); expect(h.session.stats.tradesFailed).toBe(0);
  });
  it.each(['ACCEPTED', 'REJECTED', 'UNCERTAIN'])('post-submit %s result is processed after pause', async submissionState => {
    const h = await fixture(), response = deferred<any>(); h.trading.createMarketOrder.mockReturnValueOnce(response.promise);
    const running = h.emit(); expect(h.protection()?.reason).toBe('SMART_MONEY_ACTIVE'); h.session.stop();
    expect(() => h.session.dispose()).toThrow();
    response.resolve({ submissionState, success: submissionState === 'ACCEPTED', orderId: submissionState === 'ACCEPTED' ? 'submitted' : undefined });
    await running;
    expect(h.protection()?.reason).toBe(submissionState === 'ACCEPTED' ? 'SMART_MONEY_PENDING'
      : submissionState === 'UNCERTAIN' ? 'SMART_MONEY_UNCERTAIN' : undefined);
    expect(h.onTrade).not.toHaveBeenCalled();
    if (submissionState === 'ACCEPTED') { h.terminal(); await h.session.reconcile(); expect(h.protection()?.reason).toBe('SMART_MONEY_OPEN_LOT'); expect(h.onTrade).toHaveBeenCalledTimes(1); }
  });
  it.each([false, true])('concurrent reconciles share one promise (paused=%s)', async paused => {
    const h = await fixture(); await h.emit(); if (paused) h.session.stop();
    const details = deferred<any>(); h.trading.getOrderFillDetails.mockReturnValueOnce(details.promise); h.terminal(true);
    const a = h.session.reconcile(), b = h.session.reconcile(); expect(a).toBe(b);
    await Promise.resolve(); expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(1);
    expect(() => h.session.dispose()).toThrow();
    details.resolve({ tradeIds: ['child'], sizeMatched: '10' }); await a;
    expect(h.protection()).toBeUndefined();
  });
  it('repeated start/stop/resume retains the handle, stats and one listener', async () => {
    const h = await fixture(); const stats = h.session.stats;
    expect(await h.start()).toBe(h.session); expect(h.subscribe).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      h.session.stop(); h.session.stop(); expect(h.listeners.size).toBe(0);
      await Promise.all([h.session.resume(), h.session.resume(), h.start()]);
      expect(h.listeners.size).toBe(1); expect(h.session.isActive).toBe(true); expect(h.session.stats).toBe(stats);
    }
    expect(h.subscribe).toHaveBeenCalledTimes(4);
    await h.emit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    await h.captured[0](h.trade()); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('concurrent initial starts share the exact promise and one initialization', async () => {
    type D = ConstructorParameters<typeof SmartMoneyService>;
    const service = new SmartMoneyService({} as D[0], {} as D[1], {} as D[2]);
    const list = deferred<any>(); const lookup = vi.spyOn(service, 'getSmartMoneyList').mockReturnValue(list.promise);
    const subscribe = vi.spyOn(service, 'subscribeSmartMoneyTrades').mockReturnValue({ id: 'sub', unsubscribe: vi.fn() });
    const options = { topN: 1 };
    const a = service.startAutoCopyTrading(options), b = service.startAutoCopyTrading(options); expect(a).toBe(b);
    await Promise.resolve(); expect(lookup).toHaveBeenCalledTimes(1); list.resolve([{ address: whale, pnl: 1 }]);
    expect(await a).toBe(await b); expect(subscribe).toHaveBeenCalledTimes(1);
  });
  it('incompatible options are explicit and cannot replace the economic context', async () => {
    const h = await fixture(); await expect(h.service.startAutoCopyTrading({ ...h.options, sizeScale: .7 })).rejects.toThrow('Incompatible');
    expect(await h.start()).toBe(h.session); expect(h.subscribe).toHaveBeenCalledTimes(1);
  });
  it('failed listener reinstallation stays paused and can retry', async () => {
    const h = await fixture(); h.session.stop(); h.subscribe.mockImplementationOnce(() => { throw new Error('listener'); });
    await expect(h.session.resume()).rejects.toThrow('listener'); expect(h.session.isActive).toBe(false);
    await h.session.resume(); expect(h.session.isActive).toBe(true); expect(h.listeners.size).toBe(1);
  });
  it('pause invalidates a queued resume before listener installation', async () => {
    const h = await fixture(); h.session.stop(); const resuming = h.session.resume(); h.session.stop(); await resuming;
    expect(h.listeners.size).toBe(0); expect(h.session.isActive).toBe(false);
    await h.session.resume(); expect(h.listeners.size).toBe(1);
  });
  it('resume immediately after cancelling another resume still installs one current listener', async () => {
    const h = await fixture(); h.session.stop(); const old = h.session.resume(); h.session.stop();
    const fresh = h.session.resume(); await Promise.all([old, fresh]);
    expect(h.session.isActive).toBe(true); expect(h.listeners.size).toBe(1);
    await h.emit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('real listener installation failure removes its handler and retains the economic session for retry', async () => {
    type D = ConstructorParameters<typeof SmartMoneyService>;
    const transport = { subscribeAllActivity: vi.fn().mockImplementationOnce(() => { throw new Error('connect'); })
      .mockReturnValue({ unsubscribe: vi.fn() }) };
    const service = new SmartMoneyService({} as D[0], transport as unknown as D[1], {} as D[2]);
    vi.spyOn(service, 'getSmartMoneyList').mockResolvedValue([]);
    const options = { targetAddresses: [whale] };
    await expect(service.startAutoCopyTrading(options)).rejects.toThrow('connect');
    expect((service as any).tradeHandlers.size).toBe(0);
    const retained = (service as any).copySession;
    expect(retained.isActive).toBe(false);
    const session = await service.startAutoCopyTrading(options);
    expect(session).toBe(retained); expect((service as any).tradeHandlers.size).toBe(1);
    session.stop(); expect((service as any).tradeHandlers.size).toBe(0);
  });
  it.each(['pending', 'uncertain', 'positive', 'negative'])('dispose refuses %s lifecycle while paused', async kind => {
    const h = await fixture();
    if (kind === 'uncertain') h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'UNCERTAIN' });
    await h.emit(kind === 'negative' ? 'SELL' : 'BUY');
    if (kind === 'positive' || kind === 'negative') { h.terminal(); await h.session.reconcile(); }
    h.session.stop(); const before = h.protection(); expect(() => h.session.dispose()).toThrow(); expect(h.protection()).toEqual(before);
  });
  it('safe dispose is terminal and cannot create a new authority', async () => {
    const h = await fixture(); expect(() => h.session.dispose()).toThrow();
    h.session.stop(); h.session.dispose(); h.session.dispose();
    await expect(h.session.resume()).rejects.toThrow('disposed'); await expect(h.start()).rejects.toThrow('disposed');
    await expect(h.session.reconcile()).rejects.toThrow('disposed'); expect(h.listeners.size).toBe(0);
  });
  it('terminal failed tombstone permits safe dispose', async () => {
    const h = await fixture(); await h.emit(); h.session.stop(); h.terminal(true); await h.session.reconcile();
    expect(() => h.session.dispose()).not.toThrow();
  });
});

const effectiveDefaults = {
  sizeScale: .1, maxSizePerTrade: 50, maxSlippage: .03, orderType: 'FOK',
  minTradeSize: 10, delay: 0, dryRun: false, maxStalenessMs: 5000,
  maxSpreadPct: .02, maxCopyPremiumPct: .01, maxConsecutiveFailures: 3,
  walletCooldownMs: 3600000, feeRateBps: 0, minWalletPnl: 0, topN: 0,
} satisfies Partial<AutoCopyTradingOptions>;
const equivalences = Object.entries(effectiveDefaults).flatMap(([key, value]) =>
  [false, true].map(explicitFirst => ({ key, value, explicitFirst })));

describe('Smart Money effective session option compatibility', () => {
  it.each(equivalences)('$key equivalent defaults (explicit first=$explicitFirst) retain the same session', async ({ key, value, explicitFirst }) => {
    const h = await fixture({ [key]: explicitFirst ? value : undefined });
    await h.emit();
    const context = [...(h.service as any).inventoryContexts][0];
    const before = h.protection();
    const options = { ...h.options, [key]: explicitFirst ? undefined : value };
    expect(await h.service.startAutoCopyTrading(options)).toBe(h.session);
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    h.session.stop();
    const resumed = await h.service.startAutoCopyTrading(options);
    expect(resumed).toBe(h.session); expect(resumed.isActive).toBe(true);
    expect(h.protection()).toEqual(before);
    expect([...(h.service as any).inventoryContexts]).toEqual([context]);
    expect(h.listeners.size).toBe(1); expect(h.subscribe).toHaveBeenCalledTimes(2);
    await h.emit(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    h.terminal(); await h.session.reconcile(); await h.emit('SELL'); await h.session.reconcile();
    expect(h.protection()).toBeUndefined(); expect(h.onCopyPnl).toHaveBeenCalledTimes(1);
  });
  it.each(['onTrade', 'onCopyPnl', 'onError', 'preExecutionGuard', 'inventoryAdmissionGuard'] as const)('%s remains identity-bound', async key => {
    const original = () => undefined;
    const h = await fixture({ [key]: original });
    h.session.stop();
    await expect(h.service.startAutoCopyTrading({ ...h.options, [key]: () => undefined })).rejects.toThrow('Incompatible');
    expect(h.session.isActive).toBe(false);
    expect(await h.service.startAutoCopyTrading({ ...h.options, [key]: original })).toBe(h.session);
    expect(h.listeners.size).toBe(1);
  });
  it('equivalent normalized target addresses retain one handle', async () => {
    const address = '0x' + 'ab'.repeat(20);
    const h = await fixture({ targetAddresses: [address] }); h.session.stop();
    expect(await h.service.startAutoCopyTrading({ ...h.options,
      targetAddresses: ['0x' + 'AB'.repeat(20), address] })).toBe(h.session);
    expect(h.session.targetAddresses).toEqual([address]); expect(h.listeners.size).toBe(1);
  });
  it.each([{ sizeScale: .2 }, { orderType: 'FAK' as const }, { feeRateBps: 1 }])('different effective values remain incompatible: %j', async difference => {
    const h = await fixture(); h.session.stop();
    await expect(h.service.startAutoCopyTrading({ ...h.options, ...difference })).rejects.toThrow('Incompatible');
    expect(h.session.isActive).toBe(false); expect(h.subscribe).toHaveBeenCalledTimes(1);
  });
});
