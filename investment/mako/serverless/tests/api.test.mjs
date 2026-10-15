import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../api/handler.js';
import {ApiError} from '../shared/errors.js';
import {fixture,domain} from './fixtures.mjs';
const request=(path,{method='GET',body,key='api_command_0000001',authorized=true}={})=>new Request(`https://fixture/scope/functions/v1/robinlab-api${path}`,{method,headers:{...(authorized?{authorization:'Bearer owner'}:{}),'content-type':'application/json','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function app(){const f=await fixture();return {...f,invoke:request=>createApi({authorize:async r=>{if(r.headers.get('authorization')!=='Bearer owner')throw new ApiError(401,'Unauthorized');},repository:f.repository(),domain,cache:{latest:async()=>[],pricesAt:async()=>[]},clock:()=>new Date('2026-09-26T00:00:00Z')})(request)};}
test('authentication precedes all route dispatch and malformed inputs',async()=>{
 const f=await app();for(const path of ['/accounts','/transactions','/positions','/analytics/yield','/uploads','/import/excel','/jobs/j_'+'a'.repeat(64),'/snaptrade/register','/admin/api-usage']) {
  const response=await f.invoke(request(path,{authorized:false}));assert.equal(response.status,401,path);
 }assert.equal(f.state.writes,0);
});
test('CRUD transport preserves original version on cold replay and rejects changed input',async()=>{
 const f=await app(),input={code:'SERVERLESS',name:null,account_type:null};
 const first=await f.invoke(request('/accounts',{method:'POST',body:input}));assert.equal(first.status,200);assert.equal(first.headers.get('x-robinlab-version'),'2');const account=await first.json();
 const replay=await f.invoke(request('/accounts',{method:'POST',body:input}));assert.equal(replay.headers.get('x-robinlab-version'),'2');assert.deepEqual(await replay.json(),account);
 const changed=await f.invoke(request('/accounts',{method:'POST',body:{...input,code:'CHANGED'}}));assert.equal(changed.status,409);
 assert.deepEqual(await (await f.invoke(request('/accounts/1'))).json(),account);
 const invalid=await f.invoke(request('/transactions?limit=NaN'));assert.equal(invalid.status,400);
 assert.equal((await f.invoke(request('/transactions?limit=1&limit=2'))).status,400);
 assert.equal((await f.invoke(request('/positions?include_closed=maybe'))).status,400);
});
test('all pure read families use the pinned Rust domain interface',async()=>{
 const f=await app();for(const path of ['/portfolio/version','/accounts','/tickers','/transactions','/positions','/positions/1','/prices','/analytics/summary','/analytics/performance','/analytics/ticker-pnl','/analytics/yield','/analytics/accounts-performance']) {
  const response=await f.invoke(request(path));assert.equal(response.status,200,`${path}: ${await response.text()}`);
 }assert.equal(f.state.writes,0);
});
test('option validation errors are returned without publishing any head',async()=>{
 const f=await app();for(const operation of ['roll','close','expire','assign']) {
  const response=await f.invoke(request(`/transactions/${operation}-option`,{method:'POST',body:{}}));assert.equal(response.status,400);
 }assert.equal(f.state.writes,0);
});

test('broker discovery, linking and personal registration use private domain records',async()=>{
 const f=await fixture();await f.repository().execute(f.commandInput('broker_account_000001','BROKER'));
 const {JobStore}=await import('../shared/jobs.js');const jobs=new JobStore(()=>f.documents('robinlab_jobs'));
 const broker={personal:true,user:()=>null,accounts:async()=>[{id:'remote_fixture',name:'Test',number:'masked',institution_name:'Fixture',brokerage_authorization:null}],connect:async()=>({redirectURI:'https://fixture.example/connect'})};
 const invoke=request=>createApi({authorize:async()=>{},repository:f.repository(),domain,jobs,broker,clock:()=>new Date('2026-09-26T00:00:00Z')})(request);
 const discovered=await invoke(request('/snaptrade/accounts'));assert.equal(discovered.status,200);assert.equal((await discovered.json()).accounts[0].linked_account_code,null);
 const linked=await invoke(request('/snaptrade/accounts/remote_fixture/link',{method:'POST',body:{account_id:1},key:'broker_link_0000001'}));assert.equal(linked.status,200);assert.deepEqual(await linked.json(),{status:'linked',account_code:'BROKER'});
 const registered=await invoke(request('/snaptrade/register',{method:'POST',body:{},key:'broker_register_0001'}));assert.equal(registered.status,200);assert.equal((await registered.json()).mode,'personal');
 const loaded=await f.repository().load();assert.equal(loaded.dataset.private.snaptrade_accounts[0].account_id,1);assert.equal(loaded.dataset.private.snaptrade_users.length,0);
 const status=await invoke(request('/snaptrade/status'));assert.deepEqual(await status.json(),{last_synced_at:'2026-09-26 00:00:00'});
 const {PortfolioRepository}=await import('../shared/repository.js');
 const metadata=new PortfolioRepository({documents:collection=>{assert.notEqual(collection,'portfolio_public','status must not read transaction history');return f.documents(collection);},domain});
 assert.deepEqual(await metadata.brokerAccounts(),loaded.dataset.private.snaptrade_accounts);
 const statusOnly=createApi({authorize:async()=>{},repository:metadata,domain,broker});
 assert.deepEqual(await (await statusOnly(request('/snaptrade/status'))).json(),{last_synced_at:'2026-09-26 00:00:00'});
 assert.equal((await invoke(request('/snaptrade/connect'))).status,200);
});
