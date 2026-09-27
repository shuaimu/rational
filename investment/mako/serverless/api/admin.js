import {ensure} from '../shared/errors.js';
export async function adminRoute({request,path,query,cache,domain,jobs,reply,body,clock,providers}){
 if(request.method==='POST'&&['/admin/api-usage/cache/clear','/admin/api-usage/cache/prefetch'].includes(path)){
  const id=request.headers.get('idempotency-key');ensure(id,400,'Idempotency-Key is required');
  const raw=await body(),clear=path.endsWith('/clear'),kind=clear?'cache-clear':'prefetch';
  const today=clock().toISOString().slice(0,10),days=raw.days??(clear?30:30);ensure(Number.isSafeInteger(days),400,'Invalid days');
  let normalized,input;
  if(clear){
   const scope=String(raw.scope??'').trim().toLowerCase(),symbol=String(raw.symbol??'').trim().toUpperCase();
   ensure(['all','today','older_than_days','symbol'].includes(scope)&&(scope!=='symbol'||symbol),400,'Invalid cache scope or symbol');
   const cutoffDate=new Date(Date.parse(today)-Math.max(1,days)*86400000);ensure(Number.isFinite(cutoffDate.getTime()),400,'Invalid days');
   normalized={scope,symbol,days};input={...normalized,today,cutoff:cutoffDate.toISOString().slice(0,10)};
  }else{
   ensure(Array.isArray(raw.symbols)&&raw.symbols.every(s=>typeof s==='string'),400,'Invalid symbols');
   const symbols=[...new Set(raw.symbols.map(s=>s.trim().toUpperCase()).filter(Boolean))];ensure(symbols.length>0&&symbols.length<=1000,400,'At least one symbol is required (maximum 1000)');
   normalized={symbols,days};input={symbols,mode:'series',start:new Date(Date.parse(today)-(Math.max(1,Math.min(3650,days))-1)*86400000).toISOString().slice(0,10),end:today};
  }
  const existing=await jobs.find(id);
  if(existing){ensure(existing.body.kind===kind&&domain({action:'canonical',value:existing.body.input.request}).payload===domain({action:'canonical',value:normalized}).payload,409,'Cache command already has different input');return reply(jobs.status(existing),202);}
  return reply(jobs.status(await jobs.admit(id,kind,{...input,request:normalized})),202);
 }
 if(request.method==='GET'&&['/admin/cache-coverage','/admin/cache-price-trend'].includes(path)){
  const status=await cache.status();if(status?.body.state==='updating')return reply({...jobs.status(await jobs.get(status.body.jobId)),resumePath:path+'?'+new URLSearchParams(query).toString()},202);
  const symbol=(query.symbol??'').trim().toUpperCase();ensure(symbol,400,'symbol is required');
  const {start,end}=domain({action:'cache_range',today:clock().toISOString().slice(0,10),days:query.days??365});
  const rows=await cache.range(symbol,start,end);
  return reply(domain({action:'cache_report',operation:path.endsWith('coverage')?'coverage':'trend',rows,symbol,start,end}));
 }
 if(request.method==='GET'&&path==='/admin/api-usage'){
  const bucket=Math.floor(clock().getTime()/300000),today=clock().toISOString().slice(0,10);
  const job=await jobs.admit(`cache_usage_${bucket}`,'summary',{today,providers});
  return reply(jobs.status(job),202);
 }
 return null;
}
