import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';

// Real CTFClient and ethers encoding, with offline RPC and wallet transport.

const config = getContractConfig(137);
const standardAdapter = '0xADa100874d00e3331D00F2007a9c336a65009718';
const legacyCtf = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const key = '0x' + '11'.repeat(32);
const condition = '0x' + '33'.repeat(32);
const owner = new Wallet(key).address;
const ids = { yesTokenId: '9000000000000000001', noTokenId: '9000000000000000002' };

const erc20 = new utils.Interface([
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
]);
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
    if (call.name === 'payoutDenominator') return abi.encodeFunctionResult(call.name, [BigNumber.from(1)]);
    if (call.name === 'payoutNumerators') {
      const idx = (call.args[1] as BigNumber).toNumber();
      return abi.encodeFunctionResult(call.name, [BigNumber.from(idx === 0 ? 1 : 0)]);
    }
    if (call.name === 'balanceOf') {
      if (isCtf) {
        // CTFClient reads YES first, then NO (both redeem paths).
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

  const ctf = new CTFClient({ privateKey: key });

  if (mode === 'HALT') executionMode.halt();
  return { ctf };
}

const hash = '0x' + '22'.repeat(32);
const receipt = (transactionHash = hash, status = 1) => ({ status, transactionHash, gasUsed: BigNumber.from(21000), logs: [] });
const invoke = (ctf: Awaited<ReturnType<typeof setup>>['ctf'], observer?: (p: any) => void) =>
  ctf.mergeByTokenIds(condition, ids, '10', { negRisk: false }, observer);

describe('CTF merge factual provenance', () => {
  it('validation is NOT_SUBMITTED with frozen snapshot', async () => {
    const { ctf } = await setup('LIVE'); const observer = vi.fn();
    await expect(ctf.mergeByTokenIds(condition, ids, '10', undefined, observer)).rejects.toMatchObject({ name: 'MergeProvenanceError', provenance: { state: 'NOT_SUBMITTED' } });
    expect(send).not.toHaveBeenCalled(); expect(Object.isFrozen(observer.mock.calls[0][0])).toBe(true);
  });
  it('read failure preserves original cause and message', async () => {
    const { ctf } = await setup('LIVE'); const cause = new Error('RPC read failed');
    vi.mocked(providers.BaseProvider.prototype.call).mockRejectedValueOnce(cause);
    const error = await invoke(ctf).catch(e => e);
    expect(error).toMatchObject({ name: 'MergeProvenanceError', message: cause.message, provenance: { state: 'NOT_SUBMITTED' } });
    expect(error.cause).toBe(cause); expect(send).not.toHaveBeenCalled();
  });
  it('approval wait failure is not merge submission', async () => {
    const { ctf } = await setup('LIVE'); const cause = new Error('approval wait'); const observer = vi.fn();
    send.mockResolvedValueOnce({ hash, wait: async () => { throw cause; } });
    const error = await invoke(ctf, observer).catch(e => e);
    expect(error).toMatchObject({ message: cause.message, provenance: { state: 'NOT_SUBMITTED' } });
    expect(error.cause).toBe(cause);
    expect(send).toHaveBeenCalledTimes(1);
    expect(erc1155.parseTransaction({ data: String(await send.mock.calls[0][0].data) }).name).toBe('setApprovalForAll');
    expect(observer.mock.calls).toEqual([[{ state: 'NOT_SUBMITTED' }]]);
  });
  it('successful approval followed by preparation failure never emits SUBMITTED', async () => {
    const { ctf } = await setup('LIVE'); const cause = new Error('gas preparation'); const observer = vi.fn();
    send.mockImplementationOnce(async () => {
      vi.spyOn(ctf as any, 'getGasOptions').mockRejectedValue(cause);
      return { hash, wait: async () => receipt() };
    });
    await expect(invoke(ctf, observer)).rejects.toMatchObject({ cause, provenance: { state: 'NOT_SUBMITTED' } });
    expect(send).toHaveBeenCalledTimes(1); expect(observer.mock.calls).toEqual([[{ state: 'NOT_SUBMITTED' }]]);
  });
  it.each(['not submitted', 'rejected', 'WRITE_BLOCKED', 'network'])('submission error %s remains UNCERTAIN', async message => {
    const { ctf } = await setup('LIVE'); operatorApproved = true;
    const cause = Object.assign(new Error(message), { code: 'WRITE_BLOCKED' }); send.mockRejectedValueOnce(cause);
    const error = await invoke(ctf).catch(e => e);
    expect(error.cause).toBe(cause); expect(error.message).toBe(message);
    expect(error.provenance).toEqual({ state: 'UNCERTAIN' });
  });
  it('SUBMITTED is synchronous before wait and CONFIRMED preserves legacy fields', async () => {
    const { ctf } = await setup('LIVE'); operatorApproved = true; const observer = vi.fn();
    send.mockResolvedValueOnce({ hash, wait: async () => {
      expect(observer.mock.calls).toEqual([[{ state: 'SUBMITTED', transactionHash: hash }]]);
      return receipt();
    } });
    expect(await invoke(ctf, observer)).toMatchObject({ success: true, amount: '10.0', usdcReceived: '10.0', txHash: hash, gasUsed: '21000', provenance: { state: 'CONFIRMED', transactionHash: hash } });
    expect(observer.mock.calls.map(([p]) => p.state)).toEqual(['SUBMITTED', 'CONFIRMED']);
    expect(observer.mock.calls.every(([p]) => Object.isFrozen(p))).toBe(true);
  });
  it('wait failure preserves submitted identity and cause', async () => {
    const { ctf } = await setup('LIVE'); operatorApproved = true; const cause = new Error('wait'); const observer = vi.fn();
    send.mockResolvedValueOnce({ hash, wait: async () => { throw cause; } });
    const error = await invoke(ctf, observer).catch(e => e);
    expect(error.cause).toBe(cause); expect(error.message).toBe('wait');
    expect(error.provenance).toEqual({ state: 'UNCERTAIN', transactionHash: hash });
    expect(Object.isFrozen(error.provenance)).toBe(true);
    expect(observer.mock.calls.map(([p]) => p.state)).toEqual(['SUBMITTED', 'UNCERTAIN']);
  });
  it('hash mismatch cannot confirm and preserves A', async () => {
    const { ctf } = await setup('LIVE'); operatorApproved = true; const observer = vi.fn();
    const b = '0x' + '44'.repeat(32); send.mockResolvedValueOnce({ hash, wait: async () => receipt(b) });
    const error = await invoke(ctf, observer).catch(e => e);
    const { MergeProvenanceError } = await import('../clients/ctf-client.js');
    expect(error).toBeInstanceOf(MergeProvenanceError); expect(error.cause).toBeInstanceOf(Error);
    expect(error.provenance).toEqual({ state: 'UNCERTAIN', transactionHash: hash });
    expect(observer.mock.calls.map(([p]) => p.state)).toEqual(['SUBMITTED', 'UNCERTAIN']);
  });
  it.each([undefined, '', 'bad'])('receipt hash %s cannot confirm', async transactionHash => {
    const { ctf } = await setup('LIVE'); operatorApproved = true;
    send.mockResolvedValueOnce({ hash, wait: async () => ({ ...receipt(), transactionHash }) });
    await expect(invoke(ctf)).rejects.toMatchObject({ provenance: { state: 'UNCERTAIN', transactionHash: hash } });
  });
  it.each([0, undefined])('receipt status %s cannot confirm', async status => {
    const { ctf } = await setup('LIVE'); operatorApproved = true;
    send.mockResolvedValueOnce({ hash, wait: async () => ({ ...receipt(), status }) });
    await expect(invoke(ctf)).rejects.toMatchObject({ provenance: { state: 'UNCERTAIN', transactionHash: hash } });
  });
  it.each([undefined, '', 'bad'])('missing submitted identity %s remains uncertain even with successful receipt', async txHash => {
    const { ctf } = await setup('LIVE'); operatorApproved = true; const observer = vi.fn();
    send.mockResolvedValueOnce({ hash: txHash, wait: async () => receipt() });
    await expect(invoke(ctf, observer)).rejects.toMatchObject({ provenance: { state: 'UNCERTAIN' } });
    expect(observer.mock.calls).toEqual([[{ state: 'UNCERTAIN' }]]);
  });
  it('observer exceptions cannot interrupt lifecycle', async () => {
    const { ctf } = await setup('LIVE'); operatorApproved = true;
    expect(await invoke(ctf, () => { throw new Error('observer'); })).toMatchObject({ success: true, provenance: { state: 'CONFIRMED' } });
  });
  it('absent observer preserves success fields and approval then merge transport', async () => {
    const { ctf } = await setup('LIVE');
    expect(await invoke(ctf)).toMatchObject({ success: true, txHash: hash, amount: '10.0', usdcReceived: '10.0' });
    expect(send).toHaveBeenCalledTimes(2);
    const abi = new utils.Interface(['function mergePositions(address,bytes32,bytes32,uint256[],uint256)']);
    expect(abi.parseTransaction({ data: String(await send.mock.calls[1][0].data) }).name).toBe('mergePositions');
  });
  it('typed write barrier proves NOT_SUBMITTED', async () => {
    const { ctf } = await setup('DRY'); operatorApproved = true;
    await expect(invoke(ctf)).rejects.toMatchObject({ provenance: { state: 'NOT_SUBMITTED' } });
    expect(send).not.toHaveBeenCalled();
  });
});
