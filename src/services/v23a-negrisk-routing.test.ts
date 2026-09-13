import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { RateLimiter } from '../core/rate-limiter.js';

// P0.V2.3A: prove that the CLOB negRisk identity reaches the CTF lifecycle
// boundary without touching any split/merge/redeem transaction behavior.
// All CLOB HTTP goes through a mocked axios adapter and Gamma through a
// mocked fetch; no socket is opened in this suite.

const http = vi.fn();
const originalAdapter = axios.defaults.adapter;
const limiter = { execute: (_api: unknown, fn: () => Promise<unknown>) => fn() } as RateLimiter;

const standardCondition = '0x' + 'aa'.repeat(32);
const negRiskCondition = '0x' + 'bb'.repeat(32);
const standardSlug = 'will-btc-reach-100k';
const negRiskSlug = 'eth-updown-15m-1767165300';
const endIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();

let clobNegRisk = false;

const gammaMarket = (conditionId: string, slug: string, outcomes: string[]) => ({
  id: '1',
  conditionId,
  slug,
  question: 'Fixture market',
  outcomes,
  outcomePrices: ['0.5', '0.5'],
  volume: 1000,
  volume24hr: 5000,
  liquidity: 100,
  endDate: endIso,
  active: true,
  closed: false,
});

const clobMarket = (conditionId: string, slug: string, outcomes: string[], negRisk: boolean) => ({
  condition_id: conditionId,
  market_slug: slug,
  question: 'Fixture market',
  tokens: [
    { token_id: `${conditionId}-yes`, outcome: outcomes[0], price: 0.5 },
    { token_id: `${conditionId}-no`, outcome: outcomes[1], price: 0.5 },
  ],
  active: true,
  closed: false,
  accepting_orders: true,
  neg_risk: negRisk,
  end_date_iso: endIso,
});

const orderbook = (assetId: string) => ({
  asset_id: assetId,
  market: standardCondition,
  timestamp: '0',
  hash: '0x',
  bids: [{ price: '0.45', size: '100' }],
  asks: [{ price: '0.55', size: '100' }],
});

beforeEach(() => {
  vi.resetModules();
  clobNegRisk = false;
  http.mockReset().mockImplementation(async request => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    let data: unknown;
    switch (route) {
      case `get /markets/${standardCondition}`:
        data = clobMarket(standardCondition, standardSlug, ['Yes', 'No'], false);
        break;
      case `get /markets/${negRiskCondition}`:
        data = clobMarket(negRiskCondition, negRiskSlug, ['Up', 'Down'], clobNegRisk);
        break;
      case 'get /book': {
        const tokenId = String(url.searchParams.get('token_id'));
        data = orderbook(tokenId);
        break;
      }
      default: throw new Error(`Unexpected HTTP: ${route}`);
    }
    return { data, status: 200, headers: {}, config: request };
  });
  axios.defaults.adapter = http;

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const target = String(url);
    if (!target.includes('gamma-api.polymarket.com')) {
      throw new Error(`Unexpected fetch: ${target}`);
    }
    const params = new URL(target).searchParams;
    const slug = params.get('slug');
    const conditionId = params.get('condition_id');
    let data: unknown[];
    if (slug) {
      const isEth = slug.toLowerCase().startsWith('eth');
      data = [gammaMarket(isEth ? negRiskCondition : standardCondition, slug, isEth ? ['Up', 'Down'] : ['Yes', 'No'])];
    } else if (conditionId) {
      data = [conditionId === negRiskCondition
        ? gammaMarket(negRiskCondition, negRiskSlug, ['Up', 'Down'])
        : gammaMarket(standardCondition, standardSlug, ['Yes', 'No'])];
    } else {
      data = [
        gammaMarket(standardCondition, standardSlug, ['Yes', 'No']),
        gammaMarket(negRiskCondition, negRiskSlug, ['Up', 'Down']),
      ];
    }
    return { ok: true, status: 200, json: async () => data };
  }));
});

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function makeDipArb() {
  const { DipArbService } = await import('./dip-arb-service.js');
  const { RealtimeServiceV2 } = await import('./realtime-service-v2.js');
  const { MarketService } = await import('./market-service.js');
  const { GammaApiClient } = await import('../clients/gamma-api.js');
  const { createUnifiedCache } = await import('../core/unified-cache.js');

  const cache = createUnifiedCache();
  const gammaApi = new GammaApiClient(limiter, cache);
  const marketService = new MarketService(gammaApi, undefined, limiter, cache);
  const realtime = new RealtimeServiceV2({ debug: false });
  return new DipArbService(realtime, null, marketService);
}

