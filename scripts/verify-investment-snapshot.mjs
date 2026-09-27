// Read-only verification. Financial values and captures never appear in output.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PortfolioRepository} from '../investment/mako/serverless/shared/repository.js';
import {Artifacts} from '../investment/mako/serverless/shared/artifacts.js';
import {domainCall} from '../investment/mako/serverless/shared/errors.js';
import {historicalDigest} from '../investment/mako/serverless/shared/cache-generation.js';
import {initSync,domain_invoke} from '../investment/mako/serverless/generated/robinlab_function_wasm.js';
const [directory,native]=process.argv.slice(2);
const quiescent=process.argv.includes('--quiescent');
assert.ok(directory,'Usage: node scripts/verify-investment-snapshot.mjs SNAPSHOT [NATIVE_INVOKE]');
const root=resolve(directory),manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
for(const name of ['cache_status','historical_prices','latest_prices','portfolio_commands','portfolio_heads','portfolio_private','portfolio_public','provider_requests','robinlab_coordination','robinlab_counters','robinlab_inputs','robinlab_jobs','robinlab_lanes','robinlab_uploads','split_fetch'])assert.ok(manifest.collections[name],name+' must be included');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const collections=new Map();
for(const [name,entry] of Object.entries(manifest.collections)){
 const bytes=await readFile(resolve(root,name+'.jsonl'));assert.equal(digest(bytes),entry.sha256,name+' file digest');
 const rows=bytes.toString().split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
 const map=new Map(rows.map(body=>[body.id,{body,revision:'snapshot',schemaVersion:name==='robinlab_uploads'?2:1}]));
 assert.equal(rows.length,map.size,name+' unique IDs');assert.equal(rows.length,entry.count,name+' count');collections.set(name,map);
}
if(quiescent)for(const {body} of collections.get('robinlab_jobs').values()){
 if(!['completed','failed','cancelled','needs-attention'].includes(body.state)){assert.equal(body.checkpoint,null,'finish source revision-dependent checkpoints before migration');assert.ok(body.state!=='committing'&&body.leaseUntil<=Date.now(),'source worker must be quiescent');}
}
const documents=name=>({get:async id=>collections.get(name)?.get(id)??null});
initSync({module:await readFile(new URL('../investment/mako/serverless/generated/robinlab_function_wasm_bg.wasm',import.meta.url))});
const domain=input=>domainCall(domain_invoke,input);
const repository=new PortfolioRepository({documents,domain,deadline:Infinity});
const {head,dataset}=await repository.load();
const checkedRoots=new Set();let next=head.body.command,sequence=head.body.sequence;const commands=new Set();
while(next){
 const {value:command}=await repository.verified('command',next,'c');
 assert.equal(command.sequence,sequence--);assert.ok(!commands.has(command.identity.id),'unique accepted command');commands.add(command.identity.id);
 for(const visibility of ['public','private']){
  const ref=command[visibility+'_root'];const key=visibility+ref.id;
  if(!checkedRoots.has(key)){await repository.branch(visibility,ref);checkedRoots.add(key);}
 }
 next=command.predecessor;
}
assert.equal(sequence,0,'complete replay history');
for(const name of ['portfolio_public','portfolio_private','portfolio_commands'])for(const {body} of collections.get(name).values()){
 assert.equal(digest(body.payload),body.id.slice(2),'immutable content digest');
}
const encoded=domain({action:'encode',dataset});
assert.deepEqual(encoded.public.root,head.body.public_root);assert.deepEqual(encoded.private.root,head.body.private_root);
const artifactStore=new Artifacts(()=>documents('robinlab_inputs'));let artifacts=0;
for(const {body} of collections.get('robinlab_inputs')?.values()??[]){
 if(body.kind==='manifest'){await artifactStore.load(body.jobId,{id:body.id,digest:body.digest,bytes:body.bytes});artifacts++;}
 else if(body.kind==='chunk')assert.equal(digest(Buffer.from(body.payload,'base64')),body.digest,'private capture digest');
}
const historical=[...collections.get('historical_prices').values()].map(x=>x.body.row);
const cacheStatus=collections.get('cache_status').get('cache')?.body;
const latest=cacheStatus?.latest??[...collections.get('latest_prices').values()].map(x=>x.body.row);
const cacheDigest=await historicalDigest(historical);
const cacheReady=cacheStatus?.state==='ready'&&cacheStatus.historicalCount===historical.length&&cacheStatus.historicalDigest===cacheDigest;
if(quiescent)assert.ok(cacheReady,'cache snapshot must match its published generation');
const checks=[];
function equivalent(a,b){
 if(typeof a==='number'&&typeof b==='number')return Math.abs(a-b)<=1e-8+1e-12*Math.abs(b);
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equivalent(v,b[i]));
 if(a&&b&&typeof a==='object'&&typeof b==='object')return JSON.stringify(Object.keys(a).sort())===JSON.stringify(Object.keys(b).sort())&&Object.keys(a).every(k=>equivalent(a[k],b[k]));
 return a===b;
}
for(const operation of ['accounts','tickers','transactions','summary','performance','ticker_pnl','positions','yield','accounts_performance']){
 const input={action:'read',operation,dataset,input:{today:'2026-09-27',account_id:null,include_closed:true,latest,historical}};
 const wasm=domain(input);
 if(native){const result=spawnSync(resolve(native),[],{input:JSON.stringify({interfaceVersion:1,...input}),encoding:'utf8',maxBuffer:128*1024*1024});assert.equal(result.status,0,'native calculation');const value=JSON.parse(result.stdout);assert.equal(value.ok,true);assert.ok(equivalent(wasm,value.result),'native/Wasm '+operation);}
 checks.push({operation,sha256:digest(JSON.stringify(wasm))});
}
const report={version:head.body.sequence,commands:commands.size,verifiedHistoricalRoots:checkedRoots.size,artifacts,collections:Object.fromEntries([...collections].map(([name,rows])=>[name,rows.size])),reports:checks,nativeParity:Boolean(native),quiescent,cacheReady,historicalDigest:cacheDigest,complete:true};
await writeFile(resolve(root,'verification.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({version:report.version,commands:report.commands,verifiedHistoricalRoots:report.verifiedHistoricalRoots,artifacts,financialReports:checks.length,nativeParity:report.nativeParity,cacheReady,complete:true}));
