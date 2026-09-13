import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { utils } from 'ethers';
import { createHmac } from 'node:crypto';
import type { RateLimiter } from '../core/rate-limiter.js';

const key = '0x' + '11'.repeat(32);
const credentials = { key: 'fixture-key', secret: 'dGVzdA==', passphrase: 'fixture-passphrase' };
const originalAdapter = axios.defaults.adapter;
const http = vi.fn();
const unexpected: string[] = [];
let derive = true;
let negRisk = false;
const limiter = { execute: (_api: unknown, fn: () => Promise<unknown>) => fn() } as RateLimiter;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', 'false');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  unexpected.length = 0;
  derive = true;
  negRisk = false;
  // Every SDK HTTP request terminates here; no real adapter/socket is used.
  http.mockReset().mockImplementation(async request => {
    const path = new URL(request.url).pathname;
    const route = `${request.method} ${path}`;
    let data: unknown;
    switch (route) {
      case 'get /version': data = { version: 2 }; break;
      case 'get /tick-size': data = { minimum_tick_size: 0.01 }; break;
      case 'get /neg-risk': data = { neg_risk: negRisk }; break;
      case 'get /markets-by-token/1': data = { condition_id: 'condition-1' }; break;
      case 'get /clob-markets/condition-1': data = { t: [{ t: '1' }], mts: '0.01', nr: negRisk }; break;
      case 'get /auth/derive-api-key':
        data = derive ? { apiKey: credentials.key, secret: credentials.secret, passphrase: credentials.passphrase } : {};
        break;
      case 'post /auth/api-key': data = { apiKey: credentials.key, secret: credentials.secret, passphrase: credentials.passphrase }; break;
      case 'post /order': data = { success: true, orderID: 'fixture-order' }; break;
      case 'get /balance-allowance': data = { balance: '100', allowances: { 'fixture-spender': '200' } }; break;
      case 'get /markets/condition-1': data = { condition_id: 'condition-1', tokens: [] }; break;
      default: unexpected.push(route); throw new Error(`Unexpected HTTP: ${route}`);
    }
    return { data, status: 200, headers: {}, config: request };
  });
  axios.defaults.adapter = http;
});

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  expect(unexpected).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function setup(withCredentials = true) {
  const { TradingService } = await import('./trading-service.js');
  const { createUnifiedCache } = await import('../core/unified-cache.js');
  const service = new TradingService(limiter, createUnifiedCache(), {
    privateKey: key, ...(withCredentials ? { credentials } : {}),
  });
  const sign = vi.spyOn(service.getWallet(), '_signTypedData');
  await service.initialize();
  return { service, sign };
}

describe('runtime CLOB V2 protocol with real SDK and fixture HTTP', () => {
  it.each([false, true])('signs and posts V2 limit and market orders (negRisk=%s)', async risk => {
    negRisk = risk;
    const { service, sign } = await setup();
    const { ClobClient } = await import('@polymarket/clob-client-v2');
    const client = service.getClobClient()!;
    expect(client).toBeInstanceOf(ClobClient);
    const post = vi.spyOn(client, 'postOrder');
    expect((await service.createLimitOrder({ tokenId: '1', side: 'SELL', price: 0.5, size: 10 })).success).toBe(true);
    expect((await service.createMarketOrder({ tokenId: '1', side: 'BUY', price: 0.5, amount: 5 })).success).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledTimes(2);
    const requests = http.mock.calls.map(([request]) => request).filter(request => request.method === 'post');
    expect(requests).toHaveLength(2);
    for (const [i, request] of requests.entries()) {
      const [domain, types, value] = sign.mock.calls[i];
      expect(domain).toMatchObject({
        name: 'Polymarket CTF Exchange', version: '2', chainId: 137,
        verifyingContract: risk ? '0xe2222d279d744050d28e00520010520000310F59' : '0xE111180000d2663C0091e4f400237545B87B996B',
      });
      const payload = JSON.parse(request.data);
      expect(new URL(request.url).pathname).toBe('/order');
      expect(payload.order).toMatchObject({
        maker: service.getWallet().address, signer: service.getWallet().address,
        signatureType: 0, tokenId: '1', metadata: '0x' + '00'.repeat(32), builder: '0x' + '00'.repeat(32),
      });
      expect(payload.order.timestamp).toBeDefined();
      expect(payload.order).not.toHaveProperty('nonce');
      expect(payload.order).not.toHaveProperty('feeRateBps');
      expect(utils.verifyTypedData(domain, types, value, payload.order.signature)).toBe(service.getWallet().address);
      expect(payload.order.signature).toBe(post.mock.calls[i][0].signature);
      expect(request.headers.POLY_API_KEY).toBe(credentials.key);
      expect(request.headers.POLY_PASSPHRASE).toBe(credentials.passphrase);
      const hmac = createHmac('sha256', Buffer.from(credentials.secret, 'base64'))
        .update(`${request.headers.POLY_TIMESTAMP}POST/order${request.data}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
      expect(request.headers.POLY_SIGNATURE).toBe(hmac);
    }
  });

  it.each([true, false])('uses real L1 credential auth and then L2 reads (derive=%s)', async existing => {
    derive = existing;
    vi.stubEnv('DRY_RUN', 'true');
    const { service, sign } = await setup(false);
    const auth = http.mock.calls.map(([request]) => request);
    expect(auth.map(request => new URL(request.url).pathname)).toEqual(existing
      ? ['/auth/derive-api-key'] : ['/auth/derive-api-key', '/auth/api-key']);
    for (const [i, request] of auth.entries()) {
      const [domain, types, value] = sign.mock.calls[i];
      expect(domain).toMatchObject({ name: 'ClobAuthDomain', version: '1', chainId: 137 });
      expect(utils.verifyTypedData(domain, types, value, request.headers.POLY_SIGNATURE)).toBe(service.getWallet().address);
    }
    // Auth domain v1 is distinct from the exchange order domain v2.
    expect(await service.getBalanceAllowance('COLLATERAL')).toEqual({ balance: '100', allowance: undefined });
    expect(http.mock.calls.at(-1)![0].headers.POLY_API_KEY).toBe(credentials.key);
  });

  it.each([false, true])('MarketService reads through V2 (wallet=%s)', async wallet => {
    const { MarketService } = await import('./market-service.js');
    const { createUnifiedCache } = await import('../core/unified-cache.js');
    const service = new MarketService(undefined, undefined, limiter, createUnifiedCache(), wallet ? { privateKey: key } : undefined);
    expect(await service.getClobMarket('condition-1')).toMatchObject({ conditionId: 'condition-1' });
    expect(http).toHaveBeenCalledTimes(1);
  });
});
