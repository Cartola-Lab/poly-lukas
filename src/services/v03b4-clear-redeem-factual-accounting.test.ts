import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitrageService, type ClearPositionResult } from './arbitrage-service.js';
import { RedeemProvenanceError, type RedeemResult } from '../clients/ctf-client.js';
import type { TradingService, TradeStatus } from './trading-service.js';

vi.mock('../core/rate-limiter.js', () => ({ RateLimiter: class {} }));

type Reply = Awaited<ReturnType<TradingService['createMarketOrder']>>;
type OrderRow = Awaited<ReturnType<TradingService['getOrderFillDetails']>>;
const services: ArbitrageService[] = [];
const HASH = (n: string) => '0x' + n.repeat(32);
const REDEEM_TX = HASH('ad');

/** Raw CLOB trade row for the active-market SELL used in aggregation tests. */
type Trade = {
  id: string; status: string; size?: string; price?: string; transactionHash?: string; asset_id?: string; side?: string;
  taker_order_id?: string; trader_side?: string; maker_orders?: unknown[];
};
const taker = (id: string, orderId: string, asset: string, size: string, price: string, hash = HASH('11')): Trade =>
  ({ id, status: 'MINED', size, price, transactionHash: hash, asset_id: asset, side: 'SELL', taker_order_id: orderId, trader_side: 'TAKER', maker_orders: [] });

/** Confirmed client result: the receipt-scoped payout is `usdcReceived`, independent of the pre-read balance. */
const confirmed = (usdcReceived: string, extra: Partial<RedeemResult> = {}): RedeemResult => ({
  success: true, txHash: REDEEM_TX, outcome: 'YES', tokensRedeemed: '10', usdcReceived,
  yesTokensConsumed: '10', noTokensConsumed: '0', provenance: { state: 'CONFIRMED', transactionHash: REDEEM_TX }, ...extra,
});

/**
 * Resolved market (YES wins) with a pre-read winning balance of 10 YES.
 * `redeem` controls what the CTF client reports for the confirmed transaction.
 */
function fixture(options: { yes?: string; no?: string; resolved?: boolean; winner?: string } = {}) {
  const service = new ArbitrageService({ enableLogging: false });
  services.push(service);
  const market = { name: 'm', conditionId: 'condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
  const balances = { yesBalance: options.yes ?? '10', noBalance: options.no ?? '0' };
  const resolved = options.resolved ?? true;
  const trades: Record<string, Trade> = { ty: taker('ty', 'cy', 'yes', '10', '0.55') };
  const orders: Record<string, OrderRow> = {
    cy: { id: 'cy', asset_id: 'yes', side: 'SELL', status: 'MATCHED', tradeEnumerationPresent: true, tradeIds: ['ty'], sizeMatched: '10' },
  };
  const trading = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createMarketOrder: vi.fn<TradingService['createMarketOrder']>(async (): Promise<Reply> => ({ success: true, submissionState: 'ACCEPTED', orderId: 'cy' })),
    getOrderFillDetails: vi.fn(async (id: string) => ({ ...orders[id], tradeIds: [...orders[id].tradeIds] })),
    getTradeStatuses: vi.fn(async (ids: string[]): Promise<TradeStatus[]> =>
      ids.map(id => (trades[id] ?? { id, status: 'UNKNOWN' }) as unknown as TradeStatus)),
  };
  const ctf = {
    getAddress: vi.fn().mockReturnValue('wallet'),
    getPusdBalance: vi.fn(async () => '100'),
    getPositionBalanceByTokenIds: vi.fn(async () => ({ ...balances })),
    getMarketResolution: vi.fn(async (_conditionId: string): Promise<{ isResolved: boolean; winningOutcome?: string }> =>
      resolved ? { isResolved: true, winningOutcome: options.winner ?? 'YES' } : { isResolved: false }),
    redeemByTokenIds: vi.fn(async (): Promise<RedeemResult> => confirmed('10')),
    mergeByTokenIds: vi.fn(async (_c: string, _t: unknown, amount: string) => ({ success: true, txHash: HASH('ab'), amount })),
    split: vi.fn(),
  };
  Object.assign(service, { tradingService: trading, ctf });
  const settles = vi.fn<(result: ClearPositionResult) => void>();
  service.on('settle', settles);
  const logs: string[] = [];
  vi.spyOn(service as unknown as { log: (m: string) => void }, 'log').mockImplementation(m => { logs.push(m); });
  const clear = (execute = true) => service.clearPositions(market, execute);
  const redeem = (result: RedeemResult | Error) =>
    result instanceof Error ? ctf.redeemByTokenIds.mockRejectedValue(result) : ctf.redeemByTokenIds.mockResolvedValue(result);
  return { service, market, balances, trading, ctf, settles, logs, clear, redeem };
}
type H = ReturnType<typeof fixture>;

const redeemActions = (r: ClearPositionResult) => r.actions.filter(a => a.type === 'redeem');

/** A redeem that cannot be booked: zero recovered USDC, no success, nothing else fabricated. */
function expectUnbooked(h: H, result: ClearPositionResult, error: RegExp) {
  expect(redeemActions(result)).toHaveLength(1);
  expect(redeemActions(result)[0]).toMatchObject({ type: 'redeem', amount: 10, usdcResult: 0, success: false, error: expect.stringMatching(error) });
  expect(result.totalUsdcRecovered).toBe(0);
  expect(result.success).toBe(false);
  expect(result.actions).toHaveLength(1);
  expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
  expect(h.settles).toHaveBeenCalledTimes(1);
  expect(h.settles.mock.calls[0][0].totalUsdcRecovered).toBe(0);
  expect(h.logs).not.toContainEqual(expect.stringMatching(/✅ Redeemed/));
}

afterEach(async () => {
  try { for (const service of services.splice(0)) await service.stop(); }
  finally { vi.restoreAllMocks(); }
});

describe('P0.3 clearPositions redeem factual accounting', () => {
  it('books the receipt-scoped payout, not the pre-read balance (10 tokens → 9.75 USDC)', async () => {
    const h = fixture();
    h.redeem(confirmed('9.75'));
    const result = await h.clear();
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledWith('condition', { yesTokenId: 'yes', noTokenId: 'no' }, undefined, { negRisk: false });
    expect(result.actions).toEqual([{ type: 'redeem', amount: 10, usdcResult: 9.75, txHash: REDEEM_TX, success: true }]);
    expect(result.totalUsdcRecovered).toBe(9.75);
    expect(result.totalUsdcRecovered).not.toBe(10);
    expect(result).toMatchObject({ success: true, marketStatus: 'resolved', yesBalance: 10, noBalance: 0 });
    expect(h.settles).toHaveBeenCalledTimes(1);
    expect(h.settles).toHaveBeenCalledWith(result);
    expect(h.logs).toContainEqual(expect.stringMatching(/✅ Redeemed: 10\.0000 tokens → \$9\.75 USDC \(factual payout\)/));
  });

  it('a factual payout above the pre-read balance is booked as reported by the receipt (10 tokens → 10.40 USDC)', async () => {
    const h = fixture();
    h.redeem(confirmed('10.4'));
    const result = await h.clear();
    expect(redeemActions(result)[0]).toMatchObject({ amount: 10, usdcResult: 10.4, success: true });
    expect(result.totalUsdcRecovered).toBe(10.4);
  });

  it('a factual payout equal to the balance leaves the economic result unchanged', async () => {
    const h = fixture();
    h.redeem(confirmed('10'));
    const result = await h.clear();
    expect(result.actions).toEqual([{ type: 'redeem', amount: 10, usdcResult: 10, txHash: REDEEM_TX, success: true }]);
    expect(result.totalUsdcRecovered).toBe(10);
    expect(result.success).toBe(true);
  });

  it('a confirmed zero payout is booked truthfully as zero, never replaced by the balance', async () => {
    const h = fixture();
    h.redeem(confirmed('0'));
    const result = await h.clear();
    expect(redeemActions(result)[0]).toMatchObject({ amount: 10, usdcResult: 0, success: true });
    expect(result.totalUsdcRecovered).toBe(0);
  });

  it('the pre-read balance never leaks into recovered USDC even when the client reports tokensRedeemed = balance', async () => {
    const h = fixture();
    h.redeem(confirmed('7.5', { tokensRedeemed: '10', yesTokensConsumed: '10' }));
    const result = await h.clear();
    expect(result.totalUsdcRecovered).toBe(7.5);
    expect(redeemActions(result)[0].usdcResult).toBe(7.5);
  });

  it('redeem throws: success false, usdcResult 0, no recovered USDC', async () => {
    const h = fixture();
    h.redeem(new Error('execution reverted'));
    const result = await h.clear();
    expectUnbooked(h, result, /execution reverted/);
    expect(h.logs).toContainEqual(expect.stringMatching(/❌ Redeem failed: execution reverted/));
  });

  it.each<[string, RedeemProvenanceError]>([
    ['NOT_SUBMITTED', new RedeemProvenanceError(new Error('Market is not resolved yet'), { state: 'NOT_SUBMITTED' })],
    ['SUBMITTED', new RedeemProvenanceError(new Error('receipt timeout'), { state: 'SUBMITTED', transactionHash: REDEEM_TX })],
    ['UNCERTAIN', new RedeemProvenanceError(new Error('rpc dropped'), { state: 'UNCERTAIN', transactionHash: REDEEM_TX })],
    ['CONFIRMED without payout', new RedeemProvenanceError(new Error('Confirmed redeem receipt has no identifiable pUSD mint'), { state: 'CONFIRMED', transactionHash: REDEEM_TX })],
  ])('a thrown RedeemProvenanceError (%s) books nothing', async (_label, error) => {
    const h = fixture();
    h.redeem(error);
    const result = await h.clear();
    expectUnbooked(h, result, new RegExp(error.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it.each<[string, RedeemResult]>([
    ['success false', confirmed('10', { success: false })],
    ['provenance SUBMITTED', confirmed('10', { provenance: { state: 'SUBMITTED', transactionHash: REDEEM_TX } })],
    ['provenance UNCERTAIN', confirmed('10', { provenance: { state: 'UNCERTAIN', transactionHash: REDEEM_TX } })],
    ['provenance NOT_SUBMITTED', confirmed('10', { provenance: { state: 'NOT_SUBMITTED' } })],
    ['usdcReceived missing', confirmed('10', { usdcReceived: undefined as unknown as string })],
    ['usdcReceived empty', confirmed('')],
    ['usdcReceived non-numeric', confirmed('ten')],
    ['usdcReceived negative', confirmed('-1')],
    ['usdcReceived numeric type', confirmed('10', { usdcReceived: 10 as unknown as string })],
  ])('a returned result without a valid confirmed payout (%s) books nothing and never falls back to the balance', async (_label, redeemResult) => {
    const h = fixture();
    h.redeem(redeemResult);
    const result = await h.clear();
    expectUnbooked(h, result, /Redeem payout not factually confirmed/);
    expect(h.logs).toContainEqual(expect.stringMatching(/❌ Redeem not booked: payout not factually confirmed/));
  });

  it('a result without a provenance field is accepted on the client contract (resolution implies confirmation)', async () => {
    const h = fixture();
    h.redeem({ success: true, txHash: '0x01', outcome: 'YES', tokensRedeemed: '10', usdcReceived: '3', yesTokensConsumed: '10', noTokensConsumed: '0' });
    const result = await h.clear();
    expect(result.actions).toEqual([{ type: 'redeem', amount: 10, usdcResult: 3, txHash: '0x01', success: true }]);
    expect(result.totalUsdcRecovered).toBe(3);
  });

  it('redeems the NO side when NO wins and still books only the factual payout', async () => {
    const h = fixture({ yes: '0', no: '4', winner: 'NO' });
    h.redeem(confirmed('3.9', { outcome: 'NO', tokensRedeemed: '4', yesTokensConsumed: '0', noTokensConsumed: '4' }));
    const result = await h.clear();
    expect(redeemActions(result)[0]).toMatchObject({ amount: 4, usdcResult: 3.9, success: true });
    expect(result.totalUsdcRecovered).toBe(3.9);
  });

  it('a resolved market with no winning balance redeems nothing', async () => {
    const h = fixture({ yes: '0', no: '5', winner: 'YES' });
    const result = await h.clear();
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.totalUsdcRecovered).toBe(0);
  });
});

describe('P0.3 clearPositions redeem aggregation', () => {
  it('clearAllPositions sums factual redeem payout + factual SELL proceeds across markets', async () => {
    const h = fixture();
    h.redeem(confirmed('9.75'));
    const active = { name: 'active', conditionId: 'active-condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
    h.ctf.getMarketResolution.mockImplementation(async (conditionId: string) =>
      conditionId === 'condition' ? { isResolved: true, winningOutcome: 'YES' } : { isResolved: false });
    const results = await h.service.clearAllPositions([h.market, active], true);
    expect(results[0].totalUsdcRecovered).toBe(9.75);
    expect(results[1].actions).toEqual([expect.objectContaining({ type: 'sell_yes', success: true, usdcResult: 5.5, facts: expect.objectContaining({ proceedsUsd: 5.5 }) })]);
    expect(results[1].totalUsdcRecovered).toBeCloseTo(5.5, 12);
    expect(h.ctf.redeemByTokenIds).toHaveBeenCalledTimes(1);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(expect.stringMatching(/TOTAL: \$15\.25 USDC recovered/));
  });

  it('an unbooked redeem contributes nothing to the multi-market total while SELL proceeds stay factual', async () => {
    const h = fixture();
    h.redeem(confirmed('10', { provenance: { state: 'UNCERTAIN', transactionHash: REDEEM_TX } }));
    const active = { name: 'active', conditionId: 'active-condition', yesTokenId: 'yes', noTokenId: 'no', negRisk: false };
    h.ctf.getMarketResolution.mockImplementation(async (conditionId: string) =>
      conditionId === 'condition' ? { isResolved: true, winningOutcome: 'YES' } : { isResolved: false });
    const results = await h.service.clearAllPositions([h.market, active], true);
    expect(results[0].totalUsdcRecovered).toBe(0);
    expect(results[1].totalUsdcRecovered).toBeCloseTo(5.5, 12);
    expect(h.logs).toContainEqual(expect.stringMatching(/TOTAL: \$5\.50 USDC recovered/));
  });

  it('an active market keeps the existing merge + factual SELL semantics (redeem is never attempted)', async () => {
    const h = fixture({ yes: '14', no: '4', resolved: false });
    const result = await h.clear();
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    expect(h.ctf.mergeByTokenIds).toHaveBeenCalledWith('condition', { yesTokenId: 'yes', noTokenId: 'no' }, '4', { negRisk: false });
    expect(result.actions[0]).toEqual({ type: 'merge', amount: 4, usdcResult: 4, txHash: HASH('ab'), success: true });
    expect(result.actions[1]).toMatchObject({ type: 'sell_yes', success: true, amount: 10, usdcResult: 5.5 });
    expect(result.totalUsdcRecovered).toBeCloseTo(9.5, 12);
  });

  it('a resolved market never merges or sells; the redeem branch is exclusive', async () => {
    const h = fixture({ yes: '10', no: '10' });
    h.redeem(confirmed('9.75'));
    const result = await h.clear();
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    expect(result.actions).toHaveLength(1);
    expect(result.totalUsdcRecovered).toBe(9.75);
  });
});

describe('P0.3 clearPositions redeem dry run', () => {
  it('execute=false plans the redeem as a 1:1 estimate without any write or factual lookup', async () => {
    const h = fixture();
    h.redeem(confirmed('9.75'));
    const result = await h.clear(false);
    expect(h.ctf.redeemByTokenIds).not.toHaveBeenCalled();
    expect(h.ctf.mergeByTokenIds).not.toHaveBeenCalled();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    expect(h.settles).not.toHaveBeenCalled();
    expect(result.actions).toEqual([{ type: 'redeem', amount: 10, usdcResult: 10, success: true }]);
    expect(result.totalUsdcRecovered).toBe(10);
    expect(h.logs).toContainEqual(expect.stringMatching(/📋 Plan: 1 actions, ~\$10\.00 pUSD/));
  });
});
