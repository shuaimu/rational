import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';import {JobStore} from '../shared/jobs.js';import {Artifacts} from '../shared/artifacts.js';import {UploadStore} from '../shared/uploads.js';import {ArtifactCleanup} from '../jobs/cleanup.js';
test('bounded terminal cleanup preserves replay results, active inputs and portfolio history',async()=>{
 const f=await fixture();let now=1000;const jobs=new JobStore(()=>f.documents('robinlab_jobs'),{clock:()=>now}),artifacts=new Artifacts(()=>f.documents('robinlab_inputs')),uploads=new UploadStore(()=>f.documents('robinlab_uploads'),{clock:()=>now});
 const job=await jobs.admit('cleanup_terminal_0001','summary',{}),active=await jobs.admit('cleanup_active_00001','summary',{}),review=await jobs.admit('cleanup_review_00001','register',{});
 const preserved=await artifacts.save(active.body.id,{active:true}),reviewInput=await artifacts.save(review.body.id,{reconcile:true}),responseArtifact=await artifacts.save(job.body.id,{answer:'durable result'});
 for(let i=0;i<40;i++)await artifacts.save(job.body.id,{temporary:i});
 let claim=await jobs.claim(job.body.id,'cleanup_test_worker_1');await jobs.checkpoint(claim,null,{state:'completed',result:{version:0,responseArtifact}});
 claim=await jobs.claim(review.body.id,'cleanup_test_worker_2');await jobs.checkpoint(claim,{input:reviewInput},{state:'needs-attention',error:'registration_requires_reconciliation'});
 const before=(await f.repository().head()).body;now+=8*86400000;
 const cleaner=()=>new ArtifactCleanup({jobs,uploads,artifacts,clock:()=>now});
 for(let i=0;i<10&&(await jobs.get(job.body.id)).body.artifactsExpireAt!==null;i++)await cleaner().step();
 assert.equal((await jobs.get(job.body.id)).body.artifactsExpireAt,null);
 assert.deepEqual(await artifacts.load(job.body.id,responseArtifact),{answer:'durable result'});
 assert.deepEqual(await artifacts.load(active.body.id,preserved),{active:true});assert.deepEqual(await artifacts.load(review.body.id,reviewInput),{reconcile:true});
 assert.deepEqual((await f.repository().head()).body,before);
 const remaining=[...f.state.rows].filter(([key,row])=>key.startsWith('robinlab_inputs:')&&!row._deleted&&row.body.jobId===job.body.id);assert.equal(remaining.length,2);
});
