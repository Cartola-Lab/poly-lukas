import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';

// P0.V2.3C1b: STANDARD merge migrated to the CtfCollateralAdapter.
// Fully offline: real ethers encoding with mocked RPC transport and mocked
// wallet send; any unexpected network call throws.

const config = getContractConfig(137);
const standardAdapter = '0xADa100874d00e3331D00F2007a9c336a65009718';
const legacyCtf = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const key = '0x' + '11'.repeat(32);
const condition = '0x' + '33'.repeat(32);
const owner = new Wallet(key).address;
// Real CLOB token IDs are uint256 values; these stand-ins must be valid numerics.
const ids = { yesTokenId: '9000000000000000001', noTokenId: '9000000000000000002' };

const usdce = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** Legacy standard position ID derivation (USDC.e collateral). */
function expectedPositionId(conditionId: string, indexSet: number): string {
  const collectionId = utils.keccak256(
    utils.solidityPack(['bytes32', 'bytes32', 'uint256'], [utils.hexZeroPad('0x', 32), conditionId, indexSet])
  );
  return utils.keccak256(utils.solidityPack(['address', 'bytes32'], [usdce, collectionId]));
}

const erc20 = new utils.Interface([
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
]);
const erc1155 = new utils.Interface([
  'function balanceOf(address,uint256) view returns(uint256)',
  'function isApprovedForAll(address,address) view returns(bool)',
  'function setApprovalForAll(address,bool)',
]);
const adapterAbi = new utils.Interface([
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
]);

const reads: Array<{ to: string; name: string; args: unknown[] }> = [];
const send = vi.fn();
let yesBalance = '12500000';
let noBalance = '12500000';
let operatorApproved = false;
let ctfBalanceReadCount = 0;

