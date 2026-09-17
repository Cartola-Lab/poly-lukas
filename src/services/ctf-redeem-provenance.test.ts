import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';

// P0.V2.3C1c: STANDARD redeem migrated to the CtfCollateralAdapter with
// full-balance semantics. Fully offline: real ethers encoding with mocked
// RPC transport and mocked wallet send; any unexpected network call throws.

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
let noBalance = '250000';
let operatorApproved = false;
let ctfBalanceReadCount = 0;

beforeEach(() => {
  reads.length = 0;
  yesBalance = '12500000';
  noBalance = '250000';
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
const invoke = (ctf: Awaited<ReturnType<typeof setup>>['ctf'], observer?: (p: any) => void) =>
  ctf.redeemByTokenIds(condition, ids, undefined, { negRisk: false }, observer);

describe('CTF redeem factual provenance', () => {
  it('local validation before submission is NOT_SUBMITTED', async () => {
    const { ctf } = await setup('LIVE');
    await expect(ctf.redeemByTokenIds(condition, ids)).rejects.toMatchObject({
      name: 'RedeemProvenanceError', provenance: { state: 'NOT_SUBMITTED' },
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('pre-submit RPC failure is NOT_SUBMITTED', async () => {
    const { ctf } = await setup('LIVE');
    vi.mocked(providers.BaseProvider.prototype.call).mockRejectedValueOnce(new Error('network'));
    await expect(invoke(ctf)).rejects.toMatchObject({ provenance: { state: 'NOT_SUBMITTED' } });
    expect(send).not.toHaveBeenCalled();
  });
  it('approval broadcast and wait failure are not redeem submission', async () => {
    const { ctf } = await setup('LIVE');
    send.mockResolvedValueOnce({ hash, wait: async () => { throw new Error('approval wait'); } });
    const observer = vi.fn();
    await expect(invoke(ctf, observer)).rejects.toMatchObject({ provenance: { state: 'NOT_SUBMITTED' } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(erc1155.parseTransaction({ data: String(await send.mock.calls[0][0].data) }).name).toBe('setApprovalForAll');
    expect(observer).toHaveBeenCalledWith({ state: 'NOT_SUBMITTED' });
  });
  it('typed execution barrier proves no redeem submission', async () => {
    const { ctf } = await setup('DRY');
    operatorApproved = true;
    await expect(invoke(ctf)).rejects.toMatchObject({ provenance: { state: 'NOT_SUBMITTED' } });
    expect(send).not.toHaveBeenCalled();
  });
  it('reports SUBMITTED while waiting, then CONFIRMED with legacy success fields', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    let release!: (r: unknown) => void;
    let started!: () => void;
    const waiting = new Promise<void>(r => { started = r; });
    send.mockResolvedValueOnce({ hash, wait: () => { started(); return new Promise(r => { release = r; }); } });
    const observer = vi.fn();
    const running = invoke(ctf, observer);
    await waiting;
    expect(observer).toHaveBeenCalledWith({ state: 'SUBMITTED', transactionHash: hash });
    expect(Object.isFrozen(observer.mock.calls[0][0])).toBe(true);
    release({ status: 1, transactionHash: hash, gasUsed: BigNumber.from(21000), logs: [] });
    expect(await running).toMatchObject({ success: true, txHash: hash, tokensRedeemed: '12.5',
      usdcReceived: '12.5', yesTokensConsumed: '12.5', noTokensConsumed: '0.25',
      provenance: { state: 'CONFIRMED', transactionHash: hash } });
    expect(observer).toHaveBeenLastCalledWith({ state: 'CONFIRMED', transactionHash: hash });
  });
  it('wait failure preserves the known redeem hash as UNCERTAIN', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    const cause = new Error('wait failed');
    send.mockResolvedValueOnce({ hash, wait: async () => { throw cause; } });
    await expect(invoke(ctf)).rejects.toMatchObject({ cause,
      provenance: { state: 'UNCERTAIN', transactionHash: hash } });
  });
  it.each(['not submitted', 'rejected', 'WRITE_BLOCKED', 'network'])('never infers absence of broadcast from %s', async message => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    const cause = Object.assign(new Error(message), { code: 'WRITE_BLOCKED' });
    send.mockRejectedValueOnce(cause);
    await expect(invoke(ctf)).rejects.toMatchObject({ cause, provenance: { state: 'UNCERTAIN' } });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('missing hash after submission is UNCERTAIN, not NOT_SUBMITTED', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    send.mockResolvedValueOnce({ wait: async () => { throw new Error('missing identity'); } });
    const observer = vi.fn();
    await expect(invoke(ctf, observer)).rejects.toMatchObject({ provenance: { state: 'UNCERTAIN' } });
    expect(observer).toHaveBeenCalledWith({ state: 'UNCERTAIN' });
  });
  it.each([0, undefined])('receipt status %s cannot confirm redeem', async status => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    send.mockResolvedValueOnce({ hash, wait: async () => ({ status, transactionHash: hash }) });
    await expect(invoke(ctf)).rejects.toMatchObject({ provenance: { state: 'UNCERTAIN', transactionHash: hash } });
  });
  it('successful receipt with a different hash remains UNCERTAIN with the submitted identity', async () => {
    const { ctf } = await setup('LIVE');
    const { RedeemProvenanceError } = await import('../clients/ctf-client.js');
    operatorApproved = true;
    const receiptHash = '0x' + '44'.repeat(32);
    const receipt = { status: 1, transactionHash: receiptHash, gasUsed: BigNumber.from(21000), logs: [] };
    const wait = vi.fn().mockResolvedValue(receipt);
    send.mockResolvedValueOnce({ hash, wait });
    const observer = vi.fn();

    const error: unknown = await invoke(ctf, observer).then(
      () => { throw new Error('Mismatched receipt must not resolve successfully'); },
      cause => cause,
    );

    expect(receipt.status).toBe(1);
    expect(receipt.transactionHash).not.toBe(hash);
    expect(send).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(RedeemProvenanceError);
    if (!(error instanceof RedeemProvenanceError)) throw new Error('Expected typed provenance error');
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.provenance).toEqual({ state: 'UNCERTAIN', transactionHash: hash });
    expect(error.provenance.transactionHash).not.toBe(receiptHash);
    // Assert the complete sequence from structured facts, without parsing any message.
    expect(observer.mock.calls).toEqual([
      [{ state: 'SUBMITTED', transactionHash: hash }],
      [{ state: 'UNCERTAIN', transactionHash: hash }],
    ]);
    expect(observer).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'CONFIRMED' }));
    expect(observer).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'NOT_SUBMITTED' }));
  });
  it('diagnostic callback cannot interrupt confirmation', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    expect(await invoke(ctf, () => { throw new Error('observer'); })).toMatchObject({
      success: true, provenance: { state: 'CONFIRMED', transactionHash: hash },
    });
  });
});
