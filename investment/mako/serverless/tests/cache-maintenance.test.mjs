import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,domain} from './fixtures.mjs';import {sha256} from '../shared/errors.js';import {PriceCache} from '../shared/cache.js';import {JobStore} from '../shared/jobs.js';import {JobLanes} from '../shared/coordination.js';import {Artifacts} from '../shared/artifacts.js';import {CacheMaintenance} from '../jobs/cache-maintenance.js';import {CacheReports} from '../jobs/cache-reports.js';import {JobWorker} from '../jobs/worker.js';import {historicalDigest,latestFromHistory} from '../shared/cache-generation.js';
async function setup(){
 const f=await fixture();let now=Date.parse('2026-09-26T00:00:00Z');
 const jobs=new JobStore(()=>f.documents('robinlab_jobs'),{clock:()=>now}),artifacts=new Artifacts(()=>f.documents('robinlab_inputs')),cache=new PriceCache(f.documents,{deadline:Infinity});
 const rows=Array.from({length:160},(_,i)=>({symbol:`S${i}`,price_date:'2026-09-25',price:i+1,source:'fixture',fetched_at:'2026-09-25 00:00:00',is_market_close:true}));
 for(const [collection,data,key]of [['historical_prices',rows,r=>[r.symbol,r.price_date]],['latest_prices',latestFromHistory(rows),r=>[r.symbol]]])for(const row of data){const id='r_'+await sha256(new TextEncoder().encode(JSON.stringify(key(row))));await f.documents(collection).mutate(id,{mutationId:crypto.randomUUID(),operation:'create',expectedRevision:null,schemaVersion:1,body:{id,row}});}
 const provider={capture:async()=>({source:'fixture',bars:{'2026-09-26':500}})};
 const maintenance=()=>new CacheMaintenance({cache,artifacts,domain,provider,clock:()=>now});
 const worker=()=>new JobWorker({jobs,artifacts,domain,cache,maintenance:maintenance(),reports:new CacheReports({cache,artifacts,domain,clock:()=>now}),lanes:new JobLanes(()=>f.documents('robinlab_lanes'),jobs),clock:()=>now});
 return {...f,jobs,artifacts,cache,rows,maintenance,worker,tick:()=>{now+=61000;}};
}
async function drain(f,id){for(let i=0;i<60;i++){const job=await f.worker().run(id,`cache_worker_${String(i).padStart(8,'0')}`);if(job?.body.state==='completed')return job;assert.ok(!['failed','needs-attention'].includes(job?.body.state));f.tick();}assert.fail('cache job did not finish');}
test('cache clearing resumes immutable mutation intents and exposes one complete latest generation',async()=>{
 const f=await setup(),job=await f.jobs.admit('cache_clear_test_00001','cache-clear',{scope:'all',today:'2026-09-26',symbol:'',cutoff:'2026-08-26'});let stale;
 for(let i=0;i<20;i++){
  const current=await f.jobs.get(job.body.id);if(current.body.checkpoint){const p=await f.artifacts.load(job.body.id,current.body.checkpoint.capture);if(p.phase==='apply'){stale=current;break;}}
  await f.worker().run(job.body.id,'cache_worker_initial_1');f.tick();
 }
 assert.ok(stale);assert.equal((await f.cache.status()).body.state,'updating');assert.equal((await f.cache.latest()).length,160);
 const result=await drain(f,job.body.id);assert.equal(result.body.result.response.deleted_rows,160);assert.deepEqual(await f.cache.latest(),[]);
 const ready=(await f.cache.status()).body;assert.equal(ready.state,'ready');assert.equal(ready.historicalDigest,await historicalDigest([]));
 const next=await f.jobs.admit('cache_prefetch_test_01','prefetch',{mode:'quotes',symbols:['NEW'],start:'2026-09-26',end:'2026-09-26'});await drain(f,next.body.id);
 const after=await f.cache.status();assert.equal(after.body.latest[0].latest_price,500);
 // A delayed old claimant can only replay its old receipts, even after another
 // job has published a newer cache generation.
 await f.maintenance().step(stale.body,stale.body.checkpoint);
 assert.deepEqual(await f.cache.status(),after);assert.equal((await f.cache.latest())[0].symbol,'NEW');
});
test('complete cache report includes all pages and an explicit capture time',async()=>{
 const f=await setup(),providers={fmp_enabled:false,twelve_data_enabled:true,yahoo_finance_enabled:false};
 const job=await f.jobs.admit('cache_summary_test_01','summary',{today:'2026-09-26',providers}),done=await drain(f,job.body.id),report=await f.artifacts.load(job.body.id,done.body.result.responseArtifact);
 assert.equal(report.total_records,160);assert.equal(report.unique_symbols,160);assert.ok(report.as_of);assert.equal(report.providers.twelve_data_enabled,true);
});
