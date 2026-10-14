// Explicit migration smoke test. Run with writers/scheduler paused; journal all
// reversible synthetic rows so cleanup never touches an existing transaction.
import assert from 'node:assert/strict';
import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {MakoAuthClient,MemoryAuthSessionPersistence,normalizeMakoRxdbConfig} from '@mako-cloud/rxdb';
const [phase,directory]=process.argv.slice(2);
if(!['read','write','cleanup','replay','integrations'].includes(phase)||!directory)throw new Error('Usage: mako-smoke-api.mjs read|write|cleanup|replay|integrations PRIVATE_RUN_DIRECTORY');
const dir=resolve(directory),journal=resolve(dir,'api-smoke-journal.json');
assert.equal((await stat(dir)).mode&0o077,0);
const config=JSON.parse(await readFile(new URL('../src/api/mako-config.json',import.meta.url),'utf8'));
const identities=JSON.parse(await readFile(new URL('../../.local/mako-migration/qualification-identities.json',import.meta.url),'utf8'));
const source=JSON.parse(await readFile(resolve(dir,'source.json'),'utf8'));
let saved;try{saved=JSON.parse(await readFile(journal,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;saved={format:1,run:randomUUID(),steps:{},createdIds:[],checks:[]};}
async function persist(){await writeFile(journal+'.tmp',JSON.stringify(saved)+'\n',{mode:0o600});await rename(journal+'.tmp',journal);}
const auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}),{persistence:new MemoryAuthSessionPersistence()});
const session=await auth.signInWithPassword(identities.owner.email,identities.owner.password);assert.equal(session.user.id,config.ownerId);
async function call(method,path,body,step,expected=200){
 const headers={Authorization:`Bearer ${await auth.validAccessToken()}`};
 if(step){headers['Idempotency-Key']=`smoke_${saved.run}_${step}`;await persist();}
 const init={method,headers,signal:AbortSignal.timeout(240000)};
 if(body instanceof FormData)init.body=body;
 else if(body!==undefined){headers['Content-Type']='application/json';init.body=JSON.stringify(body);}
 const response=await fetch('http://127.0.0.1:3000/api'+path,init);
 const result=await response.json();assert.equal(response.status,expected,`${method} ${path}: HTTP ${response.status}`);
 if(step&&expected===200){if(saved.steps[step])assert.deepEqual(result,saved.steps[step].result,'durable replay changed');else saved.steps[step]={result,version:Number(response.headers.get('x-robinlab-version'))};await persist();}
 return result;
}
async function check(name){saved.checks.push(name);await persist();console.log('Passed API smoke: '+name);}
async function remember(ids){for(const id of ids)if(!saved.createdIds.includes(id))saved.createdIds.push(id);await persist();}
async function allTransactions(){
 const rows=[];
 for(let offset=0;offset<100000;offset+=500){
  const page=await call('GET',`/transactions?limit=500&offset=${offset}`);
  assert.ok(Array.isArray(page.items));rows.push(...page.items);
  if(rows.length>=page.total)return rows;
  assert.ok(page.items.length>0,'Pagination stopped before total');
 }
 throw new Error('Transaction pagination bound exceeded');
}
try{
 if(phase==='read'){
  const unauth=await fetch('http://127.0.0.1:3000/api/accounts');assert.equal(unauth.status,401);
  const accounts=await call('GET','/accounts');assert.equal(accounts.length,source.public.accounts.length);
  const tickers=await call('GET','/tickers');assert.equal(tickers.length,source.public.tickers.length);
  for(const path of ['/transactions','/positions','/analytics/summary','/analytics/performance','/analytics/accounts-performance','/analytics/yield','/analytics/ticker-pnl','/prices','/snaptrade/status','/admin/api-usage','/admin/cache-coverage?symbol=SPY','/admin/cache-price-trend?symbol=SPY']){await call('GET',path);await check(path);}
  await check('owner-only reads and baseline account/ticker counts');
 }
 if(phase==='integrations'){
  // Run with market-data providers and the scheduler disabled. Broker preview
  // fetches remote activities but does not publish transactions or watermarks.
  const before=await call('GET','/portfolio/version');
  await call('POST','/import/snaptrade?apply=false');
  assert.deepEqual(await call('GET','/portfolio/version'),before);
  await check('SnapTrade preview with available credentials leaves head unchanged');
  await call('POST','/admin/api-usage/cache/clear',{scope:'invalid_smoke_scope'},undefined,400);
  await call('POST','/admin/api-usage/cache/prefetch',{symbols:[]},undefined,400);
  await call('POST','/admin/api-usage/cache/prefetch',{symbols:['SPY'],days:7});
  await check('cache admin validation and cached-price prefetch');
 }
 if(phase==='write'){
  assert.ok(!saved.cleaned,'This run was already cleaned.');
  const account=source.public.accounts[0],ticker=source.public.tickers.find(t=>t.symbol==='SPY')??source.public.tickers[0];
  saved.accountId=account.id;saved.tickerId=ticker.id;await persist();
  const base={account_id:account.id,ticker_id:ticker.id,transaction_type:'Sell short',quantity:-1,price:100,cost:-100,fees:0,date:'2026-09-24',option_type:'P',strike_price:1,expiration_date:'2030-01-18',status:'open'};
  for(const operation of ['close','expire','assign','roll']){
   const option_code=`ROBINLAB_SMOKE_${saved.run}_${operation}`;
   const lot=await call('POST','/transactions',{...base,option_code},'create_'+operation);await remember([lot.id]);
   const repeat=await call('POST','/transactions',{...base,option_code},'create_'+operation);assert.equal(repeat.id,lot.id);
   let input={account_id:account.id,ticker_id:ticker.id,option_code,opened_date:base.date,option_type:'P',strike_price:1,expiration_date:base.expiration_date,original_quantity:-1};
   if(operation==='close')input={...input,quantity:1,cost:10,fees:0,close_date:'2026-09-25'};
   if(operation==='assign')input={...input,assignment_date:'2026-09-25'};
   if(operation==='roll')input={account_id:account.id,ticker_id:ticker.id,old_option_code:option_code,old_opened_date:base.date,old_option_type:'P',old_strike_price:1,old_expiration_date:base.expiration_date,quantity:1,roll_date:'2026-09-25',new_option_type:'P',new_strike_price:1,new_expiration_date:'2030-02-15',new_option_code:option_code+'_rolled',roll_cost:0,close_fees:0,open_fees:0};
   const result=await call('POST',`/transactions/${operation}-option`,input,operation);
   const ids=Object.entries(result).filter(([k])=>k.endsWith('transaction_id')).map(([,v])=>v);assert.ok(ids.length>=1);await remember(ids);
   assert.equal((await call('GET',`/transactions/${lot.id}`)).status,'closed');
   await check(operation+' option and create replay');
  }
  const trade=await call('POST','/transactions',{...base,transaction_type:'Buy',quantity:1,cost:12.5,price:12.5,option_code:`ROBINLAB_SMOKE_${saved.run}_rollback`},'rollback_trade');await remember([trade.id]);
  await call('PUT',`/transactions/${trade.id}`,{fees:0.25},'update_trade');
  assert.equal((await call('GET',`/transactions/${trade.id}`)).fees,0.25);
  await check('transaction create/update and retained rollback trade');
  execFileSync('python3',[new URL('../../scripts/mako_smoke_workbook.py',import.meta.url).pathname,dir],{stdio:'pipe'});
  const workbook=await readFile(resolve(dir,'smoke-import.xlsx'));
  const form=()=>{const body=new FormData();body.append('file',new Blob([workbook]),'smoke-import.xlsx');return body;};
  const imported=await call('POST','/import/excel',form(),'excel_first');
  assert.equal(imported.accounts_created,0);assert.equal(imported.tickers_created,0);assert.equal(imported.transactions_imported,2);
  await call('POST','/import/excel',form(),'excel_first');
  const dedup=await call('POST','/import/excel',form(),'excel_dedup');assert.equal(dedup.transactions_imported,0);
  const all=await allTransactions();
  const importedRows=all.filter(row=>row.option_code===`ROBINLAB_SMOKE_${saved.run}_excel`);assert.equal(importedRows.length,2);
  await remember(importedRows.map(row=>row.id));await check('Excel upload, durable replay and duplicate occurrence counts');
  saved.writesComplete=true;await persist();
 }
 if(phase==='replay'){
  assert.ok(saved.writesComplete&&!saved.cleaned);
  const id=saved.steps.rollback_trade.result.id;
  const response=await call('PUT',`/transactions/${id}`,{fees:0.25},'update_trade');assert.equal(response.fees,0.25);
  await check('mutation replay after backend restart');
 }
 if(phase==='cleanup'){
  assert.ok(saved.writesComplete,'Finish/replay interrupted writes before cleanup.');
  for(const id of saved.createdIds)await call('DELETE',`/transactions/${id}`,undefined,`delete_${id}`);
  const rows=await allTransactions();
  assert.ok(Array.isArray(rows));assert.ok(!rows.some(row=>saved.createdIds.includes(row.id)));
  saved.cleaned=true;await check('all synthetic transactions removed');
 }
}finally{await auth.signOut();}
