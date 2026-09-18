import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';

const wallet = '0x' + 'ab'.repeat(20), hash = '0x' + '12'.repeat(32);
function fixture(leg: 1 | 2 = 1, guard = true) {
  const token = leg === 1 ? 'up' : 'down';
  const trade = (id = 'fill', size = '10'): any => ({ id, size, price: '0.3', status: 'CONFIRMED',
    transactionHash: hash, asset_id: token, side: 'BUY', taker_order_id: 'order', trader_side: 'TAKER', maker_orders: [] });
  const trading = { getAddress: () => wallet,
    createMarketOrder: vi.fn(async (): Promise<any> => ({ success: true, submissionState: 'ACCEPTED', orderId: 'order', tradeIds: ['fill'] })),
    getOrderFillDetails: vi.fn(async (): Promise<any> => ({ id: 'order', asset_id: token, side: 'BUY', tradeIds: ['fill'], sizeMatched: '10' })),
    getTradeStatuses: vi.fn(async (): Promise<any[]> => [trade()]) };
  const ctf = { getAddress: () => wallet, getPositionBalanceByTokenIds: vi.fn(async () => ({ yesBalance: '0', noBalance: '0' })) };
  const service = new DipArbService({} as any, trading as any, {} as any);
  const round: any = { roundId: 'r', phase: leg === 1 ? 'waiting' : 'leg1_filled', startTime: Date.now(),
    ...(leg === 2 ? { leg1: { tokenId: 'up', side: 'UP', shares: 10, price: .4, timestamp: Date.now() } } : {}) };
  const market = { conditionId: 'c', upTokenId: 'up', downTokenId: 'down', slug: 'm', endTime: new Date(Date.now() + 60000) };
  Object.assign(service, { market, currentRound: round, ctf, isRunning: true });
  service.updateConfig({ debug: false, autoMerge: false, autoExecute: true, splitOrders: 1, orderIntervalMs: 0, executionCooldown: 0 });
  if (guard) service.setInventoryAdmissionGuard(() => undefined);
  const signal: any = { type: leg === 1 ? 'leg1' : 'leg2', roundId: 'r', tokenId: token,
    dipSide: 'UP', hedgeSide: 'DOWN', shares: 10, targetPrice: .4, currentPrice: .4, source: 'test' };
  const run = () => leg === 1 ? service.executeLeg1(signal) : service.executeLeg2(signal);
  const events = { roundComplete: vi.fn(), execution: vi.fn(), settled: vi.fn() };
  for (const [name, fn] of Object.entries(events)) service.on(name, fn);
  return { service, round, trading, ctf, run, trade, signal, events, token };
}

function render(round: any): string[] {
  const source = readFileSync(new URL('../../scripts/dip-arb/auto-trade.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('auto-trade.ts', source, ts.ScriptTarget.ES2022, true);
  let block: ts.IfStatement | undefined;
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === 'round' && node.getText(ast).includes('Position: None')) block = node;
    ts.forEachChild(node, visit);
  }
  visit(ast); expect(block).toBeDefined();
  const lines: string[] = [];
  runInNewContext(ts.transpileModule(block!.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { round, log: (line: string) => lines.push(line) });
  return lines;
}
describe.each([false, true])('P0.3g.2b factual position visibility guard=%s', guard => {
  it.each([1, 2] as const)('Leg%s confirmed shares with UNKNOWN economics remain visible', async leg => {
    const h = fixture(leg, guard);
    h.trading.getTradeStatuses.mockResolvedValue([{ ...h.trade(), price: undefined }]);
    expect(await h.run()).toMatchObject({ success: false, shares: 10 });
    const before = JSON.stringify(h.round), stats = h.service.getStats(), projected = stats.currentRound![leg === 1 ? 'leg1' : 'leg2'];
    expect(projected).toMatchObject({ shares: 10, tokenId: h.token });
    expect(projected?.price).toBeUndefined(); expect(projected?.cost).toBeUndefined();
    expect(stats.currentRound?.phase).toBe(h.round.phase);
    const output = render(h.service.getCurrentRound());
    expect(output.some(line => line.includes('10x') && line.includes('@ UNKNOWN') && line.includes('Cost: UNKNOWN'))).toBe(true);
    expect(output.join()).not.toContain('Position: None'); expect(output.join()).not.toContain('Profit:');
    expect(JSON.stringify(h.round)).toBe(before); expect(h.events.roundComplete).not.toHaveBeenCalled();
    expect(h.service.getStats().totalProfit).toBe(0);
    projected!.shares = 999; expect(h.round[`leg${leg}`].shares).toBe(10);
  });
  it('known position preserves factual values and normal CLI output', async () => {
    const h = fixture(1, guard); await h.run();
    expect(h.service.getStats().currentRound?.leg1).toMatchObject({ shares: 10, price: .3, cost: 3 });
    expect(render(h.round).join()).toContain('10x UP @ 0.3000 | Waiting for Leg2');
  });
  it('cost UNKNOWN with known price still shows the position', async () => {
    const h = fixture(1, guard); await h.run(); h.round.leg1.cost = undefined;
    expect(h.service.getStats().currentRound?.leg1?.shares).toBe(10);
    expect(render(h.round).join()).toContain('Cost: UNKNOWN');
  });
  it('partial factual shares visible while waiting; no terminal events', async () => {
    const h = fixture(1, guard);
    h.trading.getTradeStatuses.mockResolvedValue([h.trade('fill', '4')]); await h.run();
    expect(h.service.getStats().currentRound?.leg1).toMatchObject({ shares: 4, price: .3, cost: 1.2 });
    expect(render(h.round).join()).toContain('4x UP'); expect(render(h.round).join()).not.toContain('Position: None');
    expect(h.round.phase).toBe('waiting'); expect(h.events.execution).not.toHaveBeenCalled();
  });
  it('zero factual shares never create a visible position', async () => {
    const h = fixture(1, guard); h.trading.getTradeStatuses.mockResolvedValue([]); await h.run();
    expect(h.service.getStats().currentRound?.leg1).toBeUndefined();
    expect(render(h.round).join()).toContain('Position: None');
    h.round.leg1 = { shares: 0, side: 'UP' };
    expect(h.service.getStats().currentRound?.leg1).toBeUndefined();
    expect(render(h.round).join()).toContain('Position: None');
  });
});
