// Reconcile a frozen final snapshot against a verified read-only staging baseline.
// Every change is a compare-and-swap; unexpected destination writes fail closed.
import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {auditedDocuments} from './investment-explorer.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export async function reconcileExact({request,id,before,after,schemaVersion,mutationId}){
 for(let attempt=0;attempt<4;attempt++){
  const current=await request('GET',id),value=current&&!current._deleted?current.body:null;
  if(canonical(value)===canonical(after))return;
  assert.equal(canonical(value),canonical(before),'destination changed after staging baseline');
  const result=await request('POST',id,{operation:after===null?'delete':current?'update':'create',mutationId:mutationId+'_'+attempt,expectedRevision:current?.revision??null,schemaVersion,body:after??{id}});
  if(['applied','replayed'].includes(result.status))return;
  assert.equal(result.status,'conflict');
 }throw Error('Concurrent destination mutation; migration stopped');
}
async function rows(root,name,manifest){
 const bytes=await readFile(resolve(root,name+'.jsonl'));assert.equal(hash(bytes),manifest.collections[name].sha256);
 const rows=bytes.toString().split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x));const map=new Map(rows.map(row=>[row.id,row]));assert.equal(map.size,rows.length);assert.equal(rows.length,manifest.collections[name].count);return map;
}
async function main(){
 const [source,baseline,configFile,cliPath,output,collections,...flags]=process.argv.slice(2);assert.ok(collections,'Usage: SOURCE BASELINE CONFIG CLI_ENTRY PRIVATE_JOURNAL COLLECTIONS [--apply] [--publish-head] [--concurrency 1..4]');
 const config=JSON.parse(await readFile(configFile,'utf8')),a=JSON.parse(await readFile(resolve(source,'manifest.json'),'utf8')),b=JSON.parse(await readFile(resolve(baseline,'manifest.json'),'utf8'));
 assert.equal(a.scope.project,config.projectId);assert.equal(a.scope.endpoint,config.endpoint);assert.notEqual(a.scope.environment,config.environmentId);
 assert.deepEqual(b.scope,{environment:config.environmentId,project:config.projectId,endpoint:config.endpoint});
 const concurrencyIndex=flags.indexOf('--concurrency');
 const concurrency=concurrencyIndex<0?1:Number(flags[concurrencyIndex+1]);
 assert.ok(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4,'concurrency must be between 1 and 4');
 const names=collections.split(',');if(names.includes('portfolio_heads'))assert.ok(flags.includes('--publish-head'),'head publication requires explicit final verification');
 const allowed=new Set(['cache_status','historical_prices','latest_prices','portfolio_commands','portfolio_heads','portfolio_private','portfolio_public','provider_requests','robinlab_coordination','robinlab_counters','robinlab_inputs','robinlab_jobs','robinlab_lanes','robinlab_uploads','split_fetch']);assert.ok(names.every(n=>allowed.has(n)));
 const root=resolve(output);await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);const path=resolve(root,'reconcile.json');
 const scope={source:hash(canonical(a)),baseline:hash(canonical(b)),environment:config.environmentId};let state;
 try{state=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(state.scope,scope);}catch(error){if(error.code!=='ENOENT')throw error;state={scope,done:{}};}
 const save=async()=>{await writeFile(path+'.tmp',JSON.stringify(state),{mode:0o600});await rename(path+'.tmp',path);};await save();
 for(const name of names){
  const desired=await rows(source,name,a),old=await rows(baseline,name,b);const changes=[...new Set([...desired.keys(),...old.keys()])].filter(id=>canonical(desired.get(id)??null)!==canonical(old.get(id)??null));
  console.log(name,changes.length,'changes',flags.includes('--apply')?'applying':'planned');
  if(!flags.includes('--apply'))continue;
  const request=auditedDocuments({cliPath,config,root,collection:name});
  for(let offset=0;offset<changes.length;offset+=concurrency){
   const results=await Promise.allSettled(changes.slice(offset,offset+concurrency).map(async id=>{
    const receipt=name+':'+id;if(state.done[receipt])return;
    await reconcileExact({request,id,before:old.get(id)??null,after:desired.get(id)??null,schemaVersion:name==='robinlab_uploads'?2:1,mutationId:'migration_'+hash(scope.source+receipt)});
    state.done[receipt]=true;
   }));
   // One journal writer records all settled successes before reporting a failure.
   // Interrupted, unrecorded successes remain safe through reconcileExact replay.
   await save();
   const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
   if(offset%100===0)console.log(name,Math.min(offset+concurrency,changes.length),'/',changes.length,'verified');
  }
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
