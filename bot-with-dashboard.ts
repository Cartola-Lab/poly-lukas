/**
 * Bot with Dashboard - Wrapper that runs the bot with real-time monitoring UI
 * 
 * This file shows HOW to integrate the dashboard with your bot.
 * It imports the dashboard and hooks into the bot's state/logs.
 * 
 * Run with: npx tsx bot-with-dashboard.ts
 * Then open: http://localhost:5173
 */

import 'dotenv/config';
import { executionMode } from './src/core/execution-mode.js';
import { handleExecutionModeCommand } from './src/dashboard/execution-commands.js';
import { ethers } from 'ethers';
import {
  PolymarketSDK,
  ArbitrageService,
  SwapService,
  type SmartMoneyTrade,
  type AutoCopyTradingSubscription,
  type DipArbRoundResult,
  OnchainService,
} from './src/index.js';
import { CTFClient, RedeemProvenanceError, type RedeemProvenance } from './src/clients/ctf-client.js';
import { startDashboard, dashboardEmitter } from './src/dashboard/index.js';
import type { BotState, BotConfig, LogLevel, DipArbSignal, SmartMoneySignal } from './src/dashboard/types.js';
import { loadHistory, saveHistory, createSessionFromState, type TradeRecord, type SessionSummary } from './src/dashboard/session-history.js';
import { resolvePolygonRpcUrl } from './src/utils/rpc.js';
import {
  computeWalletQualityFromPositions,
  evaluateWalletQuality,
  toWalletQualityGate,
  calculatePositionSize,
  shouldPauseForLossStreak,
  checkExposure,
  checkPnlDrift,
  type PreExecutionGuard,
} from './src/utils/risk.js';
import { fetchClosedPnls } from './src/utils/closed-positions.js';

// ============================================================================
// CONFIGURATION (same as bot-config.ts)
// ============================================================================

const CAPITAL_USD = parseFloat(process.env.CAPITAL_USD || '250');

const CONFIG = {
  capital: {
    totalUsd: CAPITAL_USD,
    maxPerTradePct: 0.02,  // 🔴 FIXED: Reduced from 3% to 2%
    maxPerMarketPct: 0.10,
    maxTotalExposurePct: 0.30,
    minOrderUsd: 5,
    strategyAllocation: {
      smartMoney: 0.60,
      arbitrage: 0.20,
      dipArb: 0.10,
      directTrades: 0.10,
    },
  },

  risk: {
    // Daily limits (env-overridable — documented in README)
    dailyMaxLossPct: parseFloat(process.env.DAILY_MAX_LOSS_PCT || '0.05'),
    maxConsecutiveLosses: 6,
    pauseOnBreachMinutes: 60,

    // 🔴 NEW: v3.1 Multi-layer protection (env-overridable)
    monthlyMaxLossPct: parseFloat(process.env.MONTHLY_MAX_LOSS_PCT || '0.15'),
    maxDrawdownFromPeak: parseFloat(process.env.MAX_DRAWDOWN_PCT || '0.25'),
    totalMaxLossPct: parseFloat(process.env.TOTAL_MAX_LOSS_PCT || '0.40'),

    // v3.2 AUDIT #6: PnL drift tolerance (on-chain reconciliation)
    maxPnlDriftUsd: 5,
    maxPnlDriftPct: 0.02,

    // 🔴 NEW: Dynamic position sizing
    enableDynamicSizing: true,
    minPositionPct: 0.01,  // 1% minimum
    maxPositionPct: 0.05,  // 5% maximum
    lossSizingReduction: 0.20,  // Reduce 20% per loss
    winSizingIncrease: 0.10,  // Increase 10% per win
  },

  smartMoney: {
    enabled: process.env.SMARTMONEY_ENABLED !== 'false',
    topN: 20,
    // 🔴 FIXED: Stricter criteria (v3.1)
    minWinRate: 0.60,  // Up from 0.70 to match bot-config (60%+)
    minPnl: 500,       // Up from 70 to $500
    minTrades: 30,     // Up from 15 to 30

    // 🔴 NEW: Quality filters
    minProfitFactor: 1.5,  // Total wins / total losses >= 1.5x
    minConsistencyScore: 0.7,  // Recent performance score
    maxSingleTradeExposure: 0.3,  // Max 30% of PnL from one trade
    checkLastNTrades: 10,  // Analyze last 10 trades

    sizeScale: 0.1,
    // Cap copies at the risk contract's per-trade limit — a copy above
    // maxPerTradePct × capital would be silently skipped by the risk guard
    // anyway (guard checks the USD notional before the order).
    maxSizePerTrade: Math.min(15, CAPITAL_USD * 0.02),
    maxSlippage: 0.03,
    minTradeSize: 10,  // Up from 5
    delay: 500,
    customWallets: [
      '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',
      '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74',
    ] as string[],
  },

  arbitrage: {
    enabled: process.env.ARBITRAGE_ENABLED === 'true',
    // 🔴 FIXED: Higher profit threshold for gas fees
    profitThreshold: 0.01,  // Up from 0.001 to 1%
    minTradeSize: 20,  // Up from 5 to reduce gas impact
    maxTradeSize: 100,  // Up from 50
    minVolume24h: 5000,
    autoExecute: true,
    enableRebalancer: true,

    // 🔴 NEW: Gas fee accounting
    estimatedGasCostUSD: 0.10,
    minNetProfit: 0.50,
  },

  dipArb: {
    enabled: process.env.DIPARB_ENABLED === 'true',
    coins: ['BTC', 'ETH', 'SOL'] as const,
    shares: 10,
    sumTarget: 0.92,
    autoRotate: true,
    autoExecute: true,
    // 🔴 NEW: Minimum trade value
    minTradeValueUSD: 1.5,  // $1.50 minimum
  },

  onchain: {
    enabled: true,
    autoApprove: true,
    minMatic: 0.5,
  },

  binance: {
    enabled: process.env.TREND_ANALYSIS_ENABLED === 'true',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const,
    interval: '15m' as const,
    trendThreshold: 2,
  },

  directTrading: {
    enabled: false,
    trendFollowing: true,
    minTrendStrength: 0.02,
    // 🔴 NEW: Stop-loss and take-profit
    stopLossPct: 0.15,
    takeProfitPct: 0.25,
    trailingStopPct: 0.10,
    maxHoldDays: 7,
    minRiskReward: 1.5,
  },

  get dryRun() { return executionMode.startupMode === 'DRY'; },
};

// ============================================================================
// STATE
// ============================================================================

const state: BotState = {
  startTime: Date.now(),
  dailyPnL: 0,
  totalPnL: 0,
  consecutiveLosses: 0,
  consecutiveWins: 0,  // 🔴 NEW
  tradesExecuted: 0,
  wins: 0,
  losses: 0,
  isPaused: false,
  pauseUntil: 0,

  // 🔴 NEW: v3.1 Risk tracking
  monthlyPnL: 0,
  monthStartTime: Date.now(),
  peakCapital: CONFIG.capital.totalUsd,
  currentCapital: CONFIG.capital.totalUsd,
  currentDrawdown: 0,
  permanentlyHalted: false,
  lastDailyReset: Date.now(),

  // v3.2 risk: chain-seeded exposure + PnL reconciliation baseline
  totalExposureUsd: 0,
  perMarketExposureUsd: {},
  pnlBaselineCollateral: null,

  smartMoneyTrades: 0,
  arbTrades: 0,
  dipArbTrades: 0,
  directTrades: 0,
  arbProfit: 0,
  followedWallets: [],
  positions: [],
  activeArbMarket: null,
  activeDipArbMarket: null,
  splits: 0,
  merges: 0,
  redeems: 0,
  swaps: 0,
  usdcBalance: 0,
  usdcEBalance: 0,
  pUsdBalance: 0,
  maticBalance: 0,
  unrealizedPnL: 0,
  btcTrend: 'neutral',
  ethTrend: 'neutral',
  solTrend: 'neutral',

  dipArb: {
    marketName: null,
    underlying: null,
    duration: null,
    endTime: null,
    upPrice: 0,
    downPrice: 0,
    sum: 0,
    status: 'idle',
    lastSignal: null,
    signals: [],
  },

  arbitrage: {
    status: 'idle',
    marketsScanned: 0,
    opportunitiesFound: 0,
    currentMarket: null,
    lastOpportunity: null,
  },

  smartMoneySignals: [],
};

// ============================================================================
// DASHBOARD-AWARE UTILITIES
// ============================================================================

