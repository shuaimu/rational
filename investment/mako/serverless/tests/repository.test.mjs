import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
test('cold invocation replays pre-cutover command and refuses changed input',async()=>{
 const f=await fixture();
 assert.deepEqual(await f.repository().replay(await f.repository().head(),f.identity),{version:1,response:{accepted:'before compute cutover'},replayed:true});
 await assert.rejects(()=>f.repository().replay({body:f.state.rows.get('portfolio_heads:portfolio').body},{...f.identity,request_hash:'a'.repeat(64)}),e=>e.status===409);
 assert.equal(f.state.writes,0);
});
test('staging failure preserves previous head and cold retry completes once',async()=>{
 const f=await fixture(),request=f.commandInput('account_command_0001','A');
 f.state.failStage=true;
 await assert.rejects(()=>f.repository().execute(request));
 assert.equal((await f.repository().head()).body.sequence,1);
 f.state.failStage=false;
 const result=await f.repository().execute(request);
 assert.equal(result.version,2);
 const writes=f.state.writes;
 assert.deepEqual(await f.repository().execute(request),{...result,replayed:true});
 assert.equal(f.state.writes,writes);
});
test('commit response loss replays original result from a cold invocation',async()=>{
 const f=await fixture(),request=f.commandInput('account_command_0002','B');
 f.state.loseResponse=true;
 await assert.rejects(()=>f.repository().execute(request));
 const replay=await f.repository().execute(request);
 assert.equal(replay.version,2);assert.equal(replay.response.id,1);assert.equal(replay.replayed,true);
 assert.equal((await f.repository().load()).dataset.public.accounts.length,1);
});
test('concurrent publications replan against the winning head without overwriting',async()=>{
 const f=await fixture();
 const results=await Promise.all([f.repository().execute(f.commandInput('account_concurrent_0001','A')),f.repository().execute(f.commandInput('account_concurrent_0002','B'))]);
 assert.deepEqual(results.map(r=>r.version).sort(),[2,3]);
 const loaded=await f.repository().load();
 assert.deepEqual(loaded.dataset.public.accounts.map(a=>a.code).sort(),['A','B']);
 assert.deepEqual(loaded.dataset.public.accounts.map(a=>a.id).sort(),[1,2]);
});
test('corrupt immutable content fails closed before any mutation',async()=>{
 const f=await fixture();const head=await f.repository().head();
 f.state.rows.get(`portfolio_public:${head.body.public_root.id}`).body.payload+=' ';
 await assert.rejects(()=>f.repository().load());assert.equal(f.state.writes,0);
});
test('broker status reads only private metadata and rejects a corrupt private manifest',async()=>{
 const f=await fixture(),head=await f.repository().head();
 f.state.rows.get(`portfolio_public:${head.body.public_root.id}`).body.payload+=' ';
 assert.deepEqual(await f.repository().brokerAccounts(),[]);
 f.state.rows.get(`portfolio_private:${head.body.private_root.id}`).body.payload+=' ';
 await assert.rejects(()=>f.repository().brokerAccounts());assert.equal(f.state.writes,0);
});

test('bounded snapshot resumes from cold workers and keeps its pinned head',async()=>{
 const {Artifacts}=await import('../shared/artifacts.js');
 const f=await fixture(),artifacts=new Artifacts(()=>f.documents('robinlab_inputs')),id='j_'+'b'.repeat(64);
 await f.repository().execute(f.commandInput('snapshot_account_0001','PINNED'));
 const expected=await f.repository().load();let step=await f.repository().snapshotStep(artifacts,id);
 await f.repository().execute(f.commandInput('snapshot_account_0002','LATER'));
 for(let i=0;i<20&&!step.done;i++)step=await f.repository().snapshotStep(artifacts,id,step.reference);
 assert.equal(step.done,true);assert.deepEqual(step.dataset,expected.dataset);assert.deepEqual(step.head,expected.head);
});
test('bounded snapshot validates immutable content before decoding',async()=>{
 const {Artifacts}=await import('../shared/artifacts.js');
 const f=await fixture(),artifacts=new Artifacts(()=>f.documents('robinlab_inputs')),head=await f.repository().head();
 f.state.rows.get('portfolio_public:'+head.body.public_root.id).body.payload+=' ';
 await assert.rejects(()=>f.repository().snapshotStep(artifacts,'j_'+'c'.repeat(64)));
});
test('large snapshot traversal respects the per-phase read bound',async()=>{
 const {Artifacts}=await import('../shared/artifacts.js');
 const f=await fixture(),artifacts=new Artifacts(()=>f.documents('robinlab_inputs')),id='j_'+'d'.repeat(64),head=await f.repository().head();
 const ref=(prefix,i)=>({id:prefix+'_'+i.toString(16).padStart(64,'0'),bytes:100});
 const graph=new Map();
 graph.set(head.body.public_root.id,{format:1,visibility:'public',children:[1,2,3].map(i=>({content:ref('m',i)}))});
 graph.set(head.body.private_root.id,{format:1,visibility:'private',children:[]});
 for(let i=1;i<=3;i++)graph.set(ref('m',i).id,{format:1,visibility:'public',children:Array.from({length:15},(_,j)=>({content:ref('p',i*100+j)}))});
 let step={},maximum=0;
 for(let i=0;i<40&&!step.done;i++){
  const repository=f.repository();let reads=0;
  repository.verified=async(kind,r)=>{reads++;return {body:{id:r.id,payload:'fixture'},value:graph.get(r.id)??{}};};
  repository.domain=input=>({documentCount:input.public.documents.length});
  step=await repository.snapshotStep(artifacts,id,step.reference);maximum=Math.max(maximum,reads);assert.ok(reads<=16);
 }
 assert.equal(step.done,true);assert.equal(step.dataset.documentCount,49);assert.equal(maximum,16);
});
