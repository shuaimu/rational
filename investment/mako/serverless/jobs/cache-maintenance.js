import {ensure,sha256,batches,ApiError} from '../shared/errors.js';
import {historicalDigest,latestFromHistory} from '../shared/cache-generation.js';
const encoder=new TextEncoder(),stamp=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' ');
const key=async parts=>'r_'+await sha256(encoder.encode(JSON.stringify(parts)));
export class CacheMaintenance {
 constructor({cache,artifacts,domain,provider,repository,clock=()=>Date.now()}){Object.assign(this,{cache,artifacts,domain,provider,repository,clock});}
 async save(job,point){return {done:false,checkpoint:{capture:await this.artifacts.save(job.id,point)}};}
 async scan(job,point){
  for(let i=0;i<4;i++){
   const page=await this.cache.page('historical_prices',{predicates:[{field:'id',operator:'gte',value:'r_'}],sort:[{field:'id',direction:'asc'}],cursor:point.cursor,limit:1000});
   point.count+=page.documents.length;ensure(point.count<=500000,413,'Cache exceeds configured bounds');
   if(page.documents.length)point.parts.push(await this.artifacts.save(job.id,page.documents));
   ensure(!page.nextCursor||page.nextCursor!==point.cursor);point.cursor=page.nextCursor;
   if(!point.cursor){point.phase=job.kind==='prefetch'?'capture':'plan';break;}
  }
  return this.save(job,point);
 }
 async records(job,point){return (await batches(point.parts,4,part=>this.artifacts.load(job.id,part))).flat();}
 async capture(job,point){
  if(point.symbol>=job.input.symbols.length){point.phase='plan';return this.save(job,point);}
  const records=await this.records(job,point);
  const symbols=job.input.symbols.slice(point.symbol,point.symbol+2);
  const captures=await batches(symbols,2,async symbol=>{
  const rows=records.map(doc=>doc.body.row).filter(row=>row.symbol===symbol&&row.price_date>=job.input.start&&row.price_date<=job.input.end).sort((a,b)=>a.price_date.localeCompare(b.price_date));
  const rules=this.domain({action:'market_rules',symbol}),days=milliseconds=>new Date(milliseconds).toISOString().slice(0,10);
  const covered=rows.length&&rows[0].price_date<=days(Date.parse(job.input.start)+7*86400000)&&rows.at(-1).price_date>=days(Date.parse(job.input.end)-3*86400000);
  const splitFresh=rules.split&&rows.at(-1)?.price_date>=days(Date.parse(job.input.end)-86400000);
  if((job.input.mode==='quotes'||!rules.split)&&!splitFresh&&(job.input.mode==='quotes'||!covered)){
   const capture=await this.provider.capture(symbol,job.input);
   const values=Object.entries(capture.bars).map(([price_date,price])=>({symbol,price_date,price,source:capture.source,fetched_at:stamp(this.clock()),is_market_close:price_date<new Date(this.clock()).toISOString().slice(0,10)}));
   if(values.length)return {symbol,bars:values.length,reference:await this.artifacts.save(job.id,values)};
  }
  return {symbol,bars:rows.length};});
  point.bars??=[];point.bars.push(...captures.map(({symbol,bars})=>({symbol,bars})));
  point.updates.push(...captures.filter(c=>c.reference).map(c=>c.reference));point.symbol+=symbols.length;
  return this.save(job,point);
 }
 async plan(job,point){
  const records=await this.records(job,point),previousRows=records.map(doc=>doc.body.row),byId=new Map(records.map(doc=>[doc.body.id,doc]));
  const changes=[];let deleted=0;
  if(job.kind==='cache-clear'){
   for(const doc of records){const row=doc.body.row,input=job.input;
    if(input.scope==='all'||input.scope==='today'&&row.price_date===input.today||input.scope==='older_than_days'&&row.price_date<input.cutoff||input.scope==='symbol'&&row.symbol===input.symbol){changes.push({collection:'historical_prices',id:doc.body.id,operation:'delete',expectedRevision:doc.revision,body:doc.body});byId.delete(doc.body.id);deleted++;}
   }
  }else{
   const updates=(await batches(point.updates,4,part=>this.artifacts.load(job.id,part))).flat();
   for(const row of updates){const id=await key([row.symbol,row.price_date]),old=byId.get(id),body={id,row};changes.push({collection:'historical_prices',id,operation:old?'update':'create',expectedRevision:old?.revision??null,body});byId.set(id,{body});}
  }
  const rows=[...byId.values()].map(doc=>doc.body.row),latest=latestFromHistory(rows),current=await this.cache.documents('cache_status').get('cache');
  ensure(!current||current.body.state==='ready',409,'Cache maintenance needs reconciliation');
  const generation=(current?.body.generation??0)+1;
  const baseline=current?.body??{id:'cache',generation:0,state:'ready',jobId:null,latest:latestFromHistory(previousRows),historicalDigest:await historicalDigest(previousRows),historicalCount:previousRows.length,updatedAt:this.clock()};
  const begin={collection:'cache_status',id:'cache',operation:current?'update':'create',expectedRevision:current?.revision??null,body:{...baseline,state:'updating',jobId:job.id}};
  const mirror=await this.cache.latestDocuments(),latestById=new Map();
  for(const row of latest)latestById.set(await key([row.symbol]),row);
  for(const doc of mirror){const row=latestById.get(doc.body.id);latestById.delete(doc.body.id);if(row&&this.domain({action:'canonical',value:row}).payload===this.domain({action:'canonical',value:doc.body.row}).payload)continue;changes.push({collection:'latest_prices',id:doc.body.id,operation:row?'update':'delete',expectedRevision:doc.revision,body:row?{id:doc.body.id,row}:doc.body});}
  for(const [id,row]of latestById)changes.push({collection:'latest_prices',id,operation:'create',expectedRevision:null,body:{id,row}});
  const finish={id:'cache',generation,state:'ready',jobId:null,latest,historicalDigest:await historicalDigest(rows),historicalCount:rows.length,updatedAt:this.clock()};
  const symbol_bars=job.kind==='prefetch'?(point.bars??[]).sort((a,b)=>a.symbol.localeCompare(b.symbol)):[];
  const response=job.kind==='cache-clear'?{scope:job.input.scope,deleted_rows:deleted}:{requested_symbols:job.input.symbols.length,cached_symbols:symbol_bars.filter(s=>s.bars>0).length,bars_cached:symbol_bars.reduce((sum,s)=>sum+s.bars,0),start_date:job.input.start,end_date:job.input.end,symbol_bars};
  const plan=await this.artifacts.save(job.id,{begin,changes,finish,response});
  return {done:false,committing:true,checkpoint:{capture:await this.artifacts.save(job.id,{phase:'begin',plan,offset:0})}};
 }
 async mutate(job,tag,intent){
  // Every mutation has its exact expected revision and payload durably sealed
  // before execution. Expired claimants can only replay this same receipt.
  const mutationId=`cache_${await sha256(encoder.encode(`${job.id}:${tag}`))}`;
  const {collection,id,...mutation}=intent,documents=this.cache.documents(collection);
  let result=await documents.mutate(id,{...mutation,mutationId,schemaVersion:1});
  if(result.status==='conflict'&&mutation.operation==='create'){
   const row=await documents.get(id);
   if(!row||row._deleted){ensure(result.currentRevision);result=await documents.mutate(id,{...mutation,operation:'update',expectedRevision:result.currentRevision,mutationId:`restore_${mutationId}`,schemaVersion:1});}
   else if(this.domain({action:'canonical',value:row.body}).payload===this.domain({action:'canonical',value:mutation.body}).payload)return row;
  }
  if(result.status==='conflict')throw new ApiError(409,'Cache changed outside its maintenance job');
  ensure(['applied','replayed'].includes(result.status));return result.document;
 }
 async step(job,checkpoint){
  const point=checkpoint?await this.artifacts.load(job.id,checkpoint.capture):{phase:'scan',parts:[],count:0,cursor:null,updates:[],symbol:0};
  if(!point.input&&job.input.mode==='quotes_auto'){
   const loaded=await this.repository.snapshotStep(this.artifacts,job.id,point.portfolio);
   if(!loaded.done)return this.save(job,{...point,portfolio:loaded.reference});
   const {dataset}=loaded,today=new Date(this.clock()).toISOString().slice(0,10);
   delete point.portfolio;
   const positions=this.domain({action:'read',operation:'positions',dataset,input:{latest:[],account_id:null,include_closed:false,today}});
   const symbols=new Set();for(const position of positions){symbols.add(position.ticker_symbol);const underlying=this.domain({action:'market_rules',symbol:position.ticker_symbol}).underlying;if(underlying)symbols.add(underlying[0]);}
   point.input={symbols:[...symbols].sort(),mode:'quotes',start:new Date(Date.parse(today)-420*86400000).toISOString().slice(0,10),end:today};
   return this.save(job,point);
  }
  if(point.input)job={...job,input:point.input};
  if(point.phase==='scan')return this.scan(job,point);
  if(point.phase==='capture')return this.capture(job,point);
  if(point.phase==='plan')return this.plan(job,point);
  const plan=await this.artifacts.load(job.id,point.plan);
  if(point.phase==='begin'){const row=await this.mutate(job,'begin',plan.begin);return this.save(job,{...point,phase:'apply',cacheRevision:row.revision});}
  if(point.phase==='apply'){
   const batch=plan.changes.slice(point.offset,point.offset+32);
   await batches(batch.map((intent,i)=>({intent,index:point.offset+i})),8,({intent,index})=>this.mutate(job,`row_${index}`,intent));
   const offset=point.offset+batch.length;return this.save(job,{...point,offset,phase:offset===plan.changes.length?'finish':'apply'});
  }
  ensure(point.phase==='finish');await this.mutate(job,'finish',{collection:'cache_status',id:'cache',operation:'update',expectedRevision:point.cacheRevision,body:plan.finish});
  return {done:true,result:{version:0,cacheGeneration:plan.finish.generation,response:plan.response}};
 }
}