function log(level: LogLevel, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const icons: Record<string, string> = {
    INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯',
    ARB: '🔄', WALLET: '👛', CHAIN: '⛓️', SWAP: '💱', BRIDGE: '🌉',
    KLINE: '📊', TREND: '📈',
  };

  // Console output (CLI)
  console.log(`[${timestamp}] ${icons[level] || '•'} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));

  // Dashboard output (WebSocket)
  dashboardEmitter.log(level, message, data);
}

function updateDashboard() {
  dashboardEmitter.updateState(state);
}

// v3.2: single source of truth for the config the dashboard receives
// (was built as three near-duplicate literals before).
function buildDashboardConfig(): BotConfig {
  return {
    capital: CONFIG.capital,
    risk: CONFIG.risk,
    smartMoney: {
      enabled: CONFIG.smartMoney.enabled,
      topN: CONFIG.smartMoney.topN,
      minWinRate: CONFIG.smartMoney.minWinRate,
      minPnl: CONFIG.smartMoney.minPnl,
      minTrades: CONFIG.smartMoney.minTrades,
      customWallets: CONFIG.smartMoney.customWallets,
    },
    arbitrage: {
      enabled: CONFIG.arbitrage.enabled,
      profitThreshold: CONFIG.arbitrage.profitThreshold,
      autoExecute: CONFIG.arbitrage.autoExecute,
    },
    dipArb: {
      enabled: CONFIG.dipArb.enabled,
      coins: CONFIG.dipArb.coins,
    },
    directTrading: {
      enabled: CONFIG.directTrading.enabled,
    },
    binance: {
      enabled: CONFIG.binance.enabled,
    },
    dryRun: CONFIG.dryRun,
  };
}

// 🔴 FIXED: v3.1 Multi-layer risk management
function canTrade(): boolean {
  // Check if permanently halted
  if (state.permanentlyHalted) {
    log('ERROR', '🛑 Trading permanently halted - total loss limit reached');
    return false;
  }

  // Reset daily PnL if new day
  const daysSinceReset = (Date.now() - state.lastDailyReset) / (1000 * 60 * 60 * 24);
  if (daysSinceReset >= 1) {
    log('INFO', `Daily PnL reset. Previous day: $${state.dailyPnL.toFixed(2)}`);
    state.dailyPnL = 0;
    state.lastDailyReset = Date.now();
  }

  // Reset monthly PnL if new month
  const daysSinceMonthStart = (Date.now() - state.monthStartTime) / (1000 * 60 * 60 * 24);
  if (daysSinceMonthStart >= 30) {
    log('INFO', `Monthly PnL reset. Previous month: $${state.monthlyPnL.toFixed(2)}`);
    state.monthlyPnL = 0;
    state.monthStartTime = Date.now();
  }

  // Update current capital and drawdown
  state.currentCapital = CONFIG.capital.totalUsd + state.totalPnL;
  if (state.currentCapital > state.peakCapital) {
    state.peakCapital = state.currentCapital;
  }
  state.currentDrawdown = (state.peakCapital - state.currentCapital) / state.peakCapital;

  // Check temporary pause
  if (state.isPaused && Date.now() < state.pauseUntil) return false;
  if (state.isPaused && Date.now() >= state.pauseUntil) {
    state.isPaused = false;
    // Clear the loss streak on resume — otherwise Layer 5 re-arms the pause
    // on every canTrade() call and the "60 min" break never actually ends.
    if (state.consecutiveLosses > 0) {
      log('INFO', `Loss streak reset on resume (was ${state.consecutiveLosses})`);
      state.consecutiveLosses = 0;
    }
    log('INFO', 'Bot resumed after cooldown');
    updateDashboard();
  }

  // Layer 1: Daily loss limit
  const dailyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.dailyMaxLossPct;
  if (state.dailyPnL <= -dailyLossLimit) {
    state.isPaused = true;
    state.pauseUntil = Date.now() + CONFIG.risk.pauseOnBreachMinutes * 60 * 1000;
    log('WARN', `Daily loss limit breached: -$${Math.abs(state.dailyPnL).toFixed(2)} (limit: $${dailyLossLimit.toFixed(2)})`);
    updateDashboard();
    return false;
  }

  // Layer 2: Monthly loss limit
  const monthlyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.monthlyMaxLossPct;
  if (state.monthlyPnL <= -monthlyLossLimit) {
    log('ERROR', `🛑 Monthly loss limit breached: -$${Math.abs(state.monthlyPnL).toFixed(2)} (limit: $${monthlyLossLimit.toFixed(2)})`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (30 * 24 * 60 * 60 * 1000);
    updateDashboard();
    return false;
  }

  // Layer 3: Drawdown from peak
  if (state.currentDrawdown >= CONFIG.risk.maxDrawdownFromPeak) {
    log('ERROR', `🛑 Maximum drawdown reached: ${(state.currentDrawdown * 100).toFixed(1)}%`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (7 * 24 * 60 * 60 * 1000);
    updateDashboard();
    return false;
  }

  // Layer 4: Total loss - PERMANENT HALT
  const totalLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.totalMaxLossPct;
  if (state.totalPnL <= -totalLossLimit) {
    state.permanentlyHalted = true;
    executionMode.halt();
    log('ERROR', '💀 TOTAL LOSS LIMIT REACHED - TRADING PERMANENTLY HALTED');
    log('ERROR', `Total loss: -$${Math.abs(state.totalPnL).toFixed(2)} (limit: $${totalLossLimit.toFixed(2)})`);
    updateDashboard();
    return false;
  }

  // Layer 5: Consecutive-loss circuit breaker (v3.2)
  if (shouldPauseForLossStreak(state.consecutiveLosses, CONFIG.risk.maxConsecutiveLosses)) {
    state.isPaused = true;
    state.pauseUntil = Date.now() + CONFIG.risk.pauseOnBreachMinutes * 60 * 1000;
    log('WARN', `Loss streak limit reached: ${state.consecutiveLosses} consecutive losses (max ${CONFIG.risk.maxConsecutiveLosses}) — pausing ${CONFIG.risk.pauseOnBreachMinutes} min`);
    updateDashboard();
    return false;
  }

  // Layer 6: Total exposure cap (v3.2) — blocks only, no pause
  const exposureCheck = checkExposure(state.totalExposureUsd, CONFIG.capital.totalUsd, CONFIG.capital.maxTotalExposurePct);
  if (!exposureCheck.allowed) {
    log('WARN', `Total exposure cap breached: $${state.totalExposureUsd.toFixed(2)} (${(exposureCheck.usagePct * 100).toFixed(1)}% of capital, cap ${(CONFIG.capital.maxTotalExposurePct * 100).toFixed(0)}%) — blocking new positions`);
    updateDashboard();
    return false;
  }

  return true;
}

// 🔴 v3.2 AUDIT #4: gate for opening a new position (per-trade + per-market + total caps)
function canOpenPosition(marketKey: string, sizeUsd: number): boolean {
  if (!canTrade()) return false;

  const perTradeCap = CONFIG.capital.totalUsd * CONFIG.capital.maxPerTradePct;
  if (sizeUsd > perTradeCap) {
    log('WARN', `Position blocked: $${sizeUsd.toFixed(2)} exceeds per-trade cap $${perTradeCap.toFixed(2)}`);
    return false;
  }

  const perMarketCap = CONFIG.capital.totalUsd * CONFIG.capital.maxPerMarketPct;
  const marketExposure = state.perMarketExposureUsd[marketKey] ?? 0;
  if (marketExposure + sizeUsd > perMarketCap) {
    log('WARN', `Position blocked: ${marketKey.slice(0, 18)} exposure $${(marketExposure + sizeUsd).toFixed(2)} exceeds per-market cap $${perMarketCap.toFixed(2)}`);
    return false;
  }

  const totalCap = CONFIG.capital.totalUsd * CONFIG.capital.maxTotalExposurePct;
  if (state.totalExposureUsd + sizeUsd > totalCap) {
    log('WARN', `Position blocked: total exposure $${(state.totalExposureUsd + sizeUsd).toFixed(2)} exceeds cap $${totalCap.toFixed(2)}`);
    return false;
  }

  return true;
}

// 🔴 v3.2 AUDIT #4: single shared pre-execution guard for all strategies.
// canOpenPosition already includes canTrade(), so one call enforces
// Layers 1-6 against chain-seeded exposure (refreshExposure, 60s).
// Services block silently, so the reason is logged HERE.
const riskGuard: PreExecutionGuard = (intent) => {
  if (intent.side !== 'BUY') return null; // hedges/closes/exits are never blocked
  if (!canOpenPosition(intent.marketKey, intent.usdcAmount)) {
    log('WARN', `⛔ ${intent.strategy} BUY blocked by risk guard: $${intent.usdcAmount.toFixed(2)} on ${intent.marketKey.slice(0, 18)}`);
    return `${intent.strategy} blocked by risk limits`;
  }
  return null;
};

// 🔴 v3.2: entries and realized PnL are booked separately — booking a $0
// entry used to count as a "win" in the streak tracker, inflating
// consecutiveWins and feeding the sizer's win-boost with phantom wins.
type StrategyKey = 'smartMoney' | 'arbitrage' | 'dipArb' | 'direct';

function recordEntry(strategy: StrategyKey) {
  state.tradesExecuted++;
  if (strategy === 'smartMoney') state.smartMoneyTrades++;
  else if (strategy === 'arbitrage') state.arbTrades++;
  else if (strategy === 'dipArb') state.dipArbTrades++;
  else if (strategy === 'direct') state.directTrades++;
  updateDashboard();
}

function recordRealized(profit: number, broadcast = true) {
  state.dailyPnL += profit;
  state.monthlyPnL += profit;
  state.totalPnL += profit;

  // Track consecutive wins/losses + real W/L counters (the dashboard
  // previously fabricated win-rate from PnL heuristics)
  if (profit < 0) {
    state.consecutiveLosses++;
    state.consecutiveWins = 0;
    state.losses++;
  } else {
    state.consecutiveLosses = 0;
    state.consecutiveWins++;
    state.wins++;
  }

  if (broadcast) updateDashboard();
}

function simulateTrade(profit: number, strategy: string, description: string) {
  if (!CONFIG.dryRun || !state.paper) return;

  state.paper.trades++;
  state.paper.pnl += profit;
  state.paper.balance += profit;

  // Log as a special SIMULATION event
  log('TRADE', `[SIMULATION] ${description} | Est. Profit: $${profit.toFixed(2)}`);

  // Update main PnL so the user sees movement on the dashboard (as requested)
  recordEntry(strategy as StrategyKey);
  recordRealized(profit);
}

// ============================================================================
// ============================================================================
// STRATEGIES (simplified versions - copy full implementations from bot-config.ts)
// ============================================================================

let arbService: ArbitrageService | null = null;
let isSmartMoneyInitialized = false;
let isSmartMoneyInitializing = false;

// v3.2: module-level service handles + direct-trade entry book
// (kept OUT of `state` — a Map serializes to {} over the WS broadcast)
let onchainService: OnchainService | null = null;
let copySubscription: AutoCopyTradingSubscription | null = null;
let activeSdk: PolymarketSDK | null = null;
type DirectEntry = { walletAddress?: string; price: number; size: number; time: number };
const directEntries = new Map<string, DirectEntry>();

// Session history: per-trade records feed createSessionFromState; the
// session is persisted (upserted by id) every 5 min and on shutdown so a
// crash never loses more than 5 minutes of history.
const sessionTrades: TradeRecord[] = [];

function recordTradeForHistory(trade: Omit<TradeRecord, 'id' | 'timestamp'>) {
  sessionTrades.push({
    id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...trade,
  });
  if (sessionTrades.length > 500) sessionTrades.splice(0, sessionTrades.length - 500);
}

function persistSession() {
  try {
    const session = createSessionFromState(
      state.startTime,
      {
        totalPnL: state.totalPnL,
        tradesExecuted: state.tradesExecuted,
        smartMoneyTrades: state.smartMoneyTrades,
        arbTrades: state.arbTrades,
        dipArbTrades: state.dipArbTrades,
        directTrades: state.directTrades,
        arbProfit: state.arbProfit,
        followedWallets: state.followedWallets,
        splits: state.splits,
        merges: state.merges,
        redeems: state.redeems,
        swaps: state.swaps,
        usdcBalance: state.usdcBalance,
        usdcEBalance: state.usdcEBalance,
        pUsdBalance: state.pUsdBalance,
      },
      {
        dryRun: CONFIG.dryRun,
        smartMoney: { enabled: CONFIG.smartMoney.enabled },
        arbitrage: { enabled: CONFIG.arbitrage.enabled },
        dipArb: { enabled: CONFIG.dipArb.enabled },
        directTrading: { enabled: CONFIG.directTrading.enabled },
      },
      sessionTrades,
    );

    const history = loadHistory();
    const idx = history.sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) history.sessions[idx] = session;
    else history.sessions.unshift(session);
    history.totalSessions = history.sessions.length;
    history.totalProfit = history.sessions.reduce((sum, s) => sum + s.totalPnL, 0);
    history.totalTrades = history.sessions.reduce((sum, s) => sum + s.totalTrades, 0);
    const totalWins = history.sessions.reduce((sum, s) => sum + s.wins, 0);
    history.overallWinRate = history.totalTrades > 0 ? (totalWins / history.totalTrades) * 100 : 0;
    if (history.sessions.length > 100) history.sessions = history.sessions.slice(0, 100);
    saveHistory(history);
  } catch { /* history persistence must never break trading */ }
}

// 🔴 v3.2 P7: chain-seeded exposure refresh — source of truth for
// Layer 6 + per-market caps. Replaces wholesale on each 60s tick; best-effort.
// Uses data-api positions (conditionId + size + avgPrice) valued at COST
// BASIS: cost is drift-stable for reconcilePnl (market-value exposure would
// false-positive on unrealized swings) and the subgraph UserPosition shape
// carries none of the value fields.
async function refreshExposure(sdk: PolymarketSDK) {
  try {
    const address = sdk.tradingService.getAddress();
    const positions = await sdk.wallets.getWalletPositions(address) as unknown as Array<Record<string, unknown>>;
    let total = 0;
    const perMarket: Record<string, number> = {};
    for (const p of positions) {
      const size = Number(p.size);
      const avgPrice = Number(p.avgPrice);
      if (!Number.isFinite(size) || !Number.isFinite(avgPrice) || size <= 0 || avgPrice <= 0) continue;
      const cost = size * avgPrice;
      total += cost;
      const key = String(p.conditionId ?? p.asset ?? 'unknown');
      perMarket[key] = (perMarket[key] ?? 0) + cost;
    }
    state.totalExposureUsd = total;
    state.perMarketExposureUsd = perMarket;
  } catch { /* best-effort; keep last known exposure */ }
}

// 🔴 v3.2 AUDIT #6: reconcile tracked PnL against on-chain reality.
// |(liquid + open exposure) − (baseline + tracked)| must stay within
// max($tol, %tol); fail-open on bad data (a monitor must never halt on NaN).
async function reconcilePnl() {
  if (!onchainService || CONFIG.dryRun || state.pnlBaselineCollateral === null) return;
  try {
    const liquid = parseFloat(await onchainService.getPusdBalance());
    if (!Number.isFinite(liquid)) return;
    state.pUsdBalance = liquid;

    const { drift, breached } = checkPnlDrift({
      baselineCollateral: state.pnlBaselineCollateral,
      trackedPnl: state.totalPnL,
      liquidCollateral: liquid,
      openExposureUsd: state.totalExposureUsd,
      maxDriftUsd: CONFIG.risk.maxPnlDriftUsd,
      maxDriftPct: CONFIG.risk.maxPnlDriftPct,
    });

    if (breached) {
      log('WARN', `🔴 PnL drift $${drift.toFixed(2)} exceeds tolerance (tracked $${state.totalPnL.toFixed(2)}, liquid $${liquid.toFixed(2)}, exposure $${state.totalExposureUsd.toFixed(2)}) — pausing 30m (restart to rebaseline after deposits/withdrawals)`);
      state.isPaused = true;
      state.pauseUntil = Date.now() + 30 * 60 * 1000;
      updateDashboard();
    } else {
      log('CHAIN', `PnL reconciled: drift $${drift.toFixed(2)} within tolerance`);
    }
  } catch (err) {
    log('WARN', `PnL reconcile failed: ${(err as Error).message}`);
  }
}

// v3.2: Smart Money full auto-copy — mirrors bot-config.ts. The service
// handles stale-print skipping, live re-quotes, per-wallet circuit breaker;
// riskGuard gates BUY copies; onCopyPnl books realized FIFO PnL.
// dryRun is captured at subscription start → must restart on mode flip.
async function startSmartMoneyCopy(sdk: PolymarketSDK) {
  if (!CONFIG.smartMoney.enabled || state.followedWallets.length === 0) return;
  if (copySubscription?.isActive) return;
  try {
    copySubscription = await sdk.smartMoney.startAutoCopyTrading({
      targetAddresses: state.followedWallets,
      sizeScale: CONFIG.smartMoney.sizeScale,
      maxSizePerTrade: CONFIG.smartMoney.maxSizePerTrade,
      maxSlippage: CONFIG.smartMoney.maxSlippage,
      minTradeSize: CONFIG.smartMoney.minTradeSize,
      delay: CONFIG.smartMoney.delay,
      dryRun: CONFIG.dryRun,          // service simulates fills AND closes
      preExecutionGuard: riskGuard,   // BUY copies only (service bypasses SELLs)
      onTrade: (trade, result) => {
        if (result.success && trade.side === 'BUY') {
          recordEntry('smartMoney');
          log('TRADE', `Copied BUY from ${trade.traderAddress.slice(0, 8)}... (${trade.size.toFixed(1)} sh @ ${trade.price})`);
          if (CONFIG.dryRun && state.paper) {
            state.paper.trades++;
            state.paper.totalVolume += trade.size * trade.price;
            updateDashboard();
          }
        }
      },
      onCopyPnl: (info) => {
        log('TRADE', `Copy closed ${info.closedSize.toFixed(2)} sh — PnL $${info.realizedUsd.toFixed(2)}`);
        recordRealized(info.realizedUsd);
        recordTradeForHistory({ strategy: 'smartMoney', market: info.tokenId.slice(0, 12), side: info.side, size: info.closedSize, price: 0, profit: info.realizedUsd });
        if (CONFIG.dryRun && state.paper) {
          state.paper.pnl += info.realizedUsd;
          state.paper.balance += info.realizedUsd;
        }
      },
      onError: (err) => log('ERROR', `Copy trading error: ${err.message}`),
    });
    log('WALLET', `Auto-copy ${CONFIG.dryRun ? '(dry-run)' : '(LIVE)'} active for ${state.followedWallets.length} wallets`);
  } catch (err) {
    log('ERROR', `Auto-copy start failed: ${(err as Error).message} — signal feed continues`);
  }
}

function stopSmartMoneyCopy() {
  if (copySubscription?.isActive) copySubscription.stop();
  copySubscription = null;
}

// P0.3c-1: session-local settlement facts only. Terminal records remain here
// until consumed. Finalized records remain as session-local deduplication tombstones.
type CloseSettlement =
  | { state: 'PENDING' }
  | { state: 'TERMINAL_FAILED'; orderId: string; successShares: number; weightedPrice: null; todosFailed: true }
  | { state: 'TERMINAL_SUCCESS'; orderId: string; successShares: number; weightedPrice: number; todosFailed: false };
type PendingClose = {
  walletAddress?: string;
  tokenId: string;
  entryPrice: number | null;
  directEntry?: DirectEntry;
  settlement: CloseSettlement;
  accountingFinalized?: boolean;
};
const pendingCloses = new Map<string, PendingClose>();
let closeFlushPromise: Promise<void> | null = null;

// P0.3d: BUY settlement — submission acceptance is not economic fill.
// PendingBuy mirrors the pending-close pattern so directEntries are only
// created after settlement proves the fill.
type BuySettlement =
  | { state: 'PENDING' }
  | { state: 'TERMINAL_FAILED'; orderId: string; successShares: number; weightedPrice: null; todosFailed: true }
  | { state: 'TERMINAL_SUCCESS'; orderId: string; successShares: number; weightedPrice: number; todosFailed: false };
type PendingBuy = {
  walletAddress?: string;
  orderId: string;
  tokenId: string;
  submittedAt: number;
  priorDirectEntry?: DirectEntry;
  settlement: BuySettlement;
  accountingFinalized?: boolean;
};
const pendingBuys = new Map<string, PendingBuy>();
let buyFlushPromise: Promise<void> | null = null;

function parseCloseShares(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(`Invalid factual close shares: ${String(value)}`);
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function flushPendingCloses(sdk: PolymarketSDK): Promise<void> {
  if (closeFlushPromise) return closeFlushPromise;
  closeFlushPromise = Promise.resolve().then(async () => {
    for (const [orderId, pending] of [...pendingCloses]) {
      if (pending.settlement.state !== 'PENDING') continue;
      try {
        const details = await sdk.tradingService.getOrderFillDetails(orderId);
        const matched = parseCloseShares(details.sizeMatched);
        const ids = [...new Set(details.tradeIds)];
        if (ids.length === 0) continue;
        const trades = await sdk.tradingService.getTradeStatuses(ids);
        if (trades.length !== ids.length || new Set(trades.map(t => t.id)).size !== ids.length ||
            trades.some(t => !ids.includes(t.id))) {
          throw new Error('Incomplete or ambiguous close trade records');
        }
        const sizes = trades.map(t => parseCloseShares(t.size));
        const total = sizes.reduce((sum, size) => sum + size, 0n);
        if (total < matched) continue;
        if (total > matched) throw new Error('Close child sizes exceed sizeMatched');
        const success = trades.map(t => typeof t.transactionHash === 'string' && t.transactionHash.trim().length > 0);
        if (trades.some((t, i) => !success[i] && t.status !== 'FAILED')) continue;
        let units = 0n;
        let notional = 0;
        for (let i = 0; i < trades.length; i++) {
          if (!success[i]) continue;
          const rawPrice = trades[i].price;
          const price = typeof rawPrice === 'string' && /^\d+(?:\.\d+)?$/.test(rawPrice) ? Number(rawPrice) : NaN;
          if (!Number.isFinite(price) || price <= 0 || sizes[i] <= 0n) {
            throw new Error('Invalid successful close trade price or size');
          }
          units += sizes[i];
          notional += Number(sizes[i]) / 100 * price;
        }
        if (units > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isFinite(notional)) {
          throw new Error('Invalid close settlement totals');
        }
        const successShares = Number(units) / 100;
        if (units === 0n) {
          pending.settlement = { state: 'TERMINAL_FAILED', orderId, successShares: 0, weightedPrice: null, todosFailed: true };
        } else {
          const weightedPrice = notional / successShares;
          if (!Number.isFinite(weightedPrice) || weightedPrice <= 0) throw new Error('Invalid weighted close price');
          pending.settlement = { state: 'TERMINAL_SUCCESS', orderId, successShares, weightedPrice, todosFailed: false };
        }
      } catch (err) {
        log('WARN', `Close settlement ${orderId}: ${(err as Error).message}`);
      }
    }
  }).finally(() => { closeFlushPromise = null; });
  return closeFlushPromise;
}

// Single-flight settlement for pending BUYs — identical pattern to closes.
function flushPendingBuys(sdk: PolymarketSDK): Promise<void> {
  if (buyFlushPromise) return buyFlushPromise;
  buyFlushPromise = Promise.resolve().then(async () => {
    for (const [orderId, pending] of [...pendingBuys]) {
      if (pending.settlement.state !== 'PENDING') continue;
      try {
        const details = await sdk.tradingService.getOrderFillDetails(orderId);
        const matched = parseCloseShares(details.sizeMatched);
        const ids = [...new Set(details.tradeIds)];
        if (ids.length === 0) continue;
        const trades = await sdk.tradingService.getTradeStatuses(ids);
        if (trades.length !== ids.length || new Set(trades.map(t => t.id)).size !== ids.length ||
            trades.some(t => !ids.includes(t.id))) {
          throw new Error('Incomplete or ambiguous buy trade records');
        }
        const sizes = trades.map(t => parseCloseShares(t.size));
        const total = sizes.reduce((sum, size) => sum + size, 0n);
        if (total < matched) continue;
        if (total > matched) throw new Error('Buy child sizes exceed sizeMatched');
        const success = trades.map(t => typeof t.transactionHash === 'string' && t.transactionHash.trim().length > 0);
        if (trades.some((t, i) => !success[i] && t.status !== 'FAILED')) continue;
        let units = 0n;
        let notional = 0;
        for (let i = 0; i < trades.length; i++) {
          if (!success[i]) continue;
          const rawPrice = trades[i].price;
          const price = typeof rawPrice === 'string' && /^\d+(?:\.\d+)?$/.test(rawPrice) ? Number(rawPrice) : NaN;
          if (!Number.isFinite(price) || price <= 0 || sizes[i] <= 0n) {
            throw new Error('Invalid successful buy trade price or size');
          }
          units += sizes[i];
          notional += Number(sizes[i]) / 100 * price;
        }
        if (units > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isFinite(notional)) {
          throw new Error('Invalid buy settlement totals');
        }
        const successShares = Number(units) / 100;
        if (units === 0n) {
          pending.settlement = { state: 'TERMINAL_FAILED', orderId, successShares: 0, weightedPrice: null, todosFailed: true };
        } else {
          const weightedPrice = notional / successShares;
          if (!Number.isFinite(weightedPrice) || weightedPrice <= 0) throw new Error('Invalid weighted buy price');
          pending.settlement = { state: 'TERMINAL_SUCCESS', orderId, successShares, weightedPrice, todosFailed: false };
        }
      } catch (err) {
        log('WARN', `Buy settlement ${orderId}: ${(err as Error).message}`);
      }
    }
  }).finally(() => { buyFlushPromise = null; });
  return buyFlushPromise;
}

// No awaits: validate everything before claiming the order and mutating local
// accounting. Notifications run only after all local mutations have completed.
function consumeTerminalCloses(): void {
  for (const [orderId, pending] of [...pendingCloses]) {
    if (pending.accountingFinalized || pending.settlement.state === 'PENDING') continue;
    try {
      const settled = pending.settlement;
      if (settled.orderId !== orderId) throw new Error('Close settlement orderId mismatch');
      if (settled.state === 'TERMINAL_FAILED') {
        pending.accountingFinalized = true;
        continue;
      }
      const q = settled.successShares;
      const price = settled.weightedPrice;
      if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(price) || price <= 0) {
        throw new Error('Invalid economic close quantity or price');
      }
      const entry = pending.directEntry;
      if (entry && directEntries.get(pending.tokenId) !== entry) {
        throw new Error('Original direct entry missing or replaced');
      }
      if (entry && (!Number.isFinite(entry.size) || entry.size <= 0 || q > entry.size)) {
        throw new Error('Settled close exceeds or invalidates original entry balance');
      }
      const costPrice = pending.entryPrice;
      if (costPrice === null || !Number.isFinite(costPrice) || costPrice <= 0) {
        if (entry) throw new Error('Invalid captured close cost basis');
        // A wallet position without captured cost can settle, but cannot yield PnL.
        pending.accountingFinalized = true;
        log('WARN', `Close ${orderId} settled without cost basis; PnL/history withheld`);
        continue;
      }
      const cost = q * costPrice;
      const notional = q * price;
      const exitFeeUsd = 0; // No factual/configured close fee: this is gross PnL.
      const realizedPnl = notional - cost - exitFeeUsd;
      if (![cost, notional, realizedPnl].every(Number.isFinite)) throw new Error('Invalid close accounting totals');

      // All expected failure paths above are side-effect free. Claim before
      // non-idempotent writes, and keep external notifications out of this block.
      pending.accountingFinalized = true;
      if (entry) {
        entry.size -= q;
        if (entry.size === 0) directEntries.delete(pending.tokenId);
      }
      recordRealized(realizedPnl, false);
      if (entry) {
        recordTradeForHistory({ strategy: 'direct', market: pending.tokenId.slice(0, 12),
          side: 'SELL', size: q, price, profit: realizedPnl });
      }
      updateDashboard();
      log('TRADE', `Close settled: ${q} shares of ${pending.tokenId.slice(0, 10)}...; gross PnL $${realizedPnl.toFixed(2)} (exit fee excluded)`);
    } catch (err) {
      // A notification failure must not stop consumption of other terminal orders.
      try { log('WARN', `Close accounting ${orderId}: ${err instanceof Error ? err.message : String(err)}`); } catch { /* state remains claimed or pending */ }
    }
  }
}

// P0.3d: consume terminal BUY settlements — only after settlement proof.
// Creates directEntries with factual weighted price and success shares.
// Never uses snapshot price or requested notional/size as authority.
function consumeTerminalBuys(): void {
  for (const [orderId, pending] of [...pendingBuys]) {
    if (pending.accountingFinalized || pending.settlement.state === 'PENDING') continue;
    try {
      const settled = pending.settlement;
      if (settled.orderId !== orderId) throw new Error('Buy settlement orderId mismatch');
      if (settled.state === 'TERMINAL_FAILED') {
        pending.accountingFinalized = true;
        continue;
      }
      const q = settled.successShares;
      const price = settled.weightedPrice;
      if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(price) || price <= 0) {
        throw new Error('Invalid economic buy quantity or price');
      }
      const prior = pending.priorDirectEntry;
      const current = directEntries.get(pending.tokenId);
      if (prior === undefined) {
        if (current !== undefined) {
          throw new Error('Direct entry appeared during buy settlement; refusing to overwrite');
        }
      } else {
        if (current !== prior) {
          throw new Error('Original direct entry replaced during buy settlement; refusing to overwrite');
        }
      }
      // Claim before non-idempotent writes.
      pending.accountingFinalized = true;
      directEntries.set(pending.tokenId, { price, size: q, time: pending.submittedAt,
        ...(pending.walletAddress ? { walletAddress: pending.walletAddress } : {}) });
      recordEntry('direct');
      updateDashboard();
      log('TRADE', `Buy settled: ${q} shares of ${pending.tokenId.slice(0, 10)}... @ $${price.toFixed(4)}`);
    } catch (err) {
      try { log('WARN', `Buy accounting ${orderId}: ${err instanceof Error ? err.message : String(err)}`); } catch { /* state remains claimed or pending */ }
    }
  }
}

type InventoryWriter = {
  localOperationId: number;
  wallet: string;
  tokenIds: readonly string[];
  writerType: 'CLOSE' | 'DIRECT_BUY' | 'REDEEM';
  state: 'ACTIVE' | 'SUBMITTED' | 'UNCERTAIN';
  transactionHash?: string;
};
type InventoryRefusal = { status: 'BLOCKED_INVENTORY'; reason: string };
const activeInventoryWriters = new Map<number, InventoryWriter>();
let nextInventoryWriterId = 0;

function inventoryWallet(address: string): string {
  if (!ethers.utils.isAddress(address)) throw new Error('Invalid inventory wallet identity');
  return ethers.utils.getAddress(address).toLowerCase();
}

function dashboardInventoryConflict(query: { walletAddress: string; tokenIds: readonly string[] }, includeEntry = true): string | undefined {
  const wallet = inventoryWallet(query.walletAddress);
  for (const writer of activeInventoryWriters.values()) {
    if (writer.wallet === wallet && writer.tokenIds.some(token => query.tokenIds.includes(token))) return 'EXTERNAL_WRITER_ACTIVE';
  }
  // Legacy entries in this process belong to its factual SDK signer, not to
  // the aggregated portfolio snapshot. New records capture the signer explicitly.
  const matches = (address?: string) => inventoryWallet(address ?? activeSdk?.tradingService.getAddress() ?? '') === wallet;
  for (const pending of [...pendingBuys.values(), ...pendingCloses.values()]) {
    if (!pending.accountingFinalized && query.tokenIds.includes(pending.tokenId) && matches(pending.walletAddress)) return 'EXTERNAL_SETTLEMENT_PENDING';
  }
  if (includeEntry) for (const token of query.tokenIds) {
    const entry = directEntries.get(token);
    if (entry && entry.size > 0 && matches(entry.walletAddress)) return 'DIRECT_POSITION_OPEN';
  }
}

function beginInventoryWriter(sdk: PolymarketSDK, tokenIds: string[], writerType: InventoryWriter['writerType']): InventoryWriter | InventoryRefusal {
  try {
    const wallet = inventoryWallet(sdk.tradingService.getAddress());
    if (!arbService) throw new Error('Inventory protection service unavailable');
    if (!tokenIds.length || tokenIds.some(token => typeof token !== 'string' || !token.trim())) throw new Error('Invalid inventory token identity');
    const block = arbService.getShortInventoryProtection({ walletAddress: wallet, tokenIds });
    const reason = block ? `${block.reason}: ${block.operationId}`
      : dashboardInventoryConflict({ walletAddress: wallet, tokenIds }, writerType === 'DIRECT_BUY');
    if (reason) return { status: 'BLOCKED_INVENTORY', reason };
    const writer: InventoryWriter = { localOperationId: ++nextInventoryWriterId, wallet,
      tokenIds: Object.freeze([...tokenIds]), writerType, state: 'ACTIVE' };
    activeInventoryWriters.set(writer.localOperationId, writer);
    return writer;
  } catch (error) {
    return { status: 'BLOCKED_INVENTORY', reason: error instanceof Error ? error.message : String(error) };
  }
}

// The registration callback must install pending ownership synchronously before
// active ownership is released. Unknown outcomes never release ownership.
async function submitInventoryOrder(sdk: PolymarketSDK, tokenId: string, side: 'BUY' | 'SELL', amount: number,
  register: (orderId: string, walletAddress: string) => void): Promise<boolean | InventoryRefusal> {
  const writer = beginInventoryWriter(sdk, [tokenId], side === 'BUY' ? 'DIRECT_BUY' : 'CLOSE');
  if ('status' in writer) return writer;
  try {
    const result = await sdk.tradingService.createMarketOrder({ tokenId, side, amount });
    if (result.submissionState === 'REJECTED') {
      activeInventoryWriters.delete(writer.localOperationId);
      return false;
    }
    const orderId = typeof result.orderId === 'string' ? result.orderId.trim() : '';
    if (result.success && orderId && result.submissionState !== 'UNCERTAIN') {
      register(orderId, writer.wallet);
      activeInventoryWriters.delete(writer.localOperationId);
      return true;
    }
    writer.state = 'UNCERTAIN';
    if (result.success && !orderId) log('WARN', `Submission accepted without usable orderId for ${tokenId}; accounting withheld`);
    return result.success;
  } catch (error) {
    writer.state = 'UNCERTAIN';
    log('WARN', `Inventory submission uncertain: ${String(error)}`);
    return false;
  }
}

// true acknowledges submission only; BLOCKED_INVENTORY is not an exchange result.
async function executeClosePosition(sdk: PolymarketSDK, tokenId: string, size: number): Promise<boolean | InventoryRefusal> {
  const entry = directEntries.get(tokenId);
  const callerWallet = sdk.tradingService.getAddress();
  const entryWallet = entry?.walletAddress ?? activeSdk?.tradingService.getAddress() ?? callerWallet;
  const directEntry = entryWallet?.toLowerCase() === callerWallet?.toLowerCase() ? entry : undefined;
  const position = state.positions.find(p => p.asset === tokenId);
  const candidatePrice = directEntry?.price ?? Number(position?.avgPrice);
  const entryPrice = Number.isFinite(candidatePrice) && candidatePrice > 0 ? candidatePrice : null;
  return submitInventoryOrder(sdk, tokenId, 'SELL', size, (orderId, walletAddress) => {
    if (!pendingCloses.has(orderId)) pendingCloses.set(orderId, {
      tokenId, walletAddress, entryPrice, directEntry, settlement: { state: 'PENDING' },
    });
  });
}

async function executePanicSell(sdk: PolymarketSDK): Promise<void> {
  const targets = [...state.positions].filter(p => Number(p.size) > 0).slice(0, 10);
  for (const p of targets) {
    const result = await executeClosePosition(sdk, String(p.asset), Number(p.size));
    if (typeof result === 'object') log('WARN', `Panic sell blocked: ${p.asset}: ${result.reason}`);
    else if (!result) log('WARN', `Panic sell submission unsuccessful: ${p.asset}`);
  }
}

async function executeDirectBuy(sdk: PolymarketSDK, tokenId: string, amount: number): Promise<boolean | InventoryRefusal> {
  return submitInventoryOrder(sdk, tokenId, 'BUY', amount, (orderId, walletAddress) => {
    if (!pendingBuys.has(orderId)) pendingBuys.set(orderId, {
      orderId, tokenId, walletAddress, submittedAt: Date.now(), priorDirectEntry: directEntries.get(tokenId),
      settlement: { state: 'PENDING' },
    });
  });
}

async function executeDashboardRedeem(sdk: PolymarketSDK, conditionId: string, ctfClient: CTFClient) {
  const market = await sdk.markets.getMarket(conditionId);
  if (!market || market.tokens.length < 2) return { status: 'BLOCKED_INVENTORY', reason: 'Missing redeem token identity' };
  try {
    if (inventoryWallet(sdk.tradingService.getAddress()) !== inventoryWallet(ctfClient.getAddress())) {
      return { status: 'BLOCKED_INVENTORY', reason: 'Inconsistent redeem wallet identity' };
    }
  } catch {
    return { status: 'BLOCKED_INVENTORY', reason: 'Invalid redeem wallet identity' };
  }
  const tokenIds = { yesTokenId: market.tokens[0].tokenId, noTokenId: market.tokens[1].tokenId };
  // Capture only this wallet's entries before redeem starts. The CTF adapter
  // redeems the full balances of both supplied outcome tokens. Confirmation
  // closes these lifecycles, without inferring PnL or touching newer entries.
  const redeemWallet = inventoryWallet(ctfClient.getAddress());
  const redeemEntries = Object.values(tokenIds).map(tokenId => {
    const entry = directEntries.get(tokenId);
    const address = entry?.walletAddress ?? activeSdk?.tradingService.getAddress();
    return { tokenId, entry: entry && address && inventoryWallet(address) === redeemWallet ? entry : undefined };
  });
  const writer = beginInventoryWriter(sdk, Object.values(tokenIds), 'REDEEM');
  if ('status' in writer) return writer;
  const release = (provenance: RedeemProvenance | undefined) => {
    if (provenance?.state === 'CONFIRMED') {
      for (const { tokenId, entry } of redeemEntries) {
        if (entry && directEntries.get(tokenId) === entry) directEntries.delete(tokenId);
      }
    }
    if (provenance?.state === 'CONFIRMED' || provenance?.state === 'NOT_SUBMITTED') {
      activeInventoryWriters.delete(writer.localOperationId);
    } else writer.state = 'UNCERTAIN';
  };
  const observe = (provenance: RedeemProvenance) => {
    if (provenance.transactionHash) writer.transactionHash = provenance.transactionHash;
    if (provenance.state === 'SUBMITTED' || provenance.state === 'UNCERTAIN') writer.state = provenance.state;
    // Retain ownership across observer callbacks; release only when the call exits.
  };
  try {
    const routing = typeof market.negRisk === 'boolean' ? { negRisk: market.negRisk } : undefined;
    const result = await ctfClient.redeemByTokenIds(conditionId, tokenIds, undefined, routing, observe);
    release(result.provenance);
    return result;
  } catch (error) {
    release(error instanceof RedeemProvenanceError ? error.provenance : undefined);
    throw error;
  }
}

async function setupSmartMoney(sdk: PolymarketSDK) {
  if (CONFIG.smartMoney.enabled) {
    initializeSmartMoney(sdk);
  }
}

async function initializeSmartMoney(sdk: PolymarketSDK) {
  if (isSmartMoneyInitialized || isSmartMoneyInitializing) return;
  isSmartMoneyInitializing = true;

  log('WALLET', 'Setting up Smart Money with quality filtering...');

  const qualified: string[] = [];

  // AUDIT #1: custom wallets face the SAME 6/6 gate as leaderboard (no bypass).
  // Scored on closed (realized) positions; PnL/count fall back to the sample.
  if (CONFIG.smartMoney.customWallets?.length > 0) {
    for (const wallet of CONFIG.smartMoney.customWallets) {
      try {
        const positions = await fetchClosedPnls(sdk.dataApi, wallet);
        const q = computeWalletQualityFromPositions(positions, CONFIG.smartMoney.checkLastNTrades);
        const { pass, failures } = evaluateWalletQuality(
          toWalletQualityGate(q, q.totalPnl, q.tradeCount),
          {
            minWinRate: CONFIG.smartMoney.minWinRate,
            minPnl: CONFIG.smartMoney.minPnl,
            minTrades: CONFIG.smartMoney.minTrades,
            minProfitFactor: CONFIG.smartMoney.minProfitFactor,
            minConsistencyScore: CONFIG.smartMoney.minConsistencyScore,
            maxSingleTradeExposure: CONFIG.smartMoney.maxSingleTradeExposure,
          }
        );
        if (!pass) {
          log('WALLET', `❌ Custom wallet rejected: ${wallet.slice(0, 10)}... (${failures.join(', ')})`);
          continue;
        }
        qualified.push(wallet);
        log('WALLET', `⭐ Custom wallet qualified: ${wallet.slice(0, 10)}...`);
      } catch { /* skip unreachable wallets */ }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  try {
    const leaderboard = await sdk.wallets.getLeaderboardByPeriod('week', CONFIG.smartMoney.topN * 2, 'pnl');

    for (const entry of leaderboard) {
      // Check if disabled mid-process to abort early
      if (!CONFIG.smartMoney.enabled && qualified.length === 0) break;

      if (qualified.length >= 10) break; // User limit: Max 10 qualified wallets
      if (qualified.includes(entry.address)) continue;

      const profile = await sdk.wallets.getWalletProfile(entry.address);
      if (!profile) continue;

      const pnl = entry.pnl ?? 0;
      const trades = profile.tradeCount ?? 0;

      // AUDIT #1: full shared 6/6 gate on closed (realized) positions —
      // the old 3-check (WR/PnL/trades) let whale-dominated and
      // inconsistent wallets through.
      const positions = await fetchClosedPnls(sdk.dataApi, entry.address);
      const q = computeWalletQualityFromPositions(positions, CONFIG.smartMoney.checkLastNTrades);
      const { pass, failures } = evaluateWalletQuality(
        toWalletQualityGate(q, pnl, trades),
        {
          minWinRate: CONFIG.smartMoney.minWinRate,
          minPnl: CONFIG.smartMoney.minPnl,
          minTrades: CONFIG.smartMoney.minTrades,
          minProfitFactor: CONFIG.smartMoney.minProfitFactor,
          minConsistencyScore: CONFIG.smartMoney.minConsistencyScore,
          maxSingleTradeExposure: CONFIG.smartMoney.maxSingleTradeExposure,
        }
      );

      if (pass) {
        qualified.push(entry.address);
        log('WALLET', `✅ Qualified: ${entry.address.slice(0, 10)}... (WR:${(q.winRate * 100).toFixed(0)}% PF:${q.profitFactor.toFixed(2)}x PnL:$${pnl.toFixed(0)} T:${trades})`);
      } else if (CONFIG.dryRun) {
        log('WALLET', `❌ Rejected: ${entry.address.slice(0, 10)}... (${failures.join(', ')})`);
      }

      await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    log('WARN', `Leaderboard error: ${(err as Error).message}`);
  }

  state.followedWallets = qualified;
  log('WALLET', `Following ${qualified.length} wallets`);
  updateDashboard();

  if (qualified.length > 0) {
    // Subscribe to smart money trades with address filter — SIGNAL FEED ONLY.
    // Execution lives in startAutoCopyTrading (guard + realized PnL +
    // circuit breaker); this handler just mirrors trades to the dashboard.
    sdk.smartMoney.subscribeSmartMoneyTrades(
      async (trade: SmartMoneyTrade) => {
        if (!CONFIG.smartMoney.enabled) return;

        const signal: SmartMoneySignal = {
          id: `sm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date().toISOString(),
          wallet: trade.traderAddress,
          market: trade.marketSlug || 'Unknown',
          side: trade.side as 'BUY' | 'SELL',
          size: trade.size,
          price: trade.price,
        };
        state.smartMoneySignals.unshift(signal);
        if (state.smartMoneySignals.length > 50) {
          state.smartMoneySignals = state.smartMoneySignals.slice(0, 50);
        }

        log('SIGNAL', `Copy trade signal from ${trade.traderAddress.slice(0, 10)}...`, {
          market: trade.marketSlug?.slice(0, 50),
          side: trade.side,
          size: trade.size,
          price: trade.price,
        });
        updateDashboard();
      });

    // v3.2: full auto-copy execution (dry-run simulates fills via the service)
    await startSmartMoneyCopy(sdk);
  }
  isSmartMoneyInitialized = true;
  isSmartMoneyInitializing = false;
}



