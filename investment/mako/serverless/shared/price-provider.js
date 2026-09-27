import {ensure} from './errors.js';
import {ProviderError,boundedJson} from './providers.js';
export class PriceProvider {
 constructor({twelveKey,limiter,record,domain,http=fetch,clock=()=>Date.now()}){Object.assign(this,{twelveKey,limiter,record,domain,http,clock});}
 async request(provider,endpoint,url){
  const admission=await this.limiter.reserve(provider,provider==='twelvedata'?{minute:8,day:800}:{minute:30,day:10000});
  if(!admission.allowed)throw new ProviderError('rate_limited',{retryAt:admission.retryAt});
  let response,payload,error=null;
  try{response=await this.http(url,{headers:{'User-Agent':'robinlab/0.1',Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(10000)});payload=response.ok?await boundedJson(response):null;}
  catch{error='transport_error';}
  const limited=response?.status===429||payload?.code===429;
  if(limited){const seconds=Number(response?.headers.get('retry-after')),retryAt=this.clock()+(seconds>0&&Number.isFinite(seconds)?Math.min(seconds,86400):60)*1000;await this.limiter.cooldown(provider,retryAt);error='rate_limited';await this.record({provider,endpoint,success:false,status_code:response?.status??null,error});throw new ProviderError('rate_limited',{retryAt});}
  if(!response?.ok||payload?.status==='error')error??='provider_error';
  await this.record({provider,endpoint,success:!error,status_code:response?.status??null,error});
  if(error){if(response&&response.status<500&&response.status!==429)return null;throw new ProviderError(error);}
  return payload;
 }
 async capture(symbol,{mode,start,end}){
  const rules=this.domain({action:'market_rules',symbol});
  if(rules.split){
   const [base,scale]=rules.split,url=new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(base)}`);
   url.search=new URLSearchParams({period1:String(Date.parse(start+'T00:00:00Z')/1000),period2:String(Date.parse(end+'T23:59:59Z')/1000),interval:'1d'}).toString();
   const payload=await this.request('yahoo_chart','chart',url);
   return {source:'derived',bars:this.domain({action:'market_payload',provider:'yahoo',payload,scale})};
  }
  if(!rules.fetchable)return {source:'twelvedata',bars:{}};
  ensure(this.twelveKey,503,'Twelve Data is not configured');
  const endpoint=mode==='quotes'?'price':'time_series',url=new URL(`https://api.twelvedata.com/${endpoint}`);
  url.search=new URLSearchParams({symbol,apikey:this.twelveKey,...(endpoint==='price'?{}:{interval:'1day',start_date:start,end_date:end,outputsize:'5000'})}).toString();
  const payload=await this.request('twelvedata',endpoint,url);
  const price=endpoint==='price'?this.domain({action:'market_payload',provider:'quote',payload}):null;
  return {source:'twelvedata',bars:endpoint==='price'?(price===null?{}:{[new Date(this.clock()).toISOString().slice(0,10)]:price}):this.domain({action:'market_payload',provider:'twelvedata',payload})};
 }
}
