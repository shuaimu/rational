import {ensure,ApiError} from './errors.js';
const encoder=new TextEncoder();
export class ProviderError extends ApiError {
 constructor(code,{retryAt=null,ambiguous=false}={}){super(503,'Provider operation is unavailable');this.code=code;this.retryAt=retryAt;this.ambiguous=ambiguous;}
}
export async function boundedJson(response,maximum=4*1024*1024) {
 ensure(response.body,503,'Provider response is empty');const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maximum)throw new ProviderError('response_limit');chunks.push(value);}}
 finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ProviderError('invalid_response');}
}
const percent=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export const encodeQuery=params=>params.map(([key,value])=>`${key}=${percent(String(value))}`).join('&');
export async function snaptradeSignature(key,path,query,body,canonical) {
 const content=body&&Object.keys(body).length?body:null;
 const payload=canonical({content,path,query});
 const cryptoKey=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,encoder.encode(payload)));
 return btoa(String.fromCharCode(...bytes));
}
export class SnapTrade {
 constructor({clientId,consumerKey,canonical,http=fetch,clock=()=>Date.now(),record=async()=>{}}){ensure(clientId&&consumerKey,503,'SnapTrade is not configured');Object.assign(this,{clientId,consumerKey,canonical,http,clock,record});this.personal=clientId.startsWith('PERS-');}
 user(dataset){if(this.personal)return null;const row=[...dataset.private.snaptrade_users].sort((a,b)=>a.id-b.id)[0];ensure(row,400,'SnapTrade user not registered yet');return [row.snaptrade_user_id,row.user_secret];}
 async send(method,path,{user=null,params=[],body=null,nonIdempotent=false}={}) {
  ensure(/^\/(accounts(?:\/[A-Za-z0-9_-]+(?:\/(?:activities|positions))?)?|snapTrade\/(?:registerUser|login))$/.test(path),400,'Invalid provider route');
  const userParams=user?[['userId',user[0]],['userSecret',user[1]]]:[];
  const query=encodeQuery([['clientId',this.clientId],...userParams,...params,['timestamp',Math.floor(this.clock()/1000)]]),fullPath='/api/v1'+path;
  const signature=await snaptradeSignature(this.consumerKey,fullPath,query,body,this.canonical);
  let response;
  try {response=await this.http(`https://api.snaptrade.com${fullPath}?${query}`,{method,headers:{Signature:signature,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(12000)});}
  catch{await this.record({provider:'snaptrade',endpoint:path,success:false,status:null,error:'transport_error'});throw new ProviderError('transport_error',{ambiguous:nonIdempotent});}
  await this.record({provider:'snaptrade',endpoint:path,success:response.ok,status:response.status,error:response.ok?null:'http_error'});
  if(!response.ok){await response.body?.cancel();const seconds=Number(response.headers.get('retry-after'));throw new ProviderError(response.status===429?'rate_limited':'http_error',{retryAt:response.status===429?this.clock()+(Number.isFinite(seconds)&&seconds>0?Math.min(seconds,86400):60)*1000:null,ambiguous:nonIdempotent&&response.status>=500});}
  try{return await boundedJson(response);}catch(error){if(nonIdempotent&&error instanceof ProviderError)error.ambiguous=true;throw error;}
 }
 accounts(user){return this.send('GET','/accounts',{user});}
 positions(user,id){return this.send('GET',`/accounts/${id}/positions`,{user});}
 activities(user,id,{offset=0,limit=1000,startDate=null}={}){const params=[['offset',offset],['limit',limit]];if(startDate)params.push(['startDate',startDate]);return this.send('GET',`/accounts/${id}/activities`,{user,params});}
 register(userId){ensure(!this.personal,400,'Personal SnapTrade keys do not register users');return this.send('POST','/snapTrade/registerUser',{body:{userId},nonIdempotent:true});}
 connect(user,broker){return this.send('POST','/snapTrade/login',{user,body:{connectionType:'read',...(broker?{broker}:{})}});}
}
// Sliding minute/day admission is persisted before calling a provider. Losing
// the reservation response can waste a slot, but never permits an extra call.
export class ProviderLimiter {
 constructor(documents,{clock=()=>Date.now()}={}){this.documents=documents;this.clock=clock;}
 async reserve(provider,{minute=8,day=800}={}) {
  ensure(/^[a-z_]{1,32}$/.test(provider)&&minute>0&&minute<=1000&&day>=minute);
  const id=`rate_${provider}`;
  for(let attempt=0;attempt<8;attempt++) {
   const row=await this.documents().get(id),now=this.clock(),date=new Date(now).toISOString().slice(0,10);
   const previous=row&&!row._deleted?row.body:{id,day:date,count:0,times:[],cooldown:0};
   const times=previous.times.filter(time=>time>now-60000),count=previous.day===date?previous.count:0;
   if(previous.cooldown>now)return {allowed:false,retryAt:previous.cooldown};
   if(count>=day)return {allowed:false,retryAt:Date.parse(date+'T00:00:00Z')+86400000};
   if(times.length>=minute)return {allowed:false,retryAt:times[0]+60000};
   const result=await this.documents().mutate(id,{mutationId:`rate_${crypto.randomUUID()}`,operation:row?'update':'create',expectedRevision:row?.revision??null,schemaVersion:1,body:{id,day:date,count:count+1,times:[...times,now],cooldown:previous.cooldown}});
   if(result.status==='conflict')continue;ensure(['applied','replayed'].includes(result.status));return {allowed:true};
  }
  throw new ProviderError('rate_admission_busy',{retryAt:this.clock()+1000});
 }
 async cooldown(provider,until){
  ensure(/^[a-z_]{1,32}$/.test(provider)&&Number.isSafeInteger(until));const id=`rate_${provider}`;
  for(let attempt=0;attempt<8;attempt++) {
   const row=await this.documents().get(id);ensure(row&&!row._deleted);
   const result=await this.documents().mutate(id,{mutationId:`cooldown_${crypto.randomUUID()}`,operation:'update',expectedRevision:row.revision,schemaVersion:1,body:{...row.body,cooldown:Math.max(row.body.cooldown,until)}});
   if(result.status!=='conflict'){ensure(['applied','replayed'].includes(result.status));return;}
  }throw new ProviderError('rate_admission_busy',{retryAt:this.clock()+1000});
 }
}
