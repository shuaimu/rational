import {ensure,sha256,batches} from '../shared/errors.js';
const encoder=new TextEncoder();
export class ArtifactCleanup {
 constructor({jobs,uploads,artifacts,clock=()=>Date.now()}){Object.assign(this,{jobs,uploads,artifacts,clock});}
 async remove(documents,row,schemaVersion=1){
  const id=row.body.id,mutationId=`cleanup_v2_${await sha256(encoder.encode(`${id}:${row.revision}`))}`;
  const result=await documents().mutate(id,{mutationId,operation:'delete',expectedRevision:row.revision,schemaVersion,body:row.body});
  if(result.status==='conflict'){const current=await documents().get(id);ensure(!current||current._deleted,409,'Artifact changed during cleanup');}
  else ensure(['applied','replayed'].includes(result.status));
 }
 async upload(root){
  if(!root||root.body.state!=='expired')return false;
  // Only bounded immutable chunks are deleted. The expired root remains as a
  // command tombstone, so a delayed upload or admission cannot resurrect it.
  const remaining=[];
  for(let offset=0;offset<root.body.chunks;offset+=16){
   const rows=await batches(Array.from({length:Math.min(16,root.body.chunks-offset)},(_,i)=>offset+i),8,async index=>this.uploads.documents().get(await this.uploads.chunkId(root.body.id,index)));
   remaining.push(...rows.filter(row=>row&&!row._deleted));if(remaining.length>=16)break;
  }
  await batches(remaining.slice(0,16),4,row=>this.remove(this.uploads.documents,row,2));
  return remaining.length===0;
 }
 async step(){
  const page=await this.jobs.documents().query({predicates:[{field:'artifactsExpireAt',operator:'gte',value:0},{field:'artifactsExpireAt',operator:'lte',value:this.clock()}],sort:[{field:'artifactsExpireAt',direction:'asc'},{field:'id',direction:'asc'}],limit:1,cursor:null});
  if(page.documents.length){
   const job=page.documents[0],body=job.body;
   ensure(['completed','failed','cancelled'].includes(body.state));
   if(body.kind==='excel'){
    const expired=await this.uploads.expire(body.input.uploadId,body.id);
    if(expired&&!await this.upload(expired))return {cleaned:16};
   }
   const protectedIds=new Set(),reference=body.result?.responseArtifact;
   if(reference){const manifest=await this.artifacts.documents().get(reference.id);ensure(manifest&&!manifest._deleted&&manifest.body.jobId===body.id);protectedIds.add(reference.id);for(const id of manifest.body.chunks)protectedIds.add(id);}
   const cursor=body.checkpoint?.cleanupCursor??null;
   const inputs=await this.artifacts.documents().query({predicates:[{field:'jobId',operator:'eq',value:body.id}],sort:[{field:'id',direction:'asc'}],limit:32,cursor});
   const deletions=inputs.documents.filter(row=>!row._deleted&&!protectedIds.has(row.body.id));
   await batches(deletions,4,row=>this.remove(this.artifacts.documents,row));
   await this.jobs.write(body.id,job,{...body,checkpoint:inputs.nextCursor?{cleanupCursor:inputs.nextCursor}:null,artifactsExpireAt:inputs.nextCursor?body.artifactsExpireAt:null});
   return {cleaned:deletions.length};
  }
  const uploads=await this.uploads.documents().query({predicates:[{field:'expiresAt',operator:'gte',value:0},{field:'expiresAt',operator:'lte',value:this.clock()}],sort:[{field:'expiresAt',direction:'asc'},{field:'id',direction:'asc'}],limit:1,cursor:null});
  if(uploads.documents.length){
   const root=await this.uploads.expire(uploads.documents[0].body.id);
   if(root&&await this.upload(root)){
    await this.uploads.documents().mutate(root.body.id,{mutationId:`expired_${crypto.randomUUID()}`,operation:'update',expectedRevision:root.revision,schemaVersion:2,body:{...root.body,expiresAt:null}});
   }
  }
  return {cleaned:0};
 }
}
