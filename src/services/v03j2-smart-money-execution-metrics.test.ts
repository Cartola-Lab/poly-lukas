import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { SmartMoneyService } from './smart-money-service.js';
const wallet='whale', hash='0x'+'12'.repeat(32);
beforeEach(()=>{ vi.stubEnv('DRY_RUN','false'); vi.spyOn(console,'warn').mockImplementation(()=>{}); });
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(dryRun=false, observerThrows=false) {
  // Execute the actual dashboard consumer; do not duplicate its BUY-only entry gate.
  const source=readFileSync(new URL('../../bot-with-dashboard.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('dashboard.ts',source,ts.ScriptTarget.ES2022,true);
  const callback=ast.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text==='smartMoneyCallbacks'))!;
  const recordEntry=vi.fn();
  const dashboard=runInNewContext(ts.transpileModule(callback.getText(ast)+'; smartMoneyCallbacks;',
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {recordEntry,log:()=>{},CONFIG:{dryRun:false},state:{},arbService:undefined});
  const onTrade=vi.fn((trade,result)=>{dashboard.onTrade(trade,result);if(observerThrows)throw new Error('observer');});
  let incoming:any, serial=0;
  const orders=new Map<string,any>();
  const trading={getAddress:()=> '0x'+'ab'.repeat(20),
    createMarketOrder:vi.fn(async(p:any)=>{const id=String(++serial);orders.set(id,{side:p.side,token:p.tokenId,trades:[],status:'MATCHED'});return{success:true,submissionState:'ACCEPTED',orderId:id};}),
    getOrderFillDetails:vi.fn(async(id:string)=>{const o=orders.get(id);return{id,asset_id:o.token,side:o.side,status:o.status,
      tradeEnumerationPresent:true,sizeMatched:String(o.trades.reduce((sum:number,t:any)=>sum+Number(t.localSize),0)),tradeIds:o.trades.map((t:any)=>t.id)};}),
    getTradeStatuses:vi.fn(async(ids:string[])=>[...orders.values()].flatMap(o=>o.trades).filter(t=>ids.includes(t.id)))};
  const svc=new SmartMoneyService({} as any,{} as any,trading as any);
  vi.spyOn(svc,'subscribeSmartMoneyTrades').mockImplementation(cb=>{incoming=cb;return{id:'s',unsubscribe(){}};});
  const sub=await svc.startAutoCopyTrading({targetAddresses:[wallet],delay:0,minTradeSize:1,feeRateBps:100,dryRun,onTrade});
  const submit=async(side='BUY')=>{await incoming({traderAddress:wallet,side,tokenId:'token',size:100,price:.4,timestamp:Date.now()});return String(serial);};
  const observe=async(id:string,sizes:number[],patch:any={},status='MATCHED')=>{
    const o=orders.get(id);o.status=status;o.trades=sizes.map((size,i)=>({id:id+':'+i,localSize:size,size:String(size),price:'0.5',
      status:'CONFIRMED',transactionHash:hash,asset_id:o.token,side:o.side,taker_order_id:id,trader_side:'TAKER',maker_orders:[],...patch}));
    await sub.reconcile();
  };
  const zero=()=>{expect(sub.stats).toMatchObject({tradesExecuted:0,totalUsdcSpent:0,totalFeesEstimateUsd:0});
    expect(svc.getWalletHealth()[wallet]?.copiesExecuted??0).toBe(0);
    expect(sub.stats.perWallet[wallet]?.executed??0).toBe(0);expect(recordEntry).not.toHaveBeenCalled();expect(onTrade).not.toHaveBeenCalled();};
  return{svc,sub,submit,observe,zero,onTrade,recordEntry,trading,orders};
}
describe('P0.3j.2 factual execution metrics',()=>{
  it('acceptance-only has zero execution metrics and entry',async()=>{const h=await fixture();await h.submit();await h.sub.reconcile();h.zero();});
  it.each([{status:'FAILED'},{status:'UNKNOWN'},{status:undefined},{transactionHash:'invalid'},{asset_id:'other'},{taker_order_id:'other'}])('rejects %j without metrics',async patch=>{
    const h=await fixture();await h.observe(await h.submit(),[4],patch);h.zero();
  });
  it('CANCELED zero fill has zero metrics',async()=>{const h=await fixture();await h.observe(await h.submit(),[],{},'CANCELED');h.zero();});
  it('4 then +6 uses execution price, never requested cost; entry exactly once',async()=>{
    const h=await fixture();const id=await h.submit();h.zero();await h.observe(id,[4]);
    expect(h.sub.stats).toMatchObject({tradesExecuted:1,totalUsdcSpent:2,totalFeesEstimateUsd:.02});
    expect(h.onTrade.mock.calls[0][0]).toMatchObject({size:4,price:.5});expect(h.recordEntry).toHaveBeenCalledWith('smartMoney');
    await h.observe(id,[4,6]);await h.sub.reconcile();
    expect(h.sub.stats).toMatchObject({tradesExecuted:1,totalUsdcSpent:5,totalFeesEstimateUsd:.05});
    expect(h.svc.getWalletHealth()[wallet].copiesExecuted).toBe(1);expect(h.sub.stats.perWallet[wallet].executed).toBe(1);
    expect(h.onTrade).toHaveBeenCalledTimes(1);expect(h.recordEntry).toHaveBeenCalledTimes(1);
  });
  it('4 to 7 to 10 accumulates monetary deltas and counts only one copy',async()=>{
    const h=await fixture();const id=await h.submit();let prior=0;
    for(const [sizes,delta] of [[[4],2],[[4,3],1.5],[[4,3,3],1.5]] as const){
      await h.observe(id,[...sizes]);await Promise.all([h.sub.reconcile(),h.sub.reconcile()]);
      expect(h.sub.stats.totalUsdcSpent-prior).toBeCloseTo(delta);prior=h.sub.stats.totalUsdcSpent;
      expect(h.sub.stats.totalFeesEstimateUsd).toBeCloseTo(prior*.01);expect(h.sub.stats.tradesExecuted).toBe(1);
    }
    expect(h.recordEntry).toHaveBeenCalledTimes(1);
  });
  it('maker uses only local allocation and price',async()=>{
    const h=await fixture();const id=await h.submit();await h.observe(id,[4],{size:'20',price:'0.9',side:'SELL',trader_side:'MAKER',taker_order_id:'other',
      maker_orders:[{order_id:id,asset_id:'token',side:'BUY',matched_amount:'4',price:'0.4'},
        {order_id:'other-maker',asset_id:'token',side:'BUY',matched_amount:'16',price:'0.9'}]});
    expect(h.sub.stats.totalUsdcSpent).toBeCloseTo(1.6);expect(h.sub.stats.totalFeesEstimateUsd).toBeCloseTo(.016);
    expect(h.onTrade.mock.calls[0][0]).toMatchObject({size:4,price:.4});
  });
  it('separate executed orders count twice; acceptance-only order never counts',async()=>{
    const h=await fixture();const a=await h.submit();await h.observe(a,[4]);const b=await h.submit();
    expect(h.sub.stats.tradesExecuted).toBe(1);await h.observe(b,[3]);await h.submit();await h.sub.reconcile();
    expect(h.sub.stats.tradesExecuted).toBe(2);expect(h.svc.getWalletHealth()[wallet].copiesExecuted).toBe(2);
    expect(h.sub.stats.perWallet[wallet].executed).toBe(2);expect(h.recordEntry).toHaveBeenCalledTimes(2);
    expect(h.sub.stats.totalUsdcSpent).toBe(3.5);
  });
  it('CANCELED partial finalizes only factual metrics',async()=>{
    const h=await fixture();await h.observe(await h.submit(),[4],{},'CANCELED');await h.sub.reconcile();
    expect(h.sub.stats.totalUsdcSpent).toBe(2);expect(h.sub.stats.tradesExecuted).toBe(1);expect(h.recordEntry).toHaveBeenCalledTimes(1);
  });
  it('SELL execution counts once even with unresolved excess, but never BUY spend or entry',async()=>{
    const h=await fixture();const id=await h.submit('SELL');h.zero();await h.observe(id,[10],{},'CANCELED');await h.sub.reconcile();
    expect(h.sub.stats).toMatchObject({tradesExecuted:1,totalUsdcSpent:0,totalFeesEstimateUsd:.05,realizedPnlUsd:0});
    expect(h.recordEntry).not.toHaveBeenCalled();expect(h.onTrade).toHaveBeenCalledTimes(1);
    expect(h.svc.getWalletHealth()[wallet].copiesExecuted).toBe(1);
    h.trading.getOrderFillDetails.mockClear();await h.sub.reconcile();expect(h.trading.getOrderFillDetails).toHaveBeenCalledWith(id);
  });
  it('observer throw cannot duplicate metrics or prevent FIFO processing',async()=>{
    const h=await fixture(false,true);await h.observe(await h.submit(),[4],{},'CANCELED');await h.sub.reconcile();
    expect(h.recordEntry).toHaveBeenCalledTimes(1);expect(h.sub.stats.totalUsdcSpent).toBe(2);
    await h.observe(await h.submit('SELL'),[4],{price:'0.6'},'CANCELED');
    expect(h.sub.stats.realizedPnlUsd).toBeCloseTo(.4-.02-.024);
  });
  it('dry run is not factual execution',async()=>{const h=await fixture(true);await h.submit();h.zero();expect(h.trading.createMarketOrder).not.toHaveBeenCalled();});
});
