import {checkAdmission} from '../shared/admission.js';
import {ensure,ApiError,ContinuationRequired,publicError} from '../shared/errors.js';
import {brokerRoute} from './broker.js';
import {adminRoute} from './admin.js';
import {admitQuotes,PRICE_REFRESH_ENABLED} from '../shared/quote-admission.js';
const queryTypes={days:'number',apply:'boolean',reconstruct_rolls:'boolean',fresh:'boolean',replace:'boolean',roll_detect:'boolean',account_id:'number',ticker_id:'number',limit:'number',offset:'number',include_cash_equivalents:'boolean',include_closed:'boolean'};
export function queryInput(search) {
 const result={};for(const [key,value] of search) {
  ensure(!Object.hasOwn(result,key),400,'Duplicate query parameter');
  if(queryTypes[key]==='number'){ensure(/^-?\d+$/.test(value)&&Number.isSafeInteger(Number(value)),400,'Invalid numeric query parameter');result[key]=Number(value);}
  else if(queryTypes[key]==='boolean'){ensure(value==='true'||value==='false',400,'Invalid boolean query parameter');result[key]=value==='true';}
  else result[key]=value;
 }
 return result;
}
const numericId=value=>{ensure(/^-?\d+$/.test(value)&&Number.isSafeInteger(Number(value)),400,'Invalid resource id');return Number(value);};
async function jsonInput(request) {ensure(request.headers.get('content-type')?.split(';')[0].trim()==='application/json',415,'Expected JSON request');try{return await request.json();}catch{throw new ApiError(400,'Invalid request body');}}
const readRoutes=new Map([['/accounts','accounts'],['/tickers','tickers'],['/transactions','transactions'],['/analytics/summary','summary'],['/analytics/performance','performance'],['/analytics/ticker-pnl','ticker_pnl']]);
const writeRoutes=new Map([['/accounts','create_account'],['/transactions','create_transaction'],['/transactions/roll-option','option_roll'],['/transactions/close-option','option_close'],['/transactions/expire-option','option_expire'],['/transactions/assign-option','option_assign']]);
export function createApi({authorize,repository,domain,cache,uploads,jobs,broker,artifacts,providers,mode="active",clock=()=>new Date()}) {
 return async request=>{
  const headers={'content-type':'application/json','access-control-expose-headers':'x-robinlab-version'};
  const reply=(body,status=200,version)=>{if(version!==undefined)headers['x-robinlab-version']=String(version);return new Response(JSON.stringify(body),{status,headers});};
  try {
   await authorize(request);
   const url=new URL(request.url);
   let path=url.pathname.replace(/^.*\/functions\/v1\/[^/]+/,'');
   if(path.startsWith('/api/'))path=path.slice(4);
   path=path.replace(/\/$/,'')||'/';const method=request.method;
   checkAdmission(mode,method,path);
   const commandId=()=>{const id=request.headers.get('idempotency-key');ensure(id,400,'Idempotency-Key is required');return id;};
   const now=()=>clock().toISOString().slice(0,19).replace('T',' ');
   if(path.startsWith('/admin/')){const response=await adminRoute({request,path,query:queryInput(url.searchParams),cache,domain,jobs,reply,body:()=>jsonInput(request),clock,providers});if(response)return response;}
   if(broker&&path.startsWith('/snaptrade/')) {
    const response=await brokerRoute({request,path,query:url.searchParams,repository,domain,broker,jobs,reply,body:()=>jsonInput(request),now});if(response)return response;
   }
   if(method==='GET'&&path==='/portfolio/version')return reply({version:(await repository.head()).body.sequence});
   if(method==='GET'&&path==='/prices')return reply(await cache.latest());
   const single=/^\/(accounts|transactions)\/([^/]+)$/.exec(path);
   if(method==='GET'&&(readRoutes.has(path)||single)) {
    const operation=single?(single[1]==='accounts'?'account':'transaction'):readRoutes.get(path);
    const input=single?{id:numericId(single[2])}:queryInput(url.searchParams);
    const {dataset}=await repository.load();return reply(domain({action:'read',operation,input,dataset}));
   }
   if(method==='GET'&&path==='/analytics/accounts-performance'&&cache.status){const status=await cache.status();if(status?.body.state==='updating')return reply({...jobs.status(await jobs.get(status.body.jobId)),resumePath:path+url.search},202);}
   const positions=/^\/positions(?:\/([^/]+))?$/.exec(path);
   if(method==='GET'&&(positions||['/analytics/yield','/analytics/accounts-performance'].includes(path))) {
    const query=queryInput(url.searchParams),{dataset}=await repository.load(),latest=await cache.latest(),today=clock().toISOString().slice(0,10);
    const operation=positions?'positions':path.endsWith('/yield')?'yield':'accounts_performance';
    const input={latest,today,account_id:positions?.[1]?numericId(positions[1]):null,include_closed:query.include_closed??false};
    if(operation==='accounts_performance')input.historical=await cache.pricesAt(dataset,today);
    if(mode==='active'&&positions&&jobs&&PRICE_REFRESH_ENABLED)await admitQuotes(jobs,clock());
    return reply(domain({action:'read',operation,dataset,input}));
   }
   let operation,input;
   if(method==='POST'&&writeRoutes.has(path)){operation=writeRoutes.get(path);input=await jsonInput(request);}
   else if(single?.[1]==='transactions'&&['PUT','DELETE'].includes(method)) {
    operation=method==='PUT'?'update_transaction':'delete_transaction';input={id:numericId(single[2])};if(method==='PUT')input.body=await jsonInput(request);
   }
   if(operation){
    const id=commandId(),identity=domain({action:'identity',id,operation,input});
    if(jobs&&await jobs.find(id)) {
     const row=await jobs.admit(id,'portfolio-command',{operation,input});
     if(row.body.state==='completed')return reply(row.body.result.response,200,row.body.result.version);
     return reply(jobs.status(row),202);
    }
    try{const result=await repository.execute({identity,operation,input,now:now()});return reply(result.response,200,result.version);}
    catch(error){if(!(error instanceof ContinuationRequired)||!jobs)throw error;const row=await jobs.admit(id,'portfolio-command',{operation,input});return reply(jobs.status(row),202);}
   }
   if(path==='/jobs/portfolio'&&method==='POST') {
    const body=await jsonInput(request),id=commandId();
    ensure(['create_account','create_transaction','update_transaction','delete_transaction','option_roll','option_close','option_expire','option_assign'].includes(body.operation),400,'Unsupported portfolio command');
    domain({action:'identity',id,operation:body.operation,input:body.input});
    const row=await jobs.admit(id,'portfolio-command',{operation:body.operation,input:body.input});return reply(jobs.status(row),202);
   }
   if(path==='/uploads'&&method==='POST'){const row=await uploads.admit(commandId(),await jsonInput(request));return reply({id:row.body.id,state:row.body.state,chunkBytes:row.body.chunkBytes,chunks:row.body.chunks});}
   const chunk=/^\/uploads\/(u_[a-f0-9]{64})\/chunks\/(\d+)$/.exec(path);
   if(chunk&&method==='PUT'){ensure(request.headers.get('content-type')==='application/octet-stream',415,'Expected binary chunk');await uploads.putChunk(chunk[1],Number(chunk[2]),new Uint8Array(await request.arrayBuffer()));return reply({stored:true});}
   const seal=/^\/uploads\/(u_[a-f0-9]{64})\/seal$/.exec(path);
   if(seal&&method==='POST'){const {root}=await uploads.seal(seal[1]);return reply({id:root.body.id,state:root.body.state});}
   if(path==='/import/snaptrade'&&method==='POST'){
    const q=queryInput(url.searchParams),input={apply:q.apply??false,reconstruct_rolls:q.reconstruct_rolls??true,fresh:q.fresh??false,replace:q.replace??false,roll_detect:q.roll_detect??false,start_date:q.start_date??null};
    const id=request.headers.get('idempotency-key')??(!input.apply||input.roll_detect?`preview_${crypto.randomUUID()}`:commandId());
    return reply(jobs.status(await jobs.admit(id,'snaptrade',input)),202);
   }
   if(path==='/import/excel'&&method==='POST'){
    const input=await jsonInput(request),id=commandId(),existing=await jobs.find(id);
    if(existing){ensure(existing.body.kind==='excel'&&existing.body.input.uploadId===input.uploadId,409,'Import command already has different input');return reply(jobs.status(existing),202);}
    const root=await uploads.bind(input.uploadId,await jobs.id(id));
    const row=await jobs.admit(id,'excel',{uploadId:root.body.id,sha256:root.body.digest});return reply(jobs.status(row),202);
   }
   if(path==='/jobs'&&method==='GET')return reply(await jobs.pendingPage(url.searchParams.get('cursor')));
   const job=/^\/jobs\/(j_[a-f0-9]{64})(\/cancel)?$/.exec(path);
   if(job&&(method==='GET'&&!job[2]||method==='POST'&&job[2])){
    const row=job[2]?await jobs.cancel(job[1]):await jobs.get(job[1]),status=jobs.status(row);
    if(status.result?.responseArtifact)status.result={version:status.result.version,response:await artifacts.load(row.body.id,status.result.responseArtifact)};
    return reply(status);
   }
   throw new ApiError(404,'Route not found');
  }catch(error){const failure=publicError(error);return reply({error:failure.error},failure.status);}
 };
}
