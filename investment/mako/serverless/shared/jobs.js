import {ensure,ApiError,sha256} from './errors.js';
const encoder=new TextEncoder();
const terminal=new Set(['completed','failed','cancelled','needs-attention']);
const kinds=new Set(['excel','snaptrade','register','prefetch','cache-clear','summary','portfolio-command']);
export const LEASE_MILLISECONDS=60000;
export const ARTIFACT_RETENTION_MILLISECONDS=7*86400000;
// Stable admission is separate from a worker claim. The row's revision and
// monotonically increasing generation fence every checkpoint and completion.
export class JobStore {
 constructor(documents,{clock=()=>Date.now(),canonical=JSON.stringify}={}) {this.documents=documents;this.clock=clock;this.canonical=canonical;}
 async id(commandId) {ensure(/^[A-Za-z0-9_-]{16,128}$/.test(commandId),400,'Invalid job command');return `j_${await sha256(encoder.encode(commandId))}`;}
 async find(commandId){const row=await this.documents().get(await this.id(commandId));return row&&!row._deleted?row:null;}
 async get(id) {ensure(/^j_[a-f0-9]{64}$/.test(id),400,'Invalid job id');const row=await this.documents().get(id);ensure(row&&!row._deleted,404,'Job not found');return row;}
 async write(id,row,body) {
  const result=await this.documents().mutate(id,{mutationId:`job_${crypto.randomUUID()}`,operation:row?'update':'create',expectedRevision:row?.revision??null,schemaVersion:1,body});
  ensure(['conflict','applied','replayed'].includes(result.status));return result.status==='conflict'?null:result.document;
 }
 async admit(commandId,kind,input) {
  ensure(kinds.has(kind),400,'Unsupported job kind');
  const canonical=this.canonical({kind,input});ensure(encoder.encode(canonical).length<=24000,413,'Job input exceeds bounds');
  const id=await this.id(commandId),inputHash=await sha256(encoder.encode(canonical));
  for(let attempt=0;attempt<4;attempt++) {
   const existing=await this.documents().get(id);
   if(existing&&!existing._deleted) {ensure(existing.body.commandId===commandId&&existing.body.inputHash===inputHash,409,'Job command already has different input');return existing;}
   const now=this.clock();
   const created=await this.write(id,null,{id,commandId,kind,input,inputHash,state:'queued',generation:0,attempt:0,createdAt:now,updatedAt:now,dueAt:now,leaseUntil:0,worker:null,checkpoint:null,cancelRequested:false,result:null,error:null,artifactsExpireAt:null});
   if(created)return created;
  }
  throw new ApiError(409,'Concurrent job admission; retry the same command');
 }
 async claim(id,worker) {
  ensure(typeof worker==='string'&&worker.length>=16&&worker.length<=128,400,'Invalid worker');
  const row=await this.get(id),body=row.body,now=this.clock();
  if(terminal.has(body.state)||body.dueAt>now||body.leaseUntil>now)return null;
  ensure(['queued','retry','running','committing'].includes(body.state));
  if(body.cancelRequested&&body.state!=='committing')return this.write(id,row,{...body,state:'cancelled',updatedAt:now,dueAt:Number.MAX_SAFE_INTEGER,leaseUntil:0,worker:null,artifactsExpireAt:now+ARTIFACT_RETENTION_MILLISECONDS});
  return this.write(id,row,{...body,state:body.state==='committing'?'committing':'running',generation:body.generation+1,attempt:body.attempt+1,worker,dueAt:now+LEASE_MILLISECONDS,leaseUntil:now+LEASE_MILLISECONDS,updatedAt:now});
 }
 async checkpoint(claim,checkpoint,{state='running',result=null,error=null,retryAt=null}={}) {
  const now=this.clock(),body=claim.body;
  ensure(['running','committing','retry','completed','failed','needs-attention','cancelled'].includes(state),400,'Invalid job transition');
  ensure(['running','committing'].includes(body.state)&&body.worker&&body.leaseUntil>now,409,'Job claim expired');
  ensure(!(body.state==='committing'&&state==='cancelled'),409,'A publishing job cannot be cancelled');
  ensure(encoder.encode(this.canonical({checkpoint,result})).length<=24000,413,'Job checkpoint exceeds bounds');
  if(state==='retry'||retryAt!==null)ensure(Number.isSafeInteger(retryAt)&&retryAt>now,400,'Retry time must be in the future');
  const released=terminal.has(state)||state==='retry'||state==='committing'&&retryAt!==null;
  const next=await this.write(body.id,claim,{...body,checkpoint,state,result,error,updatedAt:now,dueAt:terminal.has(state)?Number.MAX_SAFE_INTEGER:retryAt!==null?retryAt:now+LEASE_MILLISECONDS,leaseUntil:released?0:now+LEASE_MILLISECONDS,worker:released?null:body.worker,artifactsExpireAt:terminal.has(state)&&state!=='needs-attention'?now+ARTIFACT_RETENTION_MILLISECONDS:null});
  ensure(next,409,'Job claim was superseded');return next;
 }
 async cancel(id) {
  for(let attempt=0;attempt<4;attempt++) {
   const row=await this.get(id),body=row.body,now=this.clock();
   if(terminal.has(body.state))return row;
   ensure(body.state!=='committing',409,'Job is publishing; wait for its result');
   const running=body.state==='running'&&body.leaseUntil>now;
   const next=await this.write(id,row,{...body,cancelRequested:true,state:running?'running':'cancelled',dueAt:running?body.leaseUntil:Number.MAX_SAFE_INTEGER,updatedAt:now,artifactsExpireAt:running?null:now+ARTIFACT_RETENTION_MILLISECONDS});
   if(next)return next;
  }
  throw new ApiError(409,'Job changed; retry cancellation');
 }
 // Cancellation changes the revision, fencing a worker already executing. It
 // must reread/claim before doing more work; publication remains command-CAS safe.
 status(row) {const b=row.body;return {id:b.id,kind:b.kind,state:b.state,attempt:b.attempt,createdAt:b.createdAt,updatedAt:b.updatedAt,retryAt:['retry','committing'].includes(b.state)?b.dueAt:null,cancelRequested:b.cancelRequested,result:b.state==='completed'?b.result:null,error:b.error};}
 async pendingPage(cursor=null) {
  ensure(cursor===null||typeof cursor==='string'&&cursor.length<=8192,400,'Invalid job cursor');
  const page=await this.documents().query({predicates:[{field:'dueAt',operator:'gte',value:0}],sort:[{field:'dueAt',direction:'asc'},{field:'id',direction:'asc'}],limit:32,cursor});
  return {jobs:page.documents.filter(row=>!row._deleted&&!['completed','failed','cancelled'].includes(row.body.state)).map(row=>this.status(row)),cursor:page.nextCursor??null};
 }
 async due(limit=8) {
  ensure(Number.isInteger(limit)&&limit>0&&limit<=32);
  // Collection index on dueAt bounds dispatch, including expired running claims.
  const page=await this.documents().query({predicates:[{field:'dueAt',operator:'lte',value:this.clock()}],sort:[{field:'dueAt',direction:'asc'}],limit,cursor:null});
  return page.documents.filter(row=>!row._deleted&&!terminal.has(row.body.state)&&row.body.leaseUntil<=this.clock());
 }
}
