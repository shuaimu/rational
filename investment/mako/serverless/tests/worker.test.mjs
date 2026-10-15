import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,domain} from './fixtures.mjs';
import {JobStore,LEASE_MILLISECONDS} from '../shared/jobs.js';
import {Artifacts} from '../shared/artifacts.js';
import {JobWorker} from '../jobs/worker.js';
async function setup(){const f=await fixture();let now=Date.parse('2026-09-26T00:00:00Z');const jobs=new JobStore(()=>f.documents('robinlab_jobs'),{clock:()=>now,canonical:value=>domain({action:'canonical',value}).payload});const artifacts=new Artifacts(()=>f.documents('robinlab_inputs'));return {...f,jobs,artifacts,clock:()=>now,advance:ms=>{now+=ms;},tick:()=>{now+=LEASE_MILLISECONDS+1;},worker:()=>new JobWorker({jobs,artifacts,repository:f.repository(),domain,clock:()=>now})};}
async function drain(f,id,limit=30){let job;for(let i=0;i<limit;i++){job=await f.worker().run(id,`test_worker_${String(i).padStart(8,'0')}`);if(job?.body.state==='completed')return job;assert.ok(!['failed','needs-attention'].includes(job?.body.state));f.tick();}assert.fail('job did not finish');}
test('durable job resumes bounded history and stages from cold instances',async()=>{
 const f=await setup();for(let i=0;i<26;i++)await f.repository().execute(f.commandInput(`prior_command_${String(i).padStart(8,'0')}`,`P${i}`));
 const row=await f.jobs.admit('worker_command_000001','portfolio-command',{operation:'create_account',input:{code:'FINAL',name:null,account_type:null}});
 const done=await drain(f,row.body.id);assert.equal(done.body.result.version,28);assert.equal(done.body.result.response.code,'FINAL');
 assert.equal((await f.repository().load()).dataset.public.accounts.length,27);
 assert.equal((await f.jobs.admit('worker_command_000001','portfolio-command',{operation:'create_account',input:{code:'FINAL',name:null,account_type:null}})).body.state,'completed');
});
test('publication response loss recovers the original result without duplicate writes',async()=>{
 const f=await setup(),row=await f.jobs.admit('worker_command_000002','portfolio-command',{operation:'create_account',input:{code:'LOST',name:null,account_type:null}});
 f.state.loseResponse=true;const done=await drain(f,row.body.id);assert.equal(done.body.result.version,2);assert.equal((await f.repository().head()).body.sequence,2);assert.equal((await f.repository().load()).dataset.public.accounts.length,1);
});
test('captured inputs are job-scoped and reject corrupt chunks',async()=>{
 const f=await setup(),job=await f.jobs.admit('worker_command_000003','portfolio-command',{});
 const reference=await f.artifacts.save(job.body.id,{payload:'x'.repeat(300000)});
 assert.equal((await f.artifacts.load(job.body.id,reference)).payload.length,300000);
 await assert.rejects(()=>f.artifacts.load('j_'+'a'.repeat(64),reference));
 const root=f.state.rows.get(`robinlab_inputs:${reference.id}`),chunk=f.state.rows.get(`robinlab_inputs:${root.body.chunks[0]}`);chunk.body.payload='AAAA';
 await assert.rejects(()=>f.artifacts.load(job.body.id,reference));
});

