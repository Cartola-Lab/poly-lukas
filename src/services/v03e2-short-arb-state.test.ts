import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { ArbitrageService } from './arbitrage-service.js';
import type { TradeStatus } from './trading-service.js';

type Pending = Parameters<ArbitrageService['reconcilePendingShortArb']>[0];
function fixture(a = 'SUCCESS', b = 'SUCCESS', sizeA = '4.25', sizeB = '4.25') {
  const service = new ArbitrageService({ enableLogging: false });
  const child = (id: string, status: string, size: string): TradeStatus => ({
    id, status: status === 'SUCCESS' ? 'MINED' : status,
    size, price: id === 'a' ? '0.4' : '0.7',
    transactionHash: status === 'SUCCESS' ? `tx-${id}` : undefined,
  });
  const trades: Record<string, TradeStatus> = { a: child('a', a, sizeA), b: child('b', b, sizeB) };
  const trading = {
    getOrderFillDetails: vi.fn(async (id: string) => ({ tradeIds: [id], sizeMatched: trades[id].size! })),
    getTradeStatuses: vi.fn(async (ids: string[]) => ids.map(id => trades[id])),
  };
  Object.assign(service, { tradingService: trading });
  const pending: Pending = { id: 'op',
    legA: { tokenId: 'yes', orderId: 'a', submission: 'SUBMITTED' },
    legB: { tokenId: 'no', orderId: 'b', submission: 'SUBMITTED' } };
  service['pendingShortArbs'].set(pending.id, pending);
  return { service, pending, trades, trading, flush: () => service['flushPendingShortArbs']() };
}

describe('P0.3e-2 short-arb session state machine', () => {
  it.each([
    ['MATCHED', 'MATCHED'], ['SUCCESS', 'MATCHED'], ['FAILED', 'MATCHED'],
    ['MATCHED', 'SUCCESS'], ['MATCHED', 'FAILED'],
  ])('%s / %s stays pending', async (a, b) => {
    const h = fixture(a, b); await h.flush();
    expect(h.pending.finalized).not.toBe(true); expect(h.pending.terminalResult).toBeUndefined();
  });
  it.each([
    ['SUCCESS', 'SUCCESS', 'BALANCED_SUCCESS'], ['SUCCESS', 'FAILED', 'IMBALANCED'],
    ['FAILED', 'SUCCESS', 'IMBALANCED'], ['FAILED', 'FAILED', 'NO_FILL'],
  ])('%s / %s resolves to %s', async (a, b, state) => {
    const h = fixture(a, b); await h.flush();
    expect(h.pending.finalized).toBe(true); expect(h.pending.terminalResult?.state).toBe(state);
  });
  it('unequal success quantities are imbalanced, without allocation', async () => {
    const h = fixture('SUCCESS', 'SUCCESS', '10', '8'); await h.flush();
    expect(h.pending.terminalResult?.state).toBe('IMBALANCED');
    expect(h.pending.terminalResult?.legA).toMatchObject({ successShares: 10, successUnits: 1000n });
    expect(h.pending.terminalResult?.legB).toMatchObject({ successShares: 8, successUnits: 800n });
  });
  it('compares exact units even where Number share values collide', async () => {
    const h = fixture('SUCCESS', 'SUCCESS', '90071992547409.90', '90071992547409.91');
    expect(Number('90071992547409.90')).toBe(Number('90071992547409.91'));
    await h.flush(); expect(h.pending.terminalResult?.state).toBe('IMBALANCED');
  });
  it('equal decimal representations balance exactly', async () => {
    const h = fixture('SUCCESS', 'SUCCESS', '4.2', '4.20'); await h.flush();
    expect(h.pending.terminalResult?.state).toBe('BALANCED_SUCCESS');
  });
  it('preserves factual leg objects, prices, quantities and hashes', async () => {
    const h = fixture(); await h.flush(); const result = h.pending.terminalResult!;
    expect(result.legA).toBe(h.pending.legA.settlement);
    expect(result.legB).toBe(h.pending.legB.settlement);
    expect(result.legA).toMatchObject({ successShares: 4.25, weightedPrice: 0.4, txHashes: ['tx-a'] });
    expect(result.legB).toMatchObject({ successShares: 4.25, weightedPrice: 0.7, txHashes: ['tx-b'] });
    expect(Object.keys(result).sort()).toEqual(['legA', 'legB', 'state']);
    for (const leg of [result.legA, result.legB]) {
      expect(leg).not.toHaveProperty('profit'); expect(leg).not.toHaveProperty('edgeVsMerge');
      expect(leg).not.toHaveProperty('realizedPnl');
    }
  });
  it('does not query terminal leg again while other leg waits', async () => {
    const h = fixture('SUCCESS', 'MATCHED'); await h.flush(); const a = h.pending.legA.settlement;
    await h.flush(); expect(h.pending.legA.settlement).toBe(a);
    expect(h.trading.getOrderFillDetails.mock.calls.map(c => c[0])).toEqual(['a', 'b', 'b']);
    Object.assign(h.trades.b, { status: 'MINED', transactionHash: 'tx-b' });
    await h.flush(); expect(h.pending.terminalResult?.state).toBe('BALANCED_SUCCESS');
  });
  it('never recreates terminal result or queries finalized operation', async () => {
    const h = fixture(); await h.flush(); const result = h.pending.terminalResult;
    await h.flush(); await h.service['reconcilePendingShortArb'](h.pending);
    expect(h.pending.terminalResult).toBe(result); expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(2);
  });
  it('concurrent flushes share one flight and one finalization', async () => {
    const h = fixture(); const first = h.flush(); const second = h.flush();
    expect(second).toBe(first); await Promise.all([first, second]);
    const result = h.pending.terminalResult; await h.flush();
    expect(h.pending.terminalResult).toBe(result); expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(2);
  });
  it('query error preserves pending and the next flight can retry', async () => {
    const h = fixture(); h.trading.getOrderFillDetails.mockRejectedValueOnce(new Error('query'));
    await h.flush(); expect(h.pending.finalized).not.toBe(true);
    expect(h.pending.terminalResult).toBeUndefined();
    await h.flush(); expect(h.pending.terminalResult?.state).toBe('BALANCED_SUCCESS');
  });
  it.each(['MATCHED', 'ERROR'])('independent operation progresses despite %s operation', async mode => {
    const h = fixture('MATCHED', 'MATCHED');
    const other: Pending = { id: 'other', legA: { tokenId: 'x', orderId: 'c', submission: 'SUBMITTED' },
      legB: { tokenId: 'y', orderId: 'd', submission: 'SUBMITTED' } };
    h.trades.c = { id: 'c', status: 'MINED', size: '3', price: '0.4', transactionHash: 'tx-c' };
    h.trades.d = { id: 'd', status: 'MINED', size: '3', price: '0.7', transactionHash: 'tx-d' };
    h.service['pendingShortArbs'].set(other.id, other);
    if (mode === 'ERROR') h.trading.getOrderFillDetails.mockRejectedValueOnce(new Error('query'));
    await h.flush(); expect(h.pending.finalized).not.toBe(true);
    expect(other.terminalResult?.state).toBe('BALANCED_SUCCESS');
    expect(other.terminalResult?.legA).toMatchObject({ state: 'TERMINAL_SUCCESS', successUnits: 300n, txHashes: ['tx-c'] });
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledWith('c');
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledWith('d');
  });
  it('NOT_SUBMITTED remains unresolved rather than economic FAILED', async () => {
    const h = fixture(); h.pending.legA.submission = 'NOT_SUBMITTED';
    await h.flush(); expect(h.pending.terminalResult).toBeUndefined();
    expect(h.trading.getOrderFillDetails.mock.calls.map(c => c[0])).toEqual(['b']);
  });
  it('accepted submission without orderId is an anomaly, not NO_FILL', async () => {
    const h = fixture(); delete h.pending.legA.orderId;
    await h.flush(); expect(h.pending.finalized).not.toBe(true);
    expect(h.pending.terminalResult).toBeUndefined();
  });
  it.each([
    ['REJECTED', 'REJECTED', 'SUBMISSION_REJECTED'],
    ['REJECTED', 'FAILED', 'SUBMISSION_REJECTED'],
    ['FAILED', 'REJECTED', 'SUBMISSION_REJECTED'],
    ['REJECTED', 'SUCCESS', 'IMBALANCED'],
    ['SUCCESS', 'REJECTED', 'IMBALANCED'],
  ])('%s / %s preserves provenance and resolves to %s', async (a, b, state) => {
    const h = fixture(a, b);
    if (a === 'REJECTED') h.pending.legA.submission = 'REJECTED';
    if (b === 'REJECTED') h.pending.legB.submission = 'REJECTED';
    await h.flush();
    expect(h.pending.finalized).toBe(true);
    expect(h.pending.terminalResult).toMatchObject({ state,
      legA: { state: a === 'REJECTED' ? 'REJECTED' : `TERMINAL_${a}` },
      legB: { state: b === 'REJECTED' ? 'REJECTED' : `TERMINAL_${b}` } });
    if (a === 'REJECTED') expect(h.trading.getOrderFillDetails).not.toHaveBeenCalledWith('a');
    if (b === 'REJECTED') expect(h.trading.getOrderFillDetails).not.toHaveBeenCalledWith('b');
  });
  it.each(['NOT_SUBMITTED', 'MATCHED'])('rejection with %s in either leg remains pending', async unresolved => {
    for (const rejectionFirst of [true, false]) {
      const h = fixture('MATCHED', 'MATCHED');
      const rejected = rejectionFirst ? h.pending.legA : h.pending.legB;
      const other = rejectionFirst ? h.pending.legB : h.pending.legA;
      rejected.submission = 'REJECTED';
      if (unresolved === 'NOT_SUBMITTED') other.submission = 'NOT_SUBMITTED';
      await h.flush();
      expect(h.pending.finalized).not.toBe(true); expect(h.pending.terminalResult).toBeUndefined();
    }
  });
  it('terminal rejection is finalized once without economic side effects', async () => {
    const h = fixture('FAILED', 'FAILED'); h.pending.legA.submission = 'REJECTED';
    const before = h.service.getStats(); const emit = vi.spyOn(h.service, 'emit');
    const recovery = vi.fn(); Object.assign(h.service, { fixImbalanceIfNeeded: recovery });
    await h.flush(); const result = h.pending.terminalResult;
    expect(result).toEqual({ state: 'SUBMISSION_REJECTED', legA: { state: 'REJECTED' }, legB: { state: 'TERMINAL_FAILED' } });
    const calls = h.trading.getOrderFillDetails.mock.calls.length;
    await Promise.all([h.flush(), h.flush()]);
    await h.service['reconcilePendingShortArb'](h.pending);
    expect(h.pending.terminalResult).toBe(result);
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(calls);
    expect(h.service.getStats()).toEqual(before);
    expect(emit).not.toHaveBeenCalled(); expect(recovery).not.toHaveBeenCalled();
  });
  it('does not emit execution, mutate stats or call recovery', async () => {
    const h = fixture('SUCCESS', 'FAILED'); const before = h.service.getStats();
    const emit = vi.spyOn(h.service, 'emit');
    const recovery = vi.fn(); Object.assign(h.service, { fixImbalanceIfNeeded: recovery });
    await h.flush(); expect(h.service.getStats()).toEqual(before);
    expect(emit).not.toHaveBeenCalled(); expect(recovery).not.toHaveBeenCalled();
  });
  it('executeShortArb has no state machine integration', () => {
    const path = 'src/services/arbitrage-service.ts';
    const current = readFileSync(new URL('./arbitrage-service.ts', import.meta.url), 'utf8');
    const method = (source: string) => {
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const cls = ast.statements.find(ts.isClassDeclaration)!;
      return cls.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === 'executeShortArb')!.getText(ast);
    };
    expect(method(current)).not.toMatch(/pendingShortArbs|reconcilePendingShortArb|flushPendingShortArbs|reconcileSellLeg/);
    expect(method(current)).toContain('const profit = opportunity.profitRate * size');
  });
});
