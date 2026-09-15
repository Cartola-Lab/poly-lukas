import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BigNumber, providers } from 'ethers';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', 'false');
  vi.spyOn(providers.JsonRpcProvider.prototype, 'send').mockImplementation(async method => {
    if (method === 'eth_chainId') return '0x89';
    throw new Error(`Unexpected RPC: ${method}`);
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getFeeData').mockResolvedValue({
    gasPrice: BigNumber.from(100), lastBaseFeePerGas: BigNumber.from(100),
    maxFeePerGas: BigNumber.from(200), maxPriorityFeePerGas: BigNumber.from(30),
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getGasPrice').mockResolvedValue(BigNumber.from(100));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture(response: Record<string, unknown> = { success: true, orderID: 'order' }) {
  const { TradingService } = await import('./trading-service.js');
  const limiter = { execute: (_: unknown, fn: () => unknown) => fn() };
  const cache = { get: vi.fn(), set: vi.fn() };
  const service = new TradingService(limiter as any, cache as any, { privateKey: '0x' + '11'.repeat(32) });
  const post = vi.fn().mockResolvedValue(response);
  Object.assign(service, { initialized: true, clobClient: { createAndPostMarketOrder: post } });
  const tick = vi.spyOn(service as any, 'getTickSize').mockResolvedValue('0.01');
  vi.spyOn(service as any, 'isNegRisk').mockResolvedValue(false);
  return { service, post, tick, submit: (amount = 10) => service.createMarketOrder({ tokenId: '123', side: 'SELL', amount }) };
}

describe('P0.3e-3a market submission provenance', () => {
  it('explicit success with usable orderId is ACCEPTED and preserves existing fields', async () => {
    const h = await fixture({ success: true, orderID: 'order', orderIDs: ['order'],
      tradeIDs: ['trade'], transactionsHashes: ['tx'], status: 'MATCHED', errorMsg: '' });
    expect(await h.submit()).toEqual({ success: true, submissionState: 'ACCEPTED',
      orderId: 'order', orderIds: ['order'], tradeIds: ['trade'], transactionHashes: ['tx'], errorMsg: '' });
    expect(h.post.mock.calls[0][0]).toMatchObject({ tokenID: '123', side: 'SELL', amount: 10 });
    expect(h.post).toHaveBeenCalledTimes(1);
  });
  it('explicit CLOB failure is REJECTED', async () => {
    const h = await fixture({ success: false, errorMsg: 'rejected' });
    expect(await h.submit()).toMatchObject({ success: false, submissionState: 'REJECTED', errorMsg: 'rejected' });
  });
  it('local minimum guard is REJECTED before external work', async () => {
    const h = await fixture();
    expect(await h.submit(0.5)).toMatchObject({ success: false, submissionState: 'REJECTED' });
    expect(h.tick).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
  });
  it.each(['request failed', 'timeout', 'ECONNRESET', 'order rejected'])('submission exception %s is UNCERTAIN', async message => {
    const h = await fixture(); h.post.mockRejectedValue(new Error(message));
    expect(await h.submit()).toMatchObject({ success: false, submissionState: 'UNCERTAIN', errorMsg: `Market order failed: ${message}` });
    expect(h.post).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, '', '   ', null])('success with unusable orderId %j remains uncertain', async orderID => {
    const h = await fixture({ success: true, orderID, tradeIDs: ['trade'], transactionsHashes: ['tx'] });
    expect(await h.submit()).toMatchObject({ success: true, submissionState: 'UNCERTAIN',
      tradeIds: ['trade'], transactionHashes: ['tx'] });
  });
  it.each(['timeout', 'rejected', 'accepted'])('errorMsg %s does not decide provenance', async errorMsg => {
    const h = await fixture({ success: true, orderID: 'order', errorMsg });
    expect(await h.submit()).toMatchObject({ success: true, submissionState: 'ACCEPTED', errorMsg });
    h.post.mockResolvedValue({ success: false, errorMsg });
    expect(await h.submit()).toMatchObject({ success: false, submissionState: 'REJECTED', errorMsg });
    h.post.mockResolvedValue({ errorMsg });
    expect(await h.submit()).toMatchObject({ success: false, submissionState: 'UNCERTAIN', errorMsg });
  });
  it.each([{ orderID: 'order' }, { transactionsHashes: ['tx'] }])('legacy success fallback remains true but uncertain: %j', async response => {
    const h = await fixture(response);
    expect(await h.submit()).toMatchObject({ success: true, submissionState: 'UNCERTAIN' });
  });
  it('explicit false still overrides legacy ID/hash success fallbacks', async () => {
    const h = await fixture({ success: false, orderID: 'order', tradeIDs: ['trade'], transactionsHashes: ['tx'] });
    expect(await h.submit()).toMatchObject({ success: false, submissionState: 'REJECTED',
      orderId: 'order', tradeIds: ['trade'], transactionHashes: ['tx'] });
  });
  it('preparation exception is conservative and does not submit', async () => {
    const h = await fixture(); h.tick.mockRejectedValue(new Error('metadata failed'));
    expect(await h.submit()).toMatchObject({ success: false, submissionState: 'UNCERTAIN' });
    expect(h.post).not.toHaveBeenCalled();
  });
  it('initialization exceptions retain rejected-Promise compatibility, not REJECTED results', async () => {
    const h = await fixture();
    vi.spyOn(h.service as any, 'ensureInitialized').mockRejectedValue(new Error('initialization failed'));
    await expect(h.submit()).rejects.toThrow('initialization failed');
    expect(h.post).not.toHaveBeenCalled();
  });
});
