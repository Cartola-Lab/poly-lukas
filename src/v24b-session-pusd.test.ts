import { describe, expect, it } from 'vitest';
import { createSessionFromState } from './dashboard/session-history.js';

// P0.V2.4b: session balances include pUsdBalance alongside native USDC and USDC.e.

function makeState(overrides: Record<string, number> = {}) {
  return {
    totalPnL: overrides.totalPnL ?? 50,
    tradesExecuted: overrides.tradesExecuted ?? 10,
    smartMoneyTrades: overrides.smartMoneyTrades ?? 3,
    arbTrades: overrides.arbTrades ?? 4,
    dipArbTrades: overrides.dipArbTrades ?? 2,
    directTrades: overrides.directTrades ?? 1,
    arbProfit: overrides.arbProfit ?? 20,
    followedWallets: [],
    splits: overrides.splits ?? 0,
    merges: overrides.merges ?? 0,
    redeems: overrides.redeems ?? 0,
    swaps: overrides.swaps ?? 0,
    usdcBalance: overrides.usdcBalance ?? 1000,
    usdcEBalance: overrides.usdcEBalance ?? 500,
    pUsdBalance: overrides.pUsdBalance ?? 300,
  };
}

const config = {
  dryRun: false,
  smartMoney: { enabled: true },
  arbitrage: { enabled: true },
  dipArb: { enabled: true },
  directTrading: { enabled: false },
};

describe('V2.4b session-history includes pUsdBalance in balances', () => {
  it('starting balance includes native USDC + USDC.e + pUSD', () => {
    const state = makeState();
    const session = createSessionFromState(Date.now(), state, config, []);
    expect(session.startingBalance).toBe(1750); // 1000 + 500 + 300 - 50
  });

  it('ending balance includes native USDC + USDC.e + pUSD', () => {
    const state = makeState({ totalPnL: 0 });
    const session = createSessionFromState(Date.now(), state, config, []);
    expect(session.endingBalance).toBe(1800); // 1000 + 500 + 300
  });

  it('delta (ending - starting) reflects pUSD contribution against PnL', () => {
    const state = makeState({ totalPnL: 50 });
    const session = createSessionFromState(Date.now(), state, config, []);
    // starting = 1000 + 500 + 300 - 50 = 1750, ending = 1000 + 500 + 300 = 1800
    // delta = 50 = totalPnL (correct: PnL fully accounts for ending-starting)
    expect(session.endingBalance - session.startingBalance).toBe(session.totalPnL);
  });

  it('zero pUSD preserves previous total behavior', () => {
    const state = makeState({ pUsdBalance: 0, totalPnL: 0 });
    const session = createSessionFromState(Date.now(), state, config, []);
    expect(session.startingBalance).toBe(1500); // 1000 + 500 + 0
    expect(session.endingBalance).toBe(1500);
  });

  it('pUSD-only capital works correctly', () => {
    const state = makeState({ usdcBalance: 0, usdcEBalance: 0, pUsdBalance: 2000, totalPnL: 100 });
    const session = createSessionFromState(Date.now(), state, config, []);
    expect(session.startingBalance).toBe(1900); // 0 + 0 + 2000 - 100
    expect(session.endingBalance).toBe(2000);  // 0 + 0 + 2000
    expect(session.endingBalance - session.startingBalance).toBe(100);
  });

  it('starting balance never goes below zero', () => {
    const state = makeState({ totalPnL: 5000 });
    const session = createSessionFromState(Date.now(), state, config, []);
    expect(session.startingBalance).toBe(0); // 1800 - 5000 clamped to 0
  });

  it('all three components are additive, no double-counting', () => {
    const state = makeState({ usdcBalance: 100, usdcEBalance: 200, pUsdBalance: 300, totalPnL: 0 });
    const session = createSessionFromState(Date.now(), state, config, []);
    expect(session.startingBalance).toBe(600);
    expect(session.endingBalance).toBe(600);
  });
});