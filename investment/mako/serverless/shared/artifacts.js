import {ensure,sha256,batches} from './errors.js';
const encoder=new TextEncoder(),decoder=new TextDecoder(),CHUNK=256*1024,MAX=64*1024*1024;
const encode=bytes=>{let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));return btoa(binary);};
const decode=text=>{const binary=atob(text),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;};
// Immutable, private, job-scoped captures. A manifest is created only after all
// chunks exist; checkpoints refer to its digest, never to a mutable provider page.
export class Artifacts {
 constructor(documents){this.documents=documents;}
 async create(body){
  const result=await this.documents().mutate(body.id,{mutationId:`artifact_${body.id}`,operation:'create',expectedRevision:null,schemaVersion:1,body});
  if(result.status==='conflict'){const row=await this.documents().get(body.id);ensure(row&&!row._deleted&&row.body.digest===body.digest&&row.body.jobId===body.jobId&&row.body.kind===body.kind&&row.body.bytes===body.bytes);}
  else ensure(['applied','replayed'].includes(result.status));
 }
 async named(jobId,name){
  const id=`a_${await sha256(encoder.encode(`${jobId}:named:${name}`))}`,row=await this.documents().get(id);
  if(!row||row._deleted)return null;ensure(row.body.kind==='manifest'&&row.body.jobId===jobId);
  return {id,digest:row.body.digest,bytes:row.body.bytes};
 }
 async save(jobId,value,{name=null}={}){
  ensure(/^j_[a-f0-9]{64}$/.test(jobId));const bytes=encoder.encode(JSON.stringify(value));ensure(bytes.length>0&&bytes.length<=MAX,413,'Captured input exceeds bounds');
  const digest=await sha256(bytes),chunks=[];
  for(let offset=0;offset<bytes.length;offset+=CHUNK){const part=bytes.subarray(offset,offset+CHUNK),hash=await sha256(part);chunks.push({id:`b_${await sha256(encoder.encode(`${jobId}:${offset}:${hash}`))}`,jobId,kind:'chunk',digest:hash,bytes:part.length,payload:encode(part)});}
  await batches(chunks,4,chunk=>this.create(chunk));
  const body={id:`a_${await sha256(encoder.encode(name?`${jobId}:named:${name}`:`${jobId}:${digest}:${bytes.length}`))}`,jobId,kind:'manifest',digest,bytes:bytes.length,chunks:chunks.map(chunk=>chunk.id)};
  await this.create(body);return {id:body.id,digest,bytes:bytes.length};
 }
 async load(jobId,reference){
  ensure(reference&&/^a_[a-f0-9]{64}$/.test(reference.id)&&Number.isSafeInteger(reference.bytes)&&reference.bytes>0&&reference.bytes<=MAX);
  const root=await this.documents().get(reference.id);ensure(root&&!root._deleted&&root.schemaVersion===1);
  const meta=root.body;ensure(meta.id===reference.id&&meta.kind==='manifest'&&meta.jobId===jobId&&meta.digest===reference.digest&&meta.bytes===reference.bytes&&Array.isArray(meta.chunks)&&meta.chunks.length===Math.ceil(meta.bytes/CHUNK));
  const bytes=new Uint8Array(meta.bytes);
  await batches(meta.chunks.map((id,index)=>({id,index})),8,async({id,index})=>{
   ensure(/^b_[a-f0-9]{64}$/.test(id));const row=await this.documents().get(id);ensure(row&&!row._deleted&&row.schemaVersion===1);
   const part=row.body;ensure(part.id===id&&part.kind==='chunk'&&part.jobId===jobId&&part.bytes===Math.min(CHUNK,meta.bytes-index*CHUNK)&&typeof part.payload==='string'&&part.payload.length<=349528);
   let decoded;try{decoded=decode(part.payload);}catch{ensure(false);}
   ensure(decoded.length===part.bytes&&await sha256(decoded)===part.digest);bytes.set(decoded,index*CHUNK);
  });
  ensure(await sha256(bytes)===meta.digest);
  try{return JSON.parse(decoder.decode(bytes));}catch{ensure(false);}
 }
}
