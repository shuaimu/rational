import {ensure,sha256} from './errors.js';
export class ProviderLog {
 constructor(documents,{clock=()=>Date.now()}={}){this.documents=documents;this.clock=clock;}
 async record(value){
  let id;
  for(let attempt=0;attempt<8;attempt++){
   const old=await this.documents('robinlab_counters').get('provider_requests'),next=(old?.body.value??1000000000000)+1;ensure(Number.isSafeInteger(next));
   const result=await this.documents('robinlab_counters').mutate('provider_requests',{mutationId:`logid_${crypto.randomUUID()}`,operation:old?'update':'create',expectedRevision:old?.revision??null,schemaVersion:1,body:{id:'provider_requests',value:next}});
   if(result.status==='conflict')continue;ensure(['applied','replayed'].includes(result.status));id=next;break;
  }
  ensure(id,503,'Provider usage counter is busy');
  const documentId='r_'+await sha256(new TextEncoder().encode(JSON.stringify([id])));
  const row={id,...value,requested_at:new Date(this.clock()).toISOString().slice(0,19).replace('T',' ')};
  const result=await this.documents('provider_requests').mutate(documentId,{mutationId:`provider_log_${documentId}`,operation:'create',expectedRevision:null,schemaVersion:1,body:{id:documentId,row}});
  ensure(['applied','replayed'].includes(result.status));
 }
}
