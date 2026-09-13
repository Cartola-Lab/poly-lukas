import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';

// P0.V2.3C2d: NEG-RISK redeemByTokenIds through the V2 NegRiskCtfCollateralAdapter.
// Fully offline: real ethers encoding with mocked RPC transport and mocked
// wallet send; any unexpected network call throws.

const config = getContractConfig(137);
const negRiskAdapter = '0xAdA200001000ef00D07553cEE7006808F895c6F1';
const standardAdapter = '0xADa100874d00e3331D00F2007a9c336a65009718';
const legacyCTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const legacyNegRiskAdapter = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const key = '0x' + '11'.repeat(32);
const condition = '0x' + '33'.repeat(32);
const owner = new Wallet(key).address;
const ids = { yesTokenId: '9000000000000000001', noTokenId: '9000000000000000002' };

const erc1155 = new utils.Interface([
  'function balanceOf(address,uint256) view returns(uint256)',
  'function isApprovedForAll(address,address) view returns(bool)',
  'function setApprovalForAll(address,bool)',
  'function payoutNumerators(bytes32,uint256) view returns(uint256)',
  'function payoutDenominator(bytes32) view returns(uint256)',
]);
const adapterAbi = new utils.Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
]);

const reads: Array<{ to: string; name: string; args: unknown[] }> = [];
const send = vi.fn();
let yesBalance = '12500000';
let noBalance = '250000';
let operatorApproved = false;
let ctfBalanceReadCount = 0;
let yesWins = true;

