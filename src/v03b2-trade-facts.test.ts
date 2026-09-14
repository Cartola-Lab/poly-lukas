import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providers, BigNumber } from 'ethers';

// P0.3b-2: TradeStatus size/price + getOrderFillDetails.

let mockGetTrades: ReturnType<typeof vi.fn>;
let mockGetOrder: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', 'false');
  vi.spyOn(providers.JsonRpcProvider.prototype, 'send').mockImplementation(async method => {
    if (method === 'eth_chainId') return '0x89';
    throw new Error(`Unexpected RPC: ${method}`);
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getFeeData').mockResolvedValue({ gasPrice: BigNumber.from(100), lastBaseFeePerGas: BigNumber.from(100), maxFeePerGas: BigNumber.from(200), maxPriorityFeePerGas: BigNumber.from(30) });
  vi.spyOn(providers.BaseProvider.prototype, 'getGasPrice').mockResolvedValue(BigNumber.from(100));

  mockGetTrades = vi.fn().mockResolvedValue([]);
  mockGetOrder = vi.fn().mockResolvedValue({ associate_trades: [], size_matched: '0.00' });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function makeService() {
  const { TradingService } = await import('./services/trading-service.js');
  const mockLimiter = { execute: (_: unknown, fn: () => unknown) => fn() };
  const mockCache = { get: vi.fn(), set: vi.fn() };
  const service = new TradingService(mockLimiter as any, mockCache as any, { privateKey: '0x' + '11'.repeat(32) });
  (service as any).clobClient = { getTrades: mockGetTrades, getOrder: mockGetOrder };
  (service as any).initialized = true;
  return service;
}

describe('P0.3b-2 TradeStatus size/price', () => {
  it('getTradeStatuses propagates raw size', async () => {
    mockGetTrades.mockResolvedValue([{ id: 't1', status: 'CONFIRMED', transaction_hash: '0x01', size: '4.25', price: '0.39' }]);
    const service = await makeService();
    const results = await service.getTradeStatuses(['t1']);
    expect(results[0].size).toBe('4.25');
  });

  it('propagates raw price', async () => {
    mockGetTrades.mockResolvedValue([{ id: 't2', status: 'MATCHED', transaction_hash: '', size: '10', price: '0.52' }]);
    const service = await makeService();
    const results = await service.getTradeStatuses(['t2']);
    expect(results[0].price).toBe('0.52');
  });

  it('preserves existing status and transactionHash', async () => {
    mockGetTrades.mockResolvedValue([{ id: 't3', status: 'CONFIRMED', transaction_hash: '0xabc', size: '5', price: '0.40' }]);
    const service = await makeService();
    const results = await service.getTradeStatuses(['t3']);
    expect(results[0].status).toBe('CONFIRMED');
    expect(results[0].transactionHash).toBe('0xabc');
  });

  it('UNKNOWN preserves empty size/price', async () => {
    mockGetTrades.mockResolvedValue([]);
    const service = await makeService();
    const results = await service.getTradeStatuses(['missing']);
    expect(results[0].status).toBe('UNKNOWN');
    expect(results[0].size).toBeUndefined();
    expect(results[0].price).toBeUndefined();
  });
});

describe('P0.3b-2 getOrderFillDetails', () => {
  it('returns exact associate_trades and raw size_matched', async () => {
    mockGetOrder.mockResolvedValue({ associate_trades: ['t1', 't2'], size_matched: '10.00' });
    const service = await makeService();
    const details = await service.getOrderFillDetails('0xorder');
    expect(details.tradeIds).toEqual(['t1', 't2']);
    expect(details.sizeMatched).toBe('10.00');
  });

  it('empty associate_trades returns empty array', async () => {
    mockGetOrder.mockResolvedValue({ associate_trades: [], size_matched: '0.00' });
    const service = await makeService();
    const details = await service.getOrderFillDetails('0xorder');
    expect(details.tradeIds).toEqual([]);
    expect(details.sizeMatched).toBe('0.00');
  });

  it('getOrder error propagates', async () => {
    mockGetOrder.mockRejectedValue(new Error('Order not found'));
    const service = await makeService();
    await expect(service.getOrderFillDetails('0xbad')).rejects.toThrow('Order not found');
  });

  it('calls getOrder with exact supplied orderId', async () => {
    mockGetOrder.mockResolvedValue({ associate_trades: ['t3'], size_matched: '3.50' });
    const service = await makeService();
    await service.getOrderFillDetails('0xexact-order');
    expect(mockGetOrder).toHaveBeenCalledWith('0xexact-order');
  });
});