import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';

// P0.V2.3C2b: NEG-RISK split through the V2 NegRiskCtfCollateralAdapter.
// Fully offline: real ethers encoding with mocked RPC transport and mocked
// wallet send; any unexpected network call throws.

const config = getContractConfig(137);
const negRiskAdapter = '0xAdA200001000ef00D07553cEE7006808F895c6F1';
const standardAdapter = '0xADa100874d00e3331D00F2007a9c336a65009718';
const legacyCT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const usdce = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
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
  const ctf = new CTFClient({ privateKey: key });
  if (mode === 'HALT') executionMode.halt();
  return { ctf };
}

const splitSelector = utils.id('splitPosition(address,bytes32,bytes32,uint256[],uint256)').slice(0, 10);

describe('V2.3C2b neg-risk split through NegRiskCtfCollateralAdapter (offline)', () => {
  it('LIVE neg-risk split targets the NegRisk Adapter with exact calldata', async () => {
    const { ctf } = await setup('LIVE');
    const result = await ctf.split(condition, '12.5', { negRisk: true });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const tx = send.mock.calls[0][0];
    expect(String(await tx.to).toLowerCase()).toBe(negRiskAdapter.toLowerCase());
    const data = String(await tx.data);
    expect(data.startsWith(splitSelector)).toBe(true);
    const decoded = adapterAbi.parseTransaction({ data });
    expect(decoded.args[2]).toBe(condition);
    expect(decoded.args[3].map((n: BigNumber) => n.toNumber())).toEqual([1, 2]);
    expect(decoded.args[4].toString()).toBe('12500000');
  });

  it('reads pUSD balance from the Collateral Token contract', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.split(condition, '12.5', { negRisk: true });
    const balanceRead = reads.find(r => r.name === 'balanceOf');
    expect(balanceRead).toBeDefined();
    expect(String(balanceRead!.to).toLowerCase()).toBe(config.collateral.toLowerCase());
  });

  it('reads and enforces pUSD allowance against the NegRisk Adapter', async () => {
    const { ctf } = await setup('LIVE');
    pusdAllowance = '0';
    const result = await ctf.split(condition, '12.5', { negRisk: true });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    const allowanceRead = reads.find(r => r.name === 'allowance');
    expect(allowanceRead).toBeDefined();
    expect(String(allowanceRead!.args[1]).toLowerCase()).toBe(negRiskAdapter.toLowerCase());
    const approveTx = send.mock.calls[0][0];
    expect(String(await approveTx.to).toLowerCase()).toBe(config.collateral.toLowerCase());
    const approveCall = erc20.parseTransaction({ data: String(await approveTx.data) });
    expect(approveCall.name).toBe('approve');
    expect(String(approveCall.args[0]).toLowerCase()).toBe(negRiskAdapter.toLowerCase());
    const splitTx = send.mock.calls[1][0];
    expect(String(await splitTx.to).toLowerCase()).toBe(negRiskAdapter.toLowerCase());
  });

  it('skips approval write when allowance already suffices', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.split(condition, '12.5', { negRisk: true });
    expect(send).toHaveBeenCalledTimes(1);
    const data = String(await send.mock.calls[0][0].data);
    expect(data.startsWith(splitSelector)).toBe(true);
  });

  it('neg-risk split amount uses single 6-decimal conversion (12.5 -> 12500000)', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.split(condition, '12.5', { negRisk: true });
    const tx = send.mock.calls[0][0];
    const decoded = adapterAbi.parseTransaction({ data: String(await tx.data) });
    expect(decoded.args[4].toString()).toBe('12500000');
  });

  it('STANDARD split still targets the Standard Adapter (regression)', async () => {
    const { ctf } = await setup('LIVE');
    const result = await ctf.split(condition, '12.5', { negRisk: false });
    expect(result.success).toBe(true);
    expect(String(await send.mock.calls[0][0].to).toLowerCase()).toBe(standardAdapter.toLowerCase());
  });

  it('never sends EOA calldata to legacy contracts or the wrong adapter', async () => {
    const { ctf } = await setup('LIVE');
    pusdAllowance = '0';
    await ctf.split(condition, '12.5', { negRisk: true });
    for (const [tx] of send.mock.calls) {
      const to = String(await tx.to).toLowerCase();
      expect(to).not.toBe(legacyCT.toLowerCase());
      expect(to).not.toBe(usdce.toLowerCase());
      expect(to).not.toBe(standardAdapter.toLowerCase());
    }
    const splitTx = send.mock.calls[send.mock.calls.length - 1][0];
    expect(String(await splitTx.to).toLowerCase()).toBe(negRiskAdapter.toLowerCase());
  });

  it('does not need questionId, marketId, or wcol to execute the split', async () => {
    const { ctf } = await setup('LIVE');
    // The only required inputs are conditionId + amount + routing.negRisk.
    const result = await ctf.split(condition, '1', { negRisk: true });
    expect(result.success).toBe(true);
    // No additional contract reads to the legacy NegRiskAdapter were made.
    for (const read of reads) {
      expect(read.to.toLowerCase()).toBe(config.collateral.toLowerCase());
    }
  });

  it('DRY blocks the neg-risk adapter split broadcast', async () => {
    const { ctf } = await setup('DRY');
    await expect(ctf.split(condition, '12.5', { negRisk: true })).rejects.toThrow('DRY');
    expect(send).not.toHaveBeenCalled();
  });

  it('HALT blocks the neg-risk adapter split broadcast', async () => {
    const { ctf } = await setup('HALT');
    await expect(ctf.split(condition, '12.5', { negRisk: true })).rejects.toThrow('HALT');
    expect(send).not.toHaveBeenCalled();
  });
});