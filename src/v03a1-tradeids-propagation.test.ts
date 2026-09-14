import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providers, BigNumber } from 'ethers';

// P0.3a-1: TradingService.OrderResult propagates tradeIDs from the underlying CLOB SDK response.

let mockCreateAndPostMarketOrder: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', 'false');
  vi.spyOn(providers.JsonRpcProvider.prototype, 'send').mockImplementation(async method => {
    if (method === 'eth_chainId') return '0x89';
    throw new Error(`Unexpected RPC: ${method}`);
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getFeeData').mockResolvedValue({ gasPrice: BigNumber.from(100), lastBaseFeePerGas: BigNumber.from(100), maxFeePerGas: BigNumber.from(200), maxPriorityFeePerGas: BigNumber.from(30) });
  vi.spyOn(providers.BaseProvider.prototype, 'getGasPrice').mockResolvedValue(BigNumber.from(100));

  mockCreateAndPostMarketOrder = vi.fn().mockResolvedValue({
    success: true,
    orderID: '0xorder123',
    transactionsHashes: ['0xtx1', '0xtx2'],
    tradeIDs: ['0xtrade1', '0xtrade2'],
    status: 'MATCHED',
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function makeService() {
  const { TradingService } = await import('./services/trading-service.js');
  const mockLimiter = { execute: (_: unknown, fn: () => unknown) => fn() };
  const mockCache = { get: vi.fn(), set: vi.fn() };
  const service = new TradingService(mockLimiter as any, mockCache as any, { privateKey: '0x' + '11'.repeat(32) });

  // Stub the ClobClient's createAndPostMarketOrder
  vi.spyOn(service as any, 'getTickSize').mockResolvedValue('0.01');
  vi.spyOn(service as any, 'isNegRisk').mockResolvedValue(false);
  const mockClobClient = { createAndPostMarketOrder: mockCreateAndPostMarketOrder };
  (service as any).clobClient = mockClobClient;
  (service as any).initialized = true;

  return service;
}

describe('P0.3a-1 OrderResult propagates tradeIDs', () => {
  it('preserves tradeIDs from the CLOB SDK response', async () => {
    const service = await makeService();
    const result = await service.createMarketOrder({ tokenId: '123', side: 'BUY', amount: 10 });
    expect(result.success).toBe(true);
    expect(result.tradeIds).toEqual(['0xtrade1', '0xtrade2']);
  });

  it('preserves existing fields: orderId', async () => {
    const service = await makeService();
    const result = await service.createMarketOrder({ tokenId: '123', side: 'BUY', amount: 10 });
    expect(result.orderId).toBe('0xorder123');
  });

  it('preserves existing fields: transactionHashes', async () => {
    const service = await makeService();
    const result = await service.createMarketOrder({ tokenId: '123', side: 'BUY', amount: 10 });
    expect(result.transactionHashes).toEqual(['0xtx1', '0xtx2']);
  });

  it('preserves existing fields: success', async () => {
    const service = await makeService();
    const result = await service.createMarketOrder({ tokenId: '123', side: 'BUY', amount: 10 });
    expect(result.success).toBe(true);
  });
});