async function makeArbitrage() {
  const { ArbitrageService } = await import('./arbitrage-service.js');
  return new ArbitrageService({ enableLogging: false });
}

async function makeClobMarketRead() {
  const { MarketService } = await import('./market-service.js');
  const { createUnifiedCache } = await import('../core/unified-cache.js');
  return new MarketService(undefined, undefined, limiter, createUnifiedCache());
}

describe('V2.3A negRisk routing propagation (offline CLOB fixtures)', () => {
  it('MarketService carries the CLOB neg_risk flag into the unified market', async () => {
    const marketService = await makeClobMarketRead();
    const standard = await marketService.getClobMarket(standardCondition);
    expect(standard?.negRisk).toBe(false);
    clobNegRisk = true;
    const negRisk = await marketService.getClobMarket(negRiskCondition);
    expect(negRisk?.negRisk).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { flag: false, expected: false },
    { flag: true, expected: true },
  ])('DipArb market discovery propagates CLOB negRisk=$flag', async ({ flag, expected }) => {
    clobNegRisk = flag;
    const service = await makeDipArb();
    const markets = await service.scanUpcomingMarkets({ coin: 'ETH', duration: '15m', limit: 5 });
    expect(markets.length).toBeGreaterThan(0);
    expect(markets[0].negRisk).toBe(expected);
  });

  it.each([
    { flag: false, expected: false },
    { flag: true, expected: true },
  ])('Arbitrage scan propagates CLOB negRisk=$flag into the market config', async ({ flag, expected }) => {
    clobNegRisk = flag;
    const service = await makeArbitrage();
    const results = await service.scanMarkets({ minVolume24h: 0, limit: 10 }, 0);
    const negRiskResult = results.find(r => r.market.conditionId === negRiskCondition);
    expect(negRiskResult?.market.negRisk).toBe(expected);
    const standardResult = results.find(r => r.market.conditionId === standardCondition);
    expect(standardResult?.market.negRisk).toBe(false);
  });

  it('Arbitrage settle forwards {negRisk:true} to the lifecycle boundary', async () => {
    const service = await makeArbitrage();
    const mergeByTokenIds = vi.fn().mockResolvedValue({ success: true, txHash: '0x', usdcReceived: '2' });
    const internal = service as unknown as {
      ctf: { getPositionBalanceByTokenIds: () => Promise<{ yesBalance: string; noBalance: string }>; mergeByTokenIds: typeof mergeByTokenIds };
    };
    internal.ctf = {
      getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '2', noBalance: '2' }),
      mergeByTokenIds,
    };
    const market = {
      name: 'neg-risk',
      conditionId: negRiskCondition,
      yesTokenId: 'tok-1',
      noTokenId: 'tok-2',
      negRisk: true,
    };
    await service.settlePosition(market, true);
    expect(mergeByTokenIds).toHaveBeenCalledWith(negRiskCondition, expect.anything(), expect.any(String), { negRisk: true });
  });

  it('Arbitrage settle forwards {negRisk:false} for standard markets', async () => {
    const service = await makeArbitrage();
    const mergeByTokenIds = vi.fn().mockResolvedValue({ success: true, txHash: '0x', usdcReceived: '2' });
    const internal = service as unknown as {
      ctf: { getPositionBalanceByTokenIds: () => Promise<{ yesBalance: string; noBalance: string }>; mergeByTokenIds: typeof mergeByTokenIds };
    };
    internal.ctf = {
      getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '2', noBalance: '2' }),
      mergeByTokenIds,
    };
    const market = {
      name: 'standard',
      conditionId: standardCondition,
      yesTokenId: 'tok-1',
      noTokenId: 'tok-2',
      negRisk: false,
    };
    await service.settlePosition(market, true);
    expect(mergeByTokenIds).toHaveBeenCalledWith(standardCondition, expect.anything(), expect.any(String), { negRisk: false });
  });

  it('NEGATIVE: unknown Arbitrage market type reaches the boundary as undefined, never as false', async () => {
    const service = await makeArbitrage();
    const mergeByTokenIds = vi.fn().mockResolvedValue({ success: true, txHash: '0x', usdcReceived: '2' });
    const internal = service as unknown as {
      ctf: { getPositionBalanceByTokenIds: () => Promise<{ yesBalance: string; noBalance: string }>; mergeByTokenIds: typeof mergeByTokenIds };
    };
    internal.ctf = {
      getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '2', noBalance: '2' }),
      mergeByTokenIds,
    };
    const market = {
      name: 'unknown-type',
      conditionId: standardCondition,
      yesTokenId: 'tok-1',
      noTokenId: 'tok-2',
      // negRisk intentionally omitted: must not be silently coerced to false
    };
    await service.settlePosition(market, true);
    expect(mergeByTokenIds).toHaveBeenCalledTimes(1);
    const routing = mergeByTokenIds.mock.calls[0][3];
    expect(routing).toBeUndefined();
    expect(routing).not.toEqual({ negRisk: false });
  });

  it('DipArb merge forwards {negRisk:true} to the lifecycle boundary', async () => {
    const service = await makeDipArb();
    const mergeByTokenIds = vi.fn().mockResolvedValue({ success: true, txHash: '0x', usdcReceived: '2' });
    const internal = service as unknown as {
      market: { conditionId: string; upTokenId: string; downTokenId: string; negRisk?: boolean };
      currentRound: { roundId: string; leg1?: { shares: number }; leg2?: { shares: number } };
      ctf: { getPositionBalanceByTokenIds: () => Promise<{ yesBalance: string; noBalance: string }>; mergeByTokenIds: typeof mergeByTokenIds };
    };
    internal.market = { conditionId: negRiskCondition, upTokenId: 'tok-1', downTokenId: 'tok-2', negRisk: true };
    internal.currentRound = { roundId: 'r1', leg1: { shares: 2 }, leg2: { shares: 2 } };
    internal.ctf = {
      getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '2', noBalance: '2' }),
      mergeByTokenIds,
    };
    await service.merge();
    expect(mergeByTokenIds).toHaveBeenCalledWith(negRiskCondition, expect.anything(), expect.any(String), { negRisk: true });
  });

  it('NEGATIVE: DipArb routing helper yields undefined for unknown type, never false', async () => {
    const service = await makeDipArb();
    const toRouting = (service as unknown as { toLifecycleRouting(m: { negRisk?: boolean } | null): unknown }).toLifecycleRouting;
    expect(toRouting({})).toBeUndefined();
    expect(toRouting(null)).toBeUndefined();
    expect(toRouting({ negRisk: true })).toEqual({ negRisk: true });
    expect(toRouting({ negRisk: false })).toEqual({ negRisk: false });
  });

  it('NEGATIVE: a neg-risk CLOB market never arrives as false through DipArb discovery', async () => {
    clobNegRisk = true;
    const service = await makeDipArb();
    const markets = await service.scanUpcomingMarkets({ coin: 'ETH', duration: '15m', limit: 5 });
    expect(markets.length).toBeGreaterThan(0);
    expect(markets[0].negRisk).toBe(true);
  });

  it('CTFClient split/merge/redeem accept routing while transactions stay on legacy contracts', async () => {
    vi.stubEnv('DRY_RUN', 'false');
    const { CTFClient } = await import('../clients/ctf-client.js');
    const { OnchainService } = await import('./onchain-service.js');
    const { providers, utils, BigNumber, Wallet } = await import('ethers');
    vi.spyOn(providers.JsonRpcProvider.prototype, 'send').mockImplementation(async method => {
      if (method === 'eth_chainId') return '0x89';
      throw new Error(`Unexpected RPC in offline test: ${method}`);
    });
    vi.spyOn(providers.BaseProvider.prototype, 'getFeeData').mockResolvedValue({
      gasPrice: BigNumber.from(100), lastBaseFeePerGas: BigNumber.from(100),
      maxFeePerGas: BigNumber.from(200), maxPriorityFeePerGas: BigNumber.from(30),
    });
    vi.spyOn(providers.BaseProvider.prototype, 'getGasPrice').mockResolvedValue(BigNumber.from(100));
    vi.spyOn(providers.BaseProvider.prototype, 'getBalance').mockResolvedValue(utils.parseEther('100'));
    vi.spyOn(providers.BaseProvider.prototype, 'call').mockImplementation(async transaction => {
      const data = String(await transaction.data);
      let value = 100_000_000;
      if (data.startsWith(utils.id('allowance(address,address)').slice(0, 10))) value = 0;
      if (data.startsWith(utils.id('payoutDenominator(bytes32)').slice(0, 10))) value = 1;
      if (data.startsWith(utils.id('payoutNumerators(bytes32,uint256)').slice(0, 10))) {
        value = BigNumber.from('0x' + data.slice(-64)).isZero() ? 1 : 0;
      }
      return utils.defaultAbiCoder.encode(['uint256'], [value]);
    });
    const send = vi.spyOn(Wallet.prototype, 'sendTransaction').mockResolvedValue({
      hash: '0x' + '22'.repeat(32),
      wait: async () => ({ status: 1, transactionHash: '0x' + '22'.repeat(32), gasUsed: BigNumber.from(21000), logs: [] }),
    } as never);

    const key = '0x' + '11'.repeat(32);
    const ctf = new CTFClient({ privateKey: key });
    const onchain = new OnchainService({ privateKey: key });
    const condition = '0x' + '33'.repeat(32);
    const ids = { yesTokenId: '1', noTokenId: '2' };

    // Split with standard routing: V2.3C1a adapter path (pUSD approve +
    // CtfCollateralAdapter splitPosition). Neg-risk split fails closed.
    send.mockClear();
    await expect(ctf.split(condition, '1', { negRisk: true })).rejects.toThrow(/not implemented yet/);
    expect(send).not.toHaveBeenCalled();
    send.mockClear();
    const split = await ctf.split(condition, '1', { negRisk: false });
    expect(split.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(2); // approve + splitPosition (V2.3C1a flow)
    const approveData = String(await send.mock.calls[0][0].data);
    expect(approveData.startsWith(utils.id('approve(address,uint256)').slice(0, 10))).toBe(true);
    const splitData = String(await send.mock.calls[1][0].data);
    expect(splitData.startsWith(utils.id('splitPosition(address,bytes32,bytes32,uint256[],uint256)').slice(0, 10))).toBe(true);

    // Merge through OnchainService with standard routing: V2.3C1b adapter
    // path (CtfCollateralAdapter mergePositions). ERC1155 read returns
    // truthy here, so no operator approval write is needed.
    send.mockClear();
    const merge = await onchain.mergeByTokenIds(condition, ids, '1', { negRisk: false });
    expect(merge.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const mergeData = String(await send.mock.calls[0][0].data);
    expect(mergeData.startsWith(utils.id('mergePositions(address,bytes32,bytes32,uint256[],uint256)').slice(0, 10))).toBe(true);
    expect(String(await send.mock.calls[0][0].to).toLowerCase()).toBe('0xada100874d00e3331d00f2007a9c336a65009718');

    // Redeem with routing: legacy redeemPositions call.
    send.mockClear();
    const redeem = await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    expect(redeem.success).toBe(true);
    const redeemData = String(await send.mock.calls[0][0].data);
    expect(redeemData.startsWith(utils.id('redeemPositions(address,bytes32,bytes32,uint256[])').slice(0, 10))).toBe(true);
  });
});
