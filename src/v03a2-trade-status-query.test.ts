import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providers, BigNumber } from 'ethers';

// P0.3a-2: TradingService.getTradeStatuses queries CLOB trade status by ID.

let mockGetTrades: ReturnType<typeof vi.fn>;

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
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function makeService() {
  const { TradingService } = await import('./services/trading-service.js');
  const mockLimiter = { execute: (_: unknown, fn: () => unknown) => fn() };
  const mockCache = { get: vi.fn(), set: vi.fn() };
  const service = new TradingService(mockLimiter as any, mockCache as any, { privateKey: '0x' + '11'.repeat(32) });
  (service as any).clobClient = { getTrades: mockGetTrades };
  (service as any).initialized = true;
  return service;
}

describe('P0.3a-2 getTradeStatuses queries CLOB trade status', () => {
  it('returns FAILED status as-is', async () => {
    mockGetTrades.mockResolvedValue([{ id: 't1', status: 'FAILED', transaction_hash: '' }]);
    const service = await makeService();
    const results = await service.getTradeStatuses(['t1']);
    expect(results).toEqual([{ id: 't1', status: 'FAILED', transactionHash: '' }]);
  });

  it('returns MATCHED status as-is', async () => {
    mockGetTrades.mockResolvedValue([{ id: 't2', status: 'MATCHED', transaction_hash: '' }]);
    const service = await makeService();
    const results = await service.getTradeStatuses(['t2']);
    expect(results).toEqual([{ id: 't2', status: 'MATCHED', transactionHash: '' }]);
  });

  it('preserves transactionHash when present', async () => {
    mockGetTrades.mockResolvedValue([{ id: 't3', status: 'CONFIRMED', transaction_hash: '0xabc123' }]);
    const service = await makeService();
    const results = await service.getTradeStatuses(['t3']);
    expect(results[0].transactionHash).toBe('0xabc123');
  });

  it('queries multiple trade IDs', async () => {
    mockGetTrades
      .mockResolvedValueOnce([{ id: 'a1', status: 'CONFIRMED', transaction_hash: '0x01' }])
      .mockResolvedValueOnce([{ id: 'a2', status: 'MATCHED', transaction_hash: '' }]);
    const service = await makeService();
    const results = await service.getTradeStatuses(['a1', 'a2']);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('a1');
    expect(results[1].id).toBe('a2');
  });

  it('returns UNKNOWN status when CLOB returns no trade for an ID', async () => {
    mockGetTrades.mockResolvedValue([]);
    const service = await makeService();
    const results = await service.getTradeStatuses(['missing']);
    expect(results).toEqual([{ id: 'missing', status: 'UNKNOWN' }]);
  });

  it('propagates CLOB query error — does NOT disguise as terminal status', async () => {
    mockGetTrades.mockRejectedValue(new Error('CLOB API down'));
    const service = await makeService();
    await expect(service.getTradeStatuses(['x1'])).rejects.toThrow('CLOB API down');
  });
});