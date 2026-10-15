import {ensure,batches} from '../shared/errors.js';
import {boundedJson} from '../shared/providers.js';
export class SnapTradeCapture {
 constructor({repository,broker,artifacts,cache,domain,http=fetch,clock=()=>Date.now()}){Object.assign(this,{repository,broker,artifacts,cache,domain,http,clock});}
 async step(job,reference){
  const id=job.id,options=job.input,startedAt=this.clock();
  let state=reference?await this.artifacts.load(id,reference):null;
  if(!state||!Number.isSafeInteger(state.startedAt)||startedAt-state.startedAt>=86400000)
   state={startedAt,phase:'load_portfolio'};
  if(state.phase==='load_portfolio'){
   const snapshot=await this.repository.snapshotStep(this.artifacts,id,state.snapshot);
   if(!snapshot.done)return {reference:await this.artifacts.save(id,{...state,snapshot:snapshot.reference})};
   const {dataset}=snapshot;
   state={startedAt:state.startedAt,...this.domain({action:'plan_snaptrade_capture',dataset,options,today:new Date(state.startedAt).toISOString().slice(0,10)}),user:this.broker.user(dataset),phase:'activities',account:0,offset:0,capturedBytes:0,pages:[],perAccount:[],stocks:[],balances:{},refreshed:[],latest:[]};
   return {reference:await this.artifacts.save(id,state)};
  }
  if(state.phase==='activities'){
   const account=state.linked[state.account];
   if(!account){state.phase=options.apply&&!options.roll_detect?'positions':'assemble';state.account=0;}
   else{
    const response=await this.broker.activities(state.user,account.sid,{offset:state.offset,limit:1000,startDate:account.start});
    const activities=Array.isArray(response)?response:response.data;ensure(Array.isArray(activities)&&activities.length<=1000,503,'Broker activity page is invalid');
    const normalized=this.domain({action:'normalize_snaptrade',account:account.code,activities});
    const page=await this.artifacts.save(id,normalized);state.capturedBytes+=page.bytes;ensure(state.capturedBytes<=32*1024*1024,413,'Broker capture exceeds byte bounds');state.pages.push(page);ensure(state.pages.length<=1000,413,'Broker capture exceeds page bounds');
    let report=state.perAccount[state.account];if(!report){report={account:account.code,snaptrade_account_id:account.sid,start_date:account.start,activities_pulled:0,normalized:0,earliest:null,latest:null};state.perAccount.push(report);}
    report.activities_pulled+=activities.length;report.normalized+=normalized.length;
    for(const row of normalized){if(!report.earliest||row.date<report.earliest)report.earliest=row.date;if(!report.latest||row.date>report.latest)report.latest=row.date;if(row.option_code)state.splitSymbols.push(row.ticker_symbol);}
    state.splitSymbols=[...new Set(state.splitSymbols)].sort();state.offset+=activities.length;
    const total=response.pagination?.total??0;
    if(!activities.length||activities.length<1000||total>0&&state.offset>=total){state.account++;state.offset=0;}
   }
  }else if(state.phase==='positions'){
   const account=state.linked[state.account];
   if(!account){state.phase='balances';}
   else{state.stocks.push(...this.domain({action:'normalize_snaptrade_stocks',account:account.code,positions:await this.broker.positions(state.user,account.sid)}));state.account++;}
  }else if(state.phase==='balances'){
   const accounts=await this.broker.accounts(state.user);ensure(Array.isArray(accounts),503,'Broker balance response is invalid');
   for(const account of accounts){const amount=account.balance?.total?.amount;if(typeof account.id==='string'&&Number.isFinite(amount))state.balances[account.id]=amount;}
   state.phase='splits';state.splitOffset=0;
  }else if(state.phase==='splits'){
   const symbols=state.splitSymbols.slice(state.splitOffset,state.splitOffset+2);
   if(!symbols.length){state.latest=await this.cache.latest();state.phase='assemble';}
   else{
    // Independent read-only feeds share one checkpoint and run concurrently, so
    // two slow feeds still consume one 12-second provider timeout budget.
    const results=await batches(symbols,2,async symbol=>{
     const prior=await this.cache.get('split_fetch',[symbol]),fetched=prior?.body.row.fetched_at;
     if(fetched&&Date.parse(fetched.replace(' ','T')+'Z')>state.startedAt-7*86400000)return {symbol,rows:null};
     let response={};
     try{const result=await this.http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=9999999999&interval=1d&events=split`,{headers:{'User-Agent':'Mozilla/5.0'},redirect:'manual',signal:AbortSignal.timeout(12000)});if(result.ok)response=await boundedJson(result);else await result.body?.cancel();}catch{}
     return {symbol,rows:this.domain({action:'normalize_splits',symbol,response})};
    });
    for(const {symbol,rows} of results)if(rows!==null){state.splits=state.splits.filter(row=>row.symbol!==symbol);state.splits.push(...rows);state.refreshed.push(symbol);}
    state.splitOffset+=symbols.length;
   }
  }else if(state.phase==='assemble'){
   const pages=await batches(state.pages,4,ref=>this.artifacts.load(id,ref));
   const captured={linked:state.linked.map(a=>[a.sid,a.account_id,a.code]),transactions:pages.flat(),per_account:state.perAccount,stocks:state.stocks,balances:state.balances,splits:state.splits,refreshed_split_symbols:state.refreshed,latest:state.latest,today:state.today};
   return {done:true,captured:await this.artifacts.save(id,captured),captureStartedAt:state.startedAt,captureCompletedAt:this.clock()};
  }else ensure(false,503,'Broker capture checkpoint is invalid');
  return {reference:await this.artifacts.save(id,state)};
 }
}
