import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providers, BigNumber } from 'ethers';

// P0.3b-1: TradingService.getOrderTradeIds discovers trade IDs from a CLOB order.

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

  mockGetOrder = vi.fn().mockResolvedValue({ associate_trades: [] });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function makeService() {
  const { TradingService } = await import('./services/trading-service.js');
  const mockLimiter = { execute: (_: unknown, fn: () => unknown) => fn() };
  const mockCache = { get: vi.fn(), set: vi.fn() };
  const service = new TradingService(mockLimiter as any, mockCache as any, { privateKey: '0x' + '11'.repeat(32) });
  (service as any).clobClient = { getOrder: mockGetOrder };
  (service as any).initialized = true;
  return service;
}

describe('P0.3b-1 getOrderTradeIds discovers order trades', () => {
  it('one associated trade ID propagates', async () => {
    mockGetOrder.mockResolvedValue({ associate_trades: ['0xt1'] });
    const service = await makeService();
    const ids = await service.getOrderTradeIds('0xorder1');
    expect(ids).toEqual(['0xt1']);
  });

  it('multiple associated trade IDs propagate unchanged', async () => {
    mockGetOrder.mockResolvedValue({ associate_trades: ['0xa', '0xb', '0xc'] });
    const service = await makeService();
    const ids = await service.getOrderTradeIds('0xorder2');
    expect(ids).toEqual(['0xa', '0xb', '0xc']);
  });

  it('empty associate_trades returns []', async () => {
    mockGetOrder.mockResolvedValue({ associate_trades: [] });
    const service = await makeService();
    const ids = await service.getOrderTradeIds('0xorder3');
    expect(ids).toEqual([]);
  });

  it('getOrder error propagates', async () => {
    mockGetOrder.mockRejectedValue(new Error('Order not found'));
    const service = await makeService();
    await expect(service.getOrderTradeIds('0xmissing')).rejects.toThrow('Order not found');
  });

  it('calls getOrder with exact supplied orderId', async () => {
    mockGetOrder.mockResolvedValue({ associate_trades: ['0xt2'] });
    const service = await makeService();
    await service.getOrderTradeIds('0xexact-order');
    expect(mockGetOrder).toHaveBeenCalledWith('0xexact-order');
  });
});