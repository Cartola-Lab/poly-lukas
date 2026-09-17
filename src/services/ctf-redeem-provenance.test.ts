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
const transferEvent = new utils.Interface(['event Transfer(address indexed from, address indexed to, uint256 amount)']);
function mintLog(amount = '12.5', logIndex = 0, to = owner, from = '0x' + '00'.repeat(20)) {
  return { address: config.collateral, logIndex,
    ...transferEvent.encodeEventLog(transferEvent.getEvent('Transfer'), [from, to, utils.parseUnits(amount, 6)]) };
}

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
    wait: async () => ({ status: 1, transactionHash: '0x' + '22'.repeat(32), gasUsed: BigNumber.from(21000), logs: [mintLog()] }),
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

describe('CTF read-only redeem payout lookup', () => {
  const historicalWallet = '0x' + 'ab'.repeat(20);
  const mint = (amount = '12.5', index = 0) => mintLog(amount, index, historicalWallet);
  const receipt = (logs = [mint()]) => ({ status: 1, transactionHash: hash, logs });
  afterEach(() => {
    expect(send).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(providers.BaseProvider.prototype.call).not.toHaveBeenCalled();
  });

  it.each([
    ['historical wallet', [mint()], '12.5'],
    ['zero', [mint('0')], '0.0'],
    ['exact sum', [mint('9007199254740993.123456'), mint('0.000001', 1)], '9007199254740993.123457'],
    ['identical duplicate', [mint(), mint()], '12.5'],
  ] as const)('reads %s without writes or balance reads', async (_label, logs, amount) => {
    const { ctf } = await setup('HALT');
    const lookup = vi.spyOn(providers.BaseProvider.prototype, 'getTransactionReceipt')
      .mockResolvedValue({ ...receipt(), logs } as any);
    expect(await ctf.getRedeemPayout(hash, historicalWallet)).toEqual({
      state: 'PAYOUT_KNOWN', transactionHash: hash, pusdReceived: amount });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(hash);
  });

  it.each([
    ['null', null], ['bad status', { ...receipt(), status: 0 }],
    ['missing status', { ...receipt(), status: undefined }],
    ['wrong hash', { ...receipt(), transactionHash: '0x' + '33'.repeat(32) }],
    ['missing hash', { ...receipt(), transactionHash: undefined }],
    ['no mint', receipt([])], ['other wallet', receipt([mintLog()])],
    ['other token', receipt([{ ...mint(), address: legacyCtf }])],
    ['conflict', receipt([mint(), mint('1')])],
    ['recipient conflict', receipt([mint(), mintLog()])],
    ['recipient conflict reversed', receipt([mintLog(), mint()])],
    ['invalid index', receipt([{ ...mint(), logIndex: -1 }])],
    ['invalid data', receipt([{ ...mint(), data: '0x01' }])],
    ['log tx mismatch', receipt([{ ...mint(), transactionHash: '0x' + '44'.repeat(32) } as any])],
  ])('keeps %s unknown', async (_label, value) => {
    const { ctf } = await setup('LIVE');
    vi.spyOn(providers.BaseProvider.prototype, 'getTransactionReceipt').mockResolvedValue(value as any);
    const result = await ctf.getRedeemPayout(hash, historicalWallet);
    expect(result).toMatchObject({ state: 'PAYOUT_UNKNOWN', transactionHash: hash, pusdReceived: undefined });
    expect('cause' in result && result.cause).toBeInstanceOf(Error);
  });

  it('accepts canonical-equivalent wallet and transaction casing', async () => {
    const { ctf } = await setup('LIVE');
    const mixedHash = '0x' + 'ab'.repeat(32);
    vi.spyOn(providers.BaseProvider.prototype, 'getTransactionReceipt').mockResolvedValue({
      ...receipt(), transactionHash: '0x' + 'AB'.repeat(32) } as any);
    expect(await ctf.getRedeemPayout(mixedHash, '0x' + 'AB'.repeat(20))).toMatchObject({
      state: 'PAYOUT_KNOWN', pusdReceived: '12.5' });
  });

  it.each(['rpc', 'null'])('can resolve after %s and repeat without side effects', async failure => {
    const { ctf } = await setup('LIVE');
    const cause = new Error('RPC unavailable');
    const lookup = vi.spyOn(providers.BaseProvider.prototype, 'getTransactionReceipt').mockResolvedValue(receipt() as any);
    if (failure === 'rpc') lookup.mockRejectedValueOnce(cause);
    else lookup.mockResolvedValueOnce(null as any);
    const first = await ctf.getRedeemPayout(hash, historicalWallet);
    expect(first).toMatchObject({ state: 'PAYOUT_UNKNOWN', pusdReceived: undefined });
    if (failure === 'rpc') expect('cause' in first && first.cause).toBe(cause);
    for (let i = 0; i < 2; i++) {
      expect(await ctf.getRedeemPayout(hash, historicalWallet)).toEqual({
        state: 'PAYOUT_KNOWN', transactionHash: hash, pusdReceived: '12.5' });
    }
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it.each([['', historicalWallet], ['0x12', historicalWallet], [hash, ''], [hash, '0x12']])(
    'rejects invalid input %s / %s before RPC', async (txHash, wallet) => {
      const { ctf } = await setup('LIVE');
      const lookup = vi.spyOn(providers.BaseProvider.prototype, 'getTransactionReceipt');
      expect(await ctf.getRedeemPayout(txHash, wallet)).toMatchObject({
        state: 'PAYOUT_UNKNOWN', pusdReceived: undefined });
      expect(lookup).not.toHaveBeenCalled();
    });
});

describe('CTF redeem factual provenance', () => {
  const conflicts = [
    ['recipient', mintLog('12.5', 0, standardAdapter)],
    ['amount', mintLog('7.25', 0)],
    ['token', { ...mintLog(), address: legacyCtf }],
    ['from', mintLog('12.5', 0, owner, standardAdapter)],
    ['signature', { ...mintLog(), topics: [utils.id('Approval(address,address,uint256)'), ...mintLog().topics.slice(1)] }],
    ['transaction', { ...mintLog(), transactionHash: '0x' + '44'.repeat(32) }],
  ] as const;
  for (const reversed of [false, true]) {
    it.each(conflicts)('rejects conflicting %s before payout filtering (reversed=' + reversed + ')', async (_field, conflict) => {
      const { ctf } = await setup('LIVE');
      const { RedeemProvenanceError } = await import('../clients/ctf-client.js');
      operatorApproved = true;
      const logs = [mintLog(), conflict];
      if (reversed) logs.reverse();
      send.mockResolvedValueOnce({ hash, wait: async () => ({ status: 1, transactionHash: hash,
        gasUsed: BigNumber.from(21000), logs }) });
      const error = await invoke(ctf).catch(error => error);
      expect(error).toBeInstanceOf(RedeemProvenanceError);
      expect(error.provenance).toEqual({ state: 'CONFIRMED', transactionHash: hash });
      expect(error.usdcReceived).toBeUndefined();
    });
  }
  it('deduplicates identical and canonically equivalent complete log content', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    const log = { ...mintLog(), transactionHash: hash };
    const upper = (s: string) => '0x' + s.slice(2).toUpperCase();
    const equivalent = { ...log, address: upper(log.address), topics: log.topics.map(upper),
      data: upper(log.data), transactionHash: upper(hash) };
    send.mockResolvedValueOnce({ hash, wait: async () => ({ status: 1, transactionHash: hash,
      gasUsed: BigNumber.from(21000), logs: [log, { ...log }, equivalent, mintLog('1.25', 1)] }) });
    expect((await invoke(ctf)).usdcReceived).toBe('13.75');
  });
  it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid logIndex %s even in economic noise', async logIndex => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    send.mockResolvedValueOnce({ hash, wait: async () => ({ status: 1, transactionHash: hash,
      gasUsed: BigNumber.from(21000), logs: [mintLog(), { ...mintLog('1', 1, standardAdapter), logIndex }] }) });
    await expect(invoke(ctf)).rejects.toMatchObject({ name: 'RedeemProvenanceError',
      provenance: { state: 'CONFIRMED', transactionHash: hash }, usdcReceived: undefined });
  });
  it.each([false, true])('uses receipt payout independently of snapshot (negRisk=%s)', async negRisk => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    yesBalance = '20000000';
    const result = await ctf.redeemByTokenIds(condition, ids, undefined, { negRisk });
    expect(result.usdcReceived).toBe('12.5');
    expect(result.tokensRedeemed).toBe('20.0');
    expect(result.provenance?.state).toBe('CONFIRMED');
  });
  it.each(['0', '7.25'])('reports actual mint %s despite snapshot 12.5', async amount => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    send.mockResolvedValueOnce({ hash, wait: async () => ({ status: 1, transactionHash: hash,
      gasUsed: BigNumber.from(21000), logs: [mintLog(amount)] }) });
    expect((await invoke(ctf)).usdcReceived).toBe(utils.formatUnits(utils.parseUnits(amount, 6), 6));
  });
  it('filters unrelated transfers and sums distinct mint logs exactly, deduplicating logIndex', async () => {
    const { ctf } = await setup('LIVE');
    operatorApproved = true;
    const large = mintLog('9007199254740993.123456', 4);
    const logs = [
      { ...mintLog('999', 0), address: legacyCtf },
      mintLog('999', 1, owner, standardAdapter),
      mintLog('999', 2, standardAdapter),
      { ...mintLog('999', 3), topics: ['0x' + 'aa'.repeat(32)] },
      { ...large, address: config.collateral.toLowerCase() }, large,
      mintLog('0.000001', 5),
    ];
    send.mockResolvedValueOnce({ hash, wait: async () => ({ status: 1, transactionHash: hash,
      gasUsed: BigNumber.from(21000), logs }) });
    expect((await invoke(ctf)).usdcReceived).toBe('9007199254740993.123457');
  });
  it.each([
    [],
    [{ ...mintLog(), data: '0x01' }],
    [{ ...mintLog(), topics: mintLog().topics.slice(0, 2) }],
    [{ ...mintLog(), logIndex: undefined }],
    [mintLog('1', 0), mintLog('2', 0)],
    [{ ...mintLog(), transactionHash: '0x' + '44'.repeat(32) }],
    [{ ...mintLog(), address: legacyCtf }],
    [mintLog('1', 0, standardAdapter)],
    [mintLog('1', 0, owner, standardAdapter)],
  ])('keeps confirmed amount unknown for absent or invalid mint evidence %#', async (...entries) => {
    const { ctf } = await setup('LIVE');
    const { RedeemProvenanceError } = await import('../clients/ctf-client.js');
    operatorApproved = true;
    send.mockResolvedValueOnce({ hash, wait: async () => ({ status: 1, transactionHash: hash,
      gasUsed: BigNumber.from(21000), logs: entries }) });
    const error = await invoke(ctf).catch(error => error);
    expect(error).toBeInstanceOf(RedeemProvenanceError);
    expect(error.provenance).toEqual({ state: 'CONFIRMED', transactionHash: hash });
    expect(error.usdcReceived).toBeUndefined();
  });
  it('preserves the normal economic value when result construction fails after confirmation', async () => {
    const { ctf } = await setup('LIVE');
    const { RedeemProvenanceError } = await import('../clients/ctf-client.js');
    operatorApproved = true;
    yesBalance = '20000000';
    const normal = await invoke(ctf);
    expect(normal.usdcReceived).toBe('12.5');
    const normalReads = reads.length;
    reads.length = 0;
    ctfBalanceReadCount = 0;
    const cause = new Error('receipt gas formatting failed');
    send.mockResolvedValueOnce({ hash, wait: async () => ({
      status: 1, transactionHash: hash, logs: [mintLog()],
      gasUsed: { toString() { throw cause; } },
    }) });
    const observer = vi.fn();
    const error = await invoke(ctf, observer).catch(error => error);
    expect(error).toBeInstanceOf(RedeemProvenanceError);
    expect(error.provenance).toEqual({ state: 'CONFIRMED', transactionHash: hash });
    expect(error.usdcReceived).toBe(normal.usdcReceived);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe(cause.message);
    expect(Object.isFrozen(error.provenance)).toBe(true);
    expect(Reflect.set(error, 'usdcReceived', '999')).toBe(false);
    expect(error.usdcReceived).toBe('12.5');
    expect(observer.mock.calls.map(([p]) => p.state)).toEqual(['SUBMITTED', 'CONFIRMED', 'CONFIRMED']);
    expect(reads).toHaveLength(normalReads);
    expect(ctfBalanceReadCount).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('retains CONFIRMED without inventing an economic value when receipt amount extraction fails', async () => {
    const { ctf } = await setup('LIVE');
    const { RedeemProvenanceError } = await import('../clients/ctf-client.js');
    operatorApproved = true;
    const cause = new Error('receipt amount extraction failed');
    const original = BigNumber.prototype.toString;
    let failFormatting = false;
    vi.spyOn(BigNumber.prototype, 'toString').mockImplementation(function (this: BigNumber) {
      if (failFormatting) { failFormatting = false; throw cause; }
      return original.call(this);
    });
    const error = await invoke(ctf, p => {
      if (p.state === 'CONFIRMED') failFormatting = true;
    }).catch(error => error);
    failFormatting = false;
    expect(error).toBeInstanceOf(RedeemProvenanceError);
    expect(error.provenance).toEqual({ state: 'CONFIRMED', transactionHash: hash });
    expect(error.usdcReceived).toBeUndefined();
    expect(error.cause).toBe(cause);
    expect(error.message).toBe(cause.message);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(['NOT_SUBMITTED', 'SUBMITTED', 'UNCERTAIN'] as const)(
    '%s has no artificial economic fact and the legacy error constructor remains valid', async state => {
      const { ctf } = await setup('LIVE');
      const { RedeemProvenanceError } = await import('../clients/ctf-client.js');
      const cause = new Error('transport failure');
      const legacy = new RedeemProvenanceError(cause, { state, transactionHash: hash });
      expect(legacy.usdcReceived).toBeUndefined();
      expect(legacy.cause).toBe(cause);
      expect(legacy.message).toBe(cause.message);
      operatorApproved = true;
      if (state === 'NOT_SUBMITTED') {
        vi.mocked(providers.BaseProvider.prototype.call).mockRejectedValueOnce(cause);
      } else {
        send.mockResolvedValueOnce({ hash, wait: async () => { throw cause; } });
      }
      const observer = vi.fn();
      const error = await invoke(ctf, observer).catch(error => error);
      expect(error).toBeInstanceOf(RedeemProvenanceError);
      expect(error.usdcReceived).toBeUndefined();
      expect(error.cause).toBe(cause);
      expect(error.provenance.state).toBe(state === 'NOT_SUBMITTED' ? state : 'UNCERTAIN');
      if (state === 'SUBMITTED') {
        expect(observer).toHaveBeenCalledWith({ state: 'SUBMITTED', transactionHash: hash });
      }
      for (const [snapshot] of observer.mock.calls) expect(snapshot.usdcReceived).toBeUndefined();
    },
  );
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
    release({ status: 1, transactionHash: hash, gasUsed: BigNumber.from(21000), logs: [mintLog()] });
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
    const receipt = { status: 1, transactionHash: receiptHash, gasUsed: BigNumber.from(21000), logs: [mintLog()] };
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
