import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ethers } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmartMoneyService } from './smart-money-service.js';
import { ArbitrageService, type ArbitrageOpportunity } from './arbitrage-service.js';
const wallet = '0x' + 'ab'.repeat(20), otherWallet = '0x' + '22'.repeat(20);
const op: ArbitrageOpportunity = { type: 'short', profitRate: .1, profitPercent: 10,
  effectivePrices: { buyYes: .4, buyNo: .5, sellYes: .6, sellNo: .5 },
  priceCaps: { buyYes: .41, buyNo: .51, sellYes: .59, sellNo: .49 },
  maxOrderbookSize: 20, maxBalanceSize: 20, recommendedSize: 10, estimatedProfit: 1,
  description: 'wiring', timestamp: 1 };
const accepted = (orderId: string) => ({ success: true, submissionState: 'ACCEPTED' as const, orderId });
function deferred() { let resolve!: (x: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

// Execute the entrypoints' actual setup, callbacks and toggle functions with offline transports.
// bot-config has no toggle function: its actual copy-start statements are replayed.
async function fixture(entry: string, address = wallet, boot = true, arbEnabled = true) {
  const dashboard = entry === 'bot-with-dashboard.ts';
  const source = readFileSync(new URL('../../' + entry, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(entry, source, ts.ScriptTarget.ES2022, true);
  const names = new Set(['arbService', 'copySubscription', 'smartMoneyCallbacks', 'setupArbitrage',
    ...(dashboard ? ['startSmartMoneyCopy', 'stopSmartMoneyCopy', 'directEntries', 'pendingBuys',
      'pendingCloses', 'activeInventoryWriters', 'inventoryWallet', 'dashboardInventoryConflict'] : [])]);
  const selected = ast.statements.filter(s => ts.isVariableStatement(s)
    ? s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && names.has(d.name.text))
    : ts.isFunctionDeclaration(s) && !!s.name && names.has(s.name.text));
  const setup = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'setupSmartMoney') as ts.FunctionDeclaration;
  const configStart = dashboard ? '' : setup.body!.statements.slice(setup.body!.statements.findIndex(s => s.getText(ast).startsWith('state.followedWallets = qualified'))).map(s => s.getText(ast)).join('\n');
  const main = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'main') as ts.FunctionDeclaration;
  const bootCalls = main.body!.statements.filter(s => /^await setup(SmartMoney|Arbitrage)\(sdk\);$/.test(s.getText(ast))).map(s => s.getText(ast));
  expect(bootCalls).toEqual(['await setupArbitrage(sdk);', 'await setupSmartMoney(sdk);']);
  let n = 0, terminal = false, session: any;
  const trading = { getAddress: () => address,
    createMarketOrder: vi.fn().mockImplementation(async () => accepted('sm-' + (++n))),
    getOrderFillDetails: vi.fn().mockResolvedValue({ tradeIds: ['child'], sizeMatched: '10' }),
    getTradeStatuses: vi.fn().mockImplementation(async () => [{ id: 'child', size: '10', price: '0.4',
      status: terminal ? 'MINED' : 'MATCHED', ...(terminal ? { transactionHash: 'tx' } : {}) }]) };
  const smart = new SmartMoneyService({} as any, {} as any, trading as any);
  const listeners = new Set<(t: any) => any>();
  const subscribe = vi.spyOn(smart, 'subscribeSmartMoneyTrades').mockImplementation(fn => {
    listeners.add(fn); return { id: 'listener', unsubscribe: () => { listeners.delete(fn); } };
  });
  const originalStart = smart.startAutoCopyTrading.bind(smart);
  const starts = vi.spyOn(smart, 'startAutoCopyTrading').mockImplementation(async options => {
    session = await originalStart(options); return session;
  });
  const sdk = { smartMoney: smart, tradingService: trading };
  const shortOrders = vi.fn().mockImplementation(async () => accepted('arb-' + (++n)));
  let arb!: ArbitrageService;
  class RuntimeArb extends ArbitrageService {
    constructor(config: any) {
      super({ ...config, enableLogging: false }); arb = this;
      vi.spyOn(this as ArbitrageService, 'scanMarkets').mockResolvedValue([]);
      Object.assign(this, { market: { conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false },
        tradingService: { getAddress: () => wallet, createMarketOrder: shortOrders },
        ctf: { getAddress: () => wallet, getPusdBalance: async () => '100',
          getPositionBalanceByTokenIds: async () => ({yesBalance:'40',noBalance:'40'}) },
        balance: { usdc: 100, pUsdBalance: 100, yesTokens: 40, noTokens: 40, lastUpdate: Date.now() } });
    }
  }
  const accounting = { recordEntry: vi.fn(), recordRealized: vi.fn(), recordTrade: vi.fn(), recordTradeForHistory: vi.fn() };
  const context = { ArbitrageService: RuntimeArb, sdk, activeSdk: sdk, ethers, process: { env: {} },
    CONFIG: { dryRun: false, smartMoney: { enabled: true }, arbitrage: { enabled: arbEnabled, minTradeSize: 1, maxTradeSize: 20, profitThreshold: .001 } },
    state: { followedWallets: ['whale'], arbitrage: {}, arbProfit: 0 },
    riskGuard: () => null, log: vi.fn(), updateDashboard: vi.fn(), ...accounting };
  const extra = dashboard ? '' : `async function startSmartMoneyCopy(sdk) { const qualified = ['whale']; ${configStart} }`;
  const code = selected.map(s => s.getText(ast)).join('\n') + '\n' + extra;
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const api = runInNewContext(compiled + `\n({ start: () => startSmartMoneyCopy(sdk), setup: () => setupArbitrage(sdk),
    callbacks: smartMoneyCallbacks, ${dashboard ? 'stop: stopSmartMoneyCopy, directEntries,' : ''} })`, context);
  if (boot) { await api.setup(); await api.start(); }
  const emit = (side = 'BUY', tokenId = 'yes') => Promise.all([...listeners].map(fn => fn({
    traderAddress: 'whale', side, tokenId, size: 100, price: .4, timestamp: Date.now(), isSmartMoney: true })));
  const pause = () => dashboard ? api.stop() : session.stop();
  return { api, smart, trading, shortOrders, starts, subscribe, listeners, emit, pause, accounting,
    get arb() { return arb; }, get session() { return session; }, terminal: () => { terminal = true; } };
}
async function blocked(h: Awaited<ReturnType<typeof fixture>>) {
  const stats = h.arb.getStats();
  const calls = Object.values(h.accounting).map(fn => fn.mock.calls.length);
  await expect(h.arb.execute(op)).rejects.toThrow('Inventory admission refused');
  expect(h.shortOrders).not.toHaveBeenCalled(); expect(h.arb['pendingShortArbs'].size).toBe(0);
  expect(h.arb.getStats()).toEqual(stats);
  expect(Object.values(h.accounting).map(fn => fn.mock.calls.length)).toEqual(calls);
}
for (const entry of ['bot-with-dashboard.ts', 'bot-config.ts']) describe(entry, () => {
  it.each(['BUY', 'SELL'])('short pending blocks Smart Money %s operationally', async side => {
    const h = await fixture(entry); await h.arb.execute(op);
    const stats = h.session.getStats(); await h.emit(side);
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    for (const key of ['tradesExecuted','tradesFailed','totalFeesEstimateUsd','realizedPnlUsd','totalUsdcSpent']) expect(h.session.stats[key]).toBe(stats[key]);
    for (const fn of Object.values(h.accounting)) expect(fn).not.toHaveBeenCalled();
  });
  it.each(['BUY','SELL'])('active Smart Money %s blocks short before pending', async side => {
    const h = await fixture(entry), response = deferred(); h.trading.createMarketOrder.mockReturnValueOnce(response.promise);
    const pending = h.emit(side); await blocked(h); response.resolve(accepted('active')); await pending;
  });
  it.each(['pending','uncertain','positive','negative'])('%s survives pause/restart and blocks short', async kind => {
    const h = await fixture(entry);
    if (kind === 'uncertain') h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'UNCERTAIN' });
    await h.emit(kind === 'negative' ? 'SELL' : 'BUY');
    if (kind === 'positive' || kind === 'negative') { h.terminal(); await h.session.reconcile(); }
    const session = h.session, context = [...h.smart['inventoryContexts']][0], tracker = context.tracker;
    await blocked(h); h.pause(); expect(session.isActive).toBe(false); await blocked(h);
    await h.api.start(); expect(h.session).toBe(session); expect([...h.smart['inventoryContexts']][0]).toBe(context);
    expect(context.tracker).toBe(tracker); await blocked(h);
  });
  it('open lot exits after repeated toggles and factual close releases short', async () => {
    const h = await fixture(entry); await h.emit(); h.terminal(); await h.session.reconcile();
    const session = h.session, options = h.starts.mock.calls[0][0];
    for(let i=0;i<3;i++) { h.pause(); await blocked(h); await h.api.start(); expect(h.session).toBe(session); expect(h.listeners.size).toBe(1); }
    for(const [current] of h.starts.mock.calls) for(const key of ['onTrade','onCopyPnl','onError','inventoryAdmissionGuard','preExecutionGuard'] as const) expect(current[key]).toBe(options[key]);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    await h.emit('SELL'); await session.reconcile(); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.smart.getInventoryProtection({walletAddress:wallet,tokenIds:['yes']})).toBeUndefined();
    await h.arb.execute(op); expect(h.shortOrders).toHaveBeenCalledTimes(2);
  });
  it.each(['token','wallet'])('different %s permits short after Smart Money lifecycle', async identity => {
    const h = await fixture(entry, identity === 'wallet' ? otherWallet : wallet);
    await h.emit('BUY',identity === 'token' ? 'other' : 'yes'); await h.arb.execute(op);
    expect(h.shortOrders).toHaveBeenCalledTimes(2);
  });
  it.each(['token','wallet'])('different %s permits Smart Money after short', async identity => {
    const h = await fixture(entry,identity === 'wallet' ? otherWallet : wallet); await h.arb.execute(op);
    await h.emit('BUY',identity === 'token' ? 'other' : 'yes'); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('normalized factual wallet intersects short protection', async () => {
    const h = await fixture(entry, '0x'+'AB'.repeat(20)); await h.arb.execute(op); await h.emit();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  });
  it('invalid LIVE executor identity fails closed', async () => {
    const h = await fixture(entry,'invalid'); await h.emit(); expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    expect(h.session.stats.tradesFailed).toBe(0);
  });
  it('missing wiring fails closed before boot and installed callbacks see current service', async () => {
    const h = await fixture(entry,wallet,false); await h.api.start(); await h.emit();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    await h.api.setup(); await h.arb.execute(op); await h.emit(); expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  });
  it('invalid short wallet fails closed before submission', async () => {
    const h=await fixture(entry); h.arb['ctf']!.getAddress = () => 'invalid';
    await expect(h.arb.execute(op)).rejects.toThrow();expect(h.shortOrders).not.toHaveBeenCalled();
    expect(h.arb['pendingShortArbs'].size).toBe(0);
  });
  it('both free permit short', async () => { const h=await fixture(entry);await h.arb.execute(op);expect(h.shortOrders).toHaveBeenCalledTimes(2); });
});
describe('dashboard admission composition', () => {
  it('Direct alone blocks and releasing it permits short', async () => {
    const h=await fixture('bot-with-dashboard.ts');h.api.directEntries.set('yes',{size:10,price:.4,walletAddress:wallet});
    await blocked(h);h.api.directEntries.clear();await h.arb.execute(op);expect(h.shortOrders).toHaveBeenCalledTimes(2);
  });
  it('removing Direct protection retains independent Smart Money protection', async () => {
    const h=await fixture('bot-with-dashboard.ts');await h.emit();h.api.directEntries.set('yes',{size:10,price:.4,walletAddress:wallet});
    await blocked(h);h.api.directEntries.clear();await blocked(h);
  });
});


