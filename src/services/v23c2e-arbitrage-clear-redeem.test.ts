import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P0.V2.3C2e: ArbitrageService clearPositions calls redeemByTokenIds, not redeem.
// Fully offline: real ArbitrageService instantiation with mocked CTF client.

let mockGetPositionBalanceByTokenIds: ReturnType<typeof vi.fn>;
let mockGetMarketResolution: ReturnType<typeof vi.fn>;
let mockRedeemByTokenIds: ReturnType<typeof vi.fn>;
let mockRedeem: ReturnType<typeof vi.fn>;

const yesTokenId = 'tok-yes-1';
const noTokenId = 'tok-no-1';
const conditionId = '0x' + 'de'.repeat(32);

function makeMarket(negRisk: boolean) {
  return {
    name: 'test-market',
    conditionId,
    yesTokenId,
    noTokenId,
    negRisk,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', 'false');
  mockGetPositionBalanceByTokenIds = vi.fn().mockResolvedValue({ yesBalance: '3', noBalance: '1.5' });
  mockGetMarketResolution = vi.fn().mockResolvedValue({ isResolved: true, winningOutcome: 'YES' });
  mockRedeemByTokenIds = vi.fn().mockResolvedValue({
    success: true,
    txHash: '0x01',
    tokensRedeemed: '3',
    usdcReceived: '3',
    yesTokensConsumed: '3',
    noTokensConsumed: '1.5',
  });
  mockRedeem = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function makeService() {
  const { ArbitrageService } = await import('./arbitrage-service.js');
  const service = new ArbitrageService({ enableLogging: false });
  const internal = service as unknown as {
    ctf: {
      getPositionBalanceByTokenIds: typeof mockGetPositionBalanceByTokenIds;
      getMarketResolution: typeof mockGetMarketResolution;
      redeemByTokenIds: typeof mockRedeemByTokenIds;
      redeem: typeof mockRedeem;
    };
  };
  internal.ctf = {
    getPositionBalanceByTokenIds: mockGetPositionBalanceByTokenIds,
    getMarketResolution: mockGetMarketResolution,
    redeemByTokenIds: mockRedeemByTokenIds,
    redeem: mockRedeem,
  };
  return service;
}

describe('V2.3C2e Arbitrage clearPositions uses redeemByTokenIds', () => {
  it('calls redeemByTokenIds with exact conditionId and token IDs for a standard market', async () => {
    const service = await makeService();
    const market = makeMarket(false);
    await service.clearPositions(market, true);
    expect(mockRedeemByTokenIds).toHaveBeenCalledTimes(1);
    expect(mockRedeemByTokenIds).toHaveBeenCalledWith(conditionId, { yesTokenId, noTokenId }, undefined, { negRisk: false });
  });

  it('forwards exact token IDs from the market config to redeemByTokenIds', async () => {
    const service = await makeService();
    const market = makeMarket(false);
    await service.clearPositions(market, true);
    const [cId, tIds] = mockRedeemByTokenIds.mock.calls[0];
    expect(cId).toBe(conditionId);
    expect(tIds.yesTokenId).toBe(yesTokenId);
    expect(tIds.noTokenId).toBe(noTokenId);
  });

  it('preserves the negRisk routing flag from the market', async () => {
    const service = await makeService();
    await service.clearPositions(makeMarket(false), true);
    expect(mockRedeemByTokenIds).toHaveBeenCalledWith(expect.any(String), expect.anything(), undefined, { negRisk: false });

    mockRedeemByTokenIds.mockClear();
    await service.clearPositions(makeMarket(true), true);
    expect(mockRedeemByTokenIds).toHaveBeenCalledWith(expect.any(String), expect.anything(), undefined, { negRisk: true });
  });

  it('never calls generic redeem()', async () => {
    const service = await makeService();
    await service.clearPositions(makeMarket(false), true);
    expect(mockRedeem).not.toHaveBeenCalled();

    mockRedeemByTokenIds.mockClear();
    await service.clearPositions(makeMarket(true), true);
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it('preserves the existing outcome-passing behavior (undefined outcome)', async () => {
    const service = await makeService();
    await service.clearPositions(makeMarket(false), true);
    expect(mockRedeemByTokenIds.mock.calls[0][2]).toBeUndefined();
  });

  it('passes the correct routing through toLifecycleRouting for undefined negRisk', async () => {
    const service = await makeService();
    const market = { name: 'unknown-type', conditionId, yesTokenId, noTokenId };
    // negRisk is undefined → routing should be undefined
    await service.clearPositions(market, true);
    expect(mockRedeemByTokenIds).toHaveBeenCalledWith(expect.any(String), expect.anything(), undefined, undefined);
  });

  it('returns success result from redeemByTokenIds', async () => {
    const service = await makeService();
    const result = await service.clearPositions(makeMarket(false), true);
    expect(result.success).toBe(true);
    expect(result.totalUsdcRecovered).toBe(3);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].type).toBe('redeem');
    expect(result.actions[0].txHash).toBe('0x01');
  });
});