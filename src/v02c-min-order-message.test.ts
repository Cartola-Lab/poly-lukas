import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providers, BigNumber } from 'ethers';

// P0.2c: trading-service minimum-order guard uses side-aware error messages.

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', 'false');
  vi.spyOn(providers.JsonRpcProvider.prototype, 'send').mockImplementation(async method => {
    if (method === 'eth_chainId') return '0x89';
    throw new Error(`Unexpected RPC: ${method}`);
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getFeeData').mockResolvedValue({
    gasPrice: BigNumber.from(100), lastBaseFeePerGas: BigNumber.from(100),
    maxFeePerGas: BigNumber.from(200), maxPriorityFeePerGas: BigNumber.from(30),
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getGasPrice').mockResolvedValue(BigNumber.from(100));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function makeService() {
  const { TradingService } = await import('./services/trading-service.js');
  const mockLimiter = { execute: (_: unknown, fn: () => unknown) => fn() };
  const mockCache = { get: vi.fn(), set: vi.fn() };
  const service = new TradingService(mockLimiter as any, mockCache as any, { privateKey: '0x' + '11'.repeat(32) });
  // Stub ensureInitialized to bypass CLOB client + network
  (service as any).ensureInitialized = vi.fn().mockRejectedValue(new Error('should not reach API'));
  return service;
}

describe('P0.2c side-aware minimum-order guard', () => {
  it('BUY below $1 uses dollar/notional language', async () => {
    const service = await makeService();
    const result = await service.createMarketOrder({ tokenId: '1', side: 'BUY', amount: 0.50 });
    expect(result.success).toBe(false);
    expect(result.errorMsg).toContain('amount ($0.50)');
    expect(result.errorMsg).toContain('below local minimum ($1)');
  });

  it('SELL below 1 share uses share language, no $ prefix on amount', async () => {
    const service = await makeService();
    const result = await service.createMarketOrder({ tokenId: '1', side: 'SELL', amount: 0.50 });
    expect(result.success).toBe(false);
    expect(result.errorMsg).toContain('shares (0.50)');
    expect(result.errorMsg).toContain('below local minimum (1 share)');
    expect(result.errorMsg).not.toMatch(/\$0\.50/);
  });

  it('threshold at exactly $1 for BUY passes the local guard', async () => {
    const service = await makeService();
    // Passes guard ($1 >= $1), reaches initialization which throws
    await expect(service.createMarketOrder({ tokenId: '1', side: 'BUY', amount: 1.00 }))
      .rejects.toThrow('should not reach API');
  });

  it('threshold at exactly 1 share for SELL passes the local guard', async () => {
    const service = await makeService();
    await expect(service.createMarketOrder({ tokenId: '1', side: 'SELL', amount: 1.00 }))
      .rejects.toThrow('should not reach API');
  });

  it('SELL amount = 10 shares well above threshold passes local guard', async () => {
    const service = await makeService();
    await expect(service.createMarketOrder({ tokenId: '1', side: 'SELL', amount: 10 }))
      .rejects.toThrow('should not reach API');
  });
});