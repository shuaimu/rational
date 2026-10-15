import test from 'node:test';
import assert from 'node:assert/strict';
import {JobStore,LEASE_MILLISECONDS} from '../shared/jobs.js';
function fixture(){const rows=new Map();let revision=0,now=1000,lose=false;const documents=()=>({get:async id=>structuredClone(rows.get(id)??null),mutate:async(id,m)=>{
 const old=rows.get(id);if(m.operation==='create'&&old||m.operation==='update'&&old?.revision!==m.expectedRevision)return {status:'conflict'};
 const document={body:structuredClone(m.body),revision:String(++revision)};rows.set(id,document);if(lose){lose=false;throw new Error('response lost');}return {status:'applied',document:structuredClone(document)};
}});return {store:()=>new JobStore(documents,{clock:()=>now}),advance:()=>{now+=LEASE_MILLISECONDS+1;},lose:()=>{lose=true;},rows};}
test('concurrent admission and lost response preserve one stable job',async()=>{
 const f=fixture(),args=['job_command_000001','excel',{uploadId:'fixture'}];
 f.lose();await assert.rejects(()=>f.store().admit(...args));
 const [a,b]=await Promise.all([f.store().admit(...args),f.store().admit(...args)]);assert.equal(a.body.id,b.body.id);assert.equal(f.rows.size,1);
 await assert.rejects(()=>f.store().admit(args[0],'excel',{uploadId:'changed'}),e=>e.status===409);
});
test('expired workers cannot overwrite a recovered checkpoint or completion',async()=>{
 const f=fixture(),job=await f.store().admit('job_command_000002','prefetch',{});
 const first=await f.store().claim(job.body.id,'worker_original_0001');assert.equal(first.body.generation,1);
 assert.equal(await f.store().claim(job.body.id,'worker_duplicate_0001'),null);
 const saved=await f.store().checkpoint(first,{offset:10});f.advance();
 const resumed=await f.store().claim(job.body.id,'worker_recovered_0001');assert.equal(resumed.body.generation,2);assert.deepEqual(resumed.body.checkpoint,{offset:10});
 await assert.rejects(()=>f.store().checkpoint(saved,{offset:20}),e=>e.status===409);
 const publishing=await f.store().checkpoint(resumed,{offset:10},{state:'committing'});
 await assert.rejects(()=>f.store().cancel(job.body.id),e=>e.status===409);
 const done=await f.store().checkpoint(publishing,null,{state:'completed',result:{version:5}});assert.equal(done.body.state,'completed');assert.equal(await f.store().claim(job.body.id,'worker_duplicate_0001'),null);
});
test('cancellation fences a running worker and retry waits durably without sleeping',async()=>{
 const f=fixture(),job=await f.store().admit('job_command_000003','prefetch',{});
 const claim=await f.store().claim(job.body.id,'worker_original_0001');await f.store().cancel(job.body.id);
 await assert.rejects(()=>f.store().checkpoint(claim,{}),e=>e.status===409);f.advance();
 assert.equal((await f.store().claim(job.body.id,'worker_recovered_0001')).body.state,'cancelled');
 const another=await f.store().admit('job_command_000004','prefetch',{}),a=await f.store().claim(another.body.id,'worker_original_0001');
 const retry=await f.store().checkpoint(a,{offset:2},{state:'retry',retryAt:a.body.updatedAt+LEASE_MILLISECONDS});
 assert.equal(await f.store().claim(another.body.id,'worker_duplicate_0001'),null);f.advance();
 const resumed=await f.store().claim(another.body.id,'worker_recovered_0001');assert.deepEqual(resumed.body.checkpoint,retry.body.checkpoint);
});

test('manual and daily imports share one durable lane across worker restarts',async()=>{
 const {fixture}=await import('./fixtures.mjs'),{JobLanes}=await import('../shared/coordination.js'),{admitDaily}=await import('../jobs/dispatcher.js');
 const f=await fixture(),jobs=new JobStore(()=>f.documents('robinlab_jobs'));
 const manual=await jobs.admit('manual_sync_00000001','snaptrade',{apply:true});
 const daily=await admitDaily(jobs,'2026-09-26T12:03:00Z'),duplicate=await admitDaily(jobs,'2026-09-26T23:59:00Z');assert.equal(daily.body.id,duplicate.body.id);
 const lanes=()=>new JobLanes(()=>f.documents('robinlab_lanes'),jobs);
 assert.equal(await lanes().acquire('snaptrade',manual.body.id),true);
 assert.equal(await lanes().acquire('snaptrade',daily.body.id),false);
 await jobs.cancel(manual.body.id);
 assert.equal(await lanes().acquire('snaptrade',daily.body.id),true);
 assert.equal(await lanes().acquire('snaptrade',manual.body.id),false);
});

test('dispatcher finds a runnable lane owner beyond blocked due jobs',async()=>{
 const {fixture}=await import('./fixtures.mjs'),{JobLanes}=await import('../shared/coordination.js');
 const f=await fixture();let now=1000;const jobs=new JobStore(()=>f.documents('robinlab_jobs'),{clock:()=>now});
 const owner=await jobs.admit('lane_owner_command_01','snaptrade',{});
 const waiting=await jobs.admit('lane_waiter_command01','snaptrade',{});
 const free=await jobs.admit('free_excel_command_01','excel',{});
 const lanes=new JobLanes(()=>f.documents('robinlab_lanes'),jobs);
 assert.equal(await lanes.acquire('snaptrade',owner.body.id),true);
 const selected=await lanes.runnable([waiting,free],now);
 assert.deepEqual(new Set(selected.map(x=>x.body.id)),new Set([owner.body.id,free.body.id]));
 assert.equal((await jobs.get(waiting.body.id)).body.attempt,0);
 const claim=await jobs.claim(owner.body.id,'worker_lane_regression');
 assert.deepEqual((await lanes.runnable([waiting,free],now)).map(x=>x.body.id),[free.body.id]);
 await jobs.checkpoint(claim,{}, {state:'needs-attention'});
 assert.deepEqual((await lanes.runnable([waiting,free],now)).map(x=>x.body.id),[free.body.id]);
});

test('migration draining finishes checkpoints without starting accepted waiters',async()=>{
 const {fixture}=await import('./fixtures.mjs'),{JobLanes}=await import('../shared/coordination.js');
 const f=await fixture(),jobs=new JobStore(()=>f.documents('robinlab_jobs'),{clock:()=>1000});
 const owner=await jobs.admit('draining_owner_00001','snaptrade',{});
 const waiting=await jobs.admit('draining_waiter_0001','excel',{});
 const lanes=new JobLanes(()=>f.documents('robinlab_lanes'),jobs);
 await lanes.acquire('snaptrade',owner.body.id);
 const claim=await jobs.claim(owner.body.id,'draining_worker_0001');
 const retry=await jobs.checkpoint(claim,{phase:'capturing'},{state:'retry',retryAt:1100});
 assert.deepEqual((await lanes.runnable([waiting,retry],1200,{draining:true})).map(x=>x.body.id),[owner.body.id]);
 assert.equal((await jobs.get(waiting.body.id)).body.attempt,0);
});

test('new-device recovery pages accepted jobs without private inputs or completed jobs',async()=>{
 const {fixture}=await import('./fixtures.mjs');const f=await fixture(),jobs=new JobStore(()=>f.documents('robinlab_jobs'),{clock:()=>1000});
 for(let i=0;i<35;i++)await jobs.admit('recovery_command_'+String(i).padStart(4,'0'),'excel',{uploadId:'private-input'});
 const cancelled=await jobs.admit('recovery_cancelled_001','excel',{});await jobs.cancel(cancelled.body.id);
 const a=await jobs.pendingPage(),b=await jobs.pendingPage(a.cursor);
 assert.equal(a.jobs.length+b.jobs.length,35);assert.equal(b.cursor,null);
 assert.ok([...a.jobs,...b.jobs].every(job=>!('input' in job)&&!('commandId' in job)&&job.id!==cancelled.body.id));
});

test('pending discovery queries only pending states and includes needs-attention',async()=>{
 const {fixture}=await import('./fixtures.mjs');const f=await fixture(),queries=[];
 const jobs=new JobStore(()=>({...f.documents('robinlab_jobs'),query:async q=>{queries.push(q);return f.documents('robinlab_jobs').query(q);}}),{clock:()=>1000});
 for(let i=0;i<90;i++){const job=await jobs.admit('historical_cancel_'+String(i).padStart(4,'0'),'excel',{});await jobs.cancel(job.body.id);}
 const queued=await jobs.admit('current_queue_job_001','excel',{});
 const review=await jobs.admit('requires_review_job_01','register',{});
 const claim=await jobs.claim(review.body.id,'pending_test_worker01');await jobs.checkpoint(claim,{phase:'uncertain'},{state:'needs-attention'});
 const page=await jobs.pendingPage();assert.equal(page.cursor,null);
 assert.deepEqual(new Set(page.jobs.map(j=>j.id)),new Set([queued.body.id,review.body.id]));
 assert.equal(queries.length,5);assert.ok(queries.every(q=>q.predicates.some(p=>p.field==='state'&&p.operator==='eq'&&!['completed','failed','cancelled'].includes(p.value))));
 await assert.rejects(()=>jobs.pendingPage('pending1:broken'),e=>e.status===400);
 await assert.rejects(()=>jobs.pendingPage('pending1:[]'),e=>e.status===400);
});
test('state cursors paginate independently without repeating exhausted states',async()=>{
 const {fixture}=await import('./fixtures.mjs');const f=await fixture(),jobs=new JobStore(()=>f.documents('robinlab_jobs'),{clock:()=>1000});
 for(let i=0;i<35;i++){
  await jobs.admit('multi_queued_'+String(i).padStart(5,'0'),'excel',{});
  const review=await jobs.admit('multi_review_'+String(i).padStart(5,'0'),'register',{});
  const claim=await jobs.claim(review.body.id,'pending_test_worker01');await jobs.checkpoint(claim,{}, {state:'needs-attention'});
 }
 const first=await jobs.pendingPage(),second=await jobs.pendingPage(first.cursor);
 assert.equal(first.jobs.length,64);assert.equal(second.jobs.length,6);assert.equal(second.cursor,null);
 assert.equal(new Set([...first.jobs,...second.jobs].map(j=>j.id)).size,70);
});
