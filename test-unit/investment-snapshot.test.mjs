import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {snapshotRows} from '../scripts/investment-snapshot.mjs';
test('streamed snapshots verify bytes, counts and uniqueness across long lines',async()=>{
 const root=await mkdtemp(join(tmpdir(),'investment-snapshot-')),path=join(root,'rows.jsonl');
 const row={id:'capture',payload:'x'.repeat(300000)};
 const bytes=JSON.stringify(row)+'\r\n\n'+JSON.stringify({id:'second'});
 const sha256=createHash('sha256').update(bytes).digest('hex');
 try{
  await writeFile(path,bytes);
  assert.deepEqual(await snapshotRows(path,{sha256,count:2}),new Map([['capture',row],['second',{id:'second'}]]));
  await assert.rejects(()=>snapshotRows(path,{sha256:'wrong',count:2}),/digest/);
  await assert.rejects(()=>snapshotRows(path,{sha256,count:3}),/count/);
  await writeFile(path,JSON.stringify(row)+'\n'+JSON.stringify(row));
  await assert.rejects(()=>snapshotRows(path,{sha256,count:2}),/duplicate/);
 }finally{await rm(root,{recursive:true,force:true});}
});
