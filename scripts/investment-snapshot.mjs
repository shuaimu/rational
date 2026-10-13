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
