import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { BigNumber, Wallet, providers, utils } from 'ethers';

const key = '0x' + '11'.repeat(32);
const condition = '0x' + '22'.repeat(32);
const address = '0x' + '33'.repeat(20);
const ids = { yesTokenId: '1', noTokenId: '2' };
const receipt = { status: 1, transactionHash: condition, gasUsed: BigNumber.from(21000), logs: [] };
let send: MockInstance<Wallet['sendTransaction']>;

beforeEach(() => {
  // No real RPC transport is reachable, including constructor network detection.
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
    if (data.startsWith(utils.id('payoutDenominator(bytes32)').slice(0, 10))) value = 1;
    if (data.startsWith(utils.id('payoutNumerators(bytes32,uint256)').slice(0, 10))) {
      value = BigNumber.from('0x' + data.slice(-64)).isZero() ? 1 : 0;
    }
    return utils.defaultAbiCoder.encode(['uint256'], [value]);
  });
  // Real Contract encoding and signer routing; only the lower send is mocked.
  send = vi.spyOn(Wallet.prototype, 'sendTransaction').mockResolvedValue({
    hash: condition, wait: async () => receipt,
  } as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup(mode: 'DRY' | 'LIVE' | 'HALT') {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', mode === 'DRY' ? 'true' : 'false');
  const { executionMode } = await import('../core/execution-mode.js');
  const { CTFClient } = await import('../clients/ctf-client.js');
  const { OnchainService } = await import('./onchain-service.js');
  const ctf = new CTFClient({ privateKey: key });
  const onchain = new OnchainService({ privateKey: key });
  if (mode === 'HALT') executionMode.halt();
  return { ctf, onchain, executionMode };
}

describe('on-chain economic routes with real contracts and offline transport', () => {
  it.each(['DRY', 'LIVE', 'HALT'] as const)('%s gates direct CTF and OnchainService writes', async mode => {
    const { ctf, onchain } = await setup(mode);
    const routes = [
      () => ctf.split(condition, '1', { negRisk: false }),
      () => ctf.merge(condition, '1', { negRisk: false }),
      () => ctf.mergeByTokenIds(condition, ids, '1', { negRisk: false }),
      () => ctf.redeem(condition, undefined, { negRisk: false }),
      () => ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: false }),
      () => onchain.split(condition, '1', { negRisk: false }),
      () => onchain.merge(condition, '1', { negRisk: false }),
      () => onchain.mergeByTokenIds(condition, ids, '1', { negRisk: false }),
      () => onchain.redeem(condition, undefined, { negRisk: false }),
      () => onchain.redeemByTokenIds(condition, ids, undefined, { negRisk: false }),
      () => onchain.swap('USDC', 'USDC_E', '1'),
      () => onchain.wrapMatic('1'),
      () => onchain.unwrapMatic('1'),
      () => onchain.transferUsdc(address, '1'),
      () => onchain.transferMatic(address, '1'),
    ];
    for (const route of routes) {
      send.mockClear();
      if (mode === 'LIVE') {
        expect((await route()).success).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
      } else {
        await expect(route()).rejects.toThrow(mode);
        expect(send).not.toHaveBeenCalled();
      }
    }
    for (const route of [() => onchain.approveUsdc(address), () => onchain.setErc1155Approval(address)]) {
      send.mockClear();
      const result = await route();
      expect(result.success).toBe(mode === 'LIVE');
      expect(send).toHaveBeenCalledTimes(mode === 'LIVE' ? 1 : 0);
      if (mode !== 'LIVE') expect(result.error).toContain(mode);
    }
  });

  it.each(['DRY', 'HALT'] as const)('%s preserves reads and guards raw wallet/provider getters', async mode => {
    const { ctf, onchain } = await setup(mode);
    expect(await ctf.getUsdcBalance()).toBe('100.0');
    expect(await onchain.getUsdcBalance()).toBe('100.0');
    expect(await onchain.getMaticBalance()).toBe('100.0');
    const wallet = onchain.getWallet();
    await expect(wallet.sendTransaction({ to: address, value: 1 })).rejects.toThrow(mode);
    await expect(wallet.signTransaction({ to: address, value: 1 })).rejects.toThrow(mode);
    const connected = wallet.connect(new providers.StaticJsonRpcProvider(undefined, 137));
    await expect(connected.sendTransaction({ to: address, value: 1 })).rejects.toThrow(mode);
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction']) {
      await expect(onchain.getProvider().send(method, ['0x00'])).rejects.toThrow(mode);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['DRY', 'LIVE', 'HALT'] as const)('%s guards standalone bridge transfer', async mode => {
    await setup(mode);
    const { BridgeClient, depositUsdc } = await import('../clients/bridge-client.js');
    vi.spyOn(BridgeClient.prototype, 'getEvmDepositAddress').mockResolvedValue(address);
    const wallet = new Wallet(key, new providers.StaticJsonRpcProvider(undefined, 137));
    const result = await depositUsdc(wallet, 5);
    expect(result.success).toBe(mode === 'LIVE');
    expect(send).toHaveBeenCalledTimes(mode === 'LIVE' ? 1 : 0);
    if (mode !== 'LIVE') expect(result.error).toContain(mode);
  });

  it('rechecks HALT at RPC submission after a write has already entered the signer', async () => {
    const { onchain, executionMode } = await setup('LIVE');
    const rpc = onchain.getProvider();
    send.mockImplementation(async () => {
      executionMode.halt();
      return rpc.send('eth_sendRawTransaction', ['0x00']);
    });
    await expect(onchain.getWallet().sendTransaction({ to: address, value: 1 })).rejects.toThrow('HALT');
    expect(send).toHaveBeenCalledTimes(1);
    expect(providers.JsonRpcProvider.prototype.send).not.toHaveBeenCalledWith('eth_sendRawTransaction', expect.anything());
  });
});
