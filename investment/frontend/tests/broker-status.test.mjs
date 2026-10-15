import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:[new URL('../src/api/broker-status.ts',import.meta.url).pathname],bundle:true,format:'esm',write:false,plugins:[{name:'status-fixture',setup(build){
 build.onResolve({filter:/^\.\/(auth|http)$/},args=>({path:args.path,namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const requireOwnerScope=()=>globalThis.statusFixture.scope;export const onClearProtectedState=callback=>{globalThis.statusFixture.clear=callback;};export const readStatus=(url,signal)=>globalThis.statusFixture.read(url,signal);`,loader:'js'}));
}}]});
let sequence=0;
const load=()=>import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text+'\n// '+sequence++).toString('base64'));
function setup(read){
 const storage={};
 Object.defineProperties(storage,{getItem:{value:key=>storage[key]??null},setItem:{value:(key,value)=>{storage[key]=value;}},removeItem:{value:key=>{delete storage[key];}}});
 globalThis.localStorage=storage;
 globalThis.statusFixture={scope:'owner_a',read};
}
const status={last_synced_at:'2026-10-05 13:00:05'};

test('last known status survives reload and a failed cloud refresh',async()=>{
 setup(async()=>({data:status}));let api=await load();
 assert.equal(api.savedBrokerStatus(),undefined);
 assert.deepEqual(await api.fetchBrokerStatus(),status);
 api=await load();assert.deepEqual(api.savedBrokerStatus().status,status);
 statusFixture.read=async()=>{throw new Error('Cloud busy (429)');};
 await assert.rejects(()=>api.fetchBrokerStatus(),/429/);
 assert.deepEqual(api.savedBrokerStatus().status,status);
});

test('saved status is scoped and cleared on sign-out; late reads cannot cross owners',async()=>{
 setup(async()=>({data:status}));const api=await load();await api.fetchBrokerStatus();
 statusFixture.scope='owner_b';assert.equal(api.savedBrokerStatus(),undefined);
 await statusFixture.clear('owner_b');assert.equal(Object.keys(localStorage).length,0);
 let finish;statusFixture.read=()=>new Promise(resolve=>{finish=resolve;});
 const pending=api.fetchBrokerStatus();statusFixture.scope='owner_c';finish({data:status});
 await assert.rejects(()=>pending,/session changed/);assert.equal(Object.keys(localStorage).length,0);
 await statusFixture.clear(null);assert.equal(api.savedBrokerStatus(),undefined);
});

test('a stalled read times out, aborts, and cannot overwrite the saved time later',async()=>{
 setup(async()=>({data:status}));const api=await load();await api.fetchBrokerStatus();
 let finish,signal,expire;
 statusFixture.read=(url,value)=>{assert.equal(url,'/snaptrade/status');signal=value;return new Promise(resolve=>{finish=resolve;});};
 const original=globalThis.setTimeout;
 globalThis.setTimeout=(callback,delay)=>{assert.equal(delay,15000);expire=callback;return 0;};
 try{
  const pending=api.fetchBrokerStatus();expire();
  await assert.rejects(()=>pending,/timed out/);assert.equal(signal.aborted,true);
  finish({data:{last_synced_at:'2026-10-15 00:00:00'}});await Promise.resolve();
  assert.deepEqual(api.savedBrokerStatus().status,status);
 }finally{globalThis.setTimeout=original;}
});

test('a confirmed never-synced response is distinct from failure or malformed status',async()=>{
 setup(async()=>({data:{last_synced_at:null}}));const api=await load();
 assert.deepEqual(await api.fetchBrokerStatus(),{last_synced_at:null});
 statusFixture.read=async()=>({data:{}});await assert.rejects(()=>api.fetchBrokerStatus(),/invalid/);
 assert.deepEqual(api.savedBrokerStatus().status,{last_synced_at:null});
});