describe('bot-config disabled arbitrage regression with real RateLimiter', () => {
  it('does not construct ArbitrageService or create timers when disabled', async () => {
    const source = readFileSync(new URL('../../bot-config.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('bot-config.ts', source, ts.ScriptTarget.ES2022, true);
    const setup = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'setupArbitrage')!;
    // The proxy delegates to the actual constructor: no passive substitute and no RateLimiter mock.
    const constructions = vi.fn();
    const RealConstructor = new Proxy(ArbitrageService, { construct(target, args) {
      constructions(); return Reflect.construct(target, args);
    } });
    const scan = vi.spyOn(ArbitrageService.prototype, 'scanMarkets').mockResolvedValue([]);
    const code = ts.transpileModule(setup.getText(ast), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const config = { dryRun: true, arbitrage: { enabled: false } };
    const api = runInNewContext('let arbService = null;\n' + code + '\n({ setupArbitrage })', {
      ArbitrageService: RealConstructor, CONFIG: config, process: { env: {} }, riskGuard: () => null,
      log: vi.fn(), state: {}, recordTrade: vi.fn(),
    });
    const timers = vi.getTimerCount();
    await api.setupArbitrage({ smartMoney: { getInventoryProtection: () => undefined } });
    expect(constructions).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timers);
    // Positive control proves that the real constructor's three timers remain observable.
    config.arbitrage.enabled = true;
    await api.setupArbitrage({ smartMoney: { getInventoryProtection: () => undefined } });
    expect(constructions).toHaveBeenCalledTimes(1); expect(scan).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount() - timers).toBe(3);
  });
  it.each(['BUY', 'SELL'])('disabled arbitrage allows Smart Money %s without false protection', async side => {
    const h = await fixture('bot-config.ts', wallet, true, false);
    expect(h.arb).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    const session = h.session, callbacks = h.starts.mock.calls[0][0];
    await h.emit(side); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.session.stats.tradesFailed).toBe(0);
    expect(h.accounting.recordTrade).not.toHaveBeenCalled();
    h.pause(); await h.api.start(); expect(h.session).toBe(session); expect(h.listeners.size).toBe(1);
    expect(h.starts.mock.calls[1][0].inventoryAdmissionGuard).toBe(callbacks.inventoryAdmissionGuard);
    await h.emit(side); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
});
