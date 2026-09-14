import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P0.2a: DipArb emergencyExitLeg1 must pass shares (not USDC notional) as SELL amount.

let mockTradingService: { createMarketOrder: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', 'false');
  mockTradingService = { createMarketOrder: vi.fn().mockResolvedValue({ success: false, errorMsg: 'mock stub' }) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function makeService() {
  const { DipArbService } = await import('./services/dip-arb-service.js');
  // DipArbService is an EventEmitter; pass minimal config
  const service = new DipArbService(null as any, null as any, null as any);
  Object.assign(service, {
    tradingService: mockTradingService,
    market: { conditionId: '0x01', upTokenId: 'up-tok', downTokenId: 'down-tok' },
    currentRound: {
      roundId: 'r1',
      leg1: { shares: 10, side: 'UP', tokenId: 'tok-up', price: 0.30 },
      leg2: null,
    },
    upAsks: [{ price: 0.30 }],
    downAsks: [{ price: 0.70 }],
    config: { maxSlippage: 0.02, feeRateBps: 100 },
  });
  // Stub log + emit
  (service as any).log = vi.fn();
  (service as any).emit = vi.fn();
  return service;
}

describe('P0.2a DipArb emergencyExitLeg1 SELL amount', () => {
  it('passes shares (not USDC notional) as the SELL amount', async () => {
    const service = await makeService();
    const result = await (service as any).emergencyExitLeg1();
    expect(mockTradingService.createMarketOrder).toHaveBeenCalledTimes(1);
    const call = mockTradingService.createMarketOrder.mock.calls[0][0];
    expect(call.side).toBe('SELL');
    expect(call.amount).toBe(10); // leg1.shares, NOT 3 = 10 * 0.30
  });

  it('preserves tokenId from the position', async () => {
    const service = await makeService();
    await (service as any).emergencyExitLeg1();
    const call = mockTradingService.createMarketOrder.mock.calls[0][0];
    expect(call.tokenId).toBe('tok-up');
  });

  it('preserves the FOK order type', async () => {
    const service = await makeService();
    await (service as any).emergencyExitLeg1();
    const call = mockTradingService.createMarketOrder.mock.calls[0][0];
    expect(call.orderType).toBe('FOK');
  });

  it('preserves the price floor', async () => {
    const service = await makeService();
    await (service as any).emergencyExitLeg1();
    const call = mockTradingService.createMarketOrder.mock.calls[0][0];
    expect(call.price).toBe(0.30 * 0.98); // currentPrice * (1 - maxSlippage)
  });

  it('benefit: 10 shares @ $0.30 passes 10 shares, not 3 (old broken), so SELL covers full position', async () => {
    // Old: exitAmount = 10 * 0.30 = 3 → SDK treats as "sell 3 shares" → 7 shares left exposed
    // New: exitAmount = 10 → SDK treats as "sell 10 shares" → full position sold
    const service = await makeService();
    await (service as any).emergencyExitLeg1();
    const call = mockTradingService.createMarketOrder.mock.calls[0][0];
    expect(call.amount).toBeGreaterThan(3); // proves we fixed the bug
    expect(call.amount).toBe(10);           // proves exact share count
  });
});