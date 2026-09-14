import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../bot-with-dashboard.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('bot-with-dashboard.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['DirectEntry', 'directEntries', 'BuySettlement', 'PendingBuy', 'pendingBuys',
  'consumeTerminalBuys', 'recordEntry', 'recordTradeForHistory', 'sessionTrades']);
const selected = ast.statements.filter(s => ts.isVariableStatement(s)
  ? s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && names.has(d.name.text))
  : (ts.isFunctionDeclaration(s) || ts.isTypeAliasDeclaration(s)) && !!s.name && names.has(s.name.text));
const code = ts.transpileModule(selected.map(s => s.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
type Entry = { price: number; size: number; time: number };
type BuyPend = { orderId: string; tokenId: string; submittedAt: number; priorDirectEntry?: Entry;
  settlement: { state: string; orderId?: string; successShares?: number; weightedPrice?: number | null; todosFailed?: boolean };
  accountingFinalized?: boolean };

function fixture() {
  const state = { tradesExecuted: 0, smartMoneyTrades: 0, arbTrades: 0, dipArbTrades: 0, directTrades: 0 };
  const updateDashboard = vi.fn(); const log = vi.fn();
  const api = runInNewContext(code + `
    ({ directEntries, pendingBuys, consumeTerminalBuys, sessionTrades, recordEntry });`,
  { state, updateDashboard, log }) as {
    directEntries: Map<string, Entry>; pendingBuys: Map<string, BuyPend>;
    consumeTerminalBuys: () => void; sessionTrades: Array<{ size: number; price: number; profit: number; strategy: string }>;
    recordEntry: (strategy: string) => void;
  };
  return { ...api, state, updateDashboard, log, consume: api.consumeTerminalBuys };
}

describe('P0.3d terminal buy settlement accounting', () => {

  it('result.success does NOT create directEntry or recordEntry immediately', () => {
    const h = fixture();
    expect(h.directEntries.size).toBe(0);
    expect(h.state.directTrades).toBe(0);
    expect(h.state.tradesExecuted).toBe(0);
  });

  it('MATCHED entry stays pending without economic effects', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'PENDING' } };
    h.pendingBuys.set('b1', pending);
    h.consume();
    expect(h.directEntries.size).toBe(0);
    expect(h.state.directTrades).toBe(0);
    expect(pending.accountingFinalized).toBeUndefined();
  });

  it('MATCHED -> TERMINAL_FAILED produces zero entry, zero stats', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_FAILED', orderId: 'b1', successShares: 0, weightedPrice: null, todosFailed: true } };
    h.pendingBuys.set('b1', pending);
    h.consume(); h.consume();
    expect(h.directEntries.size).toBe(0);
    expect(h.state.directTrades).toBe(0);
    expect(h.state.tradesExecuted).toBe(0);
    expect(h.sessionTrades).toHaveLength(0);
    expect(pending.accountingFinalized).toBe(true);
  });

  it('settlement creates entry exactly once with factual data', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 100,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 8, weightedPrice: 0.45, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.consume(); h.consume();
    expect(h.directEntries.size).toBe(1);
    const entry = h.directEntries.get('tok')!;
    expect(entry.size).toBe(8);
    expect(entry.price).toBe(0.45);
    expect(entry.time).toBe(100);
    expect(h.state.directTrades).toBe(1);
    expect(h.state.tradesExecuted).toBe(1);
    expect(pending.accountingFinalized).toBe(true);
  });

  it('partial economic success uses only factual success shares', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 3, weightedPrice: 0.6, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.consume();
    expect(h.directEntries.get('tok')!.size).toBe(3);
  });

  it.each([0, -1, NaN, Infinity])('invalid success shares %s preserve state', q => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: q, weightedPrice: 0.5, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.consume();
    expect(h.directEntries.size).toBe(0);
    expect(h.state.directTrades).toBe(0);
  });

  it.each([0, -1, NaN, Infinity])('invalid weighted price %s preserves state', price => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 5, weightedPrice: price, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.consume();
    expect(h.directEntries.size).toBe(0);
    expect(h.state.directTrades).toBe(0);
  });

  it('weighted factual price is used, not snapshot market price', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 4, weightedPrice: 0.33, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.consume();
    expect(h.directEntries.get('tok')!.price).toBe(0.33);
  });

  it('no prior entry + new entry appeared during pending -> does not overwrite', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1, priorDirectEntry: undefined,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 4, weightedPrice: 0.5, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.directEntries.set('tok', { price: 0.9, size: 10, time: 2 });
    h.consume();
    expect(h.directEntries.get('tok')!.size).toBe(10);
    expect(h.directEntries.get('tok')!.price).toBe(0.9);
    expect(h.state.directTrades).toBe(0);
    expect(pending.accountingFinalized).not.toBe(true);
  });

  it('prior entry existed but replaced -> does not overwrite', () => {
    const h = fixture();
    const prior = { price: 0.3, size: 5, time: 1 };
    h.directEntries.set('tok', prior);
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 2, priorDirectEntry: prior,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 4, weightedPrice: 0.5, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    const replacement = { price: 0.8, size: 8, time: 3 };
    h.directEntries.set('tok', replacement);
    h.consume();
    expect(h.directEntries.get('tok')).toBe(replacement);
    expect(replacement.size).toBe(8);
    expect(h.state.directTrades).toBe(0);
    expect(pending.accountingFinalized).not.toBe(true);
  });

  it('prior entry unchanged -> settlement replaces it', () => {
    const h = fixture();
    const prior = { price: 0.3, size: 5, time: 1 };
    h.directEntries.set('tok', prior);
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 100, priorDirectEntry: prior,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 5, weightedPrice: 0.35, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.consume();
    expect(h.directEntries.get('tok')!.size).toBe(5);
    expect(h.directEntries.get('tok')!.price).toBe(0.35);
    expect(h.directEntries.get('tok')!.time).toBe(100);
    expect(h.state.directTrades).toBe(1);
  });

  it('ALL FAILED -> recordEntry("direct") called zero times', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_FAILED', orderId: 'b1', successShares: 0, weightedPrice: null, todosFailed: true } };
    h.pendingBuys.set('b1', pending);
    h.consume();
    expect(h.state.directTrades).toBe(0);
    expect(h.state.tradesExecuted).toBe(0);
  });

  it('SUCCESS -> recordEntry("direct") called exactly once', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 2, weightedPrice: 0.5, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.consume();
    expect(h.state.directTrades).toBe(1);
    expect(h.state.tradesExecuted).toBe(1);
  });

  it('next cycle does not reapply settled buy', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 3, weightedPrice: 0.5, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.consume(); h.consume(); h.consume();
    expect(h.state.directTrades).toBe(1);
    expect(h.state.tradesExecuted).toBe(1);
    expect(h.directEntries.size).toBe(1);
  });

  it('reentrant callback cannot duplicate entry', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 3, weightedPrice: 0.5, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.updateDashboard.mockImplementationOnce(() => h.consume());
    h.consume();
    expect(h.state.directTrades).toBe(1);
    expect(h.directEntries.size).toBe(1);
  });

  it('orderId mismatch prevents accounting', () => {
    const h = fixture();
    const pending: BuyPend = { orderId: 'b1', tokenId: 'tok', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b2', successShares: 3, weightedPrice: 0.5, todosFailed: false } };
    h.pendingBuys.set('b1', pending);
    h.consume();
    expect(h.directEntries.size).toBe(0);
    expect(h.state.directTrades).toBe(0);
  });

  it('multiple independent buys settle independently', () => {
    const h = fixture();
    const p1: BuyPend = { orderId: 'b1', tokenId: 'tok1', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b1', successShares: 2, weightedPrice: 0.3, todosFailed: false } };
    const p2: BuyPend = { orderId: 'b2', tokenId: 'tok2', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 'b2', successShares: 4, weightedPrice: 0.7, todosFailed: false } };
    const p3: BuyPend = { orderId: 'b3', tokenId: 'tok3', submittedAt: 1,
      settlement: { state: 'TERMINAL_FAILED', orderId: 'b3', successShares: 0, weightedPrice: null, todosFailed: true } };
    h.pendingBuys.set('b1', p1); h.pendingBuys.set('b2', p2); h.pendingBuys.set('b3', p3);
    h.consume();
    expect(h.directEntries.size).toBe(2);
    expect(h.directEntries.get('tok1')!.size).toBe(2);
    expect(h.directEntries.get('tok2')!.size).toBe(4);
    expect(h.state.directTrades).toBe(2);
    expect(h.state.tradesExecuted).toBe(2);
    expect(p3.accountingFinalized).toBe(true);
  });

  it('consuming one failure does not block consumption of another success', () => {
    const h = fixture();
    const fail: BuyPend = { orderId: 'f1', tokenId: 'tx', submittedAt: 1,
      settlement: { state: 'TERMINAL_FAILED', orderId: 'f1', successShares: 0, weightedPrice: null, todosFailed: true } };
    const succ: BuyPend = { orderId: 's1', tokenId: 'ty', submittedAt: 1,
      settlement: { state: 'TERMINAL_SUCCESS', orderId: 's1', successShares: 4, weightedPrice: 0.5, todosFailed: false } };
    h.pendingBuys.set('f1', fail); h.pendingBuys.set('s1', succ);
    h.consume();
    expect(h.directEntries.size).toBe(1);
    expect(h.directEntries.has('ty')).toBe(true);
    expect(h.state.directTrades).toBe(1);
  });

  it('Portfolio Manager hook: flush, then consume, then query positions', () => {
    const manager = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'setupPortfolioManager')!;
    const body = manager.getText(ast);
    const flushBuy = body.indexOf('await flushPendingBuys(sdk)');
    const consumeBuy = body.indexOf('consumeTerminalBuys()');
    expect(flushBuy).toBeGreaterThan(-1);
    expect(consumeBuy).toBeGreaterThan(flushBuy);
    const posQuery = body.indexOf('sdk.wallets.getWalletPositions', consumeBuy);
    expect(posQuery).toBeGreaterThan(consumeBuy);
  });
});