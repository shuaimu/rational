import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {MakoAuthClient,normalizeMakoRxdbConfig} from '@mako-cloud/rxdb';
const root=new URL('../../',import.meta.url),config=JSON.parse(await readFile(new URL('mako/runtime.json',root))),identities=JSON.parse(await readFile(new URL('.local/mako-migration/qualification-identities.json',root)));
const fixture=process.argv.includes('--delete-fixture'),clear=process.argv.includes('--clear')||fixture,prefetch=process.argv.includes('--prefetch'),mode=fixture?'delete-fixture':clear?'clear':prefetch?'prefetch':'summary',path=new URL(`.local/mako-serverless/hosted-admin-${mode}.json`,root),report=JSON.parse(await readFile(path,'utf8').catch(()=>'{}'));report.runs??=[];
const auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}));
const base=`${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/robinlab-api`;let token;
const save=()=>writeFile(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const management=args=>JSON.parse(execFileSync('node',['/tmp/robinlab-mako.j724da/platform/packages/cli/dist/main.js',...args,'--function','robinlab-jobs','--project',config.projectId,'--env',config.environmentId,'--endpoint',config.endpoint,'--profile','robinlab','--json'],{encoding:'utf8',maxBuffer:1024*1024}));
async function call(path,{native=false,method='GET',body,key,status=200}={}){const response=await fetch((native?'http://127.0.0.1:3000/api':base)+path,{method,headers:{'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(native?180000:30000)});assert.equal(response.status,status,`${path}: HTTP ${response.status}`);return response.json();}
try{
 token=(await auth.signInWithPassword(identities.owner.email,identities.owner.password)).accessToken;
 if(!report.jobId){
  report.at=new Date().toISOString();report.before=await call('/portfolio/version');
  for(const route of ['/admin/cache-coverage?symbol=SPY&days=30','/admin/cache-price-trend?symbol=SPY&days=30'])assert.deepEqual(await call(route),await call(route,{native:true}));report.rangeParity=true;
  if(!clear&&!prefetch)report.expected=await call('/admin/api-usage',{native:true});
  const job=clear?await call('/admin/api-usage/cache/clear',{method:'POST',body:{scope:'symbol',symbol:fixture?'ROBINLAB_SERVERLESS_PRICE_FIXTURE':'ROBINLAB_SERVERLESS_CLEAR_QUALIFICATION'},key:fixture?'serverless_fixture_cache_clear_0001':'serverless_empty_cache_clear_0001',status:202}):prefetch?await call('/admin/api-usage/cache/prefetch',{method:'POST',body:{symbols:['SPY'],days:30},key:'serverless_provider_prefetch_0001',status:202}):await call('/admin/api-usage',{status:202});
  report.jobId=job.id;await save();
 }
 let job=await call('/jobs/'+report.jobId);
 for(let tick=0;tick<80&&job.state!=='completed';tick++){
  assert.ok(!['failed','needs-attention','cancelled'].includes(job.state),`job ${job.state}: ${job.error}`);
  if(job.retryAt>Date.now())await delay(Math.min(job.retryAt-Date.now()+100,60000));
  const queued=management(['schedules','run-now','sch_eds861nfcp7vmojq']);let completed;
  for(let poll=0;poll<40;poll++){await delay(1000);const runs=management(['schedules','runs','sch_eds861nfcp7vmojq','--limit','10']);completed=runs.items.find(run=>run.id===(queued.id??queued.runId)&&run.outcome);if(completed)break;}
  assert.ok(completed);report.runs.push(completed);await save();
  job=await call('/jobs/'+report.jobId);report.state={state:job.state,attempt:job.attempt,error:job.error};console.log(`Cache ${mode}: ${job.state}, attempt ${job.attempt}`);await save();
  assert.equal(completed.outcome,'succeeded');
 }
 assert.equal(job.state,'completed');
 if(clear){assert.deepEqual(job.result.response,{scope:'symbol',deleted_rows:fixture?3:0});assert.ok(job.result.cacheGeneration>=1);report.cacheGeneration=job.result.cacheGeneration;}
 else if(prefetch){assert.equal(job.result.response.requested_symbols,1);assert.equal(job.result.response.cached_symbols,1);assert.ok(job.result.response.bars_cached>0);report.response=job.result.response;report.cacheGeneration=job.result.cacheGeneration;assert.deepEqual(await call('/admin/cache-price-trend?symbol=SPY&days=30'),await call('/admin/cache-price-trend?symbol=SPY&days=30',{native:true}));}
 else{const {as_of,...result}=job.result.response;assert.ok(as_of);assert.deepEqual(result,report.expected);report.capturedAt=as_of;delete report.expected;}
 report.after=await call('/portfolio/version');assert.deepEqual(report.after,report.before);report.complete=true;delete report.failure;console.log(`Hosted cache ${mode} verified without a financial write`);
}catch(error){report.failure={name:error.name,message:error.message};console.error(error.message);process.exitCode=1;}
finally{await save();try{await auth.signOut();}catch{}}
