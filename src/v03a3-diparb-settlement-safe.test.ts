import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P0.3a-3: DipArb emergencyExitLeg1 settlement-safe.

let mockTradingService: { createMarketOrder: ReturnType<typeof vi.fn>; getTradeStatuses: ReturnType<typeof vi.fn> };
let mockCtf: { getPositionBalanceByTokenIds: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', 'false');
  mockTradingService = {
    createMarketOrder: vi.fn().mockResolvedValue({ success: true, orderId: '0xorder1', tradeIds: ['t1'] }),
    getTradeStatuses: vi.fn().mockResolvedValue([{ id: 't1', status: 'MATCHED', transactionHash: '' }]),
  };
  mockCtf = {
    getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '5', noBalance: '2' }),
  };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function makeService() {
  const { DipArbService } = await import('./services/dip-arb-service.js');
  const service = new DipArbService(null as any, null as any, null as any);
  Object.assign(service, {
    tradingService: mockTradingService,
    ctf: mockCtf,
    market: { conditionId: '0x01', upTokenId: 'up-tok', downTokenId: 'down-tok' },
    currentRound: {
      roundId: 'r1',
      leg1: { side: 'UP' as const, price: 0.30, shares: 10, tokenId: 'tok-up', timestamp: Date.now() },
    },
    upAsks: [{ price: 0.30 }],
    downAsks: [{ price: 0.70 }],
    config: { maxSlippage: 0.02, feeRateBps: 100 },
  });
  (service as any).log = vi.fn();
  (service as any).emit = vi.fn();
  (service as any).stats = { totalProfit: 0, roundsCompleted: 0, roundsExpired: 0 };
  return service;
}

