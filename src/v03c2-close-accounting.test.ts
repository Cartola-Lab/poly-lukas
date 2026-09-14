import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../bot-with-dashboard.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('bot-with-dashboard.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['DirectEntry', 'directEntries', 'CloseSettlement', 'PendingClose', 'pendingCloses',
  'consumeTerminalCloses', 'executeClosePosition', 'recordRealized', 'recordTradeForHistory', 'sessionTrades']);
const selected = ast.statements.filter(s => ts.isVariableStatement(s)
  ? s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && names.has(d.name.text))
  : (ts.isFunctionDeclaration(s) || ts.isTypeAliasDeclaration(s)) && !!s.name && names.has(s.name.text));
const code = ts.transpileModule(selected.map(s => s.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
type Entry = { price: number; size: number; time: number };
type Pending = { tokenId: string; entryPrice: number | null; directEntry?: Entry; accountingFinalized?: boolean;
  settlement: { state: string; orderId?: string; successShares?: number; weightedPrice?: number | null; todosFailed?: boolean } };
function fixture() {
  const state = { positions: [{ asset: 'token', avgPrice: 0.3, curPrice: 0.99 }], dailyPnL: 0, monthlyPnL: 0,
    totalPnL: 0, consecutiveWins: 0, consecutiveLosses: 0, wins: 0, losses: 0 };
  const updateDashboard = vi.fn(); const log = vi.fn();
  const api = runInNewContext(code + `
    const originalRecord = recordRealized;
    const recordCalls = [];
    recordRealized = (...args) => { recordCalls.push(args); return originalRecord(...args); };
    ({ directEntries, pendingCloses, consumeTerminalCloses, executeClosePosition, sessionTrades, recordCalls });`,
  { state, updateDashboard, log }) as {
    directEntries: Map<string, Entry>; pendingCloses: Map<string, Pending>;
    consumeTerminalCloses: () => void; executeClosePosition: (sdk: unknown, token: string, size: number) => Promise<boolean>;
    sessionTrades: Array<{ size: number; price: number; profit: number; strategy: string }>;
    recordCalls: number[][];
  };
  const entry = { size: 10, price: 0.3, time: 1 };
  api.directEntries.set('token', entry);
  const pending: Pending = { tokenId: 'token', entryPrice: 0.3, directEntry: entry,
    settlement: { state: 'TERMINAL_SUCCESS', orderId: 'order', successShares: 6, weightedPrice: 0.5, todosFailed: false } };
  api.pendingCloses.set('order', pending);
  return { ...api, state, updateDashboard, log, entry, pending, consume: api.consumeTerminalCloses };
}
function unchanged(h: ReturnType<typeof fixture>) {
  expect(h.entry.size).toBe(10); expect(h.recordCalls).toHaveLength(0); expect(h.sessionTrades).toHaveLength(0);
  expect(h.state.totalPnL).toBe(0);
}

describe('P0.3c-2 terminal close accounting', () => {
  it('6/10 success consumes six, records factual weighted price and gross PnL exactly once', () => {
    const h = fixture(); h.consume(); h.consume();
    expect(h.entry.size).toBe(4); expect(h.recordCalls).toHaveLength(1);
    expect(h.state.totalPnL).toBeCloseTo(1.2); expect(h.state.wins).toBe(1);
    expect(h.state.dailyPnL).toBeCloseTo(1.2); expect(h.state.monthlyPnL).toBeCloseTo(1.2);
    expect(h.sessionTrades).toHaveLength(1);
    expect(h.sessionTrades[0]).toMatchObject({ strategy: 'direct', size: 6, price: 0.5 });
    expect(h.sessionTrades[0].profit).toBeCloseTo(1.2); expect(h.pending.accountingFinalized).toBe(true);
  });
  it('full success removes original entry', () => {
    const h = fixture(); h.pending.settlement.successShares = 10; h.consume();
    expect(h.directEntries.has('token')).toBe(false); expect(h.recordCalls).toHaveLength(1);
  });
  it('success exceeding balance fails closed without clamping', () => {
    const h = fixture(); h.pending.settlement.successShares = 11; h.consume(); unchanged(h);
    expect(h.pending.accountingFinalized).not.toBe(true); expect(h.log).toHaveBeenCalled();
  });
  it('replacement entry is untouched and no accounting is fabricated', () => {
    const h = fixture(); const replacement = { price: 0.8, size: 20, time: 2 };
    h.directEntries.set('token', replacement); h.consume(); unchanged(h);
    expect(h.directEntries.get('token')).toBe(replacement); expect(replacement.size).toBe(20);
    expect(h.pending.accountingFinalized).not.toBe(true);
  });
  it.each([null, NaN, Infinity, -1, 0])('invalid captured basis %s preserves all accounting', basis => {
    const h = fixture(); h.pending.entryPrice = basis; h.consume(); unchanged(h);
    expect(h.pending.accountingFinalized).not.toBe(true);
  });
  it.each([0, -1, NaN, Infinity])('invalid Q %s preserves all accounting', q => {
    const h = fixture(); h.pending.settlement.successShares = q; h.consume(); unchanged(h);
  });
  it.each([0, -1, NaN, Infinity])('invalid P %s preserves all accounting', price => {
    const h = fixture(); h.pending.settlement.weightedPrice = price; h.consume(); unchanged(h);
  });
  it('all FAILED closes the record without inventory/PnL/history writes', () => {
    const h = fixture(); h.pending.settlement = { state: 'TERMINAL_FAILED', orderId: 'order', successShares: 0, weightedPrice: null, todosFailed: true };
    h.consume(); h.consume(); unchanged(h); expect(h.pending.accountingFinalized).toBe(true);
  });
  it('no original direct entry uses captured avgPrice, without inventing entry or history', () => {
    const h = fixture(); h.directEntries.clear(); delete h.pending.directEntry;
    h.consume(); expect(h.directEntries.size).toBe(0); expect(h.recordCalls).toHaveLength(1);
    expect(h.state.totalPnL).toBeCloseTo(1.2); expect(h.sessionTrades).toHaveLength(0);
  });
  it('no entry and no basis finalizes without fabricated PnL or history', () => {
    const h = fixture(); h.directEntries.clear(); delete h.pending.directEntry; h.pending.entryPrice = null;
    h.consume(); unchanged(h); expect(h.pending.accountingFinalized).toBe(true);
  });
  it.each(['broadcast', 'log'])('%s exception after accounting cannot duplicate or omit history', mode => {
    const h = fixture();
    if (mode === 'broadcast') h.updateDashboard.mockImplementation(() => { throw new Error('broadcast'); });
    else h.log.mockImplementation(() => { throw new Error('log'); });
    h.consume(); h.consume(); expect(h.entry.size).toBe(4); expect(h.recordCalls).toHaveLength(1);
    expect(h.sessionTrades).toHaveLength(1); expect(h.state.totalPnL).toBeCloseTo(1.2);
  });
  it('reentrant callback cannot reapply an order', () => {
    const h = fixture(); h.updateDashboard.mockImplementationOnce(() => h.consume());
    h.consume(); expect(h.recordCalls).toHaveLength(1); expect(h.entry.size).toBe(4);
  });
  it('submission snapshots basis and stays pending; requested size and snapshot exit price are ignored later', async () => {
    const h = fixture(); h.pendingCloses.clear();
    const sdk = { tradingService: { createMarketOrder: vi.fn().mockResolvedValue({ success: true, orderId: 'order' }) } };
    expect(await h.executeClosePosition(sdk, 'token', 100)).toBe(true);
    h.consume(); unchanged(h);
    const pending = h.pendingCloses.get('order')!;
    expect(pending.directEntry).toBe(h.entry); expect(pending.entryPrice).toBe(0.3);
    h.entry.price = 0.9; h.state.positions[0].curPrice = 0.01;
    pending.settlement = { state: 'TERMINAL_SUCCESS', orderId: 'order', successShares: 6, weightedPrice: 0.5, todosFailed: false };
    h.consume(); expect(h.entry.size).toBe(4); expect(h.state.totalPnL).toBeCloseTo(1.2);
    await h.executeClosePosition(sdk, 'token', 100); h.consume(); expect(h.recordCalls).toHaveLength(1);
  });
  it('real Portfolio Manager hook consumes after reconciliation and before positions query', () => {
    const manager = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'setupPortfolioManager')!;
    const body = manager.getText(ast);
    const flush = body.indexOf('await flushPendingCloses(sdk)');
    const consume = body.indexOf('consumeTerminalCloses()');
    expect(flush).toBeGreaterThan(-1); expect(consume).toBeGreaterThan(flush);
    expect(body.indexOf('sdk.wallets.getWalletPositions', consume)).toBeGreaterThan(consume);
  });
});
