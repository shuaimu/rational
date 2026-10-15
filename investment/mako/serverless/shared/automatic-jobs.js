import {ARTIFACT_RETENTION_MILLISECONDS} from './jobs.js';
import {batches} from './errors.js';
function period(value){
 const match=/^(?:hourly_)?(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(value)??/^daily_(\d{4})(\d{2})(\d{2})$/.exec(value);
 if(!match)return null;
 const date=`${match[1]}-${match[2]}-${match[3]}T${match[4]??'00'}:00:00.000Z`,time=Date.parse(date);
 return Number.isFinite(time)&&new Date(time).toISOString()===date?`${match[1]}${match[2]}${match[3]}${match[4]??'99'}`:null;
}

// Recognize only application-generated identities AND their exact input shape.
// A manual request with different import options must never be superseded.
export function automaticJob(job) {
 const input=job.input,keys=Object.keys(input??{}).sort().join(',');
 const broker=/^snaptrade_(hourly_\d{10}|daily_\d{8})$/.exec(job.commandId);
 const quotes=/^market_quotes_(\d{10}|daily_\d{8})$/.exec(job.commandId);
 if(job.kind==='snaptrade'&&broker&&period(broker[1])&&keys==='apply,fresh,reconstruct_rolls,replace,roll_detect,start_date'&&input.apply===true&&input.reconstruct_rolls===true&&input.fresh===false&&input.replace===false&&input.roll_detect===false&&input.start_date===null)
  return {group:'broker',order:period(broker[1])};
 if(job.kind==='prefetch'&&quotes&&period(quotes[1])&&keys==='mode'&&input.mode==='quotes_auto')
  return {group:'quotes',order:period(quotes[1])};
 const report=/^cache_usage_(\d{1,14})$/.exec(job.commandId);
 if(job.kind==='summary'&&report&&keys==='providers,today'&&/^\d{4}-\d{2}-\d{2}$/.test(input.today)&&input.providers&&Object.keys(input.providers).sort().join(',')==='fmp_enabled,twelve_data_enabled,yahoo_finance_enabled'&&Object.values(input.providers).every(value=>typeof value==='boolean'))
  return {group:'report',order:report[1].padStart(14,'0')};
 return null;
}
export function unstarted(job) {
 return job.state==='queued'&&job.attempt===0&&job.generation===0&&job.checkpoint===null&&job.result===null&&job.worker===null&&job.leaseUntil===0&&!job.cancelRequested;
}

// No portfolio/provider reads or financial writes. Terminal rows remain replayable.
export async function coalesceAutomatic(jobs,{dryRun=false}={}) {
 const rows=[];let cursor=null;
 for(let i=0;i<5;i++){
  const page=await jobs.documents().query({predicates:[{field:'dueAt',operator:'gte',value:0},{field:'dueAt',operator:'lte',value:Number.MAX_SAFE_INTEGER-1}],sort:[{field:'dueAt',direction:'asc'},{field:'id',direction:'asc'}],limit:200,cursor});
  rows.push(...page.documents);
  if(page.nextCursor&&page.nextCursor===cursor)return {scanned:rows.length,incomplete:true,eligible:0,cancelled:0,conflicts:0};
  cursor=page.nextCursor??null;if(!cursor)break;
 }
 if(cursor)return {scanned:rows.length,incomplete:true,eligible:0,cancelled:0,conflicts:0};
 const groups=new Map();
 for(const row of rows){
  if(row._deleted||!unstarted(row.body))continue;
  const automatic=automaticJob(row.body);if(!automatic)continue;
  const group=groups.get(automatic.group)??[];group.push({row,order:automatic.order});groups.set(automatic.group,group);
 }
 const candidates=[],retained=[];
 for(const group of groups.values()){
  group.sort((a,b)=>b.order.localeCompare(a.order)||b.row.body.createdAt-a.row.body.createdAt||a.row.body.id.localeCompare(b.row.body.id));
  retained.push(group[0].row.body.id);candidates.push(...group.slice(1).map(item=>item.row));
 }
 const selected=candidates.slice(0,32);
 const results=dryRun?[]:await batches(selected,4,async row=>{
  const now=jobs.clock();
  return jobs.write(row.body.id,row,{...row.body,state:'cancelled',cancelRequested:true,error:'superseded_automatic_request',updatedAt:now,dueAt:Number.MAX_SAFE_INTEGER,artifactsExpireAt:now+ARTIFACT_RETENTION_MILLISECONDS});
 });
 return {scanned:rows.length,incomplete:false,eligible:candidates.length,selected:selected.length,retained,cancelled:results.filter(Boolean).length,conflicts:results.filter(result=>!result).length,dryRun};
}
