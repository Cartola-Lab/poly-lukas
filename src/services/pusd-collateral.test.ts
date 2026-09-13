import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import { getContractConfig, COLLATERAL_TOKEN_DECIMALS } from '@polymarket/clob-client-v2';

const config = getContractConfig(137);
const spenders = [config.exchangeV2, config.negRiskExchangeV2];
const legacyUsdcE = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const nativeUsdc = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
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
let balance = '12500000';
let legacyBalance = '12500000';
let allowances: string[];
let outcomeApproved: boolean;

beforeEach(() => {
  reads.length = 0;
  balance = '12500000';
  legacyBalance = '12500000';
  allowances = ['12500000', '12500000'];
  outcomeApproved = true;
  vi.spyOn(providers.JsonRpcProvider.prototype, 'send').mockImplementation(async method => {
    if (method === 'eth_chainId') return '0x89';
    throw new Error(`Unexpected RPC: ${method}`);
  });
  vi.spyOn(providers.BaseProvider.prototype, 'getGasPrice').mockResolvedValue(BigNumber.from(100));
  vi.spyOn(providers.BaseProvider.prototype, 'getBalance').mockResolvedValue(utils.parseEther('1'));
  vi.spyOn(providers.BaseProvider.prototype, 'call').mockImplementation(async tx => {
    const to = String(await tx.to);
    const data = String(await tx.data);
    const isCollateral = to.toLowerCase() === config.collateral.toLowerCase();
    expect([config.collateral, config.conditionalTokens, legacyUsdcE, nativeUsdc].map(a => a.toLowerCase())).toContain(to.toLowerCase());
    const isLegacyBalance = [legacyUsdcE, nativeUsdc].some(a => a.toLowerCase() === to.toLowerCase());
    const abi = isCollateral || isLegacyBalance ? erc20 : erc1155;
    const call = abi.parseTransaction({ data });
    reads.push({ to, name: call.name, args: [...call.args] });
    expect(call.args[0]).toBe(owner);
    if (call.name === 'balanceOf') return abi.encodeFunctionResult(call.name, [isLegacyBalance ? (to.toLowerCase() === legacyUsdcE.toLowerCase() ? legacyBalance : '0') : balance]);
    const index = spenders.findIndex(s => s.toLowerCase() === String(call.args[1]).toLowerCase());
    expect(index).toBeGreaterThanOrEqual(0);
    return abi.encodeFunctionResult(call.name, [call.name === 'allowance' ? allowances[index] : outcomeApproved]);
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
  const service = new OnchainService({ privateKey: key });
  if (mode === 'HALT') executionMode.halt();
  return service;
}

describe('pUSD trading collateral with real ethers contracts and offline transport', () => {
  it('keeps legacy CTF ready with USDC.e and gas when pUSD/V2 allowances are absent', async () => {
    const service = await setup('DRY');
    balance = '0';
    allowances = ['0', '0'];
    outcomeApproved = false;

    const ctf = await service.checkReadyForCTF('10', 0.5);
    expect(ctf).toMatchObject({ ready: true, usdcEBalance: '12.5', maticBalance: '1.0', tradingReady: true, issues: [] });
    expect(reads.map(r => r.to.toLowerCase())).toContain(legacyUsdcE.toLowerCase());
    expect(reads.some(r => r.to.toLowerCase() === config.collateral.toLowerCase())).toBe(false);
    expect(reads.some(r => spenders.some(s => r.args.some(arg => String(arg).toLowerCase() === s.toLowerCase())))).toBe(false);

    const trading = await service.checkReadyForTrading('10');
    expect(trading.tradingReady).toBe(false);
    expect(trading.pUsdBalance).toBe('0.0');
    expect(trading.erc20Allowances.every(a => !a.approved)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps legacy CTF not ready when USDC.e or gas is insufficient despite pUSD/V2 readiness', async () => {
    const service = await setup('DRY');
    legacyBalance = '9000000';
    expect((await service.checkReadyForCTF('10', 0.5)).ready).toBe(false);
    legacyBalance = '12500000';
    vi.mocked(providers.BaseProvider.prototype.getBalance).mockResolvedValue(utils.parseEther('0.1'));
    expect((await service.checkReadyForCTF('10', 0.5)).ready).toBe(false);
    expect((await service.checkReadyForTrading('10')).tradingReady).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('matches the required production SDK configuration', () => {
    expect(config.collateral).toBe('0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB');
    expect(COLLATERAL_TOKEN_DECIMALS).toBe(6);
    expect(spenders).toEqual(['0xE111180000d2663C0091e4f400237545B87B996B', '0xe2222d279d744050d28e00520010520000310F59']);
  });

  it.each(['DRY', 'LIVE', 'HALT'] as const)('%s reads EOA pUSD balance and trading readiness', async mode => {
    const service = await setup(mode);
    expect(await service.getPusdBalance()).toBe('12.5');
    const result = await service.checkReadyForTrading('12.5');
    expect(result).toMatchObject({ wallet: owner, pUsdBalance: '12.5', tradingReady: true, issues: [] });
    expect(reads.filter(r => r.name === 'balanceOf')).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([0, 1])('requires sufficient allowance for V2 spender %s', async index => {
    const service = await setup('DRY');
    allowances[index] = '12499999';
    const result = await service.checkReadyForTrading('12.5');
    expect(result.tradingReady).toBe(false);
    expect(result.erc20Allowances[index].approved).toBe(false);
    expect(result.erc20Allowances[1 - index].approved).toBe(true);
  });

  it('does not accept zero pUSD as trading capital even with approvals', async () => {
    const service = await setup('DRY');
    balance = '0';
    expect((await service.checkReadyForTrading('1')).tradingReady).toBe(false);
  });

  it('Arbitrage refreshes its trading budget from pUSD, not the utility USDC.e getter', async () => {
    const { ArbitrageService } = await import('./arbitrage-service.js');
    const service = new ArbitrageService({});
    const utilityBalance = vi.fn().mockResolvedValue('999999');
    const collateralBalance = vi.fn().mockResolvedValue('12.5');
    const internal = service as unknown as {
      ctf: unknown; market: unknown; updateBalance(): Promise<void>;
    };
    internal.ctf = {
      getUsdcBalance: utilityBalance,
      getPusdBalance: collateralBalance,
      getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({ yesBalance: '0', noBalance: '0' }),
    };
    internal.market = { conditionId: 'fixture', yesTokenId: '1', noTokenId: '2' };
    await internal.updateBalance();
    expect(service.getBalance().pUsdBalance).toBe(12.5);
    expect(collateralBalance).toHaveBeenCalledOnce();
    expect(utilityBalance).not.toHaveBeenCalled();
  });

  it('requires outcome-token approvals for the V2 exchanges', async () => {
    const service = await setup('DRY');
    outcomeApproved = false;
    expect((await service.checkReadyForTrading()).tradingReady).toBe(false);
  });

  it.each(['DRY', 'LIVE', 'HALT'] as const)('%s gates pUSD approveAll before lower send', async mode => {
    const service = await setup(mode);
    allowances = ['0', '0'];
    outcomeApproved = false;
    const result = await service.approveAll();
    expect(result.allApproved, JSON.stringify(result)).toBe(mode === 'LIVE');
    expect(send).toHaveBeenCalledTimes(mode === 'LIVE' ? 4 : 0);
    const seen = [];
    for (const [tx] of send.mock.calls) {
      const to = String(await tx.to);
      const data = String(await tx.data);
      const collateral = to.toLowerCase() === config.collateral.toLowerCase();
      const decoded = (collateral ? erc20 : erc1155).parseTransaction({ data });
      expect(spenders.map(s => s.toLowerCase())).toContain(decoded.args[0].toLowerCase());
      expect(to.toLowerCase()).not.toBe('0x2791bca1f2de4661ed88a30c99a7a9449aa84174');
      expect(decoded.args[0].toLowerCase()).not.toBe('0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e');
      expect(decoded.args[0].toLowerCase()).not.toBe('0xc5d563a36ae78145c45a50134d48a1215220f80a');
      if (collateral) {
        expect(decoded.name).toBe('approve');
        expect(decoded.args[1].eq(BigNumber.from(2).pow(256).sub(1))).toBe(true);
        seen.push(decoded.args[0].toLowerCase());
      }
    }
    if (mode === 'LIVE') expect(seen).toEqual(spenders.map(s => s.toLowerCase()));
  });

  it.each(['DRY', 'LIVE', 'HALT'] as const)('%s gates targeted pUSD approvals', async mode => {
    const service = await setup(mode);
    for (const spender of spenders) {
      send.mockClear();
      const result = await service.approvePusd(spender, BigNumber.from('12500000'));
      expect(result.success, JSON.stringify(result)).toBe(mode === 'LIVE');
      expect(send).toHaveBeenCalledTimes(mode === 'LIVE' ? 1 : 0);
      if (mode === 'LIVE') {
        expect(String(await send.mock.calls[0][0].to).toLowerCase()).toBe(config.collateral.toLowerCase());
        const call = erc20.parseTransaction({ data: String(await send.mock.calls[0][0].data) });
        expect(call.args[0].toLowerCase()).toBe(spender.toLowerCase());
        expect(call.args[1].toString()).toBe('12500000');
      }
    }
    await expect(service.approvePusd('0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E')).rejects.toThrow('Not a CLOB V2 spender');
  });
});
