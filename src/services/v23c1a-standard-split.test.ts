import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';

// P0.V2.3C1a: STANDARD split migrated to the CtfCollateralAdapter with pUSD.
// Fully offline: real ethers encoding with mocked RPC transport and mocked
// wallet send; any unexpected network call throws.

const config = getContractConfig(137);
const standardAdapter = '0xADa100874d00e3331D00F2007a9c336a65009718';
const negRiskAdapter = '0xAdA200001000ef00D07553cEE7006808F895c6F1';
const key = '0x' + '11'.repeat(32);
const condition = '0x' + '33'.repeat(32);
const owner = new Wallet(key).address;

const erc20 = new utils.Interface([
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
]);

const adapterAbi = new utils.Interface([
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
]);

const reads: Array<{ to: string; name: string; args: unknown[] }> = [];
const send = vi.fn();
let pusdBalance = '12500000';
let pusdAllowance = '12500000';

beforeEach(() => {
  reads.length = 0;
  pusdBalance = '12500000';
  pusdAllowance = '12500000';
  vi.spyOn(providers.JsonRpcProvider.prototype, 'send').mockImplementation(async method => {
    if (method === 'eth_chainId') return '0x89';
    throw new Error(`Unexpected RPC in offline test: ${method}`);
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getFeeData').mockResolvedValue({
    gasPrice: BigNumber.from(100), lastBaseFeePerGas: BigNumber.from(100),
    maxFeePerGas: BigNumber.from(200), maxPriorityFeePerGas: BigNumber.from(30),
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getGasPrice').mockResolvedValue(BigNumber.from(100));
  vi.spyOn(providers.BaseProvider.prototype, 'getBalance').mockResolvedValue(utils.parseEther('1'));
  vi.spyOn(providers.BaseProvider.prototype, 'call').mockImplementation(async tx => {
    const to = String(await tx.to);
    const data = String(await tx.data);
    const call = erc20.parseTransaction({ data });
    reads.push({ to, name: call.name, args: [...call.args] });
    if (call.name === 'balanceOf') return erc20.encodeFunctionResult(call.name, [BigNumber.from(pusdBalance)]);
    if (call.name === 'allowance') return erc20.encodeFunctionResult(call.name, [BigNumber.from(pusdAllowance)]);
    throw new Error(`Unexpected read: ${call.name}`);
  });
  send.mockReset().mockResolvedValue({
    hash: '0x' + '22'.repeat(32),
    wait: async () => ({ status: 1, transactionHash: '0x' + '22'.repeat(32), gasUsed: BigNumber.from(21000), logs: [] }),
  });
  vi.spyOn(Wallet.prototype, 'sendTransaction').mockImplementation(send);
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
  return { ctf, onchain };
}

const splitSelector = utils.id('splitPosition(address,bytes32,bytes32,uint256[],uint256)').slice(0, 10);
const legacyCtf = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const usdce = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

describe('V2.3C1a standard split through CtfCollateralAdapter (offline)', () => {
  it('LIVE splits standard market through the Standard Adapter with exact calldata', async () => {
    const { ctf } = await setup('LIVE');
    const result = await ctf.split(condition, '12.5', { negRisk: false });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const tx = send.mock.calls[0][0];
    expect(String(await tx.to).toLowerCase()).toBe(standardAdapter.toLowerCase());
    const data = String(await tx.data);
    expect(data.startsWith(splitSelector)).toBe(true);
    const decoded = adapterAbi.parseTransaction({ data });
    const args = [...decoded.args];
    expect(args[0].toLowerCase()).toBe(usdce.toLowerCase());
    expect(args[1]).toBe(utils.hexZeroPad('0x', 32));
    expect(args[2]).toBe(condition);
    expect(args[3].map((n: BigNumber) => n.toNumber())).toEqual([1, 2]);
    expect(args[4].toString()).toBe('12500000');
    expect(reads.some(r => r.name === 'balanceOf' && String(r.to).toLowerCase() === config.collateral.toLowerCase())).toBe(true);
  });

  it('reads the pUSD allowance against the Standard Adapter before splitting', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.split(condition, '12.5', { negRisk: false });
    const allowanceRead = reads.find(r => r.name === 'allowance');
    expect(allowanceRead).toBeDefined();
    expect(String(allowanceRead!.args[0]).toLowerCase()).toBe(owner.toLowerCase());
    expect(String(allowanceRead!.args[1]).toLowerCase()).toBe(standardAdapter.toLowerCase());
  });

  it('uses raw 6-decimal amount exactly once (12.5 -> 12500000, no double scaling)', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.split(condition, '12.5', { negRisk: false });
    const tx = send.mock.calls[0][0];
    const decoded = adapterAbi.parseTransaction({ data: String(await tx.data) });
    expect(decoded.args[4].toString()).toBe('12500000');
  });

  it('performs a pUSD->adapter approval only when the allowance is insufficient', async () => {
    const { ctf } = await setup('LIVE');
    pusdAllowance = '0';
    const result = await ctf.split(condition, '12.5', { negRisk: false });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    const approveTx = send.mock.calls[0][0];
    expect(String(await approveTx.to).toLowerCase()).toBe(config.collateral.toLowerCase());
    const approveData = String(await approveTx.data);
    expect(approveData.startsWith(utils.id('approve(address,uint256)').slice(0, 10))).toBe(true);
    const decoded = erc20.parseTransaction({ data: approveData });
    expect(String(decoded.args[0]).toLowerCase()).toBe(standardAdapter.toLowerCase());
    expect(decoded.args[1].eq(BigNumber.from(2).pow(256).sub(1))).toBe(true);
    const splitTx = send.mock.calls[1][0];
    expect(String(await splitTx.to).toLowerCase()).toBe(standardAdapter.toLowerCase());
  });

  it('skips the approval write when the allowance already suffices', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.split(condition, '12.5', { negRisk: false });
    expect(send).toHaveBeenCalledTimes(1);
    const data = String(await send.mock.calls[0][0].data);
    expect(data.startsWith(splitSelector)).toBe(true);
  });

  it('never sends EOA calldata to legacy CTF or USDC.e during standard split', async () => {
    const { ctf } = await setup('LIVE');
    pusdAllowance = '0';
    await ctf.split(condition, '12.5', { negRisk: false });
    for (const [tx] of send.mock.calls) {
      const to = String(await tx.to).toLowerCase();
      expect(to).not.toBe(legacyCtf.toLowerCase());
      expect(to).not.toBe(usdce.toLowerCase());
    }
    // The split call itself must target the Standard Adapter; the optional
    // approval targets pUSD. Neither may touch legacy CTF or USDC.e.
    const splitTx = send.mock.calls[send.mock.calls.length - 1][0];
    expect(String(await splitTx.to).toLowerCase()).toBe(standardAdapter.toLowerCase());
  });

  it('NEG-RISK fails closed without any broadcast', async () => {
    const { ctf } = await setup('LIVE');
    await expect(ctf.split(condition, '12.5', { negRisk: true })).rejects.toThrow(/not implemented yet/);
    expect(send).not.toHaveBeenCalled();
    expect(reads.some(r => r.name === 'balanceOf')).toBe(false);
    expect(reads.some(r => r.name === 'allowance')).toBe(false);
  });

  it('UNKNOWN routing fails closed without any broadcast', async () => {
    const { ctf } = await setup('LIVE');
    await expect(ctf.split(condition, '12.5')).rejects.toThrow(/routing is unknown/);
    expect(send).not.toHaveBeenCalled();
    expect(reads.some(r => r.name === 'balanceOf')).toBe(false);
    expect(reads.some(r => r.name === 'allowance')).toBe(false);
  });

  it('non-boolean negRisk fails closed without any broadcast', async () => {
    const { ctf } = await setup('LIVE');
    await expect(ctf.split(condition, '12.5', { negRisk: 'yes' as unknown as boolean })).rejects.toThrow(/routing is unknown/);
    expect(send).not.toHaveBeenCalled();
  });

  it('DRY blocks the adapter split broadcast', async () => {
    const { ctf } = await setup('DRY');
    await expect(ctf.split(condition, '12.5', { negRisk: false })).rejects.toThrow('DRY');
    expect(send).not.toHaveBeenCalled();
  });

  it('HALT blocks the adapter split broadcast', async () => {
    const { ctf } = await setup('HALT');
    await expect(ctf.split(condition, '12.5', { negRisk: false })).rejects.toThrow('HALT');
    expect(send).not.toHaveBeenCalled();
  });

  it('OnchainService standard split routes to the same adapter path', async () => {
    const { onchain } = await setup('LIVE');
    const result = await onchain.split(condition, '12.5', { negRisk: false });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(await send.mock.calls[0][0].to).toLowerCase()).toBe(standardAdapter.toLowerCase());
  });
});
