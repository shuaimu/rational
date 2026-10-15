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