test('SnapTrade captures immutable pages, previews without a head change, and applies once',async()=>{
 const {SnapTradeCapture}=await import('../jobs/snaptrade.js');
 const f=await setup();await f.repository().execute(f.commandInput('capture_account_00001','CAPTURE'));
 for(const [id,operation,input,captured] of [
  ['capture_discover_0001','discover_snaptrade_accounts',{accounts:[{id:'remote',name:null,number:null,brokerage_authorization:null,institution_name:null}]},{userId:'personal'}],
  ['capture_link_0000001','link_snaptrade_account',{snaptrade_account_id:'remote',account_id:1},undefined],
 ])await f.repository().execute({identity:domain({action:'identity',id,operation,input}),operation,input,captured,now:'2026-09-26 00:00:00'});
 let fetched=0;
 const activity={type:'BUY',symbol:{symbol:'TEST'},units:2,price:10,amount:-20,trade_date:'2026-09-25',fee:0};
 const broker={user:()=>null,activities:async()=>{fetched++;return {data:[activity,activity]};},positions:async()=>[{symbol:{symbol:'TEST'},units:4}],accounts:async()=>[{id:'remote',balance:{total:{amount:40}}}]};
 const cache={latest:async()=>[],get:async()=>null,markSplit:async()=>{}};
 f.worker=()=>{const repository=f.repository();return new JobWorker({jobs:f.jobs,repository,artifacts:f.artifacts,domain,cache,clock:f.clock,snaptradeCapture:new SnapTradeCapture({repository,artifacts:f.artifacts,broker,cache,domain,clock:f.clock,http:async()=>Response.json({})})});};
 const opts={apply:false,reconstruct_rolls:true,fresh:false,replace:false,roll_detect:false,start_date:null};
 const head=(await f.repository().head()).body.sequence;
 const preview=await f.jobs.admit('capture_preview_00001','snaptrade',opts),result=await drain(f,preview.body.id,50);
 assert.equal((await f.repository().head()).body.sequence,head);assert.equal(result.body.result.version,0);assert.ok(result.body.result.responseArtifact);
 const applied=await f.jobs.admit('capture_apply_0000001','snaptrade',{...opts,apply:true});f.advance(10*86400000);const complete=await drain(f,applied.body.id,50);
 assert.equal(complete.body.result.syncedAt,new Date(f.clock()).toISOString().slice(0,19).replace('T',' '));
 assert.equal(await f.jobs.lastBrokerSync(),complete.body.result.syncedAt);
 const mapping=(await f.repository().load()).dataset.private.snaptrade_accounts[0];
 assert.equal(mapping.last_synced_date,'2026-10-06');assert.ok(mapping.updated_at.startsWith('2026-10-06'));
 assert.ok(complete.body.result.captureStartedAt>applied.body.createdAt);
 assert.equal(complete.body.result.version,head+1);assert.equal((await f.repository().load()).dataset.public.transactions.length,2);assert.equal(fetched,2);
 assert.equal((await f.jobs.admit('capture_apply_0000001','snaptrade',{...opts,apply:true})).body.state,'completed');assert.equal(fetched,2);
});

test('commercial registration captures the secret once and publishes through the command journal',async()=>{
 const f=await setup();let calls=0;const broker={personal:false,register:async userId=>{calls++;return {userId,userSecret:'fixture-secret'};}};
 f.worker=()=>new JobWorker({jobs:f.jobs,artifacts:f.artifacts,repository:f.repository(),domain,broker,clock:f.clock});
 const job=await f.jobs.admit('snaptrade_registration_v1','register',{}),done=await drain(f,job.body.id);
 assert.equal(calls,1);assert.equal(done.body.result.response.status,'registered');
 assert.equal((await f.repository().load()).dataset.private.snaptrade_users.length,1);
 assert.ok(!JSON.stringify(f.jobs.status(done)).includes('fixture-secret'));
});
test('registration interruption recovers a captured result but never repeats an uncertain external call',async()=>{
 for(const hasResponse of [false,true]){
  const f=await setup();let calls=0;const broker={personal:false,register:async()=>{calls++;throw Error('must not run');}};
  f.worker=()=>new JobWorker({jobs:f.jobs,artifacts:f.artifacts,repository:f.repository(),domain,broker,clock:f.clock});
  const job=await f.jobs.admit('snaptrade_registration_v1','register',{}),claim=await f.jobs.claim(job.body.id,'interrupted_worker_1');
  const userId=`robinlab_${job.body.id.slice(2)}`;
  await f.jobs.checkpoint(claim,{phase:'register_pending',userId},{state:'committing'});
  if(hasResponse)await f.artifacts.save(job.body.id,{mode:'commercial',userId,userSecret:'fixture-secret'},{name:'registration-response'});
  f.tick();
  if(hasResponse)assert.equal((await drain(f,job.body.id)).body.result.response.status,'registered');
  else {const review=await f.worker().run(job.body.id,'recovered_worker_1');assert.equal(review.body.state,'needs-attention');assert.equal(review.body.artifactsExpireAt,null);}
  assert.equal(calls,0);
 }
});
test('provider retry-after survives a cold worker without an in-memory timer',async()=>{
 const {ProviderError}=await import('../shared/providers.js'),f=await setup(),retryAt=f.clock()+300000;
 const job=await f.jobs.admit('provider_retry_000001','snaptrade',{apply:false});
 const worker=new JobWorker({jobs:f.jobs,domain,clock:f.clock,snaptradeCapture:{step:async()=>{throw new ProviderError('rate_limited',{retryAt});}}});
 const retry=await worker.run(job.body.id,'provider_worker_001');assert.equal(retry.body.dueAt,retryAt);
 f.tick();assert.equal(await f.jobs.claim(job.body.id,'provider_worker_002'),null);
});

