import {ensure,sha256,batches} from './errors.js';
export const MAX_UPLOAD_BYTES=50*1024*1024;
export const UPLOAD_CHUNK_BYTES=256*1024;
const encoder=new TextEncoder();
const hash=/^[a-f0-9]{64}$/;
const same=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(key=>a[key]===b[key]);
// Documents are private and create-only. A seal can only refer to the complete
// immutable set; no changing chunk or interrupted upload is an import input.
export class UploadStore {
 constructor(documents,{clock=()=>Date.now(),schemaVersion=2}={}) {this.documents=documents;this.clock=clock;this.schemaVersion=schemaVersion;}
 async rootId(commandId) {
  ensure(/^[A-Za-z0-9_-]{16,128}$/.test(commandId),400,'Invalid upload command');
  return `u_${await sha256(encoder.encode(commandId))}`;
 }
 async admit(commandId,{bytes,digest},attempt=0) {
  ensure(attempt<4,503,'Upload admission is busy; retry the same command');
  ensure(Number.isSafeInteger(bytes)&&bytes>0&&bytes<=MAX_UPLOAD_BYTES&&hash.test(digest),400,'Invalid workbook size or digest');
  const id=await this.rootId(commandId);
  const identity={id,kind:'upload',commandId,bytes,digest,chunkBytes:UPLOAD_CHUNK_BYTES,chunks:Math.ceil(bytes/UPLOAD_CHUNK_BYTES)};
  const existing=await this.documents().get(id);
  if(existing&&!existing._deleted) {for(const key of Object.keys(identity)) ensure(existing.body[key]===identity[key],409,'Upload command already has different input');ensure(existing.body.state!=='expired',410,'Workbook upload expired; select the file again');return existing;}
  const body={...identity,createdAt:this.clock(),state:'uploading',...(this.schemaVersion>=2?{expiresAt:this.clock()+7*86400000}:{})};
  const result=await this.documents().mutate(id,{mutationId:`admit_${id}_${crypto.randomUUID()}`,operation:'create',expectedRevision:null,schemaVersion:this.schemaVersion,body});
  if(result.status==='conflict') return this.admit(commandId,{bytes,digest},attempt+1);
  ensure(['applied','replayed'].includes(result.status));return result.document;
 }
 async root(id) {const row=await this.documents().get(id);ensure(row&&!row._deleted&&row.body.kind==='upload',404,'Upload not found');return row;}
 async chunkId(id,index) {return `k_${await sha256(encoder.encode(`${id}:${index}`))}`;}
 async putChunk(id,index,bytes) {
  const root=await this.root(id),meta=root.body;ensure(meta.state!=='expired',410,'Workbook upload expired');
  ensure(Number.isInteger(index)&&index>=0&&index<meta.chunks,400,'Invalid chunk index');
  const expected=Math.min(meta.chunkBytes,meta.bytes-index*meta.chunkBytes);
  ensure(bytes instanceof Uint8Array&&bytes.length===expected,400,'Invalid chunk size');
  const chunkId=await this.chunkId(id,index);
  let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000) binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  const body={id:chunkId,kind:'chunk',uploadId:id,index,bytes:bytes.length,digest:await sha256(bytes),payload:btoa(binary)};
  const previous=await this.documents().get(chunkId);
  if(previous&&!previous._deleted) {ensure(same(previous.body,body),409,'Uploaded chunk cannot change');return;}
  ensure(meta.state==='uploading',409,'Upload is already sealed');
  const result=await this.documents().mutate(chunkId,{mutationId:`chunk_${chunkId}`,operation:'create',expectedRevision:null,schemaVersion:this.schemaVersion,body});
  if(result.status==='conflict') {const stored=await this.documents().get(chunkId);ensure(stored&&!stored._deleted&&same(stored.body,body),409,'Uploaded chunk cannot change');}
  else ensure(['applied','replayed'].includes(result.status));
 }
 async assemble(id) {
  const root=await this.root(id),meta=root.body;ensure(meta.state!=='expired',410,'Workbook upload expired');
  ensure(meta.bytes>0&&meta.bytes<=MAX_UPLOAD_BYTES&&meta.chunkBytes===UPLOAD_CHUNK_BYTES&&meta.chunks===Math.ceil(meta.bytes/meta.chunkBytes));
  const bytes=new Uint8Array(meta.bytes);
  for(let offset=0;offset<meta.chunks;offset+=8) {
   await batches(Array.from({length:Math.min(8,meta.chunks-offset)},(_,i)=>offset+i),8,async index=>{
    const row=await this.documents().get(await this.chunkId(id,index));
    ensure(row&&!row._deleted,409,'Workbook upload is incomplete');
    const chunk=row.body;
    ensure(chunk.kind==='chunk'&&chunk.uploadId===id&&chunk.index===index&&chunk.bytes===Math.min(meta.chunkBytes,meta.bytes-index*meta.chunkBytes),409,'Workbook chunk metadata differs');
    ensure(typeof chunk.payload==='string'&&chunk.payload.length<=4*Math.ceil(meta.chunkBytes/3),409,'Workbook chunk exceeds bounds');
    let decoded;try {const binary=atob(chunk.payload);decoded=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)decoded[i]=binary.charCodeAt(i);}catch{ensure(false,409,'Workbook chunk is invalid');}
    ensure(decoded.length===chunk.bytes&&await sha256(decoded)===chunk.digest,409,'Workbook chunk failed integrity check');
    bytes.set(decoded,index*meta.chunkBytes);
   });
  }
  ensure(await sha256(bytes)===meta.digest,409,'Workbook digest does not match');
  return {root,bytes};
 }
 async seal(id) {
  const {root,bytes}=await this.assemble(id);
  if(['sealed','bound'].includes(root.body.state)) return {root,bytes};
  const result=await this.documents().mutate(id,{mutationId:`seal_${id}`,operation:'update',expectedRevision:root.revision,schemaVersion:this.schemaVersion,body:{...root.body,state:'sealed'}});
  if(result.status==='conflict') {const latest=await this.root(id);ensure(['sealed','bound'].includes(latest.body.state)&&latest.body.digest===root.body.digest,409,'Upload changed while sealing');return {root:latest,bytes};}
  ensure(['applied','replayed'].includes(result.status));return {root:result.document,bytes};
 }
 async bind(id,jobId){
  for(let attempt=0;attempt<4;attempt++){
   const root=await this.root(id);
   if(root.body.state==='bound'){ensure(root.body.jobId===jobId,409,'Workbook already belongs to another import');return root;}
   ensure(root.body.state==='sealed',409,'Workbook must be sealed before import');
   const result=await this.documents().mutate(id,{mutationId:`bind_${crypto.randomUUID()}`,operation:'update',expectedRevision:root.revision,schemaVersion:this.schemaVersion,body:{...root.body,state:'bound',jobId,expiresAt:null}});
   if(result.status==='conflict')continue;ensure(['applied','replayed'].includes(result.status));return result.document;
  }ensure(false,409,'Workbook changed; retry the same import');
 }
 async expire(id,jobId=null){
  const root=await this.root(id);
  if(root.body.state==='expired')return root;
  if(jobId){if(!(root.body.state==='bound'&&root.body.jobId===jobId||root.body.state==='sealed'))return null;}
  else if(root.body.state==='bound'||root.body.expiresAt===null||root.body.expiresAt>this.clock())return null;
  const result=await this.documents().mutate(id,{mutationId:`expire_${crypto.randomUUID()}`,operation:'update',expectedRevision:root.revision,schemaVersion:this.schemaVersion,body:{...root.body,state:'expired',expiresAt:this.clock()}});
  if(result.status==='conflict')return null;ensure(['applied','replayed'].includes(result.status));return result.document;
 }

}
