import {ensure,batches} from '../shared/errors.js';
// Full summaries are assembled from bounded, durable pages. No page is silently
// omitted when a cold invocation reaches its deadline.
export class CacheReports {
 constructor({cache,artifacts,domain,clock=()=>Date.now()}){Object.assign(this,{cache,artifacts,domain,clock});}
 async step(job,checkpoint){
  let point=checkpoint?await this.artifacts.load(job.id,checkpoint.capture):{phase:'prices',cursor:null,parts:[],logParts:[],rows:0,asOf:new Date(this.clock()).toISOString()};
  if(point.phase==='compute'){
   const rows=(await batches(point.parts,4,part=>this.artifacts.load(job.id,part))).flat(),logs=(await batches(point.logParts,4,part=>this.artifacts.load(job.id,part))).flat();
   const response={...this.domain({action:'cache_report',operation:'usage',rows,logs,today:job.input.today,providers:job.input.providers}),as_of:point.asOf};
   return {done:true,result:{version:0,responseArtifact:await this.artifacts.save(job.id,response)}};
  }
  for(let pageNumber=0;pageNumber<4;pageNumber++){
   const logs=point.phase==='logs';
   const query=logs?{predicates:[{field:'row.requested_at',operator:'gte',value:job.input.today+' 00:00:00'},{field:'row.requested_at',operator:'lte',value:job.input.today+' 23:59:59'}],sort:[{field:'row.requested_at',direction:'asc'},{field:'id',direction:'asc'}],cursor:point.cursor,limit:1000}:{predicates:[{field:'id',operator:'gte',value:'r_'}],sort:[{field:'id',direction:'asc'}],cursor:point.cursor,limit:1000};
   const page=await this.cache.page(logs?'provider_requests':'historical_prices',query);
   const rows=page.documents.map(row=>{ensure(!row._deleted&&row.schemaVersion===1&&row.body.row);return row.body.row;});
   point.rows+=rows.length;ensure(point.rows<=500000,413,'Cache report exceeds configured bounds');
   if(rows.length)(logs?point.logParts:point.parts).push(await this.artifacts.save(job.id,rows));
   ensure(!page.nextCursor||page.nextCursor!==point.cursor);point.cursor=page.nextCursor;
   if(!point.cursor){point.phase=logs?'compute':'logs';break;}
  }
  return {done:false,checkpoint:{capture:await this.artifacts.save(job.id,point)}};
 }
}