test('legacy and expired unpublished captures restart with the same command and current date',async()=>{
 const {SnapTradeCapture}=await import('../jobs/snaptrade.js');
 const f=await setup(),job=await f.jobs.admit('stale_capture_000001','snaptrade',{apply:true});
 const seen=[];const capture=new SnapTradeCapture({repository:{snapshotStep:async()=>({done:true,dataset:{}})},broker:{user:()=>null},artifacts:f.artifacts,cache:{},clock:f.clock,domain:input=>{seen.push(input);return {today:input.today,linked:[],splitSymbols:[]};}});
 for(const startedAt of [undefined,f.clock()-86400000]){
  const old=await f.artifacts.save(job.body.id,{phase:'positions',account:4,startedAt,today:'2026-09-01'});
  const next=await capture.step(job.body,old),state=await f.artifacts.load(job.body.id,next.reference);
  assert.equal(state.phase,'activities');assert.equal(state.startedAt,f.clock());assert.equal(state.today,'2026-09-26');assert.deepEqual(state.pages,[]);
 }
 assert.equal(seen.length,2);assert.equal((await f.jobs.get(job.body.id)).body.commandId,job.body.commandId);
});
test('planning discards a pinned snapshot when another command advances the head',async()=>{
 const f=await setup(),job=await f.jobs.admit('snapshot_plan_race_01','portfolio-command',{operation:'create_account',input:{code:'JOB',name:null,account_type:null}});
 let row;
 for(let i=0;i<15;i++){
  row=await f.worker().run(job.body.id,'snapshot_race_worker_01');f.tick();
  if(row?.body.checkpoint?.snapshot)break;
 }
 assert.ok(row.body.checkpoint.snapshot);
 await f.repository().execute(f.commandInput('snapshot_other_0001','OTHER'));
 const complete=await drain(f,job.body.id,50);assert.equal(complete.body.result.version,3);
 assert.deepEqual((await f.repository().load()).dataset.public.accounts.map(a=>a.code).sort(),['JOB','OTHER']);
});

test('split capture bounds concurrent reads and checkpoints both results together',async()=>{
 const {SnapTradeCapture}=await import('../jobs/snaptrade.js');const f=await setup(),job=await f.jobs.admit('split_batch_bound_01','snaptrade',{});
 const state={startedAt:f.clock(),phase:'splits',splitOffset:0,splitSymbols:['A','B','C'],splits:[],refreshed:[]};
 const ref=await f.artifacts.save(job.body.id,state);let active=0,maximum=0,calls=0;
 const capture=new SnapTradeCapture({artifacts:f.artifacts,clock:f.clock,cache:{get:async()=>null},domain:({symbol})=>[{symbol,split_date:'2026-09-01',multiplier:2}],http:async()=>{calls++;maximum=Math.max(maximum,++active);await new Promise(resolve=>setImmediate(resolve));active--;return Response.json({});}});
 const next=await capture.step(job.body,ref),saved=await f.artifacts.load(job.body.id,next.reference);
 assert.equal(calls,2);assert.equal(maximum,2);assert.equal(saved.splitOffset,2);assert.deepEqual(saved.refreshed,['A','B']);assert.deepEqual(saved.splits.map(row=>row.symbol),['A','B']);assert.equal((await f.artifacts.load(job.body.id,ref)).splitOffset,0);
});

test('large staging plans checkpoint before a bounded transport budget and publish once',async()=>{
 const f=await setup(),job=await f.jobs.admit('bounded_stage_command_001','portfolio-command',{});
 const plan=await f.artifacts.save(job.body.id,{public_content:Array.from({length:33},(_,i)=>({id:`public_${i}`})),private_content:[],command:{id:'command'}});
 const claim=await f.jobs.claim(job.body.id,'stage_setup_worker');
 await f.jobs.checkpoint(claim,{phase:'stage',plan,offset:0},{state:'retry',retryAt:f.clock()+1000});f.tick();
 const staged=new Set();let publications=0;
 f.worker=()=>{let writes=0;return new JobWorker({jobs:f.jobs,artifacts:f.artifacts,clock:f.clock,repository:{stage:async(kind,body)=>{assert.ok(++writes<=16,'phase exceeded transport budget');staged.add(body.id);},publishHead:async()=>{assert.equal(staged.size,34);publications++;return {version:2};}}});};
 const first=await f.worker().run(job.body.id,'bounded_stage_worker');
 assert.equal(first.body.error,null);assert.equal(first.body.checkpoint.offset,16);assert.equal(publications,0);f.tick();
 const done=await drain(f,job.body.id);assert.equal(done.body.result.version,2);assert.equal(publications,1);
});
