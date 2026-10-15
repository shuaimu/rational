import {RUNTIME_MODE} from '../shared/admission.js';
import {createServiceClient} from '@mako-cloud/edge-sdk';
import {initSync,domain_invoke,parse_workbook} from '../generated/robinlab_function_wasm.js';
import {domainCall} from '../shared/errors.js';
import {PortfolioRepository} from '../shared/repository.js';
import {UploadStore} from '../shared/uploads.js';
import {JobStore} from '../shared/jobs.js';
import {Artifacts} from '../shared/artifacts.js';
import {SnapTrade,ProviderLimiter} from '../shared/providers.js';
import {PriceProvider} from '../shared/price-provider.js';
import {ProviderLog} from '../shared/provider-log.js';
import {CacheMaintenance} from './cache-maintenance.js';
import {ArtifactCleanup} from './cleanup.js';
import {PriceCache} from '../shared/cache.js';
import {SnapTradeCapture} from './snaptrade.js';
import {JobWorker} from './worker.js';
import {CacheReports} from './cache-reports.js';
import {JobLanes} from '../shared/coordination.js';
import {admitDaily,admitQuotes,DAILY_SYNC_ENABLED} from './dispatcher.js';
import {continuationResponse} from './continuation.js';
import {coalesceAutomatic} from '../shared/automatic-jobs.js';
const scope={endpoint:Deno.env.get('MAKO_API_URL')!,projectId:Deno.env.get('MAKO_PROJECT_ID')!,environmentId:Deno.env.get('MAKO_ENVIRONMENT_ID')!};
initSync({module:await Deno.readFile(new URL('../generated/robinlab_function_wasm_bg.wasm',import.meta.url))});
const domain=input=>domainCall(domain_invoke,input);
const keys={cache_status:'ROBINLAB_FUNCTION_MAINTENANCE_KEY',robinlab_counters:'ROBINLAB_FUNCTION_LOGS_KEY',robinlab_coordination:'ROBINLAB_FUNCTION_JOBS_KEY',provider_requests:'ROBINLAB_FUNCTION_LOGS_KEY',robinlab_lanes:'ROBINLAB_FUNCTION_LANES_KEY',portfolio_heads:'ROBINLAB_FUNCTION_PORTFOLIO_KEY',portfolio_public:'ROBINLAB_FUNCTION_PORTFOLIO_KEY',portfolio_private:'ROBINLAB_FUNCTION_PORTFOLIO_KEY',portfolio_commands:'ROBINLAB_FUNCTION_PORTFOLIO_KEY',robinlab_uploads:'ROBINLAB_FUNCTION_JOBS_KEY',robinlab_jobs:'ROBINLAB_FUNCTION_JOBS_KEY',robinlab_inputs:'ROBINLAB_FUNCTION_INPUTS_KEY',latest_prices:'ROBINLAB_FUNCTION_CACHE_KEY',historical_prices:'ROBINLAB_FUNCTION_CACHE_KEY',split_fetch:'ROBINLAB_FUNCTION_CACHE_KEY'};
const documents=collection=>createServiceClient({...scope,serviceCredential:Deno.env.get(keys[collection])!,reason:'RobinLab durable job phase',requestId:`req_${crypto.randomUUID()}`}).documents(collection);
Deno.serve(async request=>{
 const schedule=request.headers.get('x-mako-schedule-id'),run=request.headers.get('x-mako-schedule-run-id'),due=request.headers.get('x-mako-schedule-due-at');
 // The deployed gateway strips these on public requests. Only the qualified
 // internal scheduler path preserves them; no secret is stored in cron bodies.
 if(request.method!=='POST'||!schedule?.startsWith('sch_')||!run||!due||!Number.isFinite(Date.parse(due)))return Response.json({error:'Forbidden'},{status:403});
 if(!['active','draining'].includes(RUNTIME_MODE))return Response.json({processed:0,paused:true});
 try{
  const jobs=new JobStore(()=>documents('robinlab_jobs'),{canonical:value=>domain({action:'canonical',value}).payload});
  if(RUNTIME_MODE==='active'&&DAILY_SYNC_ENABLED){await admitDaily(jobs,due);await admitQuotes(jobs,due);}
  const url=new URL(request.url),maintenance=url.pathname.endsWith('/maintenance/automatic-jobs');
  const cleanup=RUNTIME_MODE==='active'?await coalesceAutomatic(jobs,{dryRun:maintenance&&url.searchParams.get('dryRun')==='true'}):null;
  console.log(JSON.stringify({event:'automatic_job_cleanup',...cleanup}));
  if(maintenance)return Response.json({processed:0,cleanup});
  const lanes=new JobLanes(()=>documents('robinlab_lanes'),jobs);
  const now=Date.now(),dueJobs=await jobs.due(32,now+300000);
  const runnable=await lanes.runnable(dueJobs,now+300000,{draining:RUNTIME_MODE==='draining'});
  const candidates=runnable.filter(row=>row.body.dueAt<=now&&row.body.leaseUntil<=now).slice(0,1);
  let processed=0,progressed=false,pending=[...new Map([...dueJobs,...runnable].map(row=>[row.body.id,row])).values()];

  for(const candidate of candidates){
   const repository=new PortfolioRepository({documents,domain}),artifacts=new Artifacts(()=>documents('robinlab_inputs')),cache=new PriceCache(documents);
   const broker=new SnapTrade({clientId:Deno.env.get('SNAPTRADE_CLIENT_ID'),consumerKey:Deno.env.get('SNAPTRADE_CONSUMER_KEY'),canonical:value=>domain({action:'canonical',value}).payload});
   const providerLog=new ProviderLog(documents),provider=new PriceProvider({twelveKey:Deno.env.get('TWELVE_DATA_API_KEY'),limiter:new ProviderLimiter(()=>documents('robinlab_coordination')),record:value=>providerLog.record(value),domain});
   const worker=new JobWorker({jobs,repository,uploads:new UploadStore(()=>documents('robinlab_uploads')),artifacts,domain,broker,cache,reports:new CacheReports({cache,artifacts,domain}),maintenance:new CacheMaintenance({cache,artifacts,domain,provider,repository}),lanes,parseWorkbook:parse_workbook,snaptradeCapture:new SnapTradeCapture({repository,artifacts,broker,cache,domain})});
   const result=await worker.run(candidate.body.id,run);processed++;progressed=!!result&&!result.body.error&&result.body.generation>candidate.body.generation;
   pending=pending.filter(row=>row.body.id!==candidate.body.id);
   if(result&&['queued','retry','running','committing'].includes(result.body.state))pending.push(result);
  }
  if(!processed)await new ArtifactCleanup({jobs,uploads:new UploadStore(()=>documents('robinlab_uploads')),artifacts:new Artifacts(()=>documents('robinlab_inputs'))}).step();
  return Response.json(continuationResponse({processed,cleanup,progressed,pending}));
 }catch(error){console.error(JSON.stringify({event:'dispatch_unavailable',type:error?.name,status:error?.status,code:error?.code,requestId:error?.requestId}));return Response.json({error:'Job dispatch is unavailable'},{status:503});}
});
