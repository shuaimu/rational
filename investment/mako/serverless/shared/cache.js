import {ensure,batches,sha256} from './errors.js';
export class PriceCache {
 constructor(documents,{deadline=performance.now()+22000}={}){this.documents=documents;this.deadline=deadline;}
 async get(collection,key){return this.documents(collection).get('r_'+await sha256(new TextEncoder().encode(JSON.stringify(key))));}
 async markSplit(symbol,now){
  const id='r_'+await sha256(new TextEncoder().encode(JSON.stringify([symbol]))),body={id,row:{symbol,fetched_at:now}};
  for(let attempt=0;attempt<4;attempt++){
   const old=await this.documents('split_fetch').get(id);if(old?.body.row.fetched_at>=now)return;
   const mutation={mutationId:`split_${crypto.randomUUID()}`,operation:old?'update':'create',expectedRevision:old?.revision??null,schemaVersion:1,body};
   let result=await this.documents('split_fetch').mutate(id,mutation);
   if(result.status==='conflict'&&!old&&result.currentRevision&&!await this.documents('split_fetch').get(id))result=await this.documents('split_fetch').mutate(id,{...mutation,mutationId:`split_${crypto.randomUUID()}`,operation:'update',expectedRevision:result.currentRevision});
   if(result.status!=='conflict'){ensure(['applied','replayed'].includes(result.status));return;}
  }ensure(false,503,'Split cache is busy');
 }
 async page(collection,query){ensure(performance.now()<this.deadline,503,'Price query needs another invocation');return this.documents(collection).query(query);}
 async latestDocuments(){
  const result=[],seen=new Set();let cursor=null;
  do {
   const page=await this.page('latest_prices',{predicates:[{field:'id',operator:'gte',value:'r_'}],sort:[{field:'id',direction:'asc'}],cursor,limit:500});
   ensure(Array.isArray(page.documents)&&page.documents.length<=500&&result.length+page.documents.length<=10000);
   for(const row of page.documents){ensure(!row._deleted&&row.schemaVersion===1&&row.body?.row);result.push(row);}
   cursor=page.nextCursor;ensure(cursor===null||typeof cursor==='string'&&cursor.length>0&&!seen.has(cursor));if(cursor)seen.add(cursor);
  }while(cursor);
  return result;
 }
 async status(){const row=await this.documents('cache_status').get('cache');return row&&!row._deleted?row:null;}
 async latest(){const status=await this.status();return status?status.body.latest:(await this.latestDocuments()).map(doc=>doc.body.row).sort((a,b)=>a.symbol.localeCompare(b.symbol));}
 async pricesAt(dataset,today){
  const date=new Date(`${today}T00:00:00Z`);date.setUTCDate(date.getUTCDate()-365);const target=date.toISOString().slice(0,10);
  const symbols=[...new Set(dataset.public.tickers.map(row=>row.symbol))];ensure(symbols.length<=1000);
  const rows=await batches(symbols,8,async symbol=>{
   const page=await this.page('historical_prices',{predicates:[{field:'row.symbol',operator:'eq',value:symbol},{field:'row.price_date',operator:'gte',value:'0001-01-01'},{field:'row.price_date',operator:'lte',value:target}],sort:[{field:'row.price_date',direction:'desc'},{field:'id',direction:'desc'}],limit:1,cursor:null});
   ensure(Array.isArray(page.documents)&&page.documents.length<=1);return page.documents.map(row=>{ensure(!row._deleted&&row.schemaVersion===1&&row.body.row.symbol===symbol&&row.body.row.price_date<=target);return row.body.row;});
  });return rows.flat();
 }
}

export function cacheRangeQuery(symbol,start,end,cursor=null,limit=1000){
 return {predicates:[{field:'row.symbol',operator:'eq',value:symbol},{field:'row.price_date',operator:'gte',value:start},{field:'row.price_date',operator:'lte',value:end}],sort:[{field:'row.price_date',direction:'asc'},{field:'id',direction:'asc'}],cursor,limit};
}
PriceCache.prototype.range=async function(symbol,start,end){
 const rows=[];let cursor=null;const seen=new Set();
 do{const page=await this.page('historical_prices',cacheRangeQuery(symbol,start,end,cursor));
  for(const row of page.documents){ensure(!row._deleted&&row.schemaVersion===1&&row.body.row.symbol===symbol);rows.push(row.body.row);}
  cursor=page.nextCursor;ensure(rows.length<=10000&&(!cursor||!seen.has(cursor)));if(cursor)seen.add(cursor);
 }while(cursor);return rows;
};
