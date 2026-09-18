import { afterEach, describe, expect, it, vi } from 'vitest';
import { DipArbService } from './dip-arb-service.js';
const wallet = '0x' + 'ab'.repeat(20), other = '0x' + '22'.repeat(20);
const accepted = (orderId = 'order') => ({ success: true, submissionState: 'ACCEPTED', orderId, tradeIds: [orderId] });
function deferred() { let resolve!: (v: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(existing = false, isolation = true) {
  let n=0;
  const factualBuy = (id: string) => {
    const submissions = trading.createMarketOrder.mock.calls;
    const index = trading.createMarketOrder.mock.results.findIndex((_: unknown, i: number) => id === `order-${i + 1}`);
    const params = submissions[index >= 0 ? index : 0]?.[0] as any;
    return { side: params?.side ?? 'BUY', price: String(params?.price ?? .4), token: params?.tokenId ?? 'up', size: String(params?.side === 'SELL' ? params.amount : (params?.amount ?? 4) / (params?.price ?? .4)) };
  };
  const trading = { getAddress: vi.fn(() => wallet), createMarketOrder: vi.fn().mockImplementation(async () => accepted(`order-${++n}`)),
    getOrderFillDetails: vi.fn(async (id: string): Promise<any> => ({ id, asset_id: factualBuy(id).token, side: factualBuy(id).side, tradeIds: [id], sizeMatched: factualBuy(id).size })),
    getTradeStatuses: vi.fn(async (ids: string[]): Promise<any[]> => ids.map(id => ({ id, status:'MINED', transactionHash:'0x'+'12'.repeat(32), size:factualBuy(id).size,
      price:factualBuy(id).price, asset_id:factualBuy(id).token, side:factualBuy(id).side, taker_order_id:id, trader_side:'TAKER', maker_orders:[] }))) };
  const ctf = { getAddress: () => wallet, getPositionBalanceByTokenIds: vi.fn().mockResolvedValue({yesBalance:'10',noBalance:'10'}) };
  const service = new DipArbService({} as any,trading as any,{} as any);
  const round: any = {roundId:'r1',phase:existing?'leg1_filled':'waiting',startTime:Date.now(),
    ...(existing?{leg1:{side:'UP',price:.4,shares:10,tokenId:'up',timestamp:Date.now()}}:{})};
  const market = {conditionId:'condition',upTokenId:'up',downTokenId:'down',slug:'market',endTime:new Date(Date.now()+60000)};
  Object.assign(service,{market,currentRound:round,ctf,upAsks:[{price:.4}],downAsks:[{price:.5}],isRunning:true});
  service.updateConfig({autoExecute:true,autoMerge:false,splitOrders:1,orderIntervalMs:0,debug:false,executionCooldown:0});
  const guard=vi.fn(():string|undefined=>undefined); if(isolation) service.setInventoryAdmissionGuard(guard);
  const events={execution:vi.fn(),roundComplete:vi.fn(),settled:vi.fn(),inventoryBlocked:vi.fn()};
  for(const [name,fn] of Object.entries(events))service.on(name,fn);
  const signal:any={type:'leg1',roundId:'r1',dipSide:'UP',tokenId:'up',shares:10,targetPrice:.4,currentPrice:.4,source:'test'};
  const leg1=()=>service.executeLeg1(signal);
  const leg2=()=>service.executeLeg2({...signal,type:'leg2',hedgeSide:'DOWN',tokenId:'down',targetPrice:.5});
  const exit=()=>service['emergencyExitLeg1']();const sell=()=>service.settle('sell');
  const protection=(token='up',address=wallet)=>service.getInventoryProtection({walletAddress:address,tokenIds:[token]});
  return {service,trading,ctf,round,market,guard,events,signal,leg1,leg2,exit,sell,protection};
}
function economicStats(service: DipArbService) {
  const { startTime, runningTimeMs, ...stats } = service.getStats();
  return stats;
}
afterEach(()=>vi.restoreAllMocks());
describe('DipArb CLOB inventory isolation',()=>{
  it.each(['leg1','leg2','exit','sell'] as const)('external conflict blocks %s without economic side effects',async method=>{
    const h=fixture(method==='exit'||method==='sell');h.guard.mockReturnValue('SHORT_PROTECTED');
    const stats=h.service.getStats(); const result=await h[method]();
    expect(result).toMatchObject({status:'BLOCKED_INVENTORY'});expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    expect(h.service.getStats()).toMatchObject({totalProfit:stats.totalProfit,leg1Filled:stats.leg1Filled,leg2Filled:stats.leg2Filled});
    for(const key of ['execution','roundComplete','settled'] as const)expect(h.events[key]).not.toHaveBeenCalled();
    expect(h.events.inventoryBlocked).toHaveBeenCalledTimes(1);
  });
  it.each(['leg1','leg2','exit','sell'] as const)('%s registers writer before transport',async method=>{
    const h=fixture(method==='exit'||method==='sell');const response=deferred();h.trading.createMarketOrder.mockReturnValueOnce(response.promise);
    const pending=h[method]();await Promise.resolve();await Promise.resolve();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    const records=[...h.service['clobLifecycles'].values()];expect(records.some(r=>r.submission==='ACTIVE')).toBe(true);
    expect(h.protection(method==='leg2'?'down':'up')).toBeDefined();response.resolve(accepted());await pending;
  });
  it.each(['leg1','leg2'] as const)('%s REJECTED releases only its attempt',async method=>{
    const h=fixture();h.trading.createMarketOrder.mockResolvedValueOnce({success:false,submissionState:'REJECTED'});await h[method]();
    expect(h.service['clobLifecycles'].size).toBe(0);
  });
  it.each(['leg1','leg2','exit','sell'] as const)('%s ACCEPTED retains protection',async method=>{
    const h=fixture(method==='exit'||method==='sell');await h[method]();expect(h.protection(method==='leg2'?'down':'up')).toBeDefined();
    expect([...h.service['clobLifecycles'].values()].some(r=>r.submission==='ACCEPTED')).toBe(true);
  });
  it.each(['leg1','leg2','exit','sell'] as const)('%s UNCERTAIN survives zero balance and round replacement',async method=>{
    const h=fixture(method==='exit'||method==='sell');h.trading.createMarketOrder.mockResolvedValueOnce({success:false,submissionState:'UNCERTAIN'});await h[method]();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'0',noBalance:'0'});
    if(method==='exit')await h.exit();
    Object.assign(h.service,{currentRound:{roundId:'new',phase:'completed'}});
    expect([...h.service['clobLifecycles'].values()].some(r=>r.submission==='UNCERTAIN')).toBe(true);
    expect(h.protection(method==='leg2'?'down':'up')).toBeDefined();
  });
  it.each(['leg1','leg2','exit','sell'] as const)('%s transport exception remains uncertain',async method=>{
    const h=fixture(method==='exit'||method==='sell');h.trading.createMarketOrder.mockRejectedValueOnce(new Error('arbitrary message'));
    await h[method]();expect([...h.service['clobLifecycles'].values()].some(r=>r.submission==='UNCERTAIN')).toBe(true);
  });
  it.each(['REJECTED','UNCERTAIN'])('accepted split then %s preserves first attempt',async submissionState=>{
    const h=fixture();h.service.updateConfig({splitOrders:2});h.trading.createMarketOrder.mockResolvedValueOnce(accepted('first')).mockResolvedValueOnce({success:false,submissionState});
    await h.leg1();expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);expect(h.protection()).toBeDefined();
    expect([...h.service['clobLifecycles'].values()].some(r=>r.orderId==='first')).toBe(true);
  });
  it.each([true,false])('leg2 completion/rejection (%s) never releases leg1',async success=>{
    const h=fixture();await h.leg1();const before=h.protection();
    if(!success)h.trading.createMarketOrder.mockResolvedValueOnce({success:false,submissionState:'REJECTED'});
    await h.leg2();expect(h.protection()).toEqual(before);Object.assign(h.service,{currentRound:{roundId:'new',phase:'waiting'}});expect(h.protection()).toEqual(before);
  });
  it('emergency exit of owned leg is allowed and partial residual remains',async()=>{
    const h=fixture();await h.leg1();await h.exit();expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.round.leg1.exitPending).toBe(true);expect(h.protection()).toBeDefined();
  });
  it('complete factual emergency exit releases resolved attempts and position',async()=>{
    const h=fixture();await h.leg1();h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'0',noBalance:'10'}).mockResolvedValueOnce({yesBalance:'10',noBalance:'10'});
    const result=await h.exit();expect(result?.success).toBe(true);expect(h.protection()).toBeUndefined();
  });
  it('zero balance cannot release accepted orders lacking terminal facts',async()=>{
    const h=fixture();await h.leg1();h.trading.getTradeStatuses.mockResolvedValue([{id:'order-1',status:'MATCHED',transactionHash:'',size:'10'}]);
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'0',noBalance:'10'});await h.exit();expect(h.protection()).toBeDefined();
  });
  it('settleBySell success alone never releases protection',async()=>{
    const h=fixture(true);const result=await h.sell();expect(result.success).toBe(false);expect(h.protection()).toBeDefined();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'0',noBalance:'0'});expect(h.protection()).toBeDefined();
  });
  it('identity uses normalized executor, other wallet/token do not conflict',async()=>{
    const h=fixture();h.trading.getAddress.mockReturnValue('0x'+'AB'.repeat(20));await h.leg1();
    expect(h.guard.mock.calls[0]).toBeDefined();expect(h.protection()).toBeDefined();expect(h.protection('different')).toBeUndefined();expect(h.protection('up',other)).toBeUndefined();
  });
  it('invalid signer fails closed operationally',async()=>{
    const h=fixture();h.trading.getAddress.mockReturnValue('invalid');expect(await h.leg1()).toMatchObject({status:'BLOCKED_INVENTORY'});
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  });
  it('snapshot is frozen and exposes only minimum fields',async()=>{
    const h=fixture();await h.leg1();const snapshot=h.protection()!;expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.keys(snapshot).sort()).toEqual(['blocked','operationId','reason']);
  });
  it.each(['round','market','stop','guard'])('reentrant %s invalidation cannot submit',async change=>{
    const h=fixture();h.guard.mockImplementation(()=>{
      if(change==='round')Object.assign(h.service,{currentRound:{roundId:'new'}});
      if(change==='market')Object.assign(h.service,{market:{...h.market,upTokenId:'other'}});
      if(change==='stop')void h.service.stop();
      if(change==='guard')h.service.setInventoryAdmissionGuard(()=>undefined);
      return undefined;
    });
    expect(await h.leg1()).toMatchObject({status:'BLOCKED_INVENTORY'});expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  });
  it('guard reentrant writer cannot create parallel submissions',async()=>{
    const h=fixture();let nested:Promise<any>|undefined;h.guard.mockImplementation(()=>{nested=h.leg1();return undefined;});
    await h.leg1();await nested;expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });
  it('in-flight response attaches to captured round rather than its replacement',async()=>{
    const h=fixture(),response=deferred();h.trading.createMarketOrder.mockReturnValueOnce(response.promise);const pending=h.leg1();
    const replacement={roundId:'new',phase:'waiting'};Object.assign(h.service,{currentRound:replacement,market:{...h.market,upTokenId:'other'}});
    response.resolve(accepted());await pending;expect(h.round.leg1.tokenId).toBe('up');expect(replacement).not.toHaveProperty('leg1');expect(h.protection()).toBeDefined();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledWith('order');
    expect(h.ctf.getPositionBalanceByTokenIds).not.toHaveBeenCalled();
  });
  it('handleSignal suppresses economic execution event on inventory refusal',async()=>{
    const h=fixture();h.guard.mockReturnValue('blocked');await h.service['handleSignal'](h.signal);
    expect(h.events.execution).not.toHaveBeenCalled();expect(h.events.inventoryBlocked).toHaveBeenCalledTimes(1);
  });
  it('absent callback preserves legacy order behavior without registry',async()=>{
    const h=fixture(false,false);h.trading.createMarketOrder.mockResolvedValueOnce({success:true,orderId:'legacy'});expect((await h.leg1()).success).toBe(true);
    expect(h.service['clobLifecycles'].size).toBe(0);
  });
  it('releasing UP does not release independent DOWN attempt',async()=>{
    const h=fixture();await h.leg1();await h.leg2();const down=h.protection('down');
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'0',noBalance:'10'}).mockResolvedValueOnce({yesBalance:'10',noBalance:'10'});
    await h.exit();expect(h.protection()).toBeUndefined();expect(h.protection('down')).toEqual(down);
  });
  it('delayed complete exit releases only after factual terminality',async()=>{
    const h=fixture();await h.leg1();await h.exit();expect(h.protection()).toBeDefined();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'0',noBalance:'10'});await h.exit();expect(h.protection()).toBeUndefined();
  });
  it('positive dust is not an empty inventory proof',async()=>{
    const h=fixture(true);h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'0.0005',noBalance:'10'});
    await h.exit();expect(h.protection()).toBeDefined();
  });
  it.each([{success:true},{success:true,submissionState:'ACCEPTED',orderId:' '}])('insufficient accepted identity stays uncertain: %j',async reply=>{
    const h=fixture();h.trading.createMarketOrder.mockResolvedValueOnce(reply);await h.leg1();
    expect(h.protection()?.reason).toBe('DIP_ARB_UNCERTAIN');
  });
  it('reused accepted order identity is uncertain for the new attempt',async()=>{
    const h=fixture();h.service.updateConfig({splitOrders:2});h.trading.createMarketOrder.mockResolvedValue(accepted('same'));
    await h.leg1();expect([...h.service['clobLifecycles'].values()].map(r=>r.submission)).toEqual(['ACCEPTED','UNCERTAIN']);
  });
  it('wallet change during pre-submit CTF read refuses the exit',async()=>{
    const h=fixture(true),balance=deferred();h.ctf.getPositionBalanceByTokenIds.mockReturnValueOnce(balance.promise);
    const exiting=h.exit();h.trading.getAddress.mockReturnValue(other);balance.resolve({yesBalance:'10',noBalance:'10'});
    expect(await exiting).toMatchObject({status:'BLOCKED_INVENTORY'});expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  });
  it('stale signal cannot acquire a new round lifecycle',async()=>{
    const h=fixture();h.signal.roundId='old';expect(await h.leg1()).toMatchObject({status:'BLOCKED_INVENTORY'});
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
  });
  it('timeout inventory block emits no roundComplete or economic result',async()=>{
    const h=fixture(true);h.round.leg1.timestamp=Date.now()-1000000;h.guard.mockReturnValue('blocked');
    await h.service['checkAndStartNewRound']();expect(h.events.roundComplete).not.toHaveBeenCalled();
    expect(h.events.execution).not.toHaveBeenCalled();expect(h.events.inventoryBlocked).toHaveBeenCalledTimes(1);
  });
  it('setter does not resurrect factually closed leg protection',async()=>{
    const h=fixture(true);h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'0',noBalance:'10'}).mockResolvedValueOnce({yesBalance:'10',noBalance:'10'});
    await h.exit();expect(h.protection()).toBeUndefined();h.service.setInventoryAdmissionGuard(h.guard);expect(h.protection()).toBeUndefined();
  });

  it('invalid final balance cannot masquerade as zero for registry release',async()=>{
    const h=fixture(true);h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'',noBalance:'10'}).mockResolvedValueOnce({yesBalance:'0',noBalance:'10'});
    await h.exit();expect(h.protection()).toBeDefined();
  });
  it('async protection proof does not reopen the P0.3a accounting claim',async()=>{
    const h=fixture();await h.leg1();await h.exit();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({yesBalance:'0',noBalance:'10'});
    const details=deferred();h.trading.getOrderFillDetails.mockReturnValueOnce(details.promise);
    const first=h.exit();await Promise.resolve();await Promise.resolve();const profit=h.service.getStats().totalProfit;
    const second=h.exit();await Promise.resolve();expect(h.service.getStats().totalProfit).toBe(profit);
    details.resolve({tradeIds:['order-1'],sizeMatched:'10'});await Promise.all([first,second]);
    expect(h.service.getStats().totalProfit).toBe(profit);
  });

  it('late leg2 response cannot auto-merge the replacement round',async()=>{
    const h=fixture(true),response=deferred();h.service.updateConfig({autoMerge:true});
    const merge=vi.spyOn(h.service,'merge');h.trading.createMarketOrder.mockReturnValueOnce(response.promise);
    const pending=h.leg2();Object.assign(h.service,{currentRound:{roundId:'next',phase:'waiting'}});
    response.resolve(accepted());await pending;expect(merge).not.toHaveBeenCalled();expect(h.protection('down')).toBeDefined();
  });

  it.each(['leg1', 'leg2'] as const)('%s materializes an accepted split before reporting blocked acquisition', async method => {
    const h = fixture(method === 'leg2');
    const control = fixture(method === 'leg2');
    for (const f of [h, control]) {
      f.service.updateConfig({ splitOrders: 2 });
      f.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '5', noBalance: '5' });
    }
    control.trading.createMarketOrder.mockResolvedValueOnce(accepted('first'))
      .mockResolvedValueOnce({ success: false, submissionState: 'REJECTED' });
    await control[method]();
    h.guard.mockReturnValueOnce(undefined).mockReturnValueOnce('SHORT_PROTECTED');
    const result = await h[method]();
    const key = method === 'leg1' ? 'leg1' : 'leg2';
    const token = method === 'leg1' ? 'up' : 'down';
    expect(result).toMatchObject({ success: false, roundId: 'r1', shares: 5,
      inventoryInterruption: { status: 'BLOCKED_INVENTORY', reason: 'SHORT_PROTECTED' } });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.trading.createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      side: 'BUY', tokenId: token, amount: method === 'leg1' ? 2 : 2.5,
    }));
    expect(h.round[key]).toMatchObject({ tokenId: token, shares: 5, price: method === 'leg1' ? .4 : .5 });
    expect(h.round.roundId).toBe('r1');
    expect(h.protection(token)).toBeDefined();
    expect([...h.service['clobLifecycles'].values()].filter(r => r.writerType !== 'POSITION')).toHaveLength(1);
    expect(economicStats(h.service)).toEqual(economicStats(control.service));
    expect(h.round.profit).toBe(control.round.profit);
    expect(h.round.totalCost).toBe(control.round.totalCost);
    expect(h.events.roundComplete).toHaveBeenCalledTimes(0);
    expect(h.events.inventoryBlocked).toHaveBeenCalledTimes(1);
    const stats = economicStats(h.service), position = h.round[key];
    await h[method](); // A new invocation must not acquire or book the same position again.
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.round[key]).toBe(position);
    expect(economicStats(h.service)).toEqual(stats);
    expect(h.events.roundComplete).toHaveBeenCalledTimes(0);
  });

  it('accepted split followed by admission block remains accessible to emergency exit', async () => {
    const h = fixture();
    h.service.updateConfig({ splitOrders: 2 });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '5', noBalance: '0' });
    h.guard.mockReturnValueOnce(undefined).mockReturnValueOnce('SHORT_PROTECTED');
    await h.service['handleSignal'](h.signal);
    expect(h.events.execution).not.toHaveBeenCalled(); // Partial BUY is not a terminal execution.
    expect(h.round.phase).toBe('waiting');
    const result = await h.exit();
    expect(result).not.toBeNull();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.trading.createMarketOrder.mock.calls[1][0]).toMatchObject({ side: 'SELL', tokenId: 'up', amount: 5 });
    expect(h.round.leg1.exitPending).toBe(true);
    expect(h.protection()).toBeDefined();
    const profit = h.service.getStats().totalProfit;
    await h.exit();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(h.service.getStats().totalProfit).toBe(profit);
  });

  it.each(['leg1', 'leg2'] as const)('%s blocked first split creates no position or accounting', async method => {
    const h = fixture();
    h.service.updateConfig({ splitOrders: 2 });
    h.guard.mockReturnValue('SHORT_PROTECTED');
    const stats = economicStats(h.service);
    expect(await h[method]()).toMatchObject({ status: 'BLOCKED_INVENTORY', success: false });
    expect(h.round.leg1).toBeUndefined();
    expect(h.round.leg2).toBeUndefined();
    expect(h.trading.createMarketOrder).not.toHaveBeenCalled();
    expect(h.service['clobLifecycles'].size).toBe(0);
    expect(economicStats(h.service)).toEqual(stats);
  });

  it.each(['REJECTED', 'UNCERTAIN'])('accepted split followed by %s still materializes only previous shares', async submissionState => {
    const h = fixture();
    h.service.updateConfig({ splitOrders: 2 });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '5', noBalance: '0' });
    h.trading.createMarketOrder.mockResolvedValueOnce(accepted('first'))
      .mockResolvedValueOnce({ success: false, submissionState });
    expect(await h.leg1()).toMatchObject({ success: false, shares: 5 });
    expect(h.round.leg1).toMatchObject({ tokenId: 'up', shares: 5, price: .4 });
    expect(h.service.getStats().leg1Filled).toBe(0);
    expect(h.protection()).toBeDefined();
  });

  it('a later split invalidated by round replacement materializes only the original round', async () => {
    const h = fixture();
    h.service.updateConfig({ splitOrders: 2 });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '5', noBalance: '0' });
    const replacement = { roundId: 'new', phase: 'waiting' };
    h.guard.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
      Object.assign(h.service, { currentRound: replacement });
      return undefined;
    });
    expect(await h.leg1()).toMatchObject({ success: false, roundId: 'r1', shares: 5 });
    expect(h.round.leg1).toMatchObject({ shares: 5, tokenId: 'up' });
    expect(replacement).not.toHaveProperty('leg1');
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.protection()).toBeDefined();
  });

  it('existing round cycle releases late facts of A after expiration and preserves B', async () => {
    const h = fixture();
    await h.leg1();
    h.round.leg1.timestamp = Date.now() - 1000000;
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: [], sizeMatched: '10' });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    await h.service['checkAndStartNewRound']();
    expect(h.round.phase).toBe('leg1_filled'); // Zero balance is not an attributed emergency exit.
    h.round.phase = 'expired'; // Exercise the existing late-fact cleanup after external rotation.
    expect(h.protection()).toBeDefined();
    await h.service['checkAndStartNewRound']();
    const b = h.service['currentRound']!;
    expect(b).not.toBe(h.round);
    // A different token permits an independent B lifecycle.
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '10' });
    await h.service.executeLeg1({ ...h.signal, roundId: b.roundId, dipSide: 'DOWN', tokenId: 'down' });
    const bProtection = h.protection('down');
    const reads = h.trading.getOrderFillDetails.mock.calls.length;
    const stats = economicStats(h.service);
    const events = Object.fromEntries(Object.entries(h.events).map(([key, fn]) => [key, fn.mock.calls.length]));
    h.trading.getOrderFillDetails.mockImplementation(async id => ({ tradeIds: [id], sizeMatched: '10' }));
    const timers = vi.spyOn(globalThis, 'setInterval');
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    await h.service['checkAndStartNewRound']();
    expect(h.trading.getOrderFillDetails.mock.calls.length).toBeGreaterThan(reads);
    expect(h.protection()).toBeUndefined();
    expect(h.protection('down')).toEqual(bProtection);
    expect(h.service['currentRound']).toBe(b);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(2);
    expect(economicStats(h.service)).toEqual(stats);
    for (const [key, fn] of Object.entries(h.events)) expect(fn).toHaveBeenCalledTimes(events[key]);
    expect(timers).not.toHaveBeenCalled();
    expect(timeouts).not.toHaveBeenCalled();
    const aReads = h.trading.getOrderFillDetails.mock.calls.filter(([id]) => id === 'order-1').length;
    await h.service['checkAndStartNewRound']();
    expect(h.trading.getOrderFillDetails.mock.calls.filter(([id]) => id === 'order-1')).toHaveLength(aReads);
    expect(h.protection('down')).toEqual(bProtection);
  });

  it.each(['incomplete', 'error'] as const)('old identity survives %s facts and is retried later', async kind => {
    const h = fixture(); await h.leg1();
    Object.assign(h.service, { currentRound: { roundId: 'B', phase: 'waiting' },
      market: { ...h.market, conditionId: 'B-condition', upTokenId: 'B-up', downTokenId: 'B-down' } });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    if (kind === 'error') h.trading.getTradeStatuses.mockRejectedValueOnce(new Error('temporary'));
    else h.trading.getTradeStatuses.mockResolvedValueOnce([]);
    await h.service['checkAndStartNewRound'](); expect(h.protection()).toBeDefined();
    const queries = h.trading.getOrderFillDetails.mock.calls.length;
    await h.service['checkAndStartNewRound']();
    expect(h.trading.getOrderFillDetails.mock.calls.length).toBeGreaterThan(queries);
    expect(h.protection()).toBeUndefined();
    expect(h.ctf.getPositionBalanceByTokenIds).toHaveBeenLastCalledWith('condition', { yesTokenId: 'up', noTokenId: 'down' });
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
  });

  it('UNCERTAIN with a unique order identity waits for complete terminal facts', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'UNCERTAIN', orderId: 'known', tradeIds: ['known'] });
    await h.leg1();
    Object.assign(h.service, { currentRound: { roundId: 'B', phase: 'waiting' } });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    h.trading.getTradeStatuses.mockResolvedValueOnce([]);
    await h.service['checkAndStartNewRound']();
    expect(h.protection()?.reason).toBe('DIP_ARB_UNCERTAIN');
    await h.service['checkAndStartNewRound']();
    expect(h.protection()).toBeUndefined();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledWith('known');
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service.getStats().totalProfit).toBe(0);
  });

  it('UNCERTAIN without identity remains protected independently of resolved A', async () => {
    const h = fixture(); await h.leg1();
    h.trading.getOrderFillDetails.mockClear();
    Object.assign(h.service, { currentRound: { roundId: 'B', phase: 'waiting' } });
    h.trading.createMarketOrder.mockResolvedValueOnce({ success: false, submissionState: 'UNCERTAIN' });
    await h.service.executeLeg1({ ...h.signal, roundId: 'B', tokenId: 'down', dipSide: 'DOWN' });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    await h.service['checkAndStartNewRound']();
    expect(h.protection()).toBeUndefined();
    expect(h.protection('down')?.reason).toBe('DIP_ARB_UNCERTAIN');
    await h.service['checkAndStartNewRound']();
    expect(h.protection('down')).toBeDefined();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'expired'])('%s is not release authority', async phase => {
    const h = fixture(); await h.leg1();
    h.trading.getOrderFillDetails.mockClear(); h.round.phase = phase;
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: [], sizeMatched: '10' });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    await h.service['checkAndStartNewRound']();
    expect(h.protection()).toBeDefined();
    await h.service['checkAndStartNewRound']();
    expect(h.protection()).toBeDefined();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(2);
  });

  it('concurrent passes and emergency proof share cleanup without accounting replay', async () => {
    const h = fixture(); await h.leg1();
    h.trading.getOrderFillDetails.mockClear();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    const facts = deferred(); h.trading.getOrderFillDetails.mockReturnValueOnce(facts.promise);
    const first = h.service['reconcileProtectedClobLifecycles']();
    const second = h.service['reconcileProtectedClobLifecycles']();
    expect(second).toBe(first);
    const exit = h.exit();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(1);
    facts.resolve({ tradeIds: ['order-1'], sizeMatched: '10' });
    await Promise.all([first, second, exit]);
    expect(h.protection()).toBeUndefined();
    const stats = economicStats(h.service);
    await h.service['reconcileProtectedClobLifecycles']();
    expect(h.trading.getOrderFillDetails).toHaveBeenCalledTimes(1);
    expect(economicStats(h.service)).toEqual(stats);
    expect(h.events.execution).not.toHaveBeenCalled();
    expect(h.events.roundComplete).not.toHaveBeenCalled();
    expect(h.events.settled).not.toHaveBeenCalled();
  });

  it('known children survive partial order queries and release only after complete late facts', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockResolvedValueOnce({ ...accepted('order'), tradeIds: ['a', 'b'] });
    await h.leg1();
    Object.assign(h.service, { currentRound: { roundId: 'B', phase: 'waiting' } });
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: ['a'], sizeMatched: '5.000000' })
      .mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '10.000000' });
    h.trading.getTradeStatuses.mockResolvedValueOnce([{ id: 'a', status: 'MINED', transactionHash: 'tx-a', size: '5' }])
      .mockImplementation(async ids => ids.map(id => ({ id, status: 'MINED', transactionHash: 'tx-' + id, size: '5.000000' })));
    const stats = economicStats(h.service);
    await h.service['checkAndStartNewRound']();
    expect(h.protection()).toBeDefined();
    expect(h.trading.getTradeStatuses).toHaveBeenLastCalledWith(['a', 'b']);
    await h.service['checkAndStartNewRound']();
    expect(h.protection()).toBeUndefined();
    expect(h.trading.getTradeStatuses).toHaveBeenCalledTimes(2);
    expect(economicStats(h.service)).toEqual(stats);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    for (const key of ['execution', 'settled', 'roundComplete'] as const) expect(h.events[key]).not.toHaveBeenCalled();
  });

  it('discovered children are retained across cycles and duplicate identities are counted once', async () => {
    const h = fixture();
    h.trading.createMarketOrder.mockResolvedValueOnce({ ...accepted('order'), tradeIds: ['a', 'a'] });
    await h.leg1();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: ['a', 'b', 'b'], sizeMatched: '10' })
      .mockResolvedValueOnce({ tradeIds: ['a'], sizeMatched: '5' })
      .mockResolvedValue({ tradeIds: ['a', 'b', 'a'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValueOnce([{ id: 'a', status: 'MINED', transactionHash: 'tx', size: '5' }])
      .mockImplementation(async ids => ids.map(id => ({ id, status: 'MINED', transactionHash: 'tx-' + id, size: '5' })));
    await h.service['reconcileProtectedClobLifecycles']();
    expect([...h.service['clobLifecycles'].values()][0].tradeIds).toEqual(['a', 'b']);
    await h.service['reconcileProtectedClobLifecycles']();
    expect(h.protection()).toBeDefined();
    expect(h.trading.getTradeStatuses).toHaveBeenLastCalledWith(['a', 'b']);
    await h.service['reconcileProtectedClobLifecycles']();
    expect(h.protection()).toBeUndefined();
  });

  it.each(['FAILED', 'MATCHED'])('known %s child is resolved only by factual terminal status', async status => {
    const h = fixture();
    h.trading.createMarketOrder.mockResolvedValueOnce({ ...accepted('order'), tradeIds: ['a', 'b'] });
    await h.leg1();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([
      { id: 'a', status: 'MINED', transactionHash: 'tx', size: '5' },
      { id: 'b', status, transactionHash: '', size: '5' },
    ]);
    await h.service['reconcileProtectedClobLifecycles']();
    expect(!!h.protection()).toBe(status !== 'FAILED');
  });

  it.each(['10', '10.0', '10.00', '10.000', '10.000000', '4.2', '4.20', '4.200000', '4.25', '4.250000'])('exact quantity %s releases with complete facts', async quantity => {
    const h = fixture(); await h.leg1();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['order-1'], sizeMatched: quantity });
    const canonical = quantity.startsWith('10') ? '10' : quantity.startsWith('4.25') ? '4.25' : '4.2';
    h.trading.getTradeStatuses.mockResolvedValue([{ id: 'order-1', status: 'MINED', transactionHash: 'tx', size: canonical }]);
    await h.service['reconcileProtectedClobLifecycles']();
    expect(h.protection()).toBeUndefined();
  });

  it.each(['4.251', '10.000001', '1.234', '-1', '', 'NaN', 'Infinity', 'text', '1e1', ' 10', '+10', '10.'])('invalid quantity %j cannot be rounded or truncated', async quantity => {
    const h = fixture(); await h.leg1();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['order-1'], sizeMatched: quantity });
    h.trading.getTradeStatuses.mockResolvedValue([{ id: 'order-1', status: 'MINED', transactionHash: 'tx', size: quantity }]);
    await h.service['reconcileProtectedClobLifecycles']();
    expect(h.protection()).toBeDefined();
  });

  it('complete children do not release when exact quantities disagree', async () => {
    const h = fixture(); await h.leg1();
    h.ctf.getPositionBalanceByTokenIds.mockResolvedValue({ yesBalance: '0', noBalance: '0' });
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['order-1'], sizeMatched: '4.250000' });
    h.trading.getTradeStatuses.mockResolvedValue([{ id: 'order-1', status: 'MINED', transactionHash: 'tx', size: '4.20' }]);
    await h.service['reconcileProtectedClobLifecycles']();
    expect(h.protection()).toBeDefined();
  });

  it('discovered failed children preserve the attempt without terminal order proof', async () => {
    const h = fixture(true);
    h.trading.createMarketOrder.mockResolvedValueOnce({ ...accepted('sell-1'), tradeIds: ['a'] });
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: ['a'], sizeMatched: '10' });
    await h.exit();
    const first = [...h.service['clobLifecycles'].values()].find(r => r.writerType === 'EMERGENCY_EXIT')!;
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockImplementation(async ids => ids.map(id => ({ id, status: 'MATCHED', transactionHash: '', size: '5' })));
    await h.service['reconcileProtectedClobLifecycles']();
    expect(first.tradeIds).toEqual(['a', 'b']);
    expect(h.round.leg1.exitTradeIds).toEqual(['a']);
    h.trading.getTradeStatuses.mockImplementation(async ids => ids.map(id => ({ id, status: 'FAILED', transactionHash: '', size: '5' })));
    const position = h.round.leg1;
    const stats = economicStats(h.service);
    expect(await h.exit()).toMatchObject({ success: false, orderId: 'sell-1' });
    expect(h.trading.getTradeStatuses).toHaveBeenLastCalledWith(['a', 'b']);
    expect(h.round.leg1).toBe(position);
    expect(position.shares).toBe(10);
    expect(position.exitPending).toBe(true);
    expect(h.protection()).toBeDefined();
    await h.exit();
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.service['clobLifecycles'].get(first.operationId)).toBe(first);
    expect(economicStats(h.service)).toEqual(stats);
    for (const key of ['execution', 'settled', 'roundComplete'] as const) expect(h.events[key]).not.toHaveBeenCalled();
  });

  it.each(['missing', 'pending', 'success'])('discovered child %s prevents all-failed cleanup', async state => {
    const h = fixture(true);
    h.trading.createMarketOrder.mockResolvedValueOnce({ ...accepted('sell-1'), tradeIds: ['a'] });
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: ['a'], sizeMatched: '10' });
    await h.exit();
    h.trading.getOrderFillDetails.mockResolvedValue({ tradeIds: ['a', 'b'], sizeMatched: '10' });
    h.trading.getTradeStatuses.mockResolvedValue([]);
    await h.service['reconcileProtectedClobLifecycles']();
    const first = [...h.service['clobLifecycles'].values()].find(r => r.writerType === 'EMERGENCY_EXIT')!;
    h.trading.getTradeStatuses.mockResolvedValue([
      { id: 'a', status: 'FAILED', transactionHash: '', size: '5' },
      ...(state === 'missing' ? [] : [{ id: 'b', status: state === 'success' ? 'MINED' : 'MATCHED',
        transactionHash: state === 'success' ? 'tx-b' : '', size: '5' }]),
    ]);
    await h.exit(); await h.exit();
    expect(h.trading.getTradeStatuses).toHaveBeenLastCalledWith(['a', 'b']);
    expect(h.service['clobLifecycles'].get(first.operationId)).toBe(first);
    expect(h.round.leg1.exitPending).toBe(true);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect(h.protection()).toBeDefined();
  });

  it('concurrent known-failed observations retain the original exit', async () => {
    const h = fixture(true);
    h.trading.createMarketOrder.mockResolvedValueOnce({ ...accepted('sell-1'), tradeIds: ['a'] });
    h.trading.getOrderFillDetails.mockResolvedValueOnce({ tradeIds: ['a'], sizeMatched: '10' });
    await h.exit();
    const facts = deferred();
    h.trading.getTradeStatuses.mockReturnValue(facts.promise);
    h.trading.createMarketOrder.mockResolvedValueOnce({ ...accepted('sell-2'), tradeIds: ['c'] });
    const one = h.exit(), two = h.exit();
    await Promise.resolve(); await Promise.resolve();
    facts.resolve([{ id: 'a', status: 'FAILED', size: '10' }]);
    await Promise.all([one, two]);
    expect(h.trading.createMarketOrder).toHaveBeenCalledTimes(1);
    expect([...h.service['clobLifecycles'].values()].filter(r => r.writerType === 'EMERGENCY_EXIT'))
      .toEqual([expect.objectContaining({ orderId: 'sell-1', tradeIds: ['a'] })]);
    expect(h.round.leg1.exitPending).toBe(true);
    expect(h.protection()).toBeDefined();
  });

});