async function setupArbitrage(_sdk: PolymarketSDK) {
  // Always setup service and listeners
  log('ARB', 'Setting up Arbitrage Service...');

  state.arbitrage.status = 'idle';
  updateDashboard();

  // Create standalone ArbitrageService (not using SDK wrapper)
  arbService = new ArbitrageService({
    privateKey: CONFIG.dryRun ? undefined : process.env.POLYMARKET_PRIVATE_KEY,
    profitThreshold: CONFIG.arbitrage.profitThreshold,
    minTradeSize: CONFIG.arbitrage.minTradeSize,
    maxTradeSize: CONFIG.arbitrage.maxTradeSize,
    autoExecute: !CONFIG.dryRun && CONFIG.arbitrage.autoExecute,
    enableRebalancer: !CONFIG.dryRun && CONFIG.arbitrage.enableRebalancer,
    enableLogging: true,
    preExecutionGuard: riskGuard, // v3.2 AUDIT #4: risk limits gate arb too
    shortInventoryAdmission: query => dashboardInventoryConflict(query),
  });

  arbService.on('opportunity', (opp) => {
    state.activeArbMarket = opp.market?.name || 'scanning';
    state.arbitrage.opportunitiesFound++;
    state.arbitrage.lastOpportunity = {
      timestamp: new Date().toISOString(),
      type: opp.type as 'long' | 'short',
      profitPct: opp.profitPercent / 100,
      market: opp.market?.name || 'Unknown',
    };
    log('ARB', `Opportunity: ${opp.type.toUpperCase()} +${opp.profitPercent.toFixed(2)}%`);

    // SIMULATION HOOK
    if (CONFIG.dryRun && opp.profitPercent > 0) {
      // Conservative estimate: 10% of max size or min size
      const size = Math.max(CONFIG.arbitrage.minTradeSize, 10);
      const estimatedProfit = size * (opp.profitPercent / 100);
      simulateTrade(estimatedProfit, 'arbitrage', `Arb ${opp.market}`);
    }

    updateDashboard();
  });

  arbService.on('execution', (result) => {
    if (result.success) {
      state.arbProfit += result.profit || 0;
      recordEntry('arbitrage');
      recordRealized(result.profit || 0);
      recordTradeForHistory({ strategy: 'arbitrage', market: state.activeArbMarket ?? 'unknown', side: 'BUY', size: result.size, price: 0, profit: result.profit || 0 });
      log('TRADE', `Arb trade executed: +$${(result.profit || 0).toFixed(2)} profit`);
    }
  });

  // Scan for arbitrage opportunities ONLY if enabled
  if (CONFIG.arbitrage.enabled) {
    state.arbitrage.status = 'scanning';
    try {
      const results = await arbService.scanMarkets(
        { minVolume24h: CONFIG.arbitrage.minVolume24h },
        CONFIG.arbitrage.profitThreshold
      );
      state.arbitrage.marketsScanned = results.length;
      const opps = results.filter(r => r.arbType !== 'none');

      if (opps.length > 0) {
        state.activeArbMarket = opps[0].market.name;
        state.arbitrage.currentMarket = opps[0].market.name;
        state.arbitrage.status = 'monitoring';
        await arbService.start(opps[0].market);
        log('ARB', `Started monitoring: ${opps[0].market.name}`);
      } else {
        state.arbitrage.status = 'idle';
        log('ARB', 'No arbitrage opportunities found, will keep scanning...');
      }
      updateDashboard();
    } catch (err) {
      state.arbitrage.status = 'idle';
      log('WARN', `Arbitrage scan error: ${(err as Error).message}`);
      updateDashboard();
    }
  }
}

