import { createFunctionClientFromRequest, createServiceClient } from '@mako-cloud/edge-sdk';
import { initSync, domain_invoke, domain_version, parse_workbook } from './robinlab_function_wasm.js';
import { qualifyPortfolio } from './portfolio.ts';
import {qualifyWorkbook} from './workbooks.js';
import {UploadStore} from './shared/uploads.js';
import {batches,ensure} from './shared/errors.js';
import {boundedJson} from './shared/providers.js';
const owner = 'usr_bff00e348e6052c4559a7b1a2ba4c50c170121d6ad67439e9cd423ccd1d65df5';
const scope = {endpoint:Deno.env.get('MAKO_API_URL')!,projectId:Deno.env.get('MAKO_PROJECT_ID')!,environmentId:Deno.env.get('MAKO_ENVIRONMENT_ID')!};
const instance = crypto.randomUUID();
const startup = performance.now();
let wasm;
let startupFailure;
try {wasm = initSync({module:await Deno.readFile(new URL('./robinlab_function_wasm_bg.wasm', import.meta.url))});}
catch (error) {startupFailure=error instanceof Error ? String(error).slice(0,500) : 'Unknown';}
const wasmMilliseconds = performance.now()-startup;
const invoke = input => {
  const result = JSON.parse(domain_invoke(JSON.stringify({interfaceVersion:1,...input})));
  if (!result.ok) throw new Error('domain_rejected');
  return result.result;
};
Deno.serve(async (request: Request) => {
  // The platform owns cache-control and origin policy. Expose the business
  // version header without attempting to override its reserved security headers.
  const headers = {'content-type':'application/json','access-control-expose-headers':'x-robinlab-version','x-robinlab-version':'0'};
  const reply = (status,body) => new Response(JSON.stringify(body),{status,headers});
  let user;
  try {user=await createFunctionClientFromRequest({...scope,request}).auth.getUser();}
  catch {return reply(401,{error:'unauthorized'});}
  if (user.id !== owner || user.status !== 'active') return reply(403,{error:'forbidden'});
  if (!wasm) return reply(503,{error:'wasm_initialization_failed',startupFailure});
  let input;
  try {input=await request.json();} catch {return reply(400,{error:'invalid_request'});}
  try {
    const uploadDocuments=()=>createServiceClient({...scope,serviceCredential:Deno.env.get('ROBINLAB_QUALIFY_UPLOAD_KEY')!,reason:'Isolated bounded workbook upload qualification',requestId:`req_${crypto.randomUUID()}`}).documents('serverless_qualification_uploads');
    const uploads=new UploadStore(uploadDocuments,{schemaVersion:1});
    if(input.action==='uploadAdmit') return reply(200,{root:(await uploads.admit(input.commandId,input)).body});
    if(input.action==='uploadChunk') {
      if(typeof input.payload!=='string'||input.payload.length>349528)return reply(413,{error:'chunk_limit'});
      await uploads.putChunk(input.id,input.index,Uint8Array.from(atob(input.payload),c=>c.charCodeAt(0)));
      return reply(200,{stored:true});
    }
    if(input.action==='uploadSeal') {
      const started=performance.now();const {root,bytes}=await uploads.seal(input.id);
      const rows=JSON.parse(parse_workbook(bytes));
      return reply(200,{sealed:root.body.state==='sealed',bytes:bytes.length,rows:rows.length,milliseconds:performance.now()-started,memoryBytes:wasm.memory.buffer.byteLength});
    }
    if(input.action==='uploadCleanup') {
      const root=await uploads.root(input.id);
      const ids=[];for(let index=input.offset;index<Math.min(input.offset+16,root.body.chunks);index++)ids.push(await uploads.chunkId(input.id,index));
      if(input.offset>=root.body.chunks)ids.push(input.id);
      await batches(ids,4,async id=>{const row=await uploadDocuments().get(id);if(row&&!row._deleted){const result=await uploadDocuments().mutate(id,{mutationId:`qa_delete_${crypto.randomUUID()}`,operation:'delete',expectedRevision:row.revision,schemaVersion:1,body:row.body});if(!['applied','replayed'].includes(result.status))throw new Error('cleanup_conflict');}});
      return reply(200,{cleaned:ids.length});
    }
    const stageDocuments=()=>createServiceClient({...scope,serviceCredential:Deno.env.get('ROBINLAB_QUALIFY_STAGE_KEY')!,reason:'Isolated serverless staging qualification',requestId:`req_${crypto.randomUUID()}`}).documents('serverless_qualification_content');
    const stage=async document=>{
      const result=await stageDocuments().mutate(document.id,{mutationId:`qa_stage_${document.id}`,operation:'create',expectedRevision:null,schemaVersion:1,body:document});
      if(result.status==='conflict') {
        const row=await stageDocuments().get(document.id);
        if(!row||row._deleted||row.body.payload!==document.payload) throw new Error('stage_mismatch');
      } else if(!['applied','replayed'].includes(result.status)) throw new Error('stage_failed');
    };
    if(input.action==='cleanup') {
      if(!Array.isArray(input.ids)||input.ids.length>32||input.ids.some(id=>!/^[pm]_[0-9a-f]{64}$/.test(id))) return reply(400,{error:'invalid_cleanup'});
      for(const id of input.ids) {
        const row=await stageDocuments().get(id);
        if(row&&!row._deleted) {
          const result=await stageDocuments().mutate(id,{mutationId:`qa_cleanup_${crypto.randomUUID()}`,operation:'delete',expectedRevision:row.revision,schemaVersion:1,body:row.body});
          if(!['applied','replayed'].includes(result.status)) throw new Error('cleanup_conflict');
        }
      }
      return reply(200,{cleaned:input.ids.length});
    }
    const workbook=input.action==='workbook'?qualifyWorkbook(parse_workbook,input.kind):undefined;
    if(input.action==='yahoo'){
      const end=Math.floor(Date.now()/1000),start=end-30*86400;
      const response=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/VIGIX?period1=${start}&period2=${end}&interval=1d&events=splits`,{headers:{'User-Agent':'Mozilla/5.0'},redirect:'manual',signal:AbortSignal.timeout(12000)});
      ensure(response.ok,503,'Yahoo response unavailable');const payload=await boundedJson(response);
      const bars=invoke({action:'market_payload',provider:'yahoo',payload,scale:1.987}),splits=invoke({action:'normalize_splits',symbol:'VIGIX',response:payload});
      return reply(200,{host:'query1.finance.yahoo.com',status:response.status,bars:Object.keys(bars).length,latestDate:Object.keys(bars).sort().at(-1),splits:splits.length});
    }
    if(input.action==='twelvedata'){
      const url=new URL('https://api.twelvedata.com/price');
      url.search=new URLSearchParams({symbol:'SPY',apikey:Deno.env.get('TWELVE_DATA_API_KEY')!}).toString();
      const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});
      ensure(response.ok,503,'Twelve Data response unavailable');
      const price=invoke({action:'market_payload',provider:'quote',payload:await boundedJson(response)});
      ensure(typeof price==='number'&&Number.isFinite(price)&&price>0,503,'Twelve Data quote unavailable');
      return reply(200,{host:'api.twelvedata.com',status:response.status,normalizedQuote:true});
    }
    const egress=input.action==='egress'?await Promise.all(['https://api.snaptrade.com/api/v1/brokerages','https://api.twelvedata.com/price','https://financialmodelingprep.com/stable/batch-quote','https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=5d&interval=1d','https://example.com/'].map(async url=>{
      try {const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(4000)});await response.body?.cancel();return {host:new URL(url).hostname,status:response.status};}
      catch(error){return {host:new URL(url).hostname,denied:error.name==='TypeError'||error.name==='NotCapable',type:error.name};}
    })):undefined;
    const portfolio = ['portfolio','stage','stageSingle'].includes(input.action) ? await qualifyPortfolio(collection=>createServiceClient({
      ...scope,serviceCredential:Deno.env.get('ROBINLAB_QUALIFY_READ_KEY')!,reason:'Read-only serverless runtime qualification',requestId:`req_${crypto.randomUUID()}`,
    }).documents(collection),invoke,['stage','stageSingle'].includes(input.action)?stage:undefined,input.offset??0,input.action==='stageSingle'?1:32) : undefined;
    return reply(200,{instance,version:domain_version(),wasmMilliseconds,memoryBytes:wasm.memory.buffer.byteLength,
      portfolio,workbook,egress,scheduledHeaderPresent:request.headers.has('x-mako-schedule-id'),idempotencyKeyPresent:request.headers.has('idempotency-key')});
  } catch (error) {
    return reply(Number.isInteger(error?.status)?error.status:503,{error:'qualification_failed',type:error instanceof Error ? error.name : 'Unknown',upstreamStatus:Number.isInteger(error?.status)?error.status:undefined,upstreamCode:error?.code,upstreamRequestId:error?.requestId,upstreamReason:['document mutation is unavailable','document storage is unavailable','document sequencer is unavailable','quota authority is unavailable','collection schema is unavailable','service authorization is unavailable'].includes(error?.message)?error.message:undefined});
  }
});
