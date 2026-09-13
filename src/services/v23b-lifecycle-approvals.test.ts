import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import { getContractConfig, COLLATERAL_TOKEN_DECIMALS } from '@polymarket/clob-client-v2';
import { CTF_COLLATERAL_ADAPTER, NEG_RISK_CTF_COLLATERAL_ADAPTER } from './authorization-service.js';

// P0.V2.3B: lifecycle collateral adapter approvals (pUSD ERC20 + ERC1155
// operator) selected by V2.3A routing. Strictly separate from V2.2 CLOB
// trading approvals. Fully offline: real ethers encoding with mocked RPC
// transport; no network traffic is possible.

const config = getContractConfig(137);
const standardAdapter = '0xADa100874d00e3331D00F2007a9c336a65009718';
const negRiskAdapter = '0xAdA200001000ef00D07553cEE7006808F895c6F1';
const exchangeV1 = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const negRiskExchangeV1 = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const key = '0x' + '11'.repeat(32);
const owner = new Wallet(key).address;

const erc20 = new utils.Interface([
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
]);
const erc1155 = new utils.Interface([
  'function isApprovedForAll(address,address) view returns(bool)',
  'function setApprovalForAll(address,bool)',
]);

const reads: Array<{ to: string; name: string; args: unknown[] }> = [];
const send = vi.fn();
let erc20Allowance = '0';
let operatorApproved = false;