beforeEach(() => {
  reads.length = 0;
  yesBalance = '12500000';
  noBalance = '12500000';
  operatorApproved = false;
  ctfBalanceReadCount = 0;
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
    const isCtf = to.toLowerCase() === config.conditionalTokens.toLowerCase();
    const abi = isCtf ? erc1155 : erc20;
    const call = abi.parseTransaction({ data });
    reads.push({ to, name: call.name, args: [...call.args] });
    if (call.name === 'balanceOf') {
      if (isCtf) {
        // CTFClient always reads YES first, then NO (both merge paths).
        const value = ctfBalanceReadCount === 0 ? BigNumber.from(yesBalance) : BigNumber.from(noBalance);
        ctfBalanceReadCount += 1;
        return abi.encodeFunctionResult(call.name, [value]);
      }
      return abi.encodeFunctionResult(call.name, [BigNumber.from('12500000')]);
    }
    if (call.name === 'isApprovedForAll') return abi.encodeFunctionResult(call.name, [operatorApproved]);
    if (call.name === 'allowance') return abi.encodeFunctionResult(call.name, [BigNumber.from(0)]);
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

async function decodeSends() {
  const decoded = [];
  for (const [tx] of send.mock.calls) {
    const to = String(await tx.to);
    const data = String(await tx.data);
    const isCtf = to.toLowerCase() === config.conditionalTokens.toLowerCase();
    const abi = isCtf ? erc1155 : adapterAbi;
    const call = abi.parseTransaction({ data });
    decoded.push({ to, name: call.name, args: [...call.args] });
  }
  return decoded;
}

const mergeSelector = utils.id('mergePositions(address,bytes32,bytes32,uint256[],uint256)').slice(0, 10);

describe('V2.3C1b standard merge through CtfCollateralAdapter (offline)', () => {
  it('LIVE merge goes through the Standard Adapter with exact calldata', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    const result = await ctf.merge(condition, '12.5', { negRisk: false });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const tx = send.mock.calls[0][0];
    expect(String(await tx.to).toLowerCase()).toBe(standardAdapter.toLowerCase());
    const data = String(await tx.data);
    expect(data.startsWith(mergeSelector)).toBe(true);
    const decoded = adapterAbi.parseTransaction({ data });
    expect(decoded.args[2]).toBe(condition);
    expect(decoded.args[3].map((n: BigNumber) => n.toNumber())).toEqual([1, 2]);
    expect(decoded.args[4].toString()).toBe('12500000');
  });

  it('merge validates balances using calculated standard position IDs (USDC.e-derived)', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    await ctf.merge(condition, '12.5', { negRisk: false });
    const balanceReads = reads.filter(r => r.name === 'balanceOf' && r.to.toLowerCase() === config.conditionalTokens.toLowerCase());
    expect(balanceReads.length).toBeGreaterThanOrEqual(2);
    const expectedYes = BigNumber.from(expectedPositionId(condition, 1));
    const expectedNo = BigNumber.from(expectedPositionId(condition, 2));
    const readIds = balanceReads.map(r => (r.args[1] as BigNumber).toHexString());
    expect(readIds).toContain(expectedYes.toHexString());
    expect(readIds).toContain(expectedNo.toHexString());
    for (const read of balanceReads) {
      expect(String(read.args[0]).toLowerCase()).toBe(owner.toLowerCase());
    }
  });

  it('mergeByTokenIds validates balances using the supplied CLOB token IDs', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    await ctf.mergeByTokenIds(condition, ids, '12.5', { negRisk: false });
    const balanceReads = reads.filter(r => r.name === 'balanceOf' && r.to.toLowerCase() === config.conditionalTokens.toLowerCase());
    expect(balanceReads.length).toBeGreaterThanOrEqual(2);
    const tokenIdsRead = balanceReads.map(r => (r.args[1] as BigNumber).toString());
    expect(tokenIdsRead).toContain(ids.yesTokenId);
    expect(tokenIdsRead).toContain(ids.noTokenId);
    const tx = send.mock.calls[0][0];
    expect(String(await tx.to).toLowerCase()).toBe(standardAdapter.toLowerCase());
  });

  it('performs ERC1155 setApprovalForAll to the Standard Adapter when not yet operator', async () => {
    const { ctf } = await setup('LIVE');
    const result = await ctf.merge(condition, '12.5', { negRisk: false });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    const txs = await decodeSends();
    const approval = txs.find(t => t.name === 'setApprovalForAll')!;
    const merge = txs.find(t => t.name === 'mergePositions')!;
    expect(approval.to.toLowerCase()).toBe(config.conditionalTokens.toLowerCase());
    expect(String(approval.args[0]).toLowerCase()).toBe(standardAdapter.toLowerCase());
    expect(approval.args[1]).toBe(true);
    expect(merge.to.toLowerCase()).toBe(standardAdapter.toLowerCase());
  });

  it('skips the approval write when the adapter is already an operator', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    await ctf.merge(condition, '12.5', { negRisk: false });
    expect(send).toHaveBeenCalledTimes(1);
    const data = String(await send.mock.calls[0][0].data);
    expect(data.startsWith(mergeSelector)).toBe(true);
  });

  it('never performs a pUSD ERC20 approval during merge', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.merge(condition, '12.5', { negRisk: false });
    const txs = await decodeSends();
    expect(txs.some(t => t.name === 'approve')).toBe(false);
    const erc20Targets = txs.filter(t => t.to.toLowerCase() === config.collateral.toLowerCase());
    expect(erc20Targets).toHaveLength(0);
  });

  it('fails before any transaction when YES balance is insufficient', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    yesBalance = '12499999';
    await expect(ctf.merge(condition, '12.5', { negRisk: false })).rejects.toThrow(/Insufficient token balance/);
    expect(send).not.toHaveBeenCalled();
  });

  it('fails before any transaction when NO balance is insufficient', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    noBalance = '12499999';
    await expect(ctf.mergeByTokenIds(condition, ids, '12.5', { negRisk: false })).rejects.toThrow(/Insufficient token balance/);
    expect(send).not.toHaveBeenCalled();
  });

  it('neg-risk generic merge() remains fail-closed; mergeByTokenIds routes to NegRisk adapter', async () => {
    const { ctf } = await setup('LIVE');
    // Generic merge() for neg-risk is still blocked.
    await expect(ctf.merge(condition, '12.5', { negRisk: true })).rejects.toThrow(/not implemented yet/);
    expect(send).not.toHaveBeenCalled();
    expect(reads).toHaveLength(0);
    // mergeByTokenIds with neg-risk now routes to the NegRiskCtfCollateralAdapter.
    operatorApproved = true;
    const result = await ctf.mergeByTokenIds(condition, ids, '12.5', { negRisk: true });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const to = String(await send.mock.calls[0][0].to).toLowerCase();
    expect(to).toBe('0xAdA200001000ef00D07553cEE7006808F895c6F1'.toLowerCase());
  });

  it('UNKNOWN routing fails closed without any broadcast or read', async () => {
    const { ctf } = await setup('LIVE');
    await expect(ctf.merge(condition, '12.5')).rejects.toThrow(/routing is unknown/);
    await expect(ctf.mergeByTokenIds(condition, ids, '12.5', undefined)).rejects.toThrow(/routing is unknown/);
    expect(send).not.toHaveBeenCalled();
    expect(reads).toHaveLength(0);
  });

  it('non-boolean negRisk fails closed without any broadcast', async () => {
    const { ctf } = await setup('LIVE');
    await expect(ctf.merge(condition, '12.5', { negRisk: 'yes' as unknown as boolean })).rejects.toThrow(/routing is unknown/);
    expect(send).not.toHaveBeenCalled();
  });

  it('DRY blocks the adapter merge broadcast', async () => {
    const { ctf } = await setup('DRY');
    await expect(ctf.merge(condition, '12.5', { negRisk: false })).rejects.toThrow('DRY');
    expect(send).not.toHaveBeenCalled();
  });

  it('HALT blocks the adapter merge broadcast', async () => {
    const { ctf } = await setup('HALT');
    await expect(ctf.merge(condition, '12.5', { negRisk: false })).rejects.toThrow('HALT');
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends direct legacy CTF mergePositions from the EOA', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.merge(condition, '12.5', { negRisk: false });
    const txs = await decodeSends();
    for (const tx of txs) {
      if (tx.name === 'mergePositions') {
        expect(tx.to.toLowerCase()).toBe(standardAdapter.toLowerCase());
        expect(tx.to.toLowerCase()).not.toBe(legacyCtf.toLowerCase());
      }
    }
    expect(txs.some(t => t.to.toLowerCase() === legacyCtf.toLowerCase() && t.name === 'mergePositions')).toBe(false);
  });

  it('OnchainService standard merge routes to the adapter path', async () => {
    const { onchain } = await setup('LIVE');
    operatorApproved = true;
    const result = await onchain.merge(condition, '12.5', { negRisk: false });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(await send.mock.calls[0][0].to).toLowerCase()).toBe(standardAdapter.toLowerCase());
  });
});