beforeEach(() => {
  reads.length = 0;
  yesBalance = '12500000';
  noBalance = '250000';
  operatorApproved = false;
  ctfBalanceReadCount = 0;
  yesWins = true;
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
    const isCTF = to.toLowerCase() === config.conditionalTokens.toLowerCase();
    if (!isCTF) throw new Error(`Unexpected eth_call: ${to}`);
    const call = erc1155.parseTransaction({ data });
    reads.push({ to, name: call.name, args: [...call.args] });
    if (call.name === 'payoutDenominator') return erc1155.encodeFunctionResult(call.name, [BigNumber.from(1)]);
    if (call.name === 'payoutNumerators') {
      const idx = (call.args[1] as BigNumber).toNumber();
      const value = yesWins ? BigNumber.from(idx === 0 ? 1 : 0) : BigNumber.from(idx === 0 ? 0 : 1);
      return erc1155.encodeFunctionResult(call.name, [value]);
    }
    if (call.name === 'balanceOf') {
      const value = ctfBalanceReadCount === 0 ? BigNumber.from(yesBalance) : BigNumber.from(noBalance);
      ctfBalanceReadCount += 1;
      return erc1155.encodeFunctionResult(call.name, [value]);
    }
    if (call.name === 'isApprovedForAll') return erc1155.encodeFunctionResult(call.name, [operatorApproved]);
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

const redeemSelector = utils.id('redeemPositions(address,bytes32,bytes32,uint256[])').slice(0, 10);

describe('V2.3C2d neg-risk redeemByTokenIds (offline)', () => {
  it('LIVE: targets the NegRiskCtfCollateralAdapter with exact redeem calldata', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    const result = await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const tx = send.mock.calls[0][0];
    expect(String(await tx.to).toLowerCase()).toBe(negRiskAdapter.toLowerCase());
    const data = String(await tx.data);
    expect(data.startsWith(redeemSelector)).toBe(true);
    const decoded = adapterAbi.parseTransaction({ data });
    expect(decoded.args).toHaveLength(4);
    expect(decoded.args[2]).toBe(condition);
    expect(decoded.args[3].map((n: BigNumber) => n.toNumber())).toEqual([1, 2]);
  });

  it('reads YES and NO balances against supplied CLOB token IDs', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    const balanceReads = reads.filter(r => r.name === 'balanceOf');
    expect(balanceReads).toHaveLength(2);
    expect(String(balanceReads[0].args[1])).toBe(ids.yesTokenId);
    expect(String(balanceReads[1].args[1])).toBe(ids.noTokenId);
  });

  it('reports full YES and NO balances consumed and winning-side pUSD received (YES winner)', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    const result = await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    expect(result.success).toBe(true);
    expect(result.yesTokensConsumed).toBe('12.5');
    expect(result.noTokensConsumed).toBe('0.25');
    expect(result.tokensRedeemed).toBe('12.5');
    expect(result.usdcReceived).toBe('12.5');
  });

  it('accounts correctly for a NO winner', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    yesWins = false;
    yesBalance = '250000';
    noBalance = '50000000';
    const result = await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    expect(result.tokensRedeemed).toBe('50.0');
    expect(result.outcome).toBe('NO');
  });

  it('does not broadcast when the winning balance is zero', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    yesBalance = '0';
    noBalance = '250000';
    await expect(ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true }))
      .rejects.toThrow(/No YES tokens to redeem/);
    expect(send).not.toHaveBeenCalled();
  });

  it('explicit outcome mismatch fails before any write', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    await expect(ctf.redeemByTokenIds(condition, ids, 'NO', { negRisk: true }))
      .rejects.toThrow(/Outcome mismatch/);
    expect(send).not.toHaveBeenCalled();
  });

  it('checks isApprovedForAll against the NegRisk adapter', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    const approvalReads = reads.filter(r => r.name === 'isApprovedForAll');
    expect(approvalReads).toHaveLength(1);
    expect(String(approvalReads[0].args[1]).toLowerCase()).toBe(negRiskAdapter.toLowerCase());
  });

  it('performs ERC1155 setApprovalForAll to the NegRisk adapter when not yet operator', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    expect(send).toHaveBeenCalledTimes(2);
    const approvalTx = send.mock.calls[0][0];
    expect(String(await approvalTx.to).toLowerCase()).toBe(config.conditionalTokens.toLowerCase());
    const decoded = erc1155.parseTransaction({ data: String(await approvalTx.data) });
    expect(decoded.name).toBe('setApprovalForAll');
    expect(decoded.args[0].toLowerCase()).toBe(negRiskAdapter.toLowerCase());
    expect(decoded.args[1]).toBe(true);
  });

  it('skips the approval write when the adapter is already an operator', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    expect(send).toHaveBeenCalledTimes(1);
    const to = String(await send.mock.calls[0][0].to).toLowerCase();
    expect(to).toBe(negRiskAdapter.toLowerCase());
  });

  it('never performs a pUSD ERC20 approval during neg-risk redeem', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    for (const [tx] of send.mock.calls) {
      const data = String(await tx.data);
      // pUSD approve selector
      expect(data.startsWith('0x095ea7b3')).toBe(false);
    }
    const pusd = config.collateral.toLowerCase();
    for (const [tx] of send.mock.calls) {
      expect(String(await tx.to).toLowerCase()).not.toBe(pusd);
    }
  });

  it('never sends EOA lifecycle writes to forbidden targets', async () => {
    const { ctf } = await setup('LIVE');
    await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true });
    const pusd = config.collateral.toLowerCase();
    for (const [tx] of send.mock.calls) {
      const to = String(await tx.to).toLowerCase();
      expect(to).not.toBe(standardAdapter.toLowerCase());
      expect(to).not.toBe(legacyNegRiskAdapter.toLowerCase());
      expect(to).not.toBe(pusd);
    }
    const redeemTx = send.mock.calls[send.mock.calls.length - 1][0];
    const redeemTo = String(await redeemTx.to).toLowerCase();
    expect(redeemTo).toBe(negRiskAdapter.toLowerCase());
    expect(redeemTo).not.toBe(legacyCTF.toLowerCase());
  });

  it('DRY blocks the neg-risk redeemByTokenIds broadcast', async () => {
    const { ctf } = await setup('DRY');
    await expect(ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true }))
      .rejects.toThrow('DRY');
    expect(send).not.toHaveBeenCalled();
  });

  it('HALT blocks the neg-risk redeemByTokenIds broadcast', async () => {
    const { ctf } = await setup('HALT');
    await expect(ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: true }))
      .rejects.toThrow('HALT');
    expect(send).not.toHaveBeenCalled();
  });

  it('standard redeemByTokenIds still targets the Standard Adapter', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    const result = await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: false });
    expect(result.success).toBe(true);
    expect(String(await send.mock.calls[0][0].to).toLowerCase()).toBe(standardAdapter.toLowerCase());
  });

  it('generic neg-risk redeem() remains fail-closed', async () => {
    const { ctf } = await setup('LIVE');
    await expect(ctf.redeem(condition, undefined, { negRisk: true }))
      .rejects.toThrow(/not implemented yet/);
    expect(send).not.toHaveBeenCalled();
  });

  it('neg-risk merge() remains fail-closed', async () => {
    const { ctf } = await setup('LIVE');
    await expect(ctf.merge(condition, '12.5', { negRisk: true }))
      .rejects.toThrow(/not implemented yet/);
    expect(send).not.toHaveBeenCalled();
  });

  it('unknown routing fails before any reads or writes', async () => {
    const { ctf } = await setup('LIVE');
    await expect(ctf.redeemByTokenIds(condition, ids, undefined, {} as any))
      .rejects.toThrow(/Cannot select a lifecycle collateral adapter/);
    expect(send).not.toHaveBeenCalled();
    expect(reads).toHaveLength(0);
  });
});