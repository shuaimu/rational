import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {MakoAuthClient,normalizeMakoRxdbConfig} from '@mako-cloud/rxdb';
const root=new URL('../../',import.meta.url),config=JSON.parse(await readFile(new URL('mako/runtime.json',root))),identities=JSON.parse(await readFile(new URL('.local/mako-migration/qualification-identities.json',root)));
const auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}));
const url=`${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/robinlab-api`;
const report={at:new Date().toISOString(),checks:[]};let token;
function equivalent(a,b){if(typeof a==='number'&&typeof b==='number')return Math.abs(a-b)<=1e-8+1e-12*Math.abs(b);if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equivalent(v,b[i]));if(a&&b&&typeof a==='object'&&typeof b==='object')return JSON.stringify(Object.keys(a).sort())===JSON.stringify(Object.keys(b).sort())&&Object.keys(a).every(k=>equivalent(a[k],b[k]));return a===b;}
async function get(path,base=url){const start=performance.now(),response=await fetch(base+path,{headers:{'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});const text=await response.text();assert.equal(response.status,200,`${path}: HTTP ${response.status}`);assert.ok(text,`${path}: empty response`);return {data:JSON.parse(text),milliseconds:performance.now()-start};}
try{
 const anonymous=await fetch(url+'/accounts',{headers:{'x-mako-key':config.publicProjectKey}});assert.equal(anonymous.status,401);report.anonymousDenied=true;
 token=(await auth.signInWithPassword(identities.owner.email,identities.owner.password)).accessToken;
 report.startVersion=(await get('/portfolio/version')).data.version;
 for(const path of (process.argv.includes('--only-performance')?[]:['/accounts','/accounts/1','/tickers','/transactions?limit=7&offset=3','/analytics/summary','/analytics/performance','/analytics/ticker-pnl'])) {
  const hosted=await get(path),native=await get(path,'http://127.0.0.1:3000/api');assert.ok(equivalent(hosted.data,native.data),`${path}: native parity`);report.checks.push({path,milliseconds:hosted.milliseconds,nativeParity:true});console.log(`${path}: parity passed, ${Math.round(hosted.milliseconds)} ms`);
 }
 for(const path of (process.argv.includes('--only-performance')?['/analytics/accounts-performance']:['/prices','/positions','/positions/1?include_closed=true','/analytics/yield','/analytics/accounts-performance'])) {
  const hosted=await get(path);report.checks.push({path,milliseconds:hosted.milliseconds,count:Array.isArray(hosted.data)?hosted.data.length:null});console.log(`${path}: HTTP 200, ${Math.round(hosted.milliseconds)} ms`);
 }
 report.endVersion=(await get('/portfolio/version')).data.version;assert.equal(report.endVersion,report.startVersion,'Portfolio changed during parity capture');report.complete=true;
}catch(error){report.failure={type:error.name,message:error.message};console.error(error.message);process.exitCode=1;}
finally{await writeFile(new URL(process.argv.includes('--only-performance')?'.local/mako-serverless/api-performance-report.json':'.local/mako-serverless/api-read-report.json',root),JSON.stringify(report,null,2)+'\n',{mode:0o600});try{await auth.signOut();}catch{}}
