import { describe, expect, it, vi } from 'vitest';
import { ArbitrageService } from './arbitrage-service.js';
import type { TradeStatus } from './trading-service.js';

function fixture() {
  const service = new ArbitrageService({ enableLogging: false });
  const details = { tradeIds: ['a', 'b'], sizeMatched: '10' };
  const trades: TradeStatus[] = [
    { id: 'a', status: 'MINED', transactionHash: 'tx-a', size: '4', price: '0.4' },
    { id: 'b', status: 'CONFIRMED', transactionHash: 'tx-b', size: '6', price: '0.6' },
  ];
  const trading = {
    getOrderFillDetails: vi.fn().mockResolvedValue(details),
    getTradeStatuses: vi.fn().mockResolvedValue(trades),
  };
  // Access the actual private method without copying or extracting its implementation.
  Object.assign(service, { tradingService: trading });
  return { service, details, trades, trading, reconcile: () => service['reconcileSellLeg']('order') };
}

describe('P0.3e-1 factual SELL leg settlement', () => {
  it('empty trade IDs stay pending without querying trades', async () => {
    const h = fixture(); h.details.tradeIds = [];
    expect(await h.reconcile()).toEqual({ state: 'PENDING' });
    expect(h.trading.getTradeStatuses).not.toHaveBeenCalled();
  });
  it.each(['MATCHED', 'MINED', 'RETRYING', 'UNKNOWN'])('%s without hash stays pending', async status => {
    const h = fixture(); Object.assign(h.trades[0], { status, transactionHash: undefined });
    expect(await h.reconcile()).toEqual({ state: 'PENDING' });
  });
  it.each(['getOrderFillDetails', 'getTradeStatuses'] as const)('%s errors propagate, not FAILED', async method => {
    const h = fixture(); h.trading[method].mockRejectedValue(new Error('query failed'));
    await expect(h.reconcile()).rejects.toThrow('query failed');
  });
  it('smaller complete-set stays pending', async () => {
    const h = fixture(); h.details.sizeMatched = '11';
    expect(await h.reconcile()).toEqual({ state: 'PENDING' });
  });
  it('excess child sum is an anomaly', async () => {
    const h = fixture(); h.details.sizeMatched = '9';
    await expect(h.reconcile()).rejects.toThrow('exceed sizeMatched');
  });
  it.each(['', 'abc', '-1', '4.258'])('invalid child decimal %j fails closed', async size => {
    const h = fixture(); h.trades[0].size = size;
    await expect(h.reconcile()).rejects.toThrow('Invalid factual SELL shares');
  });
  it('invalid sizeMatched fails closed', async () => {
    const h = fixture(); h.details.sizeMatched = '10.001';
    await expect(h.reconcile()).rejects.toThrow('Invalid factual SELL shares');
  });
  it.each(['4', '4.2', '4.25'])('parses exact share decimal %s', async size => {
    const h = fixture(); h.details.tradeIds = ['a']; h.details.sizeMatched = size;
    h.trades.splice(1); h.trades[0].size = size;
    expect(await h.reconcile()).toMatchObject({ state: 'TERMINAL_SUCCESS', successShares: Number(size) });
  });
  it('all FAILED returns no fabricated economic fields', async () => {
    const h = fixture();
    h.trades.forEach(t => Object.assign(t, { status: 'FAILED', transactionHash: undefined, price: undefined }));
    expect(await h.reconcile()).toEqual({ state: 'TERMINAL_FAILED' });
  });
  it('all SUCCESS uses factual quantity, weighted price and hashes without accounting mutations', async () => {
    const h = fixture(); const before = h.service.getStats(); const event = vi.fn();
    h.service.on('execution', event);
    Object.assign(h.service, { orderbook: { yesBids: [{ price: 0.99, size: 100 }] } });
    const result = await h.reconcile();
    expect(result).toMatchObject({ state: 'TERMINAL_SUCCESS', successShares: 10, txHashes: ['tx-a', 'tx-b'] });
    if (result.state !== 'TERMINAL_SUCCESS') throw new Error('Expected terminal success');
    expect(result.weightedPrice).toBeCloseTo(0.52);
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledWith('order');
    expect(h.trading.getTradeStatuses).toHaveBeenCalledWith(['a', 'b']);
    expect(h.service.getStats()).toEqual(before); expect(event).not.toHaveBeenCalled();
  });
  it('mixed terminal children include FAILED size in completeness but not economics', async () => {
    const h = fixture(); Object.assign(h.trades[1], { status: 'FAILED', transactionHash: undefined, price: '999' });
    expect(await h.reconcile()).toEqual({ state: 'TERMINAL_SUCCESS', successShares: 4, weightedPrice: 0.4, txHashes: ['tx-a'] });
  });
  it('MATCHED can later become FAILED', async () => {
    const h = fixture(); h.trades.forEach(t => Object.assign(t, { status: 'MATCHED', transactionHash: undefined }));
    expect(await h.reconcile()).toEqual({ state: 'PENDING' });
    h.trades.forEach(t => { t.status = 'FAILED'; });
    expect(await h.reconcile()).toEqual({ state: 'TERMINAL_FAILED' });
  });
  it.each([undefined, '', 'abc', '-1', 'Infinity', '1e309', '0'])('invalid SUCCESS price %j fails closed', async price => {
    const h = fixture(); h.trades[0].price = price;
    await expect(h.reconcile()).rejects.toThrow('Invalid successful SELL facts');
  });
  it('SUCCESS missing factual size stays pending', async () => {
    const h = fixture(); delete h.trades[0].size;
    expect(await h.reconcile()).toEqual({ state: 'PENDING' });
  });
  it.each(['missing', 'duplicate', 'foreign'])('%s child identity cannot prove completeness', async mode => {
    const h = fixture();
    if (mode === 'missing') h.trades.pop();
    else h.trades[1].id = mode === 'duplicate' ? 'a' : 'other';
    expect(await h.reconcile()).toEqual({ state: 'PENDING' });
  });
  it('deduplicates discovery IDs and transaction hashes', async () => {
    const h = fixture(); h.details.tradeIds.push('a'); h.trades[1].transactionHash = ' tx-a ';
    expect(await h.reconcile()).toMatchObject({ txHashes: ['tx-a'] });
    expect(h.trading.getTradeStatuses).toHaveBeenCalledWith(['a', 'b']);
  });
});
