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

test('disk index reads bounded records by ID and rejects corrupt or duplicate snapshots',async t=>{
 const {snapshotIndex}=await import('../scripts/investment-snapshot.mjs');
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const directory=await mkdtemp(join(tmpdir(),'snapshot-index-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=join(directory,'input.jsonl');
 const rows=[{id:'a',payload:'é'.repeat(100000)},{id:'b',payload:'x'.repeat(350000)},{id:'c',payload:'last'}];
 const bytes=Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n'));
 await writeFile(path,bytes,{mode:0o600});const entry={sha256:createHash('sha256').update(bytes).digest('hex'),count:rows.length};
 const index=await snapshotIndex(path,entry);
 try{assert.equal(index.size,3);assert.deepEqual([...index.keys()],['a','b','c']);assert.deepEqual(await index.get('b'),rows[1]);assert.equal(await index.get('missing'),undefined);const all=[];for await(const row of index.values())all.push(row);assert.deepEqual(all,rows);}finally{await index.close();}
 await assert.rejects(()=>snapshotIndex(path,{...entry,sha256:'wrong'}),/digest/);
 await assert.rejects(()=>snapshotIndex(path,{...entry,count:1}),/count/);
 await writeFile(path,'{"id":"a"}\n{"id":"a"}\n');await assert.rejects(()=>snapshotIndex(path,entry),/duplicate/);
 await writeFile(path,JSON.stringify({id:'huge',payload:'x'.repeat(1024*1024)}));await assert.rejects(()=>snapshotIndex(path,entry),/bound/);
});
