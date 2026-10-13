// Real auth adapter + RxDB/Dexie + application materializer with an in-memory
// IndexedDB implementation and a deterministic HTTP fixture. No live cloud writes.
import 'fake-indexeddb/auto';
import { build } from 'esbuild';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
class Storage { data=new Map(); getItem(k){return this.data.get(k)??null;} setItem(k,v){this.data.set(k,String(v));} removeItem(k){this.data.delete(k);} clear(){this.data.clear();} }
const storage=new Storage();
Object.defineProperty(globalThis,'localStorage',{value:storage,configurable:true});
const windowTarget=new EventTarget();windowTarget.localStorage=storage;windowTarget.indexedDB=globalThis.indexedDB;
Object.defineProperty(globalThis,'window',{value:windowTarget,configurable:true});
Object.defineProperty(globalThis,'document',{value:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},configurable:true});
Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
const root=resolve(import.meta.dirname,'..');
const config=JSON.parse(await readFile(resolve(root,'src/api/mako-config.json'),'utf8'));
let offline=false,revoked=false,epoch=1,rotation=0,missing=false,headAbsent=false;
const throttled=new Set();
const user={id:config.ownerId,email:'owner@fixture.invalid',status:'active',authorizationEpoch:1};
const token=()=>`fixture.${Buffer.from(JSON.stringify({sub:user.id,project_id:config.projectId,environment_id:config.environmentId,environment_authorization_epoch:epoch,user_authorization_epoch:1,nonce:++rotation})).toString('base64url')}.signature`;
const wire=()=>({accessToken:token(),refreshToken:`refresh_${rotation}`,expiresIn:3600,user});
const encode=(prefix,value)=>{const payload=JSON.stringify(value);return {id:`${prefix}_${createHash('sha256').update(payload).digest('hex')}`,payload};};
const ref=d=>({id:d.id,bytes:Buffer.byteLength(d.payload)});
let version=1;
const part=encode('p',{format:1,table:'accounts',bucket:'fixture',rows:[{id:1,code:'A',name:null,account_type:null}]});
const manifest=encode('m',{format:1,visibility:'public',children:[{kind:'partition',table:'accounts',bucket:'fixture',content:ref(part)}]});
const empty=encode('m',{format:1,visibility:'public',children:[]});
const head=()=>({id:'portfolio',format:1,sequence:version,public_root:ref(version===1?manifest:empty),private_root:{id:`m_${'0'.repeat(64)}`,bytes:10},command:{id:`c_${'0'.repeat(64)}`,bytes:10},next_ids:{account:2,ticker:1,transaction:1,brokerage_user:1}});
const requests=[];
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async(url,init={})=>{
 const path=new URL(url).pathname;requests.push(path);
 if(offline) throw new TypeError('fixture offline');
 if(path.endsWith('/auth/signin')||path.endsWith('/auth/token')) return revoked?json({error:{code:'unauthenticated',message:'fixture revoked',requestId:'req_fixture',retry:{kind:'never'}}},401):json(wire());
 if(path.endsWith('/auth/user')) return revoked?json({},401):json(user);
 if(path.endsWith('/auth/signout')) return json({});
 if(init.headers?.Accept==='text/event-stream') return new Response(new ReadableStream({start(controller){init.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});
 if(path.endsWith('/replication/pull')) {
   if(revoked)return json({error:{code:'unauthenticated',message:'fixture revoked',requestId:'req_fixture',retry:{kind:'never'}}},401);
   const collection=path.split('/').at(-3),body=JSON.parse(init.body);
   if(throttled.has(collection))return json({error:{code:'rate_limited',message:'replication request is throttled',requestId:'req_fixture',retry:{kind:'after_delay',afterMs:25}}},429);
   const checkpoint=`fixture_${epoch}_${version}_${missing}_${headAbsent}_${collection}`;
   const rows=collection==='portfolio_heads'?(headAbsent?[]:[head()]):collection==='portfolio_public'?[manifest,...missing?[]:[part],empty]:collection==='cache_status'?[{id:'cache',generation:1,state:'ready',jobId:null,latest:[],historicalDigest:createHash('sha256').update('[]').digest('hex'),historicalCount:0,updatedAt:0}]:[];
   return json({documents:body.checkpoint===checkpoint?[]:rows.map(r=>({...r,_deleted:false})),checkpoint});
 }
 throw new Error('Unexpected fixture route: '+path);
};
const directory=resolve(root,'node_modules/.cache/robinlab-tests');await mkdir(directory,{recursive:true});
const output=resolve(directory,`local-${process.pid}.mjs`);
await build({stdin:{contents:`export * from './src/api/auth.ts'; export * from './src/api/rxdb.ts';`,resolveDir:root},bundle:true,format:'esm',platform:'node',packages:'external',outfile:output,define:{'import.meta.hot':'undefined'},logLevel:'silent'});
const app=await import(pathToFileURL(output));
async function until(predicate,label){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25));}throw new Error(`${label}; auth=${app.getAuthState().status}, sync=${JSON.stringify(app.getSyncStatus())}`);}
try {
 await app.initializeAuth();assert.equal(app.getAuthState().status,'signed-out');
 await app.signIn('owner@fixture.invalid','fixture-password');
 headAbsent=true;throttled.add('portfolio_heads');await app.startReplication();
 await until(()=>app.getSyncStatus().message?.includes('rate limit'),'throttle is visible before a head exists');
 throttled.clear();await app.resync();
 await until(()=>app.getSyncStatus().message==='Waiting for the cloud portfolio.','empty successful pull clears throttle');
 assert.equal(app.getSyncStatus().readable,false);
 console.log('Passed local integration: recovered throttle clears while waiting for cloud head');
 headAbsent=false;missing=true;await app.resetLocalData();await new Promise(r=>setTimeout(r,200));assert.equal(app.getSyncStatus().readable,false);
 missing=false;await app.resync();await until(()=>app.getSyncStatus().readable,'first complete generation');assert.equal((await app.readGeneration()).tables.accounts.length,1);
 console.log('Passed local integration: incomplete head waits for all parts');
 throttled.add('portfolio_heads');throttled.add('portfolio_public');await app.resync();
 await until(()=>app.getSyncStatus().message?.includes('rate limit'),'throttle on unchanged generation');
 throttled.delete('portfolio_heads');await app.resync();await new Promise(r=>setTimeout(r,2300));
 assert.ok(app.getSyncStatus().message?.includes('rate limit'),'one recovered collection must not hide another failure');
 throttled.clear();await app.resync();await until(()=>app.getSyncStatus().phase==='ready'&&app.getSyncStatus().message===null,'unchanged successful pulls clear throttle');
 console.log('Passed local integration: all failing collections must recover before clearing warning');
 const refreshes=requests.filter(p=>p.endsWith('/auth/token')).length;
 await Promise.all(Array.from({length:8},()=>app.auth.refreshSession()));
 assert.equal(requests.filter(p=>p.endsWith('/auth/token')).length-refreshes,1);
 console.log('Passed local integration: concurrent session renewal is coalesced');
 await app.closeLocalData();offline=true;navigator.onLine=false;await app.startReplication();assert.equal((await app.readGeneration()).tables.accounts.length,1);assert.equal(app.getSyncStatus().readable,true);
 console.log('Passed local integration: offline reopen retains verified data');
 offline=false;navigator.onLine=true;version=2;await app.resync();await app.waitForVersion(2);assert.equal((await app.readGeneration()).tables.accounts.length,0);
 console.log('Passed local integration: version catch-up applies deletion atomically');
 await app.resetLocalData();await until(()=>app.getSyncStatus().readable&&app.getSyncStatus().version===2,'checkpoint reset');
 console.log('Passed local integration: checkpoint rebuild preserves complete view');
 revoked=true;await app.validateSession();assert.equal(app.getAuthState().status,'signed-out');assert.equal(app.getSyncStatus().readable,false);assert.throws(()=>app.requireOwnerScope());
 console.log('Passed local integration: definitive revocation clears protected state');
 revoked=false;epoch=2;version=1;await app.signIn('owner@fixture.invalid','fixture-password');await app.startReplication();await until(()=>app.getSyncStatus().readable,'new authorization epoch');assert.ok(app.requireOwnerScope().includes(',2,1]'));
 await Promise.all(Array.from({length:8},()=>app.signOut()));assert.equal(app.getAuthState().status,'signed-out');assert.equal(app.getSyncStatus().version,0);
 console.log('Passed local integration: new authorization scope and sign-out');
} finally {await app.closeLocalData();await unlink(output);}
