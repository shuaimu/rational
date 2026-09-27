// Create only explicitly named synthetic retention fixtures. Financial records
// are never mutated; the actual deployed dispatcher performs the cleanup.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {readFile,writeFile} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
const root=new URL('../../',import.meta.url),c=JSON.parse(await readFile(new URL('mako/runtime.json',root))),path=new URL('.local/mako-serverless/hosted-cleanup.json',root),report=JSON.parse(await readFile(path,'utf8').catch(()=>'{}'));
const sha=v=>createHash('sha256').update(v).digest('hex'),now=report.fixtureTime??Date.now(),old=now-8*86400000;report.fixtureTime=now;
const scope=['--project',c.projectId,'--env',c.environmentId,'--endpoint',c.endpoint,'--profile','robinlab','--json'];
function command(args){return JSON.parse(execFileSync('node',['/tmp/robinlab-mako.j724da/platform/packages/cli/dist/main.js',...args,...scope],{encoding:'utf8',maxBuffer:2*1024*1024}));}
const save=()=>writeFile(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function put(collection,content,schemaVersion=1){const file=new URL(`.local/mako-serverless/cleanup-${content.id}.json`,root);await writeFile(file,JSON.stringify({kind:'create',documentId:content.id,expectedRevision:null,schemaVersion,content}),{mode:0o600});try{command(['explorer','mutate',collection,'--reason','Create disposable serverless retention fixture','--mutation','@'+file.pathname,'--yes']);}catch(error){const existing=get(collection,content.id);assert.equal(existing.deleted,false);assert.deepEqual(existing.content,content);}}
function get(collection,id){try{return command(['explorer','get',collection,id,'--reason','Verify disposable serverless retention fixture']);}catch(error){if(String(error.stderr).includes('error not_found:'))return {deleted:true,content:null};throw error;}}
function artifact(jobId,value){const bytes=Buffer.from(JSON.stringify(value)),digest=sha(bytes),chunk={id:'b_'+sha(`${jobId}:0:${digest}`),jobId,kind:'chunk',digest,bytes:bytes.length,payload:bytes.toString('base64')};const manifest={id:'a_'+sha(`${jobId}:${digest}:${bytes.length}`),jobId,kind:'manifest',digest,bytes:bytes.length,chunks:[chunk.id]};return {chunk,manifest,reference:{id:manifest.id,digest,bytes:bytes.length}};}
try{
 if(!report.prepared){
  const identity='serverless_cleanup_fixture_'+now,jobId='j_'+sha(identity),uploadId='u_'+sha(identity),chunkId='k_'+sha(`${uploadId}:0`),bytes=Buffer.from([42]),digest=sha(bytes);
  const transient=artifact(jobId,{temporary:true}),result=artifact(jobId,{cleanupFixture:true});
  report.fixture={identity,jobId,uploadId,chunkId,transient,result};report.created??=[];await save();
  for(const a of [transient,result])for(const content of [a.chunk,a.manifest]){await put('robinlab_inputs',content);report.created.push(content.id);await save();}
  await put('robinlab_uploads',{id:uploadId,kind:'upload',commandId:identity,bytes:1,digest,chunkBytes:262144,chunks:1,createdAt:old,state:'uploading',expiresAt:now-1},2);
  await put('robinlab_uploads',{id:chunkId,kind:'chunk',uploadId,index:0,bytes:1,digest,payload:bytes.toString('base64')},2);
  await put('robinlab_jobs',{id:jobId,commandId:identity,kind:'summary',input:{},inputHash:sha(JSON.stringify({input:{},kind:'summary'})),state:'completed',generation:1,attempt:1,createdAt:old,updatedAt:old,dueAt:Number.MAX_SAFE_INTEGER,leaseUntil:0,worker:null,checkpoint:null,cancelRequested:false,result:{version:0,responseArtifact:result.reference},error:null,artifactsExpireAt:now-1});
  report.prepared=true;await save();
 }
 const f=report.fixture;
 for(let tick=0;tick<12;tick++){
  const job=get('robinlab_jobs',f.jobId),upload=get('robinlab_uploads',f.uploadId);
  if(job.content.artifactsExpireAt===null&&upload.content.state==='expired'&&upload.content.expiresAt===null)break;
  const run=command(['schedules','run-now','sch_eds861nfcp7vmojq','--function','robinlab-jobs']);
  for(let poll=0;poll<35;poll++){await delay(1000);const history=command(['schedules','runs','sch_eds861nfcp7vmojq','--function','robinlab-jobs','--limit','10']);const done=history.items.find(r=>r.id===(run.id??run.runId)&&r.outcome);if(done){assert.equal(done.outcome,'succeeded');break;}}
 }
 assert.equal(get('robinlab_jobs',f.jobId).content.artifactsExpireAt,null);
 assert.equal(get('robinlab_uploads',f.uploadId).content.state,'expired');
 for(const id of [f.transient.chunk.id,f.transient.manifest.id])assert.equal(get('robinlab_inputs',id).deleted,true);
 assert.equal(get('robinlab_uploads',f.chunkId).deleted,true);
 for(const id of [f.result.chunk.id,f.result.manifest.id])assert.equal(get('robinlab_inputs',id).deleted,false);
 report.complete=true;delete report.failure;console.log('Hosted cleanup removed only expired inputs and preserved replay results');
}catch(error){report.failure={name:error.name,message:error.message};console.error(error.message);process.exitCode=1;}finally{await save();}
