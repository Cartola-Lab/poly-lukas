import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P0.2b: Smart Money copy must use shares for SELL amount, USDC notional for BUY amount.
// Intercepts the actual tradingService.createMarketOrder call through the full
// SmartMoneyService execution pipeline by mocking subscribeSmartMoneyTrades.

let mockTradingService: { createMarketOrder: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', 'false');
  mockTradingService = { createMarketOrder: vi.fn().mockResolvedValue({ success: true, orderId: '0x01' }) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function makeTrade(side: 'BUY' | 'SELL'): Record<string, unknown> {
  return {
    traderAddress: '0x' + 'aa'.repeat(20),
    side,
    size: 100,
    price: 0.40,
    marketSlug: 'test-market',
    conditionId: '0x01',
    tokenId: side === 'BUY' ? 'tok-buy' : 'tok-sell',
    timestamp: Date.now(),
    isSmartMoney: true,
  };
}

async function runCopyWithTrade(trade: Record<string, unknown>) {
  const { SmartMoneyService } = await import('./services/smart-money-service.js');
  const service = new SmartMoneyService({ dryRun: false, enableLogging: false });

  (service as any).tradingService = mockTradingService;
  (service as any).log = vi.fn();
  (service as any).stats = { smartMoneyTrades: 0, smartMoneyPnl: 0 };
  (service as any).trackedWallets = {
    getStats: vi.fn().mockReturnValue({}),
    getHealth: vi.fn().mockReturnValue({}),
    recordFill: vi.fn().mockReturnValue({ totalPnl: 0, hasCooldown: false }),
  };
  (service as any).walletStats = {};
  (service as any).consecutiveTradeFailures = {};
  (service as any).walletCooldowns = {};

  // Mock subscribeSmartMoneyTrades to immediately invoke the callback
  vi.spyOn(service as any, 'subscribeSmartMoneyTrades').mockImplementation(
    (onTrade: (t: unknown) => void) => {
      onTrade(trade);
      return { id: 'sub-1', unsubscribe: vi.fn() };
    }
  );

  await service.startAutoCopyTrading({
    targetAddresses: ['0x' + 'aa'.repeat(20)],
    sizeScale: 0.1,
    maxSizePerTrade: 50,
    minTradeSize: 1,
    maxStalenessMs: 60000,
    feeRateBps: 0,
  });

  return service;
}

describe('P0.2b Smart Money SELL amount intercepted at createMarketOrder', () => {
  it('BUY passes USDC notional as amount (100 * 0.1 * 0.40 = 4)', async () => {
    await runCopyWithTrade(makeTrade('BUY'));
    expect(mockTradingService.createMarketOrder).toHaveBeenCalledTimes(1);
    const call = mockTradingService.createMarketOrder.mock.calls[0][0];
    expect(call.side).toBe('BUY');
    expect(call.amount).toBe(4); // 10 shares * $0.40 = $4 USDC
  });

  it('SELL passes shares as amount (100 * 0.1 = 10 shares)', async () => {
    await runCopyWithTrade(makeTrade('SELL'));
    expect(mockTradingService.createMarketOrder).toHaveBeenCalledTimes(1);
    const call = mockTradingService.createMarketOrder.mock.calls[0][0];
    expect(call.side).toBe('SELL');
    expect(call.amount).toBe(10); // 10 shares, NOT 4
  });

  it('preserves tokenId from the trade', async () => {
    await runCopyWithTrade(makeTrade('BUY'));
    expect(mockTradingService.createMarketOrder.mock.calls[0][0].tokenId).toBe('tok-buy');
  });

  it('preserves orderType FOK', async () => {
    await runCopyWithTrade(makeTrade('BUY'));
    expect(mockTradingService.createMarketOrder.mock.calls[0][0].orderType).toBe('FOK');
  });

  it('benefit: 10 shares @ $0.40 SELL passes 10, not 4', async () => {
    await runCopyWithTrade(makeTrade('SELL'));
    const call = mockTradingService.createMarketOrder.mock.calls[0][0];
    expect(call.amount).toBeGreaterThan(4);
    expect(call.amount).toBe(10);
  });
});