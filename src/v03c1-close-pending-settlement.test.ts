import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute actual production declarations, without starting the dashboard bot,
// installing process handlers, or contacting any trading service.
const source = readFileSync(new URL('../bot-with-dashboard.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('bot-with-dashboard.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['pendingBuys', 'activeInventoryWriters', 'nextInventoryWriterId', 'inventoryWallet', 'dashboardInventoryConflict', 'beginInventoryWriter', 'submitInventoryOrder', 'DirectEntry', 'directEntries', 'CloseSettlement', 'PendingClose',
  'pendingCloses', 'closeFlushPromise', 'parseCloseShares', 'flushPendingCloses', 'executeClosePosition']);
const selected = ast.statements.filter(statement => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(d => ts.isIdentifier(d.name) && names.has(d.name.text));
  }
  return (ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
    !!statement.name && names.has(statement.name.text);
});
const compiled = ts.transpileModule(selected.map(s => s.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

type Settlement = { state: string; successShares?: number; weightedPrice?: number | null; todosFailed?: boolean; orderId?: string };
type RecordState = { tokenId: string; entryPrice: number | null; settlement: Settlement };
function fixture() {
  const tradingService = {
    getAddress: () => '0x' + '11'.repeat(20),
    createMarketOrder: vi.fn().mockResolvedValue({ success: true, orderId: 'order' }),
    getOrderFillDetails: vi.fn().mockResolvedValue({ tradeIds: ['a'], sizeMatched: '4.25' }),
    getTradeStatuses: vi.fn().mockResolvedValue([trade()]),
  };
  const sdk = { tradingService };
  const log = vi.fn();
  const api = runInNewContext(compiled + '\n({ pendingCloses, parseCloseShares, flushPendingCloses, executeClosePosition })', {
    ethers, arbService: { getShortInventoryProtection: () => undefined }, activeSdk: null,
    state: { positions: [{ asset: 'token', avgPrice: 0.3 }] }, log,
  }) as {
    pendingCloses: Map<string, RecordState>;
    parseCloseShares: (v: unknown) => bigint;
    flushPendingCloses: (sdk: unknown) => Promise<void>;
    executeClosePosition: (sdk: unknown, token: string, size: number) => Promise<boolean>;
  };
  return { ...api, tradingService, sdk, log, submit: () => api.executeClosePosition(sdk, 'token', 10),
    flush: () => api.flushPendingCloses(sdk), current: () => api.pendingCloses.get('order')! };
}
function trade(status = 'MATCHED', size: string | undefined = '4.25', price: string | undefined = '0.4', transactionHash?: string, id = 'a') {
  return { id, status, size, price, transactionHash };
}

describe('P0.3c-1 close pending settlement infrastructure', () => {
  it.each(['MATCHED', 'MINED', 'RETRYING', 'UNKNOWN'])('%s without hash remains pending', async status => {
    const h = fixture(); await h.submit();
    h.tradingService.getTradeStatuses.mockResolvedValue([trade(status)]);
    await h.flush(); expect(h.current().settlement.state).toBe('PENDING');
  });
  it('identifies all FAILED and retains the terminal record and context', async () => {
    const h = fixture(); expect(await h.submit()).toBe(true);
    h.tradingService.getTradeStatuses.mockResolvedValue([trade('FAILED')]);
    await h.flush();
    expect(h.current()).toMatchObject({ tokenId: 'token', entryPrice: 0.3, settlement: {
      state: 'TERMINAL_FAILED', orderId: 'order', successShares: 0, weightedPrice: null, todosFailed: true,
    } });
    await h.flush(); expect(h.tradingService.getOrderFillDetails).toHaveBeenCalledTimes(1);
  });
  it('identifies delayed hash settlement and does not overwrite it on repeated submission', async () => {
    const h = fixture(); await h.submit(); await h.flush();
    expect(h.current().settlement.state).toBe('PENDING');
    h.tradingService.getTradeStatuses.mockResolvedValue([trade('MINED', '4.25', '0.4', 'hash')]);
    await h.flush();
    expect(h.current().settlement).toMatchObject({ state: 'TERMINAL_SUCCESS', successShares: 4.25, weightedPrice: 0.4, todosFailed: false });
    await h.submit(); await h.flush(); expect(h.tradingService.getTradeStatuses).toHaveBeenCalledTimes(2);
  });
  it.each(['4.24', '4.26'])('sum %s differing from matched preserves pending and retries', async size => {
    const h = fixture(); await h.submit();
    h.tradingService.getTradeStatuses.mockResolvedValue([trade('MINED', size, '0.4', 'hash')]);
    await h.flush(); expect(h.current().settlement.state).toBe('PENDING');
    if (size === '4.26') expect(h.log).toHaveBeenCalledWith('WARN', expect.stringContaining('exceed'));
    h.tradingService.getTradeStatuses.mockResolvedValue([trade('MINED', '4.25', '0.4', 'hash')]);
    await h.flush(); expect(h.current().settlement.state).toBe('TERMINAL_SUCCESS');
  });
  it.each(['4.258', '-1', '', 'abc', undefined])('invalid decimal %s in either field preserves pending', async value => {
    const h = fixture(); await h.submit();
    h.tradingService.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: ['a'], sizeMatched: value });
    await h.flush();
    h.tradingService.getTradeStatuses.mockResolvedValueOnce([{ ...trade('MINED', '4.25', '0.4', 'hash'), size: value }]);
    await h.flush(); expect(h.current().settlement.state).toBe('PENDING');
    expect(h.log).toHaveBeenCalledWith('WARN', expect.stringContaining('Invalid factual'));
  });
  it.each([['4', 400n], ['4.2', 420n], ['4.25', 425n]] as const)('parses %s exactly', (value, expected) => {
    expect(fixture().parseCloseShares(value)).toBe(expected);
  });
  it.each(['getOrderFillDetails', 'getTradeStatuses'] as const)('%s error preserves pending', async method => {
    const h = fixture(); await h.submit(); h.tradingService[method].mockRejectedValueOnce(new Error('offline'));
    await h.flush(); expect(h.current().settlement.state).toBe('PENDING');
    h.tradingService.getTradeStatuses.mockResolvedValue([trade('MINED', '4.25', '0.4', 'hash')]);
    await h.flush(); expect(h.current().settlement.state).toBe('TERMINAL_SUCCESS');
  });
  it('empty IDs at zero matched remain available for late discovery', async () => {
    const h = fixture(); await h.submit();
    h.tradingService.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: [], sizeMatched: '0' });
    await h.flush(); expect(h.current().settlement.state).toBe('PENDING');
    h.tradingService.getTradeStatuses.mockResolvedValue([trade('MINED', '4.25', '0.4', 'hash')]);
    await h.flush(); expect(h.current().settlement.state).toBe('TERMINAL_SUCCESS');
  });
  it('aggregates success-only size and weighted actual price, including FAILED in completeness', async () => {
    const h = fixture(); await h.submit();
    h.tradingService.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b', 'c'], sizeMatched: '10' });
    h.tradingService.getTradeStatuses.mockResolvedValue([
      trade('MINED', '2', '0.2', 'h1'), trade('MATCHED', '4', '0.5', 'h2', 'b'), trade('FAILED', '4', '0.9', undefined, 'c'),
    ]);
    await h.flush(); expect(h.current().settlement).toMatchObject({ state: 'TERMINAL_SUCCESS', successShares: 6 });
    expect(h.current().settlement.weightedPrice).toBeCloseTo(0.4);
  });
  it('success plus unresolved child stays pending', async () => {
    const h = fixture(); await h.submit();
    h.tradingService.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '6' });
    h.tradingService.getTradeStatuses.mockResolvedValue([trade('MINED', '2', '0.2', 'h1'), trade('RETRYING', '4', '0.5', undefined, 'b')]);
    await h.flush(); expect(h.current().settlement.state).toBe('PENDING');
  });
  it('concurrent flushes share a promise; a new pending remains reachable next cycle', async () => {
    const h = fixture(); await h.submit();
    let resolve!: (value: ReturnType<typeof trade>[]) => void;
    h.tradingService.getTradeStatuses.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const a = h.flush(); const b = h.flush(); expect(a).toBe(b);
    await vi.waitFor(() => expect(h.tradingService.getTradeStatuses).toHaveBeenCalledTimes(1));
    h.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: 'second' });
    await h.executeClosePosition(h.sdk, 'other-token', 10);
    resolve([trade('MINED', '4.25', '0.4', 'hash')]); await Promise.all([a, b]);
    expect(h.pendingCloses.get('second')!.settlement.state).toBe('PENDING');
    h.tradingService.getTradeStatuses.mockResolvedValue([trade('FAILED')]);
    await h.flush(); expect(h.pendingCloses.get('second')!.settlement.state).toBe('TERMINAL_FAILED');
  });
  it.each([undefined, '', '   '])('accepted submission without ID %s does not invent a pending key', async orderId => {
    const h = fixture(); h.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId });
    expect(await h.submit()).toBe(true); expect(h.pendingCloses.size).toBe(0);
    expect(h.log).toHaveBeenCalledWith('WARN', expect.stringContaining('without usable orderId'));
  });
  it('missing success price keeps pending', async () => {
    const h = fixture(); await h.submit();
    h.tradingService.getTradeStatuses.mockResolvedValue([{ ...trade('MINED', '4.25', '0.4', 'hash'), price: undefined }]);
    await h.flush(); expect(h.current().settlement.state).toBe('PENDING');
  });
});
