import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ethers } from 'ethers';
import { RedeemProvenanceError } from '../clients/ctf-client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ArbitrageOpportunity, type ShortArbSubmissionAck } from './arbitrage-service.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
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

function arbFixture() {
  const service = new ArbitrageService({ enableLogging: false, autoFixImbalance: true, enableRebalancer: true });
  services.push(service);
  const market = { name: 'original', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const trades: Record<string, TradeStatus> = {
    a: { id: 'a', status: 'MINED', size: '10', price: '0.6', transactionHash: '0x' + '11'.repeat(32) },
    b: { id: 'b', status: 'MINED', size: '10', price: '0.5', transactionHash: '0x' + '22'.repeat(32) },
  };
  const trading = {
    getAddress: () => wallet,
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>()
      .mockResolvedValueOnce(accepted('a')).mockResolvedValueOnce(accepted('b')),
    getOrderFillDetails: vi.fn(async (id: string) => ({ id, asset_id: id === 'a' ? 'yes' : 'no', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: [id], sizeMatched: trades[id].size! })),
    getTradeStatuses: vi.fn(async (ids: string[]) => ids.map(id => ({ ...trades[id], asset_id: id === 'a' ? 'yes' : 'no', side: 'SELL', trader_side: 'TAKER', taker_order_id: id, maker_orders: [] }))),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue(wallet),
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

async function submit(h: ReturnType<typeof arbFixture>, op = opportunity): Promise<ShortArbSubmissionAck> {
  const result = await h.service.execute(op);
  expect(result.type).toBe('SHORT_SUBMISSION');
  if (result.type !== 'SHORT_SUBMISSION') throw new Error('Expected submission acknowledgment');
  expect(Object.keys(result).sort()).toEqual(['operationId', 'status', 'type']);
  expect(result.operationId).toEqual(expect.any(String));
  return result;
}

const wallet = '0x' + '11'.repeat(20);
const otherWallet = '0x' + '22'.repeat(20);
const source = readFileSync(new URL('../../bot-with-dashboard.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('bot-with-dashboard.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['directEntries', 'pendingBuys', 'pendingCloses', 'activeInventoryWriters',
  'nextInventoryWriterId', 'inventoryWallet', 'dashboardInventoryConflict', 'beginInventoryWriter',
  'submitInventoryOrder', 'executeClosePosition', 'executePanicSell', 'executeDirectBuy',
  'executeDashboardRedeem', 'setupDirectTrading', 'consumeTerminalBuys', 'consumeTerminalCloses']);
const selected = ast.statements.filter(s => ts.isVariableStatement(s)
  ? s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && names.has(d.name.text))
  : ts.isFunctionDeclaration(s) && !!s.name && names.has(s.name.text));
const main = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'main') as ts.FunctionDeclaration;
const commandHook = main.body!.statements.find(s => ts.isExpressionStatement(s) &&
  ts.isCallExpression(s.expression) && s.expression.expression.getText(ast) === 'dashboardEmitter.on')!;
const commandCode = ts.transpileModule(commandHook.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const compiled = ts.transpileModule(selected.map(s => s.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fixture(address = wallet) {
  const h = arbFixture();
  let id = 0;
  const send = vi.fn().mockImplementation(async () => accepted(`external-${++id}`));
  const sdk = { tradingService: { getAddress: () => address, createMarketOrder: send },
    markets: { getMarket: vi.fn().mockResolvedValue({ tokens: [{ tokenId: 'yes' }, { tokenId: 'no' }], negRisk: false }) },
    gammaApi: { getTrendingMarkets: vi.fn().mockResolvedValue([{ conditionId: 'condition', question: 'Bitcoin?' }]) },
    getMarket: vi.fn().mockResolvedValue({ tokens: [{ outcome: 'Yes', tokenId: 'yes', price: .4 }, { outcome: 'No', tokenId: 'no', price: .5 }] }) };
  const redeem = vi.fn().mockResolvedValue({ success: true, provenance: { state: 'CONFIRMED', transactionHash: 'tx' } });
  const redeemCtf = { getAddress: () => address, redeemByTokenIds: redeem };
  const state = { positions: [{ asset: 'yes', size: 10, avgPrice: .4 }, { asset: 'other', size: 10, avgPrice: .4 }], btcTrend: 'up', totalPnL: 0 };
  const log = vi.fn(), recordEntry = vi.fn(), recordRealized = vi.fn(), recordTradeForHistory = vi.fn();
  const timers: Array<() => Promise<void>> = [];
  let command!: (value: { command: string; payload?: unknown }) => Promise<void>;
  const context = { sdk, CTFClient: class { constructor() { return redeemCtf; } }, process: { env: {} },
    handleExecutionModeCommand: () => false, refreshExposure: vi.fn(),
    dashboardEmitter: { on: (_event: string, handler: typeof command) => { command = handler; } }, ethers, RedeemProvenanceError, arbService: h.service, activeSdk: sdk, state, log,
    recordEntry, recordRealized, recordTradeForHistory, updateDashboard: vi.fn(),
    setInterval: (fn: () => Promise<void>) => timers.push(fn), setTimeout: () => 0,
    CONFIG: { dryRun: false, directTrading: { enabled: true, trendFollowing: true }, capital: { totalUsd: 100, minOrderUsd: 1 }, risk: {} },
    canTrade: () => true, canOpenPosition: () => true, calculatePositionSize: () => .05 };
  const api = runInNewContext(compiled + '\n' + commandCode + `\n({ directEntries, pendingBuys, pendingCloses, activeInventoryWriters,
    dashboardInventoryConflict, executeClosePosition, executePanicSell, executeDirectBuy,
    executeDashboardRedeem, setupDirectTrading, consumeTerminalBuys, consumeTerminalCloses })`, context);
  h.service.updateConfig({ shortInventoryAdmission: query => api.dashboardInventoryConflict(query) });
  return { ...h, command, sdk, send, redeem, redeemCtf, state, api, timers, log, recordEntry, recordRealized, recordTradeForHistory,
    close: (token = 'yes') => api.executeClosePosition(sdk, token, 10),
    buy: (token = 'yes') => api.executeDirectBuy(sdk, token, 5),
    redeemCall: () => api.executeDashboardRedeem(sdk, 'condition', redeemCtf) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function blockedShort(h: ReturnType<typeof fixture>) {
  const stats = h.service.getStats();
  await expect(h.service.execute(opportunity)).rejects.toThrow('Inventory admission refused');
  expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  expect(h.pending.size).toBe(0);
  expect(h.service.getStats()).toEqual(stats);
  expect(h.execution).not.toHaveBeenCalled();
}
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); vi.restoreAllMocks(); });

describe('P0.3e dashboard inventory exclusion through real writers', () => {
  it.each(['pending', 'uncertain', 'terminal'])('short %s blocks close with no economy', async kind => {
    const h = fixture();
    if (kind === 'uncertain') h.trading.createMarketOrder.mockReset().mockResolvedValue({ success: false, submissionState: 'UNCERTAIN' });
    await submit(h);
    if (kind === 'terminal') await h.flush();
    const stats = h.service.getStats();
    expect(await h.close()).toMatchObject({ status: 'BLOCKED_INVENTORY' });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.service.getStats()).toEqual(stats);
    expect(h.execution).not.toHaveBeenCalled();
    expect(h.recordRealized).not.toHaveBeenCalled();
    expect(h.recordEntry).not.toHaveBeenCalled();
    expect(h.recordTradeForHistory).not.toHaveBeenCalled();
  });
  it('factual short release permits close', async () => {
    const h = fixture(); await submit(h); await h.flush(); await h.service['updateBalance']();
    expect(await h.close()).toBe(true); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it.each(['token', 'wallet'])('different %s permits close', async kind => {
    const h = fixture(kind === 'wallet' ? otherWallet : wallet); await submit(h);
    expect(await h.close(kind === 'token' ? 'other' : 'yes')).toBe(true);
  });
  it('public query is immutable and matches either leg', async () => {
    const h = fixture(); await submit(h);
    const block = h.service.getShortInventoryProtection({ walletAddress: wallet, tokenIds: ['no'] });
    expect(Object.isFrozen(block)).toBe(true);
    expect(Object.keys(block!).sort()).toEqual(['operationId', 'reason']);
  });
  it.each(['', 'invalid'])('invalid caller identity %s fails closed', async address => {
    const h = fixture(address); expect(await h.close()).toMatchObject({ status: 'BLOCKED_INVENTORY' });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('inconsistent arb signer and CTF identity fails closed', async () => {
    const h = fixture(); h.ctf.getAddress.mockReturnValue(otherWallet);
    expect(await h.buy()).toMatchObject({ status: 'BLOCKED_INVENTORY' }); expect(h.send).not.toHaveBeenCalled();
    await expect(h.service.execute(opportunity)).rejects.toThrow('wallet identity');
  });
  it('panic skips protected token and sends the other token', async () => {
    const h = fixture(); await submit(h); await h.api.executePanicSell(h.sdk);
    expect(h.send).toHaveBeenCalledWith({ tokenId: 'other', side: 'SELL', amount: 10 });
  });
  it('short blocks Direct BUY but permits another token', async () => {
    const h = fixture(); await submit(h);
    expect(await h.buy()).toMatchObject({ status: 'BLOCKED_INVENTORY' });
    expect(await h.buy('other')).toBe(true); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it.each(['BUY', 'CLOSE'])('%s owns inventory during transport and transfers to pending atomically', async kind => {
    const h = fixture(), finish = deferred<any>();
    h.send.mockImplementationOnce(() => {
      expect(h.api.activeInventoryWriters.size).toBe(1);
      return finish.promise;
    });
    const running = kind === 'BUY' ? h.buy() : h.close();
    await blockedShort(h);
    expect(await h.buy()).toMatchObject({ status: 'BLOCKED_INVENTORY' });
    finish.resolve(accepted('external'));
    expect(await running).toBe(true);
    expect(h.api.activeInventoryWriters.size).toBe(0);
    expect(kind === 'BUY' ? h.api.pendingBuys.has('external') : h.api.pendingCloses.has('external')).toBe(true);
    await blockedShort(h);
  });
  it('explicit Direct rejection releases and permits a new short', async () => {
    const h = fixture(); h.send.mockResolvedValueOnce(rejected); expect(await h.buy()).toBe(false);
    expect(h.api.activeInventoryWriters.size).toBe(0); await submit(h);
  });
  it.each(['UNCERTAIN', 'missing-id', 'exception'])('Direct %s retains protection', async kind => {
    const h = fixture();
    if (kind === 'exception') h.send.mockRejectedValueOnce(new Error('network'));
    else h.send.mockResolvedValueOnce(kind === 'missing-id' ? { success: true } : { success: false, submissionState: 'UNCERTAIN' });
    await h.buy(); expect(h.api.activeInventoryWriters.size).toBe(1); await blockedShort(h);
  });
  it('open Direct entry blocks short but preserves its legitimate exit', async () => {
    const h = fixture(); h.api.directEntries.set('yes', { size: 10, price: .4, time: 1, walletAddress: wallet });
    await blockedShort(h); expect(await h.close()).toBe(true);
  });
  it('finalized tombstones alone do not block short', async () => {
    const h = fixture(); h.api.pendingBuys.set('old', { tokenId: 'yes', walletAddress: wallet, accountingFinalized: true });
    h.api.pendingCloses.set('old', { tokenId: 'no', walletAddress: wallet, accountingFinalized: true });
    await submit(h);
  });
  it('BUY settlement hands ownership to Direct entry and full close releases it', async () => {
    const h = fixture(); await h.buy();
    const p = h.api.pendingBuys.get('external-1');
    p.settlement = { state: 'TERMINAL_SUCCESS', orderId: 'external-1', successShares: 10, weightedPrice: .4 };
    h.api.consumeTerminalBuys(); await blockedShort(h);
    await h.close(); const c = h.api.pendingCloses.get('external-2');
    c.settlement = { state: 'TERMINAL_SUCCESS', orderId: 'external-2', successShares: 10, weightedPrice: .5 };
    h.api.consumeTerminalCloses(); expect(h.api.directEntries.size).toBe(0); await submit(h);
  });
  it('short blocks redeem before the CTF call', async () => {
    const h = fixture(); await submit(h);
    expect(await h.redeemCall()).toMatchObject({ status: 'BLOCKED_INVENTORY' }); expect(h.redeem).not.toHaveBeenCalled();
  });
  it('redeem of different tokens preserves routing and succeeds', async () => {
    const h = fixture(); await submit(h);
    h.sdk.markets.getMarket.mockResolvedValue({ tokens: [{ tokenId: 'other' }, { tokenId: 'other-no' }], negRisk: false });
    expect(await h.redeemCall()).toMatchObject({ success: true });
    expect(h.redeem).toHaveBeenCalledWith('condition', { yesTokenId: 'other', noTokenId: 'other-no' }, undefined, { negRisk: false }, expect.any(Function));
    expect(h.api.activeInventoryWriters.size).toBe(0);
  });
  it('redeem signer mismatch fails closed', async () => {
    const h = fixture(); h.redeemCtf.getAddress = () => otherWallet;
    expect(await h.redeemCall()).toMatchObject({ status: 'BLOCKED_INVENTORY' }); expect(h.redeem).not.toHaveBeenCalled();
  });
  it.each(['NOT_SUBMITTED', 'CONFIRMED', 'SUBMITTED', 'UNCERTAIN'] as const)('redeem error provenance %s controls release', async provenance => {
    const h = fixture(); h.redeem.mockRejectedValueOnce(new RedeemProvenanceError(new Error('same message'), { state: provenance, transactionHash: 'tx' }));
    await expect(h.redeemCall()).rejects.toBeInstanceOf(RedeemProvenanceError);
    if (provenance === 'NOT_SUBMITTED' || provenance === 'CONFIRMED') {
      expect(h.api.activeInventoryWriters.size).toBe(0); await submit(h);
    } else await blockedShort(h);
  });
  it('redeem untyped exception remains protected regardless of message', async () => {
    const h = fixture(); h.redeem.mockRejectedValueOnce(new Error('NOT_SUBMITTED'));
    await expect(h.redeemCall()).rejects.toThrow(); await blockedShort(h);
  });
  it('redeem observer and awaited transport preserve ownership until factual completion', async () => {
    const h = fixture(), started = deferred<void>(), finish = deferred<any>();
    let reentrant: Promise<unknown>;
    h.redeem.mockImplementationOnce((_c, _t, _o, _r, observer) => {
      observer({ state: 'SUBMITTED', transactionHash: 'tx' });
      expect([...h.api.activeInventoryWriters.values()][0]).toMatchObject({ state: 'SUBMITTED', transactionHash: 'tx' });
      reentrant = h.buy(); started.resolve(); return finish.promise;
    });
    const running = h.redeemCall(); await started.promise;
    await blockedShort(h); expect(await reentrant!).toMatchObject({ status: 'BLOCKED_INVENTORY' });
    finish.resolve({ success: true, provenance: { state: 'CONFIRMED', transactionHash: 'tx' } });
    await running; expect(h.api.activeInventoryWriters.size).toBe(0); await submit(h);
  });
  it('overlapping real Direct timer callbacks submit only one writer', async () => {
    const h = fixture(), started = deferred<void>(), finish = deferred<any>();
    h.send.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    await h.api.setupDirectTrading(h.sdk);
    const first = h.timers[0](); await started.promise;
    await h.timers[0](); expect(h.send).toHaveBeenCalledTimes(1); await blockedShort(h);
    finish.resolve(accepted('timer')); await first;
  });
  it('real Direct timer uses the short guard', async () => {
    const h = fixture(); await submit(h); await h.api.setupDirectTrading(h.sdk); await h.timers[0]();
    expect(h.send).not.toHaveBeenCalled(); expect(h.recordEntry).not.toHaveBeenCalled();
  });
  it.each(['closePosition', 'panicSell', 'redeemPosition'])('real command hook %s enforces the guard', async command => {
    const h = fixture(); await submit(h);
    await h.command({ command, payload: { tokenId: 'yes', size: 10, conditionId: 'condition' } });
    if (command === 'panicSell') {
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.send.mock.calls[0][0].tokenId).toBe('other');
    } else expect(h.send).not.toHaveBeenCalled();
    expect(h.redeem).not.toHaveBeenCalled();
  });
  it('registration-to-pending handoff resists reentrant short admission', async () => {
    const h = fixture();
    const original = h.api.pendingBuys.set.bind(h.api.pendingBuys);
    let during: Promise<void>;
    h.api.pendingBuys.set = (key: string, value: unknown) => {
      during = blockedShort(h);
      return original(key, value);
    };
    await h.buy(); await during!; await blockedShort(h);
  });
  it('transport callback cannot recursively admit the same Direct writer', async () => {
    const h = fixture(); let nested: Promise<unknown>;
    h.send.mockImplementationOnce(async () => { nested = h.buy(); return accepted('first'); });
    await h.buy(); expect(await nested!).toMatchObject({ status: 'BLOCKED_INVENTORY' });
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('nonconflicting wallet lifecycle does not block short', async () => {
    const h = fixture(otherWallet); await h.buy(); await submit(h);
  });
  it('duplicate short acknowledgment is preserved despite later external entries', async () => {
    const h = fixture(); const first = await submit(h);
    h.api.directEntries.set('yes', { size: 10, price: .4, walletAddress: wallet });
    expect(await submit(h)).toEqual(first); expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
  });

  it('second BUY cannot replace the original 10-share entry, whose full close still releases short', async () => {
    const h = fixture();
    const entry = { size: 10, price: .4, time: 1, walletAddress: wallet };
    h.api.directEntries.set('yes', entry);
    expect(await h.api.executeDirectBuy(h.sdk, 'yes', 5)).toMatchObject({ status: 'BLOCKED_INVENTORY' });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.api.activeInventoryWriters.size).toBe(0);
    expect(h.api.pendingBuys.size).toBe(0);
    expect(h.api.directEntries.get('yes')).toBe(entry);
    expect(entry.size).toBe(10);
    expect(h.recordEntry).not.toHaveBeenCalled();
    expect(h.recordRealized).not.toHaveBeenCalled();
    expect(h.recordTradeForHistory).not.toHaveBeenCalled();
    await blockedShort(h);
    expect(await h.close()).toBe(true);
    h.api.pendingCloses.get('external-1').settlement = {
      state: 'TERMINAL_SUCCESS', orderId: 'external-1', successShares: 10, weightedPrice: .5,
    };
    h.api.consumeTerminalCloses();
    expect(h.api.directEntries.has('yes')).toBe(false);
    await submit(h);
  });
  it.each(['other-token', 'other-wallet', 'tombstone'])('new BUY remains allowed for %s', async scenario => {
    const h = fixture(scenario === 'other-wallet' ? otherWallet : wallet);
    if (scenario === 'tombstone') {
      h.api.pendingBuys.set('old', { tokenId: 'yes', walletAddress: wallet, accountingFinalized: true });
    } else h.api.directEntries.set('yes', { size: 10, price: .4, time: 1, walletAddress: wallet });
    expect(await h.buy(scenario === 'other-token' ? 'other' : 'yes')).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it.each(['result', 'typed-error'])('CONFIRMED redeem %s removes matching entries without economic accounting', async mode => {
    const h = fixture();
    for (const token of ['yes', 'no', 'other']) h.api.directEntries.set(token, { size: 10, price: .4, time: 1, walletAddress: wallet });
    const stats = h.service.getStats();
    if (mode === 'typed-error') {
      h.redeem.mockRejectedValueOnce(new RedeemProvenanceError(new Error('post-confirmation reporting'), { state: 'CONFIRMED', transactionHash: 'tx' }));
      await expect(h.redeemCall()).rejects.toBeInstanceOf(RedeemProvenanceError);
    } else await h.redeemCall();
    expect(h.api.directEntries.has('yes')).toBe(false);
    expect(h.api.directEntries.has('no')).toBe(false);
    expect(h.api.directEntries.has('other')).toBe(true);
    expect(h.api.activeInventoryWriters.size).toBe(0);
    expect(h.service.getStats()).toEqual(stats);
    expect(h.execution).not.toHaveBeenCalled();
    expect(h.recordRealized).not.toHaveBeenCalled();
    expect(h.recordEntry).not.toHaveBeenCalled();
    expect(h.recordTradeForHistory).not.toHaveBeenCalled();
    expect(h.state.totalPnL).toBe(0);
    await submit(h);
  });
  it.each(['different-token', 'different-wallet', 'replacement'])('redeem confirmation preserves %s entry', async scenario => {
    const h = fixture();
    const token = scenario === 'different-token' ? 'other' : 'yes';
    const entry = { size: 10, price: .4, time: 1, walletAddress: scenario === 'different-wallet' ? otherWallet : wallet };
    h.api.directEntries.set(token, entry);
    const replacement = { ...entry, time: 2 };
    if (scenario === 'replacement') h.redeem.mockImplementationOnce(async () => {
      h.api.directEntries.set(token, replacement);
      return { success: true, provenance: { state: 'CONFIRMED', transactionHash: 'tx' } };
    });
    await h.redeemCall();
    expect(h.api.directEntries.get(token)).toBe(scenario === 'replacement' ? replacement : entry);
    expect(h.api.activeInventoryWriters.size).toBe(0);
  });
  it.each(['NOT_SUBMITTED', 'SUBMITTED', 'UNCERTAIN', 'untyped'] as const)('redeem %s preserves the original entry', async state => {
    const h = fixture(); const entry = { size: 10, price: .4, time: 1, walletAddress: wallet };
    h.api.directEntries.set('yes', entry);
    h.redeem.mockRejectedValueOnce(state === 'untyped' ? new Error('CONFIRMED')
      : new RedeemProvenanceError(new Error('same text'), { state }));
    await expect(h.redeemCall()).rejects.toThrow();
    expect(h.api.directEntries.get('yes')).toBe(entry);
    expect(h.api.activeInventoryWriters.size).toBe(state === 'NOT_SUBMITTED' ? 0 : 1);
    await blockedShort(h);
    expect(h.recordRealized).not.toHaveBeenCalled();
    expect(h.recordTradeForHistory).not.toHaveBeenCalled();
  });

});
