import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function fixture() {
  const source = readFileSync(new URL('../bot-with-dashboard.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('bot-with-dashboard.ts', source, ts.ScriptTarget.ES2022, true);
  let registration: ts.CallExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'sdk.dipArb.on' &&
        node.arguments[0]?.getText(ast) === "'roundComplete'") registration = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(registration).toBeDefined();
  const recorder = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'recordRealized')!;
  const state = { dailyPnL: 5, monthlyPnL: 6, totalPnL: 7, wins: 2, losses: 3, consecutiveWins: 1, consecutiveLosses: 0 };
  const log = vi.fn(), updateDashboard = vi.fn(), history = vi.fn();
  let listener!: (event: any) => void;
  let realRecorder!: (profit: number) => void;
  const recordRealized = vi.fn((profit: number) => realRecorder(profit));
  const context = { state, log, updateDashboard, recordRealized, recordTradeForHistory: history,
    sdk: { dipArb: { on: (_: string, fn: typeof listener) => { listener = fn; } } } };
  const code = recorder.getText(ast).replace('function recordRealized(', 'function actualRecorder(') + '\n' + registration!.getText(ast) + ';\nactualRecorder;';
  realRecorder = runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { state, log, history, recordRealized, emit: (event: any) => listener(event) };
}
function event(entry: unknown, exit: unknown, shares: unknown) {
  return Object.freeze({ status: 'expired', roundId: 'round', targetPrice: .9,
    leg1: Object.freeze({ price: entry, shares: 10, targetPrice: .9, tokenId: 'up' }),
    exitResult: Object.freeze({ success: true, price: exit, shares }) });
}
describe('P0.3g.2a dashboard roundComplete entry authority', () => {
  it.each([.4, 0])('known entry %s preserves normal accounting including numeric zero', entry => {
    const h = fixture(); h.emit(event(entry, .55, 10));
    expect(h.recordRealized).toHaveBeenCalledTimes(1);
    expect(h.recordRealized.mock.calls[0][0]).toBeCloseTo((.55 - entry) * 10);
    expect(h.state.totalPnL).toBeCloseTo(7 + (.55 - entry) * 10);
    expect(h.state.wins).toBe(3);
  });
  it.each([[undefined, .55], [.4, undefined], [undefined, undefined], [NaN, .55], [Infinity, .55], ['0.4', .55], [.4, NaN], [.4, Infinity]])(
    'entry %s / exit %s cannot invent accounting', (entry, exit) => {
      const h = fixture(), before = { ...h.state }, payload = event(entry, exit, 10);
      h.emit(payload); h.emit(payload);
      expect(h.recordRealized).not.toHaveBeenCalled(); expect(h.history).not.toHaveBeenCalled();
      expect(h.state).toEqual(before); expect(payload.leg1.shares).toBe(10);
      expect(h.log.mock.calls.every(([level]) => level === 'WARN')).toBe(true);
      if (entry === undefined) expect(h.log.mock.calls[0][1]).toContain('entry price UNKNOWN');
    });
  it.each([0, undefined, NaN, Infinity, -1])('invalid shares %s cannot reach accounting', shares => {
    const h = fixture(); h.emit(event(.4, .55, shares));
    expect(h.recordRealized).not.toHaveBeenCalled();
  });
});