beforeEach(() => {
  reads.length = 0;
  erc20Allowance = '0';
  operatorApproved = false;
  vi.spyOn(providers.JsonRpcProvider.prototype, 'send').mockImplementation(async method => {
    if (method === 'eth_chainId') return '0x89';
    throw new Error(`Unexpected RPC: ${method}`);
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getGasPrice').mockResolvedValue(BigNumber.from(100));
  vi.spyOn(providers.BaseProvider.prototype, 'getBalance').mockResolvedValue(utils.parseEther('1'));
  vi.spyOn(providers.BaseProvider.prototype, 'call').mockImplementation(async tx => {
    const to = String(await tx.to);
    const data = String(await tx.data);
    const abi = to.toLowerCase() === config.conditionalTokens.toLowerCase() ? erc1155 : erc20;
    const call = abi.parseTransaction({ data });
    reads.push({ to, name: call.name, args: [...call.args] });
    if (call.name === 'allowance') return abi.encodeFunctionResult(call.name, [BigNumber.from(erc20Allowance)]);
    if (call.name === 'isApprovedForAll') return abi.encodeFunctionResult(call.name, [operatorApproved]);
    if (call.name === 'balanceOf') return abi.encodeFunctionResult(call.name, [utils.parseUnits('100', COLLATERAL_TOKEN_DECIMALS)]);
    throw new Error(`Unexpected read: ${call.name}`);
  });
  send.mockReset().mockResolvedValue({ hash: '0x' + '22'.repeat(32), wait: async () => ({ status: 1, logs: [] }) });
  vi.spyOn(Wallet.prototype, 'sendTransaction').mockImplementation(send);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup(mode: 'DRY' | 'LIVE' | 'HALT') {
  vi.resetModules();
  vi.stubEnv('DRY_RUN', mode === 'DRY' ? 'true' : 'false');
  const { executionMode } = await import('../core/execution-mode.js');
  const { OnchainService } = await import('./onchain-service.js');
  const { AuthorizationService, CTF_COLLATERAL_ADAPTER, NEG_RISK_CTF_COLLATERAL_ADAPTER } = await import('./authorization-service.js');
  const onchain = new OnchainService({ privateKey: key });
  const auth = onchain.getAuthorizationService();
  expect(auth).toBeInstanceOf(AuthorizationService);
  if (mode === 'HALT') executionMode.halt();
  return { onchain, auth, executionMode };
}

async function decodedSends() {
  const decoded = [];
  for (const [tx] of send.mock.calls) {
    const to = String(await tx.to);
    const data = String(await tx.data);
    const abi = to.toLowerCase() === config.conditionalTokens.toLowerCase() ? erc1155 : erc20;
    const call = abi.parseTransaction({ data });
    decoded.push({ to, name: call.name, args: [...call.args] });
  }
  return decoded;
}

const forbiddenTargets = [config.exchangeV2, config.negRiskExchangeV2, exchangeV1, negRiskExchangeV1];

describe('V2.3B lifecycle collateral adapter approvals (offline)', () => {
  it('pins the verified V2.3B adapter addresses', () => {
    expect(CTF_COLLATERAL_ADAPTER).toBe(standardAdapter);
    expect(NEG_RISK_CTF_COLLATERAL_ADAPTER).toBe(negRiskAdapter);
    expect(config.collateral).toBe('0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB');
    expect(COLLATERAL_TOKEN_DECIMALS).toBe(6);
  });

  it.each([
    { negRisk: false, adapter: standardAdapter },
    { negRisk: true, adapter: negRiskAdapter },
  ])('check reads allowance and operator status against the correct adapter (negRisk=$negRisk)', async ({ negRisk, adapter }) => {
    const { onchain } = await setup('DRY');
    const status = await onchain.checkLifecycleAdapterApprovals({ negRisk }, '12.5');
    expect(status.adapter).toBe(adapter);
    expect(status.ready).toBe(false);
    expect(status.pusdAllowance.approved).toBe(false);
    expect(status.erc1155Approval.approved).toBe(false);
    const allowanceReads = reads.filter(r => r.name === 'allowance');
    expect(allowanceReads).toHaveLength(1);
    expect(String(allowanceReads[0].args[0]).toLowerCase()).toBe(owner.toLowerCase());
    expect(String(allowanceReads[0].args[1]).toLowerCase()).toBe(adapter.toLowerCase());
    expect(reads.some(r => r.name === 'isApprovedForAll' && String(r.args[1]).toLowerCase() === adapter.toLowerCase())).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('check reports ready when both approvals already suffice', async () => {
    const { onchain } = await setup('DRY');
    erc20Allowance = '12500000';
    operatorApproved = true;
    const status = await onchain.checkLifecycleAdapterApprovals({ negRisk: false }, '12.5');
    expect(status.ready).toBe(true);
    expect(status.issues).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed on unknown routing: no adapter selected, zero broadcasts', async () => {
    const { onchain } = await setup('LIVE');
    await expect(onchain.checkLifecycleAdapterApprovals(undefined)).rejects.toThrow('negRisk routing is unknown');
    await expect(onchain.approveLifecycleAdapter(undefined)).rejects.toThrow('negRisk routing is unknown');
    expect(send).not.toHaveBeenCalled();
    expect(reads.some(r => r.name === 'allowance')).toBe(false);
    expect(reads.some(r => r.name === 'isApprovedForAll')).toBe(false);
  });

  it.each(['DRY', 'HALT'] as const)('%s blocks lifecycle adapter approval broadcasts', async mode => {
    const { onchain } = await setup(mode);
    for (const negRisk of [false, true]) {
      send.mockClear();
      const result = await onchain.approveLifecycleAdapter({ negRisk });
      expect(result.allApproved, JSON.stringify(result)).toBe(false);
      expect(result.erc20Approval.error).toContain(mode);
      expect(result.erc1155Approval.error).toContain(mode);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it.each([
    { negRisk: false, adapter: standardAdapter },
    { negRisk: true, adapter: negRiskAdapter },
  ])('LIVE approves pUSD and ERC1155 only for the selected adapter (negRisk=$negRisk)', async ({ negRisk, adapter }) => {
    const { onchain } = await setup('LIVE');
    const result = await onchain.approveLifecycleAdapter({ negRisk });
    expect(result.allApproved, JSON.stringify(result)).toBe(true);
    expect(result.adapter).toBe(adapter);
    expect(send).toHaveBeenCalledTimes(2);
    const txs = await decodedSends();
    const approve = txs.find(t => t.name === 'approve')!;
    const setOp = txs.find(t => t.name === 'setApprovalForAll')!;
    expect(approve.to.toLowerCase()).toBe(config.collateral.toLowerCase());
    expect(String(approve.args[0]).toLowerCase()).toBe(adapter.toLowerCase());
    expect(approve.args[1].eq(BigNumber.from(2).pow(256).sub(1))).toBe(true);
    expect(setOp.to.toLowerCase()).toBe(config.conditionalTokens.toLowerCase());
    expect(String(setOp.args[0]).toLowerCase()).toBe(adapter.toLowerCase());
    expect(setOp.args[1]).toBe(true);
    for (const t of txs) {
      for (const forbidden of forbiddenTargets) {
        expect(t.to.toLowerCase()).not.toBe(forbidden.toLowerCase());
        for (const arg of t.args) {
          if (typeof arg === 'string') expect(arg.toLowerCase()).not.toBe(forbidden.toLowerCase());
        }
      }
    }
  });

  it('skips writes when approvals already exist (no unnecessary broadcast)', async () => {
    const { onchain } = await setup('LIVE');
    erc20Allowance = BigNumber.from(2).pow(256).sub(1).toString();
    operatorApproved = true;
    const result = await onchain.approveLifecycleAdapter({ negRisk: true });
    expect(result.allApproved).toBe(true);
    expect(result.erc20Approval.txHash).toBeUndefined();
    expect(result.erc1155Approval.txHash).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps V2.2 trading approval scope separate: approvePusd rejects adapters', async () => {
    const { onchain } = await setup('LIVE');
    for (const adapter of [standardAdapter, negRiskAdapter]) {
      await expect(onchain.approvePusd(adapter)).rejects.toThrow('Not a CLOB V2 spender');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects arbitrary lifecycle spender input via routing-only API', async () => {
    const { onchain } = await setup('LIVE');
    await expect(onchain.approveLifecycleAdapter({ negRisk: 'yes' as unknown as boolean })).rejects.toThrow('negRisk routing is unknown');
    expect(send).not.toHaveBeenCalled();
  });
});
