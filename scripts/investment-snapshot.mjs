// Read sealed NDJSON without constructing one string for a whole collection.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export async function snapshotRows(path,entry){
 const stream=createReadStream(path),hash=createHash('sha256'),rows=new Map();
 stream.on('data',chunk=>hash.update(chunk));
 const lines=createInterface({input:stream,crlfDelay:Infinity});
 try{
  for await(const line of lines){
   if(!line.trim())continue;
   const row=JSON.parse(line);assert.equal(typeof row.id,'string','snapshot document ID');
   assert.ok(!rows.has(row.id),'duplicate snapshot document ID');rows.set(row.id,row);
  }
  assert.equal(hash.digest('hex'),entry.sha256,'snapshot file digest');
  assert.equal(rows.size,entry.count,'snapshot record count');return rows;
 }finally{lines.close();stream.destroy();}
}

// Keep only IDs and byte ranges in memory. Captures can occupy gigabytes while
// individual documents remain bounded by the platform's one-MiB limit.
export async function snapshotIndex(path,entry){
 const {open}=await import('node:fs/promises');
 const file=await open(path,'r'),ranges=new Map(),hash=createHash('sha256');
 let pending=Buffer.alloc(0),offset=0;
 const MAX_LINE=1024*1024+1;
 const accept=line=>{
  if(!line.toString('utf8').trim())return;
  assert.ok(line.length<=MAX_LINE,'snapshot document exceeds platform bound');
  const row=JSON.parse(line.toString('utf8'));assert.equal(typeof row.id,'string','snapshot document ID');
  assert.ok(!ranges.has(row.id),'duplicate snapshot document ID');
  ranges.set(row.id,{offset,length:line.length});
 };
 try{
  const stream=file.createReadStream({autoClose:false});
  for await(const chunk of stream){
   hash.update(chunk);pending=Buffer.concat([pending,chunk]);
   let start=0,end;
   while((end=pending.indexOf(10,start))>=0){const line=pending.subarray(start,end+1);accept(line);offset+=line.length;start=end+1;}
   pending=pending.subarray(start);assert.ok(pending.length<=MAX_LINE,'snapshot document exceeds platform bound');
  }
  if(pending.length){accept(pending);offset+=pending.length;}
  assert.equal(hash.digest('hex'),entry.sha256,'snapshot file digest');
  assert.equal(ranges.size,entry.count,'snapshot record count');
  const get=async id=>{
   const range=ranges.get(id);if(!range)return undefined;
   const bytes=Buffer.alloc(range.length);let filled=0;
   while(filled<bytes.length){const {bytesRead}=await file.read(bytes,filled,bytes.length-filled,range.offset+filled);assert.ok(bytesRead,'snapshot file truncated');filled+=bytesRead;}
   const row=JSON.parse(bytes.toString('utf8'));assert.equal(row.id,id,'snapshot file changed');return row;
  };
  return {size:ranges.size,keys:()=>ranges.keys(),get,
   async *values(){for(const id of ranges.keys())yield await get(id);},
   close:()=>file.close()};
 }catch(error){await file.close();throw error;}
}
