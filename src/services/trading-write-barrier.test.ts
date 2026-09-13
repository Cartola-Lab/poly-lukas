import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RateLimiter } from '../core/rate-limiter.js';
import axios from 'axios';

// Replace the actual SDK transport adapter; module mocks do not intercept its
// external ESM imports. No adapter in this suite opens a socket.
const http = vi.fn();
const originalAdapter = axios.defaults.adapter;

const key = '0x' + '11'.repeat(32);
const credentials = { key: 'test-key', secret: 'dGVzdA==', passphrase: 'test-passphrase' };

async function setup(mode: 'DRY' | 'LIVE' | 'HALT') {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', mode === 'DRY' ? 'true' : 'false');
  const { executionMode } = await import('../core/execution-mode.js');
  const { TradingService } = await import('./trading-service.js');
  const { createUnifiedCache } = await import('../core/unified-cache.js');
  const limiter = { execute: (_api: unknown, fn: () => Promise<unknown>) => fn() } as RateLimiter;
  const service = new TradingService(limiter, createUnifiedCache(), { privateKey: key, credentials });
  await service.initialize();
  const client = service.getClobClient()!;
  vi.spyOn(client, 'getTickSize').mockResolvedValue('0.01');
  vi.spyOn(client, 'getNegRisk').mockResolvedValue(false);
  if (mode === 'HALT') executionMode.halt();
  return { service, client, executionMode };
}

beforeEach(() => {
  http.mockReset().mockImplementation(async request => {
    const path = new URL(request.url).pathname;
    const data = path === '/version' ? { version: 2 }
      : path === '/markets-by-token/1' ? { condition_id: 'condition-1' }
      : path === '/clob-markets/condition-1' ? { t: [{ t: '1' }], mts: '0.01', nr: false }
      : { success: true, orderID: 'test-order' };
    return { data, status: 200, headers: {} };
  });
  axios.defaults.adapter = http;
});
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  vi.unstubAllEnvs();
});

const writes = () => http.mock.calls.filter(([request]) => request.method !== 'get');

describe('real clob-client-v2 1.1.0 with mocked HTTP only', () => {
  describe.each(['DRY', 'LIVE', 'HALT'] as const)('%s cancellation and heartbeat transport', mode => {
    const routes = [
      { name: 'service.cancelOrder', path: '/order', data: { orderID: 'order-1' }, run: ({ service }: Awaited<ReturnType<typeof setup>>) => service.cancelOrder('order-1') },
      { name: 'service.cancelOrders', path: '/orders', data: ['order-1', 'order-2'], run: ({ service }: Awaited<ReturnType<typeof setup>>) => service.cancelOrders(['order-1', 'order-2']) },
      { name: 'service.cancelAllOrders', path: '/cancel-all', data: undefined, run: ({ service }: Awaited<ReturnType<typeof setup>>) => service.cancelAllOrders() },
      { name: 'raw.cancelOrder', path: '/order', data: { orderID: 'order-1' }, run: ({ client }: Awaited<ReturnType<typeof setup>>) => client.cancelOrder({ orderID: 'order-1' }) },
      { name: 'raw.cancelOrders', path: '/orders', data: ['order-1', 'order-2'], run: ({ client }: Awaited<ReturnType<typeof setup>>) => client.cancelOrders(['order-1', 'order-2']) },
      { name: 'raw.cancelAll', path: '/cancel-all', data: undefined, run: ({ client }: Awaited<ReturnType<typeof setup>>) => client.cancelAll() },
      { name: 'raw.cancelMarketOrders', path: '/cancel-market-orders', data: { market: 'market-1', asset_id: '1' }, run: ({ client }: Awaited<ReturnType<typeof setup>>) => client.cancelMarketOrders({ market: 'market-1', asset_id: '1' }) },
      { name: 'raw.postHeartbeat', path: '/v1/heartbeats', data: { heartbeat_id: 'heartbeat-1' }, run: ({ client }: Awaited<ReturnType<typeof setup>>) => client.postHeartbeat('heartbeat-1') },
    ];
    it.each(routes)('$name', async route => {
      const context = await setup(mode);
      http.mockResolvedValue({ data: { canceled: true, heartbeat_id: 'heartbeat-2' }, status: 200, headers: {} });
      if (mode !== 'LIVE') {
        await expect(route.run(context)).rejects.toThrow(mode);
        expect(http).not.toHaveBeenCalled();
        return;
      }
      await route.run(context);
      expect(http).toHaveBeenCalledTimes(1);
      const request = http.mock.calls[0][0];
      expect(request.method).toBe(route.path === '/v1/heartbeats' ? 'post' : 'delete');
      expect(new URL(request.url).pathname).toBe(route.path);
      expect(request.data === undefined ? undefined : JSON.parse(request.data)).toEqual(route.data);
      expect(request.headers.POLY_API_KEY).toBe(credentials.key);
    });
  });

  it.each(['DRY', 'LIVE', 'HALT'] as const)('%s gates limit and market writes', async mode => {
    const { service } = await setup(mode);
    const market = await service.createMarketOrder({ tokenId: '1', side: 'BUY', amount: 5, price: 0.5 });
    const limit = await service.createLimitOrder({ tokenId: '1', side: 'SELL', size: 10, price: 0.5 });
    expect(market.success).toBe(mode === 'LIVE');
    expect(limit.success).toBe(mode === 'LIVE');
    expect(writes()).toHaveLength(mode === 'LIVE' ? 2 : 0);
    if (mode !== 'LIVE') expect(market.errorMsg).toContain(mode);
  });

  it.each(['DRY', 'HALT'] as const)('%s also blocks the advanced raw client getter', async mode => {
    const { client } = await setup(mode);
    const signed = await client.createOrder({ tokenID: '1', side: 'BUY' as never, size: 10, price: 0.5 });
    await expect(client.postOrder(signed)).rejects.toThrow(mode);
    await expect(client.postOrders([{ order: signed, orderType: 'FOK' as never }])).rejects.toThrow(mode);
    expect(writes()).toHaveLength(0);
  });

  it('rechecks HALT after order signing started but before final HTTP POST', async () => {
    const { service, client, executionMode } = await setup('LIVE');
    const createOrder = client.createMarketOrder.bind(client);
    vi.spyOn(client, 'createMarketOrder').mockImplementation(async (...args) => {
      const signed = await createOrder(...args);
      executionMode.halt();
      return signed;
    });
    const result = await service.createMarketOrder({ tokenId: '1', side: 'BUY', amount: 5, price: 0.5 });
    expect(result.success).toBe(false);
    expect(result.errorMsg).toContain('HALT');
    expect(writes()).toHaveLength(0);
  });

  it.each(['DRY', 'HALT'] as const)('%s allows authenticated reads', async mode => {
    const { service } = await setup(mode);
    http.mockResolvedValueOnce({ data: { balance: '100', allowances: { 'fixture-spender': '100' } } });
    expect(await service.getBalanceAllowance('COLLATERAL')).toEqual({ balance: '100', allowances: { 'fixture-spender': '100' } });
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }));
  });

  it('does not expose the removed V1 RFQ client or captured transports', async () => {
    const { client } = await setup('LIVE');
    expect(client).not.toHaveProperty('rfq');
  });

  it.each(['DRY', 'HALT'] as const)('%s allows batch book reads even though they use POST', async mode => {
    const { client } = await setup(mode);
    http.mockResolvedValueOnce({ data: [] });
    expect(await client.getOrderBooks([{ token_id: '1', side: 'BUY' as never }])).toEqual([]);
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ method: 'post', url: expect.stringContaining('/books') }));
  });
});
