// Create only missing immutable captures using bounded, resumable cloud jobs.
// A fresh destination export must still verify the result before head publication.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,chmod,unlink,open} from 'node:fs/promises';
import {appendFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {snapshotIndex} from './investment-snapshot.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

export async function missingIds(source,baseline,rehearsal){
 const existing=new Set(baseline.keys());
 for(const id of existing){
  const desired=await source.get(id),current=await baseline.get(id);
  // Frozen-source cleanup can retire earlier rehearsal captures. They are
  // reconciled separately by revision; bulk admission never targets those IDs.
  const expected=desired??(rehearsal?await rehearsal.get(id):undefined);
  assert.ok(expected&&canonical(expected)===canonical(current),'destination baseline is not an exact immutable subset or verified rehearsal record');
 }
 return [...source.keys()].filter(id=>!existing.has(id)).sort();
}

export async function* inputParts(source,ids,maxBytes=32*1024*1024,maxRows=2048){
 assert.ok(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=64*1024*1024);
 let buffers=[],bytes=0,index=0;
 for(const id of ids){
  const row=await source.get(id);assert.equal(row?.id,id);
  const line=Buffer.from(JSON.stringify(row)+'\n');assert.ok(line.length<=1024*1024,'document exceeds platform bound');
  assert.ok(line.length<=maxBytes,'document exceeds part bound');
  if(buffers.length&&(bytes+line.length>maxBytes||buffers.length>=maxRows)){
   yield {index:index++,rows:buffers.length,bytes,content:Buffer.concat(buffers,bytes)};buffers=[];bytes=0;
  }
  buffers.push(line);bytes+=line.length;
 }
 if(buffers.length)yield {index,rows:buffers.length,bytes,content:Buffer.concat(buffers,bytes)};
}

export async function importInputs({source,baseline,configFile,cliPath,output,rehearsal}){
 const [a,b,config]=await Promise.all([source,baseline,configFile].map((path,i)=>readFile(i<2?resolve(path,'manifest.json'):path,'utf8').then(JSON.parse)));
 assert.equal(a.scope.project,config.projectId);assert.equal(a.scope.endpoint,config.endpoint);assert.notEqual(a.scope.environment,config.environmentId);
 assert.deepEqual(b.scope,{environment:config.environmentId,project:config.projectId,endpoint:config.endpoint});
 const root=resolve(output);await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
 const lock=resolve(root,'owner.lock');
 try{const pid=Number(await readFile(lock,'utf8'));assert.ok(Number.isInteger(pid)&&pid>0);try{process.kill(pid,0);throw Error('Import journal already has an active owner');}catch(error){if(error.code!=='ESRCH')throw error;}await unlink(lock);}catch(error){if(error.code!=='ENOENT')throw error;}
 const owned=await open(lock,'wx',0o600);await owned.writeFile(String(process.pid));await owned.close();
 let desired,old,previous;
 try{
  desired=await snapshotIndex(resolve(source,'robinlab_inputs.jsonl'),a.collections.robinlab_inputs);
  old=await snapshotIndex(resolve(baseline,'robinlab_inputs.jsonl'),b.collections.robinlab_inputs);
  let rehearsalManifest;
  if(rehearsal){rehearsalManifest=JSON.parse(await readFile(resolve(rehearsal,'manifest.json'),'utf8'));assert.deepEqual(rehearsalManifest.scope,b.scope);previous=await snapshotIndex(resolve(rehearsal,'robinlab_inputs.jsonl'),rehearsalManifest.collections.robinlab_inputs);}
  const ids=await missingIds(desired,old,previous);
  const scope={source:hash(canonical(a)),baseline:hash(canonical(b)),endpoint:config.endpoint,project:config.projectId,environment:config.environmentId,collection:'robinlab_inputs',format:1};
  if(rehearsalManifest)scope.rehearsal=hash(canonical(rehearsalManifest));
  const path=resolve(root,'import.json');let state;
  try{state=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(state.scope,scope);}catch(error){if(error.code!=='ENOENT')throw error;state={scope,missing:ids.length,parts:{}};}
  const save=()=>{writeFileSync(path+'.tmp',JSON.stringify(state,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);};save();
  console.log('Missing immutable input records',ids.length);
  let completed=0;
  for await(const part of inputParts(desired,ids)){
   const digest=hash(part.content),key=String(part.index);let receipt=state.parts[key];
   if(receipt){assert.equal(receipt.sha256,digest);assert.equal(receipt.rows,part.rows);assert.equal(receipt.bytes,part.bytes);}else{receipt=state.parts[key]={sha256:digest,rows:part.rows,bytes:part.bytes};save();}
   if(!receipt.succeeded){
    const file=resolve(root,'active-part.jsonl'),log=resolve(root,'part-'+key+'.log');await writeFile(file,part.content,{mode:0o600});
    const words=['data','import','--input',file,'--schema-version','1','--yes','--wait','--timeout','7200',...(receipt.jobId?['--job',receipt.jobId]:['--collection','robinlab_inputs','--strategy','create_only']),'--project',config.projectId,'--env',config.environmentId,'--endpoint',config.endpoint,'--profile','robinlab','--json'];
    const result=await new Promise((resolveResult,reject)=>{
     const child=spawn(process.execPath,[cliPath,...words],{stdio:['ignore','pipe','pipe']});let stdout='',tail='';
     child.stdout.on('data',chunk=>{stdout+=chunk;});
     child.stderr.on('data',chunk=>{appendFileSync(log,chunk,{mode:0o600});tail=(tail+chunk).slice(-4096);const match=tail.match(/\bjob (djob_[a-zA-Z0-9_]+)/);if(match&&!receipt.jobId){receipt.jobId=match[1];save();}});
     child.on('error',reject);child.on('close',code=>{try{if(code!==0)throw Error('Import incomplete; retain journal and inspect protected part log. Resume the same job; never create a replacement blindly.');resolveResult(JSON.parse(stdout));}catch(error){reject(error);}});
    });
    const job=result.job??result;assert.equal(job.jobId,receipt.jobId);assert.equal(job.state,'succeeded');assert.equal(job.collectionId,'robinlab_inputs');assert.equal(job.conflictStrategy,'create_only');
    assert.deepEqual(job.tenant,{projectId:config.projectId,environmentId:config.environmentId});
    assert.equal(job.manifest.digest,'sha256:'+digest);assert.equal(job.manifest.rowCount,part.rows);assert.equal(job.manifest.byteCount,part.bytes);
    assert.equal(job.progress.failed,0);assert.equal(job.progress.skipped,0);assert.equal(job.progress.committed,part.rows);assert.equal(job.progress.processed,part.rows);
    receipt.succeeded=true;receipt.verifiedAt=new Date().toISOString();save();await unlink(file);
   }
   completed+=part.rows;console.log('Imported missing inputs',completed,'/',ids.length,'part',part.index);
  }
  state.complete=true;state.completedAt=new Date().toISOString();save();return {created:completed,baseline:old.size,total:desired.size};
 }finally{await desired?.close();await old?.close();await previous?.close();await unlink(lock);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [source,baseline,configFile,cliPath,output,rehearsal]=process.argv.slice(2);assert.ok(output,'Usage: SOURCE BASELINE CONFIG INSTALLED_CLI_ENTRY PRIVATE_JOURNAL [VERIFIED_REHEARSAL]');
 console.log(JSON.stringify(await importInputs({source,baseline,configFile,cliPath,output,rehearsal})));
}
