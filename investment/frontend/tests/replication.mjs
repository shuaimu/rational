// Real browser IndexedDB/RxDB smoke fixture. Serve on the isolated fixture port.
// Every cloud request is intercepted; this never writes hosted data.
import config from '../src/api/mako-config.json';
import {historicalDigest} from '../../mako/serverless/shared/cache-generation.js';
if(location.port!=='5175') throw new Error('Use the isolated browser-test origin on port 5175.');
const output=document.querySelector('#result');
const assert={equal:(a,b)=>{if(a!==b)throw new Error('Equality assertion failed');},ok:value=>{if(!value)throw new Error('Assertion failed');},throws:fn=>{let threw=false;try{fn();}catch{threw=true;}if(!threw)throw new Error('Expected an error');}};
const lines=[];
const passed=message=>{lines.push(message);output.textContent=lines.join('\n');};
Object.defineProperty(navigator,'onLine',{value:true,writable:true,configurable:true});
let offline=false,revoked=false,epoch=1,rotation=0,missing=false;
const user={id:config.ownerId,email:'owner@fixture.invalid',status:'active',authorizationEpoch:1};
const token=()=>`fixture.${btoa(JSON.stringify({sub:user.id,project_id:config.projectId,environment_id:config.environmentId,environment_authorization_epoch:epoch,user_authorization_epoch:1,nonce:++rotation})).replaceAll('=','')}.signature`;
const wire=()=>({accessToken:token(),refreshToken:`refresh_${rotation}`,expiresIn:3600,user});
const encode=async(prefix,value)=>{const payload=JSON.stringify(value);const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))),b=>b.toString(16).padStart(2,'0')).join('');return {id:`${prefix}_${hash}`,payload};};
const ref=d=>({id:d.id,bytes:new TextEncoder().encode(d.payload).length});
let version=1;
const part=await encode('p',{format:1,table:'accounts',bucket:'fixture',rows:[{id:1,code:'A',name:null,account_type:null}]});
const manifest=await encode('m',{format:1,visibility:'public',children:[{kind:'partition',table:'accounts',bucket:'fixture',content:ref(part)}]});
const empty=await encode('m',{format:1,visibility:'public',children:[]});
const cacheHead={id:'cache',generation:1,state:'ready',jobId:null,latest:[],historicalCount:0,historicalDigest:await historicalDigest([]),updatedAt:new Date().toISOString()};
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
   const checkpoint=`fixture_${epoch}_${version}_${missing}_${collection}`;
   const rows=collection==='portfolio_heads'?[head()]:collection==='portfolio_public'?[manifest,...missing?[]:[part],empty]:collection==='cache_status'?[cacheHead]:[];
   return json({documents:body.checkpoint===checkpoint?[]:rows.map(r=>({...r,_deleted:false})),checkpoint});
 }
 throw new Error('Unexpected fixture route: '+path);
};
const app={...await import('../src/api/auth.ts'),...await import('../src/api/rxdb.ts')};
async function until(predicate,label){for(let i=0;i<1800;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25));}throw new Error(`${label}; auth=${app.getAuthState().status}, sync=${JSON.stringify(app.getSyncStatus())}`);}
try {
 await app.initializeAuth();await app.signOut();assert.equal(app.getAuthState().status,'signed-out');
 await app.signIn('owner@fixture.invalid','fixture-password');
 missing=true;await app.startReplication();await new Promise(r=>setTimeout(r,200));assert.equal(app.getSyncStatus().readable,false);
 missing=false;await app.resync();await until(()=>app.getSyncStatus().readable,'first complete generation');assert.equal((await app.readGeneration()).tables.accounts.length,1);
 passed('Passed local integration: incomplete head waits for all parts');
 const refreshes=requests.filter(p=>p.endsWith('/auth/token')).length;
 await Promise.all(Array.from({length:8},()=>app.auth.refreshSession()));
 assert.equal(requests.filter(p=>p.endsWith('/auth/token')).length-refreshes,1);
 passed('Passed local integration: concurrent session renewal is coalesced');
 await app.closeLocalData();offline=true;navigator.onLine=false;await app.startReplication();assert.equal((await app.readGeneration()).tables.accounts.length,1);assert.equal(app.getSyncStatus().readable,true);
 passed('Passed local integration: offline reopen retains verified data');
 offline=false;navigator.onLine=true;version=2;await app.resync();await app.waitForVersion(2);assert.equal((await app.readGeneration()).tables.accounts.length,0);
 passed('Passed local integration: version catch-up applies deletion atomically');
 await app.resetLocalData();await until(()=>app.getSyncStatus().readable&&app.getSyncStatus().version===2,'checkpoint reset');
 passed('Passed local integration: checkpoint rebuild preserves complete view');
 version=3;await until(()=>app.getSyncStatus().version===3,'missed live notification catch-up');
 passed('Passed local integration: missed live notification catches up without user action');
 revoked=true;await app.validateSession();assert.equal(app.getAuthState().status,'signed-out');assert.equal(app.getSyncStatus().readable,false);assert.throws(()=>app.requireOwnerScope());
 passed('Passed local integration: definitive revocation clears protected state');
 revoked=false;epoch=2;version=1;await app.signIn('owner@fixture.invalid','fixture-password');await app.startReplication();await until(()=>app.getSyncStatus().readable,'new authorization epoch');assert.ok(app.requireOwnerScope().includes(',2,1]'));
 await Promise.all(Array.from({length:8},()=>app.signOut()));assert.equal(app.getAuthState().status,'signed-out');assert.equal(app.getSyncStatus().version,0);
 passed('Passed local integration: new authorization scope and sign-out');
} catch(error) {output.textContent+='\nFAILED: '+error.message;document.title='FAILED — RobinLab replication';throw error;} finally {await app.closeLocalData();}
passed('ALL 8 BROWSER CHECKS PASSED');document.title='PASSED — RobinLab replication';
