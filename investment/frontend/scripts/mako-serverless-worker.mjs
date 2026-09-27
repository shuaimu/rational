import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {MakoAuthClient,normalizeMakoRxdbConfig} from '@mako-cloud/rxdb';
const root=new URL('../../',import.meta.url),config=JSON.parse(await readFile(new URL('mako/runtime.json',root))),identities=JSON.parse(await readFile(new URL('.local/mako-migration/qualification-identities.json',root)));
const journal=JSON.parse(await readFile(new URL('.local/mako-migration/final-20260925/api-smoke-journal.json',root))),schedule=JSON.parse(await readFile(new URL('.local/mako-serverless/dispatcher-schedule.json',root)));
assert.equal(schedule.enabled,false);assert.ok(journal.cleaned);
const auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}));
const preview=process.argv.includes('--preview'),excel=process.argv.includes('--excel');
const base=`${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/`,report={at:new Date().toISOString(),runs:[]};let token;
const save=()=>writeFile(new URL(preview?'.local/mako-serverless/hosted-preview.json':excel?'.local/mako-serverless/hosted-excel.json':'.local/mako-serverless/hosted-worker.json',root),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const management=args=>JSON.parse(execFileSync('node',['/tmp/robinlab-mako.j724da/platform/packages/cli/dist/main.js',...args,'--function','robinlab-jobs','--project',config.projectId,'--env',config.environmentId,'--endpoint',config.endpoint,'--profile','robinlab','--json'],{encoding:'utf8',maxBuffer:1024*1024}));
async function call(path,{method='GET',body,key,status=200}={}){const response=await fetch(base+'robinlab-api'+path,{method,headers:{'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});assert.equal(response.status,status,`${path}: ${response.status}`);return response.json();}
try{
 const spoof=await fetch(base+'robinlab-jobs',{method:'POST',headers:{'x-mako-key':config.publicProjectKey,'x-mako-schedule-id':schedule.id,'x-mako-schedule-run-id':'run_public_spoof','x-mako-schedule-due-at':new Date().toISOString()}});assert.equal(spoof.status,403);report.spoofDenied=true;
 token=(await auth.signInWithPassword(identities.owner.email,identities.owner.password)).accessToken;
 report.before=await call('/portfolio/version');
 const readHead=async()=>{const response=await fetch(`${config.endpoint}/v1/projects/${config.projectId}/environments/${config.environmentId}/collections/portfolio_heads/documents/portfolio`,{headers:{'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`}});assert.equal(response.status,200);return (await response.json()).body;};
 const beforeHead=excel?await readHead():null;
 let excelInput;
 if(excel){
  const bytes=await readFile(new URL('.local/mako-serverless/empty-import.xlsx',root));
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const upload=await call('/uploads',{method:'POST',body:{bytes:bytes.length,digest},key:'serverless_empty_upload_qualification_0001'});report.uploadId=upload.id;await save();
  const response=await fetch(base+`robinlab-api/uploads/${upload.id}/chunks/0`,{method:'PUT',headers:{'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`,'content-type':'application/octet-stream'},body:bytes});assert.equal(response.status,200);
  await call(`/uploads/${upload.id}/seal`,{method:'POST',body:{}});excelInput={uploadId:upload.id};
 }

 const input={operation:'update_transaction',input:{id:journal.steps.rollback_trade.result.id,body:{fees:0.25}}},key=`smoke_${journal.run}_update_trade`;
 let job=excel?await call('/import/excel',{method:'POST',body:excelInput,key:'serverless_empty_excel_qualification_0001',status:202}):preview?await call('/import/snaptrade?apply=false',{method:'POST',key:'serverless_preview_qualification_0001',status:202}):await call('/jobs/portfolio',{method:'POST',body:input,key,status:202});report.jobId=job.id;await save();
 const duplicate=excel?await call('/import/excel',{method:'POST',body:excelInput,key:'serverless_empty_excel_qualification_0001',status:202}):preview?await call('/import/snaptrade?apply=false',{method:'POST',key:'serverless_preview_qualification_0001',status:202}):await call('/jobs/portfolio',{method:'POST',body:input,key,status:202});assert.equal(duplicate.id,job.id);report.duplicateAdmission=true;
 for(let tick=0;tick<60&&job.state!=='completed';tick++){
  if(job.retryAt&&job.retryAt>Date.now())await delay(Math.min(job.retryAt-Date.now()+100,60000));
  const queued=management(['schedules','run-now',schedule.id]);report.runs.push(queued);await save();
  let finished=false;
  for(let poll=0;poll<35;poll++){
   await delay(1000);const history=management(['schedules','runs',schedule.id,'--limit','10']);
   const run=history.items.find(row=>row.id===queued.id||row.id===queued.runId);
   if(run&&['succeeded','failed','error','skipped_overlap'].includes(run.outcome)){assert.equal(run.outcome,'succeeded');finished=true;report.runs[report.runs.length-1]=run;break;}
  }
  assert.ok(finished,'Hosted scheduled run did not finish');job=await call('/jobs/'+job.id);console.log(`Hosted worker: ${job.state}, attempt ${job.attempt}`);await save();
 }
 assert.equal(job.state,'completed');
 if(excel){assert.deepEqual(job.result.response,{accounts_created:0,tickers_created:0,transactions_imported:0});const afterHead=await readHead();assert.deepEqual(afterHead.public_root,beforeHead.public_root);assert.deepEqual(afterHead.private_root,beforeHead.private_root);assert.deepEqual(afterHead.next_ids,beforeHead.next_ids);report.unchangedFinancialRoots=true;}else if(preview){
  assert.equal(job.result.version,0);
  const response=await fetch('http://127.0.0.1:3000/api/import/snaptrade?apply=false',{method:'POST',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(180000)});assert.equal(response.status,200);const expected=await response.json();
  assert.deepEqual(job.result.response,expected);report.nativeParity=true;
 }else{assert.equal(job.result.version,journal.steps.update_trade.version);assert.deepEqual(job.result.response,journal.steps.update_trade.result);}
 report.originalVersion=job.result.version;
 report.after=await call('/portfolio/version');if(!excel)assert.deepEqual(report.after,report.before);report.complete=true;console.log(excel?'Hosted Excel import completed with unchanged financial roots':'Hosted worker replay completed without a portfolio write');
}catch(error){report.failure={type:error.name,message:error.message};console.error(error.message);process.exitCode=1;}
finally{await save();try{await auth.signOut();}catch{}}