describe('P0.3a-3 DipArb emergencyExitLeg1 settlement-safe', () => {
  it('pre-read CTF failure → no SELL, fail closed', async () => {
    mockCtf.getPositionBalanceByTokenIds.mockRejectedValue(new Error('RPC down'));
    const service = await makeService();
    const result = await (service as any).emergencyExitLeg1();
    expect(result.success).toBe(false);
    expect(result.error).toContain('balance query failed');
    expect(mockTradingService.createMarketOrder).not.toHaveBeenCalled();
  });

  it('zero pre-balance → no SELL, resolves without PnL when no exit context', async () => {
    mockCtf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '2' });
    const service = await makeService();
    const result = await (service as any).emergencyExitLeg1();
    expect(result.success).toBe(true);
    expect(mockTradingService.createMarketOrder).not.toHaveBeenCalled();
    expect((service as any).currentRound.leg1.exitPending).toBeUndefined();
  });

  it('fresh balance 5 / stale shares 10 → SELL amount = 5', async () => {
    mockCtf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '5', noBalance: '2' });
    const service = await makeService();
    await (service as any).emergencyExitLeg1();
    const call = mockTradingService.createMarketOrder.mock.calls[0][0];
    expect(call.amount).toBe(5);
  });

  it('successful SELL + post-balance positive → pending retained, no PnL', async () => {
    // Set CTF balance to match leg1.shares so exitSubmitShares = 10
    mockCtf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '10', noBalance: '2' });
    const service = await makeService();
    const result = await (service as any).emergencyExitLeg1();
    expect(result.success).toBe(false);
    expect(result.error).toContain('awaiting settlement');
    expect((service as any).currentRound.leg1.exitPending).toBe(true);
    expect((service as any).currentRound.leg1.exitTradeIds).toEqual(['t1']);
    expect((service as any).currentRound.leg1.exitSubmitPrice).toBe(0.30);
    expect((service as any).currentRound.leg1.exitSubmitShares).toBe(10);
    expect((service as any).stats.totalProfit).toBe(0); // no PnL yet
  });

  it('next cycle: pending + MATCHED trades → no duplicate SELL', async () => {
    const service = await makeService();
    await (service as any).emergencyExitLeg1(); // first attempt sets pending
    mockTradingService.createMarketOrder.mockClear();
    const result = await (service as any).emergencyExitLeg1(); // second call
    expect(result.success).toBe(false);
    expect(result.error).toContain('pending settlement');
    expect(mockTradingService.createMarketOrder).not.toHaveBeenCalled();
  });

  it('next cycle: pending + empty tradeIds → no duplicate SELL', async () => {
    mockTradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: '0xorder2', tradeIds: [] });
    const service = await makeService();
    await (service as any).emergencyExitLeg1();
    mockTradingService.createMarketOrder.mockClear();
    const result = await (service as any).emergencyExitLeg1();
    expect(result.success).toBe(false);
    expect(result.error).toContain('no trade IDs');
    expect(mockTradingService.createMarketOrder).not.toHaveBeenCalled();
  });

  it('pending + trade-status query error → no duplicate SELL', async () => {
    const service = await makeService();
    await (service as any).emergencyExitLeg1();
    mockTradingService.getTradeStatuses.mockRejectedValue(new Error('CLOB down'));
    mockTradingService.createMarketOrder.mockClear();
    const result = await (service as any).emergencyExitLeg1();
    expect(result.success).toBe(false);
    expect(result.error).toContain('waiting');
    expect(mockTradingService.createMarketOrder).not.toHaveBeenCalled();
  });

  it('pending + all FAILED → fresh SELL allowed with current balance', async () => {
    const service = await makeService();
    await (service as any).emergencyExitLeg1(); // first SELL, sets pending
    mockTradingService.getTradeStatuses.mockResolvedValue([{ id: 't1', status: 'FAILED' }]);
    mockTradingService.createMarketOrder.mockClear();
    const result = await (service as any).emergencyExitLeg1();
    // After FAILED, pending cleared and new SELL submitted
    expect(mockTradingService.createMarketOrder).toHaveBeenCalledTimes(1);
    // New SELL sets pending again (fresh SELL → exitPending = true)
    expect((service as any).currentRound.leg1.exitPending).toBe(true);
  });

  it('pending + mixed FAILED/MATCHED → no retry', async () => {
    const service = await makeService();
    (service as any).currentRound.leg1.exitPending = true;
    (service as any).currentRound.leg1.exitTradeIds = ['t1', 't2'];
    mockTradingService.getTradeStatuses.mockResolvedValue([
      { id: 't1', status: 'FAILED' },
      { id: 't2', status: 'MATCHED' },
    ]);
    mockTradingService.createMarketOrder.mockClear();
    const result = await (service as any).emergencyExitLeg1();
    expect(result.success).toBe(false);
    expect(mockTradingService.createMarketOrder).not.toHaveBeenCalled();
  });

  it('pending + trade status UNKNOWN → no duplicate SELL', async () => {
    const service = await makeService();
    (service as any).currentRound.leg1.exitPending = true;
    (service as any).currentRound.leg1.exitTradeIds = ['trade-unknown'];
    mockTradingService.getTradeStatuses.mockResolvedValue([
      { id: 'trade-unknown', status: 'UNKNOWN' },
    ]);
    mockTradingService.createMarketOrder.mockClear();
    const result = await (service as any).emergencyExitLeg1();
    expect(result.success).toBe(false);
    expect(result.error).toContain('pending settlement');
    expect(mockTradingService.createMarketOrder).not.toHaveBeenCalled();
    // pending metadata intact
    expect((service as any).currentRound.leg1.exitPending).toBe(true);
    expect((service as any).currentRound.leg1.exitTradeIds).toEqual(['trade-unknown']);
    // no PnL
    expect((service as any).stats.totalProfit).toBe(0);
  });

  it('delayed CTF zero → finalize using stored exitSubmitPrice and exitSubmitShares', async () => {
    mockCtf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '10', noBalance: '2' });
    const service = await makeService();
    await (service as any).emergencyExitLeg1(); // sets exitSubmitPrice=0.30, exitSubmitShares=10
    // Next cycle: CTF balance zero, pending set
    mockCtf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '2' });
    mockTradingService.createMarketOrder.mockClear();
    const result = await (service as any).emergencyExitLeg1();
    expect(result.success).toBe(true);
    expect(mockTradingService.createMarketOrder).not.toHaveBeenCalled();
    // PnL recorded using stored price
    expect((service as any).stats.totalProfit).toBeLessThan(0);
    expect((service as any).currentRound.leg1.exitPending).toBeUndefined();
  });

  it('immediate post-SELL CTF zero → one completion, PnL recorded', async () => {
    mockCtf.getPositionBalanceByTokenIds
      .mockResolvedValueOnce({ yesBalance: '10', noBalance: '2' }) // pre-check
      .mockResolvedValueOnce({ yesBalance: '0', noBalance: '2' });  // post-check
    const service = await makeService();
    const result = await (service as any).emergencyExitLeg1();
    expect(result.success).toBe(true);
    expect((service as any).stats.totalProfit).toBeLessThan(0);
    expect((service as any).currentRound.leg1.exitPending).toBeUndefined();
  });

  it('unconfirmed exit keeps round in leg1_filled phase', async () => {
    const service = await makeService();
    // Caller pattern: only mutate on success
    const exitResult = await (service as any).emergencyExitLeg1();
    if (exitResult.success) {
      (service as any).currentRound.phase = 'expired';
      (service as any).stats.roundsExpired++;
      (service as any).stats.roundsCompleted++;
    }
    expect(exitResult.success).toBe(false);
    expect((service as any).currentRound.phase).not.toBe('expired');
    expect((service as any).stats.roundsCompleted).toBe(0);
  });

  it('confirmed exit advances lifecycle: phase=expired, counters incremented', async () => {
    mockCtf.getPositionBalanceByTokenIds
      .mockResolvedValueOnce({ yesBalance: '10', noBalance: '2' })
      .mockResolvedValueOnce({ yesBalance: '0', noBalance: '2' });
    const service = await makeService();
    const exitResult = await (service as any).emergencyExitLeg1();
    if (exitResult.success) {
      (service as any).currentRound.phase = 'expired';
      (service as any).stats.roundsExpired++;
      (service as any).stats.roundsCompleted++;
    }
    expect(exitResult.success).toBe(true);
    expect((service as any).currentRound.phase).toBe('expired');
    expect((service as any).stats.roundsCompleted).toBe(1);
  });
});