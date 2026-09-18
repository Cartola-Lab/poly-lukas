import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmartMoneyService, type SmartMoneyTrade } from './services/smart-money-service.js';
import { CopyPnlTracker } from './services/copy-pnl-tracker.js';
import type { TradeStatus } from './services/trading-service.js';

const child = (id = 'a', status = 'MATCHED', size = '4.25', price = '0.4', transactionHash?: string): TradeStatus =>
  ({ id, status, size, price, transactionHash: transactionHash ? '0x' + (transactionHash.includes('sell') ? '34' : '12').repeat(32) : undefined });

async function setup(onCopyPnl = vi.fn()) {
  const trading = {
    createMarketOrder: vi.fn().mockResolvedValue({ success: true, orderId: 'order-1' }),
    getOrderFillDetails: vi.fn().mockResolvedValue({ tradeIds: ['a'], sizeMatched: '4.25' }),
    getTradeStatuses: vi.fn().mockResolvedValue([child()]),
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
  type Dependencies = ConstructorParameters<typeof SmartMoneyService>;
  const service = new SmartMoneyService(
    {} as Dependencies[0], {} as Dependencies[1], factualTrading as unknown as Dependencies[2],
  );
  let incoming!: (trade: SmartMoneyTrade) => Promise<void>;
  vi.spyOn(service, 'subscribeSmartMoneyTrades').mockImplementation(callback => {
    incoming = callback as typeof incoming;
    return { id: 'sub', unsubscribe: vi.fn() };
  });
  const sub = await service.startAutoCopyTrading({ targetAddresses: ['wallet'], minTradeSize: 1, feeRateBps: 100, onCopyPnl });
  const emit = (side: 'BUY' | 'SELL' = 'BUY', traderAddress = 'wallet') => incoming({
    traderAddress, side, size: 100, price: 0.4, tokenId: 'token', timestamp: Date.now(),
  } as SmartMoneyTrade);
  const flush = () => emit('BUY', 'untracked');
  const record = vi.spyOn(CopyPnlTracker.prototype, 'recordFill');
  await emit();
  return { trading, sub, emit, flush, record, onCopyPnl };
}

beforeEach(() => { vi.stubEnv('DRY_RUN', 'false'); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('P0.3b-3 Smart Money settlement accounting', () => {
  it('MATCHED waits, then attributed MINED fill resolves exactly once', async () => {
    const h = await setup();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.sub.stats.tradesExecuted).toBe(0);
    expect(h.sub.stats.totalUsdcSpent).toBe(0);
    expect(h.sub.stats.totalFeesEstimateUsd).toBe(0);
    await h.flush();
    expect(h.record).not.toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4.25', '0.4', 'hash')]);
    await h.flush(); await h.flush();
    expect(h.record).toHaveBeenCalledTimes(1); expect(h.record).toHaveBeenCalledWith('token', 'BUY', 4.25, 0.4, 0.017);
    await h.emit(); await h.flush(); // Same order ID returned again.
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it('all FAILED finalizes without accounting or re-query', async () => {
    const h = await setup();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'FAILED')]);
    await h.flush(); await h.flush();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('aggregates factual success size, weighted price and fee (mixed failure=%s)', async mixed => {
    const h = await setup();
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([
      child('a', 'MINED', '4', '0.25', 'hash-a'),
      child('b', mixed ? 'FAILED' : 'CONFIRMED', '6', '0.5', mixed ? undefined : 'hash-b'),
    ]);
    await h.flush();
    expect(h.record).toHaveBeenCalledTimes(1); expect(h.record).toHaveBeenCalledWith('token', 'BUY', mixed ? 4 : 10, mixed ? 0.25 : 0.4, mixed ? 0.01 : 0.04);
  });

  it.each(['MATCHED', 'MINED', 'RETRYING', 'UNKNOWN'])('success plus %s without hash waits', async status => {
    const h = await setup();
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4', '0.4', 'hash'), child('b', status, '6')]);
    await h.flush(); expect(h.record).not.toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4', '0.4', 'hash'), child('b', 'FAILED', '6')]);
    await h.flush(); expect(h.record).toHaveBeenCalledTimes(1);
  });

  it.each(['4.24', '4.26'])('size sum %s differing from matched stays pending when the same trade changes quantity', async size => {
    const h = await setup();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', size, '0.4', 'hash')]);
    await h.flush(); expect(h.record).not.toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4.25', '0.4', 'hash')]);
    await h.flush(); expect(h.record).not.toHaveBeenCalled();
  });

  it('empty discovery at zero matched remains reconcilable', async () => {
    const h = await setup();
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: [], sizeMatched: '0' });
    await h.flush(); expect(h.record).not.toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4.25', '0.4', 'hash')]);
    await h.flush(); expect(h.record).toHaveBeenCalledTimes(1);
  });

  it.each(['getOrderFillDetails', 'getTradeStatuses'] as const)('%s error preserves pending', async method => {
    const h = await setup();
    h.trading[method].mockRejectedValueOnce(new Error('query failure'));
    await h.flush(); expect(h.record).not.toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4.25', '0.4', 'hash')]);
    await h.flush(); expect(h.record).toHaveBeenCalledTimes(1);
  });

  it.each(['4.258', '-1', '', 'abc', '1e2', ' 4.25', undefined])('invalid shares %s fail closed in either factual field', async invalid => {
    const h = await setup();
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: ['a'], sizeMatched: invalid });
    await h.flush();
    h.trading.getTradeStatuses.mockResolvedValueOnce([{ ...child('a', 'MINED', '4.25', '0.4', 'hash'), size: invalid }]);
    await h.flush(); expect(h.record).not.toHaveBeenCalled(); expect(console.warn).toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4.25', '0.4', 'hash')]);
    await h.flush(); expect(h.record).toHaveBeenCalledTimes(1);
  });

  it('uses exact hundredths for 4.2 + 0.05 = 4.25', async () => {
    const h = await setup();
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '4.25' });
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4.2', '0.4', 'h'), child('b', 'FAILED', '0.05')]);
    await h.flush(); expect(h.record.mock.calls[0][2]).toBe(4.2);
  });

  it('overlapping callbacks share one in-flight reconciliation', async () => {
    const h = await setup();
    let resolve!: (trades: TradeStatus[]) => void;
    h.trading.getTradeStatuses.mockReturnValueOnce(new Promise<TradeStatus[]>(r => { resolve = r; }));
    const first = h.flush(); const second = h.flush();
    await vi.waitFor(() => expect(h.trading.getTradeStatuses).toHaveBeenCalledTimes(1));
    resolve([child('a', 'MINED', '4.25', '0.4', 'hash')]);
    await Promise.all([first, second]);
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it('SELL waits before closing lots; callback exception cannot replay accounting', async () => {
    const onCopyPnl = vi.fn(() => { throw new Error('external callback'); });
    const h = await setup(onCopyPnl);
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4.25', '0.4', 'buy-hash')]);
    await h.flush();
    h.trading.createMarketOrder.mockResolvedValue({ success: true, orderId: 'order-2' });
    await h.emit('SELL');
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MATCHED', '4.25', '0.6')]);
    await h.flush();
    expect(h.onCopyPnl).not.toHaveBeenCalled(); expect(h.sub.stats.realizedPnlUsd).toBe(0);
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4.25', '0.6', 'sell-hash')]);
    await h.flush(); await h.flush();
    expect(h.record).toHaveBeenCalledTimes(2); expect(h.onCopyPnl).toHaveBeenCalledTimes(1);
    expect(h.sub.stats.realizedPnlUsd).toBeCloseTo(0.8075);
    expect(h.sub.stats.tradesFailed).toBe(0);
  });

  it.each([undefined, '', '   '])('success without usable order ID %s withholds accounting', async orderId => {
    const h = await setup();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'FAILED')]);
    await h.flush();
    h.trading.createMarketOrder.mockResolvedValue({ success: true, orderId });
    await h.emit(); await h.flush();
    expect(h.record).not.toHaveBeenCalled(); expect(console.warn).toHaveBeenCalled();
    expect(h.sub.stats.tradesExecuted).toBe(0);
  });

  it.each([undefined, '', 'abc', '0', '-0.2'])('missing/invalid success price %s preserves pending', async price => {
    const h = await setup();
    h.trading.getTradeStatuses.mockResolvedValue([{ ...child('a', 'MINED', '4.25', '0.4', 'hash'), price }]);
    await h.flush(); expect(h.record).not.toHaveBeenCalled();
    h.trading.getTradeStatuses.mockResolvedValue([child('a', 'MINED', '4.25', '0.4', 'hash')]);
    await h.flush(); expect(h.record).toHaveBeenCalledTimes(1);
  });
});