async function setupDipArb(sdk: PolymarketSDK) {
  // Always setup listeners provided by this function
  log('ARB', 'Setting up DipArb Service...');

  // Configure the DipArb service
  sdk.dipArb.updateConfig({
    shares: CONFIG.dipArb.shares,
    sumTarget: CONFIG.dipArb.sumTarget,
    autoExecute: !CONFIG.dryRun,
    debug: true,
    preExecutionGuard: riskGuard, // v3.2 AUDIT #4: gates DipArb Leg1 openers only
  });

  // Event handlers - listen to orderbookUpdate for live orderbook data
  sdk.dipArb.on('orderbookUpdate', (update: {
    upPrice: number;
    downPrice: number;
    sum: number;
  }) => {
    state.dipArb.upPrice = update.upPrice;
    state.dipArb.downPrice = update.downPrice;
    state.dipArb.sum = update.sum;
    updateDashboard();
  });

  // Listen to 'started' event to sync market details immediately
  sdk.dipArb.on('started', (market: any) => {
    log('ARB', `DipArb Service Started Monitoring: ${market.name}`);
    state.activeDipArbMarket = market.name;
    state.dipArb.marketName = market.name;
    state.dipArb.underlying = market.underlying || 'ETH';
    state.dipArb.duration = `${market.durationMinutes}m`;
    state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
    state.dipArb.status = 'active'; // Force status update
    updateDashboard();

    // Also notify dashboard specifically about status change
    dashboardEmitter.updateStrategyStatus('dipArb', 'active', market.name);
  });

  // Listen to newRound for round changes
  sdk.dipArb.on('newRound', (round: { roundId: string; priceToBeat: number }) => {
    log('ARB', `New round: ${round.roundId}, Price to Beat: ${round.priceToBeat}`);
    updateDashboard();
  });

  // Signal handler - extract data from DipArbLeg1Signal or DipArbLeg2Signal
  sdk.dipArb.on('signal', (s: {
    type: 'leg1' | 'leg2';
    dipSide?: string;
    hedgeSide?: string;
    currentPrice: number;
    source?: string;
    dropPercent?: number;
  }) => {
    const side = s.dipSide || s.hedgeSide || 'UP';
    const signal: DipArbSignal = {
      id: `da-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      type: s.type as DipArbSignal['type'],
      side: side as 'UP' | 'DOWN',
      price: s.currentPrice || 0,
      change: s.dropPercent ? -s.dropPercent * 100 : 0,
    };
    state.dipArb.lastSignal = signal;
    state.dipArb.signals.unshift(signal);
    if (state.dipArb.signals.length > 20) {
      state.dipArb.signals = state.dipArb.signals.slice(0, 20);
    }
    log('SIGNAL', `DipArb: ${s.type} ${side} @ ${s.currentPrice?.toFixed(3)}`);

    // NO SIMULATION on signal anymore - signals are not trades!
    // We only want to track actual executions (which will fire the 'execution' event)

    updateDashboard();
  });

  sdk.dipArb.on('execution', (r: any) => {
    if (r.success) {
      const price = r.price ? r.price.toFixed(3) : '??';
      const shares = r.shares ? r.shares.toFixed(1) : '??';
      const market = state.activeDipArbMarket || 'unknown-market';

      switch (r.leg) {
        case 'leg1':
          log('TRADE', `OPEN ${r.side} | ${shares} shares @ $${price} | ${market}`);
          break;
        case 'leg2':
          log('TRADE', `HEDGE ${r.side} | ${shares} shares @ $${price} | Locked Profit`);
          break;
        case 'exit':
          log('TRADE', `CLOSE ${r.side} (Timeout Exit) | ${shares} shares @ $${price}`);
          break;
        case 'merge':
          log('TRADE', `REDEEM | Merged positions for $1.00 payout | ${market}`);
          break;
        default:
          log('TRADE', `DipArb ${r.leg}: ${r.side} @ ${price}`);
      }
      // v3.2: one entry per ROUND (leg1 opens it) — legs are not trades
      if (r.leg === 'leg1') recordEntry('dipArb');
    } else {
      log('WARN', `DipArb Execution Failed (${r.leg}): ${r.error || 'Unknown error'}`);
    }
  });

  // v3.2 AUDIT #2: book REAL round PnL. `profit` on completed rounds is NET
  // PER-UNIT (dip-arb-service.ts:884) — multiply by leg2 shares.
  sdk.dipArb.on('roundComplete', (r: DipArbRoundResult) => {
    if (r.status === 'completed') {
      const shares = r.leg2?.shares ?? 0;
      const netProfit = (r.profit ?? 0) * shares;
      recordRealized(netProfit);
      recordTradeForHistory({ strategy: 'dipArb', market: state.activeDipArbMarket ?? 'unknown', side: 'BUY', size: shares, price: 0, profit: netProfit });
      log('TRADE', `DipArb round ${r.roundId.slice(0, 12)} completed: ${shares.toFixed(1)} sh, net +$${netProfit.toFixed(2)}`);
    } else {
      // expired / partial: book only when Leg1 was actually exited for a price
      const leg1 = r.leg1;
      const exit = r.exitResult;
      if (leg1 && exit?.success && (exit.shares ?? 0) > 0 && exit.price !== undefined) {
        const netProfit = (exit.price - leg1.price) * (exit.shares ?? 0);
        recordRealized(netProfit);
        log('TRADE', `DipArb round ${r.roundId.slice(0, 12)} ${r.status}: exited Leg1 ${exit.shares!.toFixed(1)} @ $${exit.price.toFixed(3)} → $${netProfit.toFixed(2)}`);
      } else {
        log('WARN', `DipArb round ${r.roundId.slice(0, 12)} ${r.status}: no booked exit${exit ? ` (${exit.error ?? 'exit failed'})` : ''} — PnL untracked, exposure sync will reflect it`);
      }
    }
    updateDashboard();
  });

  sdk.dipArb.on('rotate', (e: { newMarket: string }) => {
    state.activeDipArbMarket = e.newMarket;
    state.dipArb.marketName = e.newMarket;
    log('ARB', `DipArb rotated to ${e.newMarket}`);
    updateDashboard();
  });

  // Enable auto-rotate if configured
  if (CONFIG.dipArb.autoRotate) {
    sdk.dipArb.enableAutoRotate({
      enabled: true,
      underlyings: ['ETH', 'BTC', 'SOL'],
      duration: '15m',
      settleStrategy: 'redeem',
      redeemWaitMinutes: 5,
    });
  }

  // Find and start monitoring a market
  if (CONFIG.dipArb.enabled) {
    try {
      const market = await sdk.dipArb.findAndStart({ coin: 'ETH', preferDuration: '15m' });
      if (market) {
        state.activeDipArbMarket = market.name;
        state.dipArb.marketName = market.name;
        state.dipArb.underlying = market.underlying || 'ETH';
        state.dipArb.duration = `${market.durationMinutes}m`;
        // endTime is a Date object, convert to timestamp
        state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
        state.dipArb.status = 'active'; // Force status update
        log('ARB', `DipArb started: ${market.name}`);
      } else {
        log('WARN', 'No DipArb markets found');
      }
      updateDashboard();
    } catch (err) {
      log('WARN', `DipArb setup error: ${(err as Error).message}`);
    }
  }
}

let swapService: SwapService | null = null;

async function updateBalances() {
  if (CONFIG.dryRun) {
    // SIMULATION: Mock balances
    // Base 10,000 + whatever PnL we've made in this session
    state.pUsdBalance = 10000 + state.totalPnL;
    state.maticBalance = 100;

    // Only verify once/log sparsely
    if (Math.random() < 0.05) { // Occasional log
      // no-op
    }
    updateDashboard();
    return;
  }

  if (!swapService) return;
  try {
    const balances = await swapService.getBalances();
    let changed = false;

    // Parse balances from TokenBalance array
    for (const b of balances) {
      if (b.symbol === 'MATIC') {
        const val = parseFloat(b.balance);
        if (state.maticBalance !== val) { state.maticBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC') {
        const val = parseFloat(b.balance);
        if (state.usdcBalance !== val) { state.usdcBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC_E') {
        const val = parseFloat(b.balance);
        if (state.usdcEBalance !== val) { state.usdcEBalance = val; changed = true; }
      }
    }

    if (changed) {
      updateDashboard();
      // Optional: Log only on significant changes or debug
      // log('SWAP', 'Balances updated');
    }
  } catch (err) {
    // Silent fail on interval to avoid log spam
  }
}

async function setupSwap() {
  log('SWAP', 'Setting up Wallet & Balance Monitor...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    // Create SwapService with signer
    const provider = new ethers.providers.JsonRpcProvider(resolvePolygonRpcUrl());
    const signer = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY, provider);
    swapService = new SwapService(signer);

    // Initial fetch
    await updateBalances();

    log('SWAP', 'Balances:', {
      matic: state.maticBalance.toFixed(4),
      usdce: `$${state.usdcEBalance.toFixed(2)}`,
    });

    // USDC.e is a utility balance; CLOB capital is checked in setupOnchain().

    // Poll balances every 30 seconds
    setInterval(updateBalances, 30000);

    updateDashboard();
  } catch (err) {
    log('WARN', `Balance setup error: ${(err as Error).message}`);
  }
}

async function setupOnchain() {
  if (!CONFIG.onchain.enabled || CONFIG.dryRun) return;
  log('CHAIN', 'Checking on-chain approvals...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    const onchain = new OnchainService({
      privateKey: process.env.POLYMARKET_PRIVATE_KEY,
      rpcUrl: resolvePolygonRpcUrl(),
    });
    onchainService = onchain; // v3.2: module handle for reconcilePnl()

    if (CONFIG.onchain.autoApprove) {
      log('CHAIN', 'Auto-approving CLOB V2 exchanges...');
      const result = await onchain.approveAll();

      if (result.allApproved) {
        log('CHAIN', '✅ All approvals ready');
      } else {
        log('WARN', `Approval status: ${result.summary}`);
        // Log individual failures
        result.erc20Approvals.forEach(r => {
          if (!r.success) log('WARN', `❌ ERC20 Approval failed: ${r.contract} - ${r.error}`);
        });
        result.erc1155Approvals.forEach(r => {
          if (!r.success) log('WARN', `❌ ERC1155 Approval failed: ${r.contract} - ${r.error}`);
        });
      }
    } else {
      const status = await onchain.checkAllowances();
      if (!status.tradingReady) {
        log('WARN', 'Missing approvals:', status.issues);
        log('WARN', 'Enable onchain.autoApprove=true to fix automatically');
      } else {
        log('CHAIN', '✅ Approvals verified');
      }
    }

    // v3.2 AUDIT #6: anchor PnL baseline from live on-chain balance
    // (session-scoped; restart to rebaseline after deposits/withdrawals)
    try {
      const collateral = parseFloat(await onchain.getPusdBalance());
      state.pUsdBalance = collateral;
      if (Number.isFinite(collateral)) {
        state.pnlBaselineCollateral = collateral;
        log('CHAIN', `PnL baseline anchored: ${collateral.toFixed(2)} pUSD`);
      }
    } catch { /* reconcile loop will surface persistent failure */ }
  } catch (err) {
    log('WARN', `Onchain setup error: ${(err as Error).message}`);
  }
}

async function setupBinanceAnalysis(sdk: PolymarketSDK) {
  if (!CONFIG.binance.enabled) return;
  log('KLINE', 'Setting up Binance K-line analysis...');

  async function analyzeTrend(symbol: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT'): Promise<'up' | 'down' | 'neutral'> {
    try {
      const klines = await sdk.binance.getKLines(symbol, CONFIG.binance.interval, { limit: 20 });
      if (klines.length < 10) return 'neutral';

      const recent = klines.slice(-5);
      const older = klines.slice(-10, -5);

      const recentAvg = recent.reduce((s, k) => s + k.close, 0) / recent.length;
      const olderAvg = older.reduce((s, k) => s + k.close, 0) / older.length;

      const change = (recentAvg - olderAvg) / olderAvg;

      if (change > CONFIG.binance.trendThreshold / 100) return 'up';
      if (change < -CONFIG.binance.trendThreshold / 100) return 'down';
      return 'neutral';
    } catch {
      return 'neutral';
    }
  }

  async function updateTrends() {
    state.btcTrend = await analyzeTrend('BTCUSDT');
    state.ethTrend = await analyzeTrend('ETHUSDT');
    state.solTrend = await analyzeTrend('SOLUSDT');
    log('TREND', `BTC:${state.btcTrend} ETH:${state.ethTrend} SOL:${state.solTrend}`);
    updateDashboard();
  }

  await updateTrends();
  setInterval(updateTrends, 5 * 60 * 1000);
}

async function setupDirectTrading(sdk: PolymarketSDK) {
  log('INFO', 'Direct trading setup complete - waiting for toggle');

  if (CONFIG.directTrading.enabled) {
    if (CONFIG.dryRun) {
      log('INFO', 'Direct trading enabled (simulation mode)');
    } else {
      log('INFO', 'Direct trading enabled - will place orders based on trend analysis');
    }
  }

  async function checkTrendTrades() {
    if (!CONFIG.directTrading.enabled) return;
    if (!canTrade()) return;

    try {
      const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);

      for (const market of trendingMarkets) {
        if (!market.conditionId) continue;

        try {
          const fullMarket = await sdk.getMarket(market.conditionId);
          const yesToken = fullMarket.tokens.find(t => t.outcome === 'Yes');
          const noToken = fullMarket.tokens.find(t => t.outcome === 'No');

          if (!yesToken || !noToken) continue;

          const isCryptoMarket = /btc|bitcoin|eth|ethereum|sol|solana/i.test(market.question || '');

          if (isCryptoMarket && CONFIG.directTrading.trendFollowing) {
            let trend: 'up' | 'down' | 'neutral' = 'neutral';
            if (/btc|bitcoin/i.test(market.question || '')) trend = state.btcTrend;
            else if (/eth|ethereum/i.test(market.question || '')) trend = state.ethTrend;
            else if (/sol|solana/i.test(market.question || '')) trend = state.solTrend;

            if (trend !== 'neutral') {
              // Strategy:
              // UP -> Expect YES to win -> Buy YES
              // DOWN -> Expect YES to lose -> Buy NO
              const targetToken = trend === 'up' ? yesToken : noToken;
              const price = targetToken.price;

              // v3.2 AUDIT #5: streak-adjusted size from the shared sizer —
              // computed identically in BOTH modes. At rest (no streak) this
              // is maxPerTradePct × capital = 0.02 × $250 = $5, identical to
              // the old fixed size; loss streaks shrink it (dust floor
              // skips), win streaks grow it within caps.
              const sizeFrac = calculatePositionSize(
                CONFIG.capital.maxPerTradePct,
                {
                  consecutiveLosses: state.consecutiveLosses,
                  consecutiveWins: state.consecutiveWins,
                  capitalUsd: CONFIG.capital.totalUsd,
                },
                {
                  enableDynamicSizing: CONFIG.risk.enableDynamicSizing,
                  minPositionPct: CONFIG.risk.minPositionPct,
                  maxPositionPct: CONFIG.risk.maxPositionPct,
                  lossSizingReduction: CONFIG.risk.lossSizingReduction,
                  winSizingIncrease: CONFIG.risk.winSizingIncrease,
                  minOrderUsd: CONFIG.capital.minOrderUsd,
                }
              );
              const amountUsdc = Math.round(sizeFrac * CONFIG.capital.totalUsd * 100) / 100;
              if (amountUsdc <= 0) {
                log('WARN', `Direct trade skipped: sized notional below $${CONFIG.capital.minOrderUsd} floor after ${state.consecutiveLosses} consecutive losses`);
                continue;
              }
              // Same per-trade/per-market/total caps the other strategies
              // face — sizing alone can reach maxPositionPct ($12.50), 2.5×
              // the per-trade guard.
              if (!canOpenPosition(String(market.conditionId), amountUsdc)) {
                continue;
              }

              if (CONFIG.dryRun) {
                // DRY RUN: book entry + paper movement. Realized PnL for
                // direct positions is only booked on a real close, which the
                // simulator never performs — so no directEntries record is
                // kept (it could never be consumed and would grow unbounded).
                recordEntry('direct');
                if (state.paper) {
                  state.paper.trades++;
                  state.paper.totalVolume += amountUsdc;
                }
                log('TRADE', `[SIMULATION] Direct trend buy: ${market.question?.slice(0, 40)}... → ${trend.toUpperCase()} (Buy ${targetToken.outcome}) @ ${price.toFixed(2)}`);
                updateDashboard();
              } else {
                log('SIGNAL', `Executing Trend Trade: ${trend.toUpperCase()} on ${market.question?.slice(0, 30)}...`);

                void executeDirectBuy(sdk, targetToken.tokenId, amountUsdc).then(result => {
                  if (typeof result === 'object') log('WARN', `Direct BUY blocked: ${result.reason}`);
                }).catch(err => log('ERROR', `Direct BUY error: ${String(err)}`));
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      log('WARN', `Direct trading error: ${(err as Error).message}`);
    }
  }

  // Check every 5 minutes
  setInterval(checkTrendTrades, 5 * 60 * 1000);
  // Initial check after 10 seconds (let trends stabilize)
  setTimeout(checkTrendTrades, 10000);
}

async function setupPortfolioManager(sdk: PolymarketSDK) {
  log('INFO', 'Starting Portfolio Manager...');

  // Initial Sync
  try {
    const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());
    state.positions = positions;
    log('WALLET', `Synced ${positions.length} existing positions.`);
    updateDashboard();
  } catch (err: any) {
    log('WARN', `Portfolio Sync failed: ${err.message}`);
  }

  // Periodic Position Sync (Every 30s)
  setInterval(async () => {
    try {
      await flushPendingCloses(sdk);
      await flushPendingBuys(sdk);
      consumeTerminalCloses();
      consumeTerminalBuys();
      const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());

      // Enrich positions with market data (to check if won or lost)
      const enrichedPositions = await Promise.all(positions.map(async (pos: any) => {
        try {
          // Use cached market data if available
          const market = await sdk.markets.getMarket(pos.conditionId);
          if (market) {
            pos.marketClosed = market.closed;

            // Enrich with current price for PnL
            // Try to find the token in the market outcomes
            const token = market.tokens.find((t: any) => t.tokenId === pos.asset);

            if (token) {
              pos.isWinner = token.winner || false;
              // Store current price for frontend
              pos.curPrice = token.price || 0;
            }

            // If market is closed but winner info is missing/false, assume lost unless proven otherwise
            if (market.closed && !pos.isWinner) {
              // Double check if ANY token won (if market resolved)
            }
          }
        } catch (e) {
          // Ignore market fetch errors, keep basic pos data
        }
        return pos;
      }));

      // Calculate Unrealized PnL
      let unrealized = 0;
      for (const p of enrichedPositions) {
        const entry = Number(p.avgPrice) || 0;
        const current = Number(p.curPrice) || Number(p.msg_price) || 0;
        const size = Number(p.size) || 0;

        if (current > 0 && size > 0) {
          unrealized += (current - entry) * size;
        }
      }
      state.unrealizedPnL = unrealized;

      // Update Total PnL display to include Unrealized? 
      // User requested "P&L total is still not updating".
      // Usually Total = Realized + Unrealized.
      // But we keep them separate in state, let frontend decide how to show.

      state.positions = enrichedPositions;
      updateDashboard();
    } catch (err: any) {
      log('WARN', `Portfolio sync error: ${err.message}`);
    }
  }, 30 * 1000);
}

async function main() {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║          POLYMARKET BOT v3.2 + DASHBOARD                           ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  // Start Dashboard Server (v3.2: localhost bind + optional token auth)
  const dashToken = process.env.DASHBOARD_TOKEN;
  startDashboard({ port: 3001, token: dashToken });
  console.log(`\n🌐 Dashboard: http://localhost:3001${dashToken ? `/?token=${dashToken}` : ''}\n`);

  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    log('ERROR', 'POLYMARKET_PRIVATE_KEY not found');
    process.exit(1);
  }

  // Send config to dashboard
  dashboardEmitter.updateConfig(buildDashboardConfig());
  dashboardEmitter.updateState(state);

  log('INFO', 'Configuration', {
    binance: CONFIG.binance.enabled,
  });

  // NOTE: dashboard commands are handled by the single handler registered
  // after the SDK is created (a second early handler previously created a
  // use-before-init hazard and double-processed every command).

  // Initialize Paper Wallet if Dry Run
  if (CONFIG.dryRun) {
    state.paper = {
      balance: CONFIG.capital.totalUsd,
      initialBalance: CONFIG.capital.totalUsd,
      pnl: 0,
      trades: 0,
      totalVolume: 0,
    };
    log('INFO', '📝 Paper Trading Activated: Simulating trades with $250 initial capital');
    updateDashboard();
  }

  const sdk = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });
  activeSdk = sdk;

  log('INFO', `Wallet: ${sdk.tradingService.getAddress()}`);

  // Setup all services
  await setupOnchain(); // MUST BE FIRST (Approvals + PnL baseline anchor)
  await setupSwap();
  await setupBinanceAnalysis(sdk);
  await refreshExposure(sdk); // v3.2: seed exposure BEFORE strategies start
  await setupSmartMoney(sdk);
  await setupArbitrage(sdk);
  await setupDipArb(sdk);

  // v3.2: exposure is chain-seeded every 60s; PnL reconciled every 5 min;
  // session history is upserted every 5 min so a crash loses at most that
  setInterval(() => void refreshExposure(sdk), 60_000);
  setInterval(() => void reconcilePnl(), 5 * 60_000);
  setInterval(() => persistSession(), 5 * 60_000);

  // Periodic state update
  setInterval(() => {
    updateDashboard();
  }, 5000);

  // Setup Direct Trading
  await setupDirectTrading(sdk);

  // Setup Portfolio Manager (Persistence)
  await setupPortfolioManager(sdk);

  // Listen for commands from dashboard — single handler (registered after
  // the SDK exists; the old second handler double-processed commands)
  dashboardEmitter.on('command', async ({ command, payload }: { command: string; payload: any }) => {
    if (handleExecutionModeCommand(command, message => log('WARN', message))) {
      dashboardEmitter.updateConfig(buildDashboardConfig());
      return;
    }

    // v3.2: emergency halt — blocks every entry path via canTrade/riskGuard
    // (permanentlyHalted is the first check). Does NOT flip CONFIG.*.enabled:
    // a user could re-toggle a strategy, but nothing can open while halted.
    if (command === 'emergencyStop') {
      executionMode.halt(); // Latch before any await; no cancel-all or drain here.
      state.permanentlyHalted = true;
      state.isPaused = true;
      state.pauseUntil = Date.now() + 365 * 24 * 60 * 60 * 1000;
      stopSmartMoneyCopy();
      try { if (arbService) await arbService.stop(); } catch { /* best effort */ }
      try { await sdk.dipArb.stop(); } catch { /* best effort */ }
      log('ERROR', '🛑 EMERGENCY STOP — all strategies halted (restart bot to resume)');
      updateDashboard();
      dashboardEmitter.updateConfig(buildDashboardConfig());
      return;
    }

    // v3.2: panic sell — sequentially close up to 10 open positions at market
    if (command === 'panicSell') {
      if (CONFIG.dryRun) {
        log('TRADE', '[SIMULATION] Panic sell would close all open positions');
        return;
      }
      await executePanicSell(sdk);
      await refreshExposure(sdk);
      updateDashboard();
      return;
    }

    if (command === 'closePosition') {
      const { tokenId, size } = payload;
      log('TRADE', `Closing position: ${tokenId} (${size} shares)`);

      if (CONFIG.dryRun) {
        log('TRADE', `[SIMULATION] Would sell ${size} shares of ${tokenId}`);
        return;
      }

      const result = await executeClosePosition(sdk, tokenId, size);
      if (typeof result === 'object') log('WARN', `Close blocked: ${result.reason}`);
    }

    if (command === 'toggleStrategy') {
      const { strategy, enabled } = payload;
      const strategyName = strategy as keyof typeof CONFIG;

      if (CONFIG[strategyName] && typeof (CONFIG[strategyName] as any).enabled !== 'undefined') {
        (CONFIG[strategyName] as any).enabled = enabled;
        log('INFO', `⚙️ Strategy ${strategy} ${enabled ? 'ENABLED' : 'DISABLED'}`);

        // Actively Start/Stop Services based on toggle
        try {
          if (strategy === 'dipArb') {
            if (enabled) {
              if (sdk.dipArb.isActive()) {
                log('WARN', `DipArb is already running.`);
              } else {
                log('INFO', `Starting DipArb Service (Scanning for markets)...`);
                await sdk.dipArb.findAndStart();
              }
            } else {
              log('INFO', `Stopping DipArb Service...`);
              await sdk.dipArb.stop();
            }
          } else if (strategy === 'arbitrage') {
            if (enabled) {
              if (arbService) {
                // Update config
                arbService.updateConfig({
                  profitThreshold: CONFIG.arbitrage.profitThreshold,
                  autoExecute: CONFIG.arbitrage.autoExecute,
                });

                if (arbService.isActive()) {
                  log('WARN', `Arbitrage Service is already running.`);
                } else {
                  log('INFO', `Starting Arbitrage Service...`);

                  // Try to scan and start a market if possible
                  try {
                    const results = await arbService.scanMarkets({ minVolume24h: 1000 }, CONFIG.arbitrage.profitThreshold);
                    const best = results.find(r => r.arbType !== 'none') || results[0]; // Pick best or just first to monitor

                    if (best) {
                      await arbService.start(best.market);
                      state.activeArbMarket = best.market.name;
                      state.arbitrage.status = 'monitoring';
                      log('ARB', `Auto-started monitoring: ${best.market.name}`);
                      updateDashboard();
                    } else {
                      state.arbitrage.status = 'idle';
                      log('WARN', 'Arbitrage Service started but no markets found. Will keep scanning in background if configured.');
                      updateDashboard();
                    }
                  } catch (e) {
                    state.arbitrage.status = 'idle';
                    log('WARN', `Arbitrage auto-start failed: ${(e as Error).message}`);
                    updateDashboard();
                  }
                }
              } else {
                log('ERROR', 'Arbitrage Service not initialized. Restart bot.');
              }
            } else {
              log('INFO', `Stopping Arbitrage Service...`);
              if (arbService) {
                await arbService.stop();
                state.arbitrage.status = 'idle';
                updateDashboard();
              }
            }
          } else if (strategy === 'smartMoney') {
            if (enabled) {
              log('INFO', `Initializing Smart Money...`);
              // Call the lazy initializer we created
              initializeSmartMoney(sdk);
              // initializeSmartMoney is idempotent (guards on
              // isSmartMoneyInitialized) and would silently skip after the
              // first run — restart copy execution explicitly on re-enable.
              await startSmartMoneyCopy(sdk);
            } else {
              log('INFO', `Smart Money monitoring disabled.`);
              stopSmartMoneyCopy(); // v3.2: also stop live copy execution
            }
          } else if (strategy === 'directTrading') {
            if (enabled) {
              log('INFO', `Triggering Direct Trading analysis...`);
              // We can't easily reach the inner function checkTrendTrades from here because it's scoped inside setupDirectTrading.
              // However, checkTrendTrades runs on an interval and checks the config flag. 
              // By enabling the flag, the NEXT interval will pick it up.
              // To be immediate, we'd need to expose it, but simplified "Wait for next cycle" is acceptable or we can just log.
              log('INFO', `Direct Trading will run on next cycle (within 5 min).`);
            }
          }
        } catch (err: any) {
          log('WARN', `Failed to toggle service: ${err.message}`);
        }

        // Broadcast updated config to dashboard
        dashboardEmitter.updateConfig(buildDashboardConfig());
      } else {
        log('WARN', `Unknown strategy: ${strategy}`);
      }
    }

    if (command === 'redeemPosition') {
      const { conditionId } = payload;
      log('CHAIN', `Redeem requested for: ${conditionId}`);

      if (CONFIG.dryRun) {
        log('CHAIN', `[SIMULATION] Would redeem position ${conditionId}`);
        return;
      }

      try {
        // Create CTFClient instance for on-chain redemption
        const ctfClient = new CTFClient({
          privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
        });

        const result = await executeDashboardRedeem(sdk, conditionId, ctfClient);
        if ('status' in result) log('WARN', `Redeem blocked: ${result.reason}`);
        else if (result.success) log('CHAIN', `Redeemed ${result.tokensRedeemed} tokens; TX: ${result.txHash}`);

      } catch (err: any) {
        log('WARN', `❌ Redeem error: ${err.message}`);
      }
    }
  });

  process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    persistSession(); // final history checkpoint
    stopSmartMoneyCopy();
    if (arbService) await arbService.stop();
    await sdk.dipArb.stop();
    sdk.stop();
    process.exit(0);
  });

  log('INFO', '🚀 Bot + Dashboard running! Press Ctrl+C to stop.\n');

  // Status Display Loop
  function displayStatus() {
    const runtime = Math.round((Date.now() - state.startTime) / 1000 / 60);

    console.log('\n' + '═'.repeat(70));
    console.log('              POLYMARKET BOT v3.2 STATUS');
    console.log('═'.repeat(70));
    console.log(`  Runtime:        ${runtime} minutes`);
    console.log(`  Mode:           ${CONFIG.dryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`);
    console.log(`  Status:         ${state.permanentlyHalted ? '🛑 HALTED' : state.isPaused ? '⏸️ PAUSED' : '▶️ ACTIVE'}`);
    console.log(`  Exposure:       $${state.totalExposureUsd.toFixed(2)} / $${(CONFIG.capital.totalUsd * CONFIG.capital.maxTotalExposurePct).toFixed(2)} cap`);
    console.log('─'.repeat(70));
    console.log('  BALANCES:');
    console.log(`    MATIC:        ${state.maticBalance.toFixed(4)}`);
    console.log(`    USDC:         $${state.usdcBalance.toFixed(2)}`);
    console.log(`    USDC.e:       $${state.usdcEBalance.toFixed(2)}`);
    console.log(`    pUSD (CLOB):  $${state.pUsdBalance.toFixed(2)}`);
    console.log('─'.repeat(70));
    console.log('  STRATEGIES:');
    console.log(`    Smart Money:  ${state.smartMoneyTrades} trades | ${state.followedWallets.length} wallets`);
    console.log(`    Arbitrage:    ${state.arbTrades} trades`);
    console.log(`    DipArb:       ${state.dipArbTrades} trades`);
    console.log('═'.repeat(70) + '\n');
  }

  setInterval(displayStatus, 60000);
  displayStatus(); // Initial call
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  console.error(err);
  process.exit(1);
});

// ============================================================================
// v3.2: process-level guards — one rejected order promise used to kill the
// bot (no handler existed anywhere). Rejections are logged and survived;
// uncaught exceptions attempt a best-effort service stop then exit.
// ============================================================================
process.on('unhandledRejection', (reason) => {
  console.error('[guard] Unhandled promise rejection:', reason);
  try {
    log('ERROR', `Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  } catch { /* logger may itself be down */ }
});

process.on('uncaughtException', (err) => {
  console.error('[guard] Uncaught exception:', err);
  try { log('ERROR', `Uncaught exception: ${err.message} — stopping`); } catch { /* best effort */ }
  try {
    stopSmartMoneyCopy();
    void arbService?.stop();
    void activeSdk?.dipArb.stop();
  } catch { /* best effort */ }
  process.exit(1);
});
