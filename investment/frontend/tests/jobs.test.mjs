import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:[new URL('../src/api/jobs.ts',import.meta.url).pathname],bundle:true,format:'esm',write:false,plugins:[{name:'job-runtime-fixture',setup(build){build.onResolve({filter:/^\.\/(auth|rxdb)$/},args=>({path:args.path,namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const requireOwnerScope=()=>globalThis.jobFixture.scope;export const onClearProtectedState=callback=>{globalThis.jobFixture.clear=callback;};export const waitForVersion=version=>globalThis.jobFixture.wait(version);export const waitForCacheGeneration=version=>globalThis.jobFixture.wait(version);`,loader:'js'}));}}]});
let sequence=0;
async function load(){return import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text+'\n// '+sequence++).toString('base64'));}
function storage(){const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key),data};}
const id='j_'+'a'.repeat(64),command={scope:'owner_scope',fingerprint:'request_hash',id:'stable_command_0001'};
const queued={id,kind:'excel',state:'queued',attempt:0,retryAt:null,cancelRequested:false,error:null,result:null};
function setup(wait=async()=>{}){globalThis.localStorage=storage();globalThis.jobFixture={scope:command.scope,wait};}
test('accepted command survives until the committed version reaches the local replica',async()=>{
 let release;setup(()=>new Promise(resolve=>{release=resolve;}));const jobs=await load(),completed=[];
 jobs.configureJobs({get:async()=>({...queued,state:'completed',result:{version:4,response:{imported:2}}}),cancel:async()=>queued,complete:value=>completed.push(value)});
 jobs.trackJob(queued,command);const refresh=jobs.refreshJob(id);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(completed.length,0);assert.equal(jobs.getJobs()[0].waitingForSync,true);
 assert.ok([...localStorage.data.values()][0].includes('stable_command_0001'));
 release();await refresh;assert.deepEqual(completed,[command]);assert.equal(jobs.getJobs()[0].settled,true);
});
test('reload resumes the saved cloud job without submitting another operation',async()=>{
 setup();let jobs=await load();jobs.trackJob(queued,command);
 jobs=await load();const completed=[];let reads=0;
 jobs.configureJobs({get:async()=>{reads++;return {...queued,state:'completed',result:{version:0,response:{preview:true}}};},cancel:async()=>queued,complete:value=>completed.push(value)});
 jobs.recoverJobs();await jobs.refreshJob(id);assert.equal(reads,1);assert.deepEqual(completed,[command]);
});
test('network loss keeps admission and cancellation waits for a terminal result',async()=>{
 setup();const jobs=await load(),completed=[];
 jobs.configureJobs({get:async()=>{throw new Error('offline');},cancel:async()=>({...queued,state:'running',cancelRequested:true}),complete:value=>completed.push(value)});
 jobs.trackJob(queued,command);await assert.rejects(()=>jobs.refreshJob(id));assert.equal(jobs.getJobs()[0].id,id);assert.equal(completed.length,0);
 await jobs.cancelJob(id);jobs.dismissJob(id);assert.equal(jobs.getJobs().length,1);assert.equal(completed.length,0);
 jobs.trackJob({...queued,state:'cancelled'});jobs.dismissJob(id);assert.equal(jobs.getJobs().length,0);assert.deepEqual(completed,[command]);
});
test('cache writes retain their retry command until the full price generation replicates',async()=>{
 let release;setup(()=>new Promise(resolve=>{release=resolve;}));const jobs=await load(),completed=[];
 jobs.configureJobs({get:async()=>({...queued,kind:'cache-clear',state:'completed',result:{version:0,cacheGeneration:3,response:{deleted_rows:7}}}),cancel:async()=>queued,complete:value=>completed.push(value)});
 jobs.trackJob({...queued,kind:'cache-clear'},command);const pending=jobs.refreshJob(id);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(completed.length,0);assert.equal(jobs.getJobs()[0].waitingForSync,true);
 release();await pending;assert.deepEqual(completed,[command]);
});
test('a new browser discovers accepted cloud jobs without another admission',async()=>{
 setup();const jobs=await load();let pages=0;
 jobs.configureJobs({list:async cursor=>{pages++;return cursor?{jobs:[{...queued,id:'j_'+'b'.repeat(64),kind:'snaptrade'}],cursor:null}:{jobs:[queued],cursor:'next'};},get:async()=>queued,cancel:async()=>queued,complete:()=>{}});
 jobs.recoverJobs();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(pages,2);assert.equal(jobs.getJobs().length,2);assert.ok(jobs.getJobs().every(job=>job.scope===command.scope));
 jobs.recoverJobs();await new Promise(resolve=>setImmediate(resolve));assert.equal(pages,2);
});

test('a migrated queued backlog uses paged discovery instead of a per-job request burst',async()=>{
 setup();const jobs=await load();let reads=0;
 const backlog=Array.from({length:335},(_,i)=>({...queued,id:'j_'+i.toString(16).padStart(64,'0'),kind:'snaptrade'}));
 jobs.configureJobs({list:async()=>({jobs:backlog,cursor:null}),get:async()=>{reads++;return queued;},cancel:async()=>queued,complete:()=>{}});
 jobs.recoverJobs();await new Promise(resolve=>setImmediate(resolve));jobs.recoverJobs();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(jobs.getJobs().length,335);assert.equal(reads,0);
});
test('background recovery bounds overlapping requests and fairly resumes active jobs',async()=>{
 setup();const jobs=await load(),seen=[],releases=[];
 const active=Array.from({length:10},(_,i)=>({...queued,id:'j_'+i.toString(16).padStart(64,'0'),state:'running'}));
 jobs.configureJobs({list:async()=>({jobs:[],cursor:null}),get:id=>new Promise(resolve=>{seen.push(id);releases.push(()=>resolve(active.find(job=>job.id===id)));}),cancel:async()=>queued,complete:()=>{}});
 for(const job of active)jobs.trackJob(job);
 jobs.recoverJobs();jobs.recoverJobs();assert.equal(seen.length,4);
 for(const release of releases.splice(0))release();await new Promise(resolve=>setImmediate(resolve));
 jobs.recoverJobs();assert.equal(seen.length,8);assert.equal(new Set(seen).size,8);
 for(const release of releases.splice(0))release();await new Promise(resolve=>setImmediate(resolve));
});
