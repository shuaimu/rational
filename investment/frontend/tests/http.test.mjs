import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:[new URL('../src/api/http.ts',import.meta.url).pathname],bundle:true,platform:'browser',format:'esm',write:false,define:{'import.meta.env.VITE_API_RUNTIME':'"cloud"'},plugins:[{name:'http-runtime-fixture',setup(build){build.onResolve({filter:/^\.\/(auth|rxdb|jobs)$/},args=>({path:args.path,namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const requireOwnerScope=()=>globalThis.httpFixture.scope;export const onClearProtectedState=()=>{};export const auth={validAccessToken:async()=> 'fixture-token',refreshSession:async()=>{}};export const signOut=async()=>{};export const waitForVersion=async()=>{};export const getSyncStatus=()=>({readable:false});export const subscribeSync=()=>{};export const configureJobs=()=>{};export const waitForJob=async()=>{};`,loader:'js'}));}}]});
let sequence=0;
async function load(){globalThis.httpFixture={scope:'owner'};const data=new Map();globalThis.localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};return import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text+'\n// '+sequence++).toString('base64'));}
function busy(config){return Object.assign(new Error('busy'),{isAxiosError:true,config,response:{status:429,data:{},headers:{'retry-after':'1'}}});}
test('gateway backpressure retries the exact same write identity and payload',async()=>{
 const {api}=await load(),requests=[];
 api.defaults.adapter=async config=>{requests.push({key:config.headers['Idempotency-Key'],data:config.data});if(requests.length===1)throw busy(config);return {status:200,statusText:'OK',headers:{},data:{ok:true},config};};
 assert.deepEqual((await api.post('/transactions',{quantity:2})).data,{ok:true});assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);assert.ok(requests[0].key);
});
test('a signed-out owner cannot send the delayed retry',async()=>{
 const {api}=await load();let calls=0;
 api.defaults.adapter=async config=>{calls++;globalThis.httpFixture.scope='different-owner';throw busy(config);};
 await assert.rejects(api.get('/accounts'),/session changed/);assert.equal(calls,1);
});
test('status reads surface cloud busy immediately without hidden backoff retries',async()=>{
 const {api,readStatus}=await load();let calls=0;
 api.defaults.adapter=async config=>{calls++;throw busy(config);};
 await assert.rejects(readStatus('/snaptrade/status',new AbortController().signal),error=>error.status===429);
 assert.equal(calls,1);
});
