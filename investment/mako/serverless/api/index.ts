import {RUNTIME_MODE} from '../shared/admission.js';
import {createFunctionClientFromRequest,createServiceClient} from '@mako-cloud/edge-sdk';
import {initSync,domain_invoke} from '../generated/robinlab_function_wasm.js';
import {createApi} from './handler.js';
import {ApiError,domainCall} from '../shared/errors.js';
import {PortfolioRepository} from '../shared/repository.js';
import {PriceCache} from '../shared/cache.js';
import {UploadStore} from '../shared/uploads.js';
import {Artifacts} from '../shared/artifacts.js';
import {SnapTrade} from '../shared/providers.js';
import {JobStore} from '../shared/jobs.js';
const scope={endpoint:Deno.env.get('MAKO_API_URL')!,projectId:Deno.env.get('MAKO_PROJECT_ID')!,environmentId:Deno.env.get('MAKO_ENVIRONMENT_ID')!};
const owner=Deno.env.get('ROBINLAB_OWNER_ID');
initSync({module:await Deno.readFile(new URL('../generated/robinlab_function_wasm_bg.wasm',import.meta.url))});
const domain=input=>domainCall(domain_invoke,input);
const broker=new SnapTrade({clientId:Deno.env.get('SNAPTRADE_CLIENT_ID'),consumerKey:Deno.env.get('SNAPTRADE_CONSUMER_KEY'),canonical:value=>domain({action:'canonical',value}).payload});
const keys={cache_status:'ROBINLAB_FUNCTION_STATUS_KEY',portfolio_heads:'ROBINLAB_FUNCTION_PORTFOLIO_KEY',portfolio_public:'ROBINLAB_FUNCTION_PORTFOLIO_KEY',portfolio_private:'ROBINLAB_FUNCTION_PORTFOLIO_KEY',portfolio_commands:'ROBINLAB_FUNCTION_PORTFOLIO_KEY',latest_prices:'ROBINLAB_FUNCTION_CACHE_KEY',historical_prices:'ROBINLAB_FUNCTION_CACHE_KEY',robinlab_uploads:'ROBINLAB_FUNCTION_JOBS_KEY',robinlab_jobs:'ROBINLAB_FUNCTION_JOBS_KEY',robinlab_inputs:'ROBINLAB_FUNCTION_RESULTS_KEY'};
const documents=collection=>{
 const key=keys[collection];if(!key)throw new ApiError(503,'Storage collection is unavailable');
 return createServiceClient({...scope,serviceCredential:Deno.env.get(key)!,reason:'Authorized RobinLab domain operation',requestId:`req_${crypto.randomUUID()}`}).documents(collection);
};
Deno.serve(request=>createApi({
 mode:RUNTIME_MODE,
 authorize:async request=>{
  let user;
  try{user=await createFunctionClientFromRequest({...scope,request}).auth.getUser();}
  catch(error){if(error?.status===401||error?.statusCode===401)throw new ApiError(401,'Unauthorized');throw new ApiError(503,'Authentication is unavailable');}
  if(user.id!==owner||user.status!=='active')throw new ApiError(403,'Forbidden');
 },
 providers:{fmp_enabled:false,twelve_data_enabled:true,yahoo_finance_enabled:false},
 repository:new PortfolioRepository({documents,domain}),domain,broker,cache:new PriceCache(documents),
 artifacts:new Artifacts(()=>documents('robinlab_inputs')),
 uploads:new UploadStore(()=>documents('robinlab_uploads')),
 jobs:new JobStore(()=>documents('robinlab_jobs'),{canonical:value=>domain({action:'canonical',value}).payload}),
})(request));
