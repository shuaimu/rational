import test from 'node:test';
import assert from 'node:assert/strict';
import {UploadStore,UPLOAD_CHUNK_BYTES} from '../shared/uploads.js';
import {sha256} from '../shared/errors.js';
function fixture(){const rows=new Map();let revision=0;const documents=()=>({get:async id=>structuredClone(rows.get(id)??null),mutate:async(id,m)=>{
 const old=rows.get(id);if(m.operation==='create'&&old||m.operation==='update'&&old?.revision!==m.expectedRevision)return {status:'conflict'};
 const document={body:structuredClone(m.body),revision:String(++revision)};rows.set(id,document);return {status:'applied',document};
}});return {store:()=>new UploadStore(documents),rows};}
test('interrupted upload stays unsealed; changed chunks and command reuse are rejected',async()=>{
 const f=fixture(),bytes=new Uint8Array(UPLOAD_CHUNK_BYTES+3).fill(7),digest=await sha256(bytes);
 const root=await f.store().admit('upload_command_000001',{bytes:bytes.length,digest});
 await f.store().putChunk(root.body.id,0,bytes.subarray(0,UPLOAD_CHUNK_BYTES));
 await assert.rejects(()=>f.store().seal(root.body.id),e=>e.status===409);
 assert.equal((await f.store().root(root.body.id)).body.state,'uploading');
 await assert.rejects(()=>f.store().putChunk(root.body.id,0,new Uint8Array(UPLOAD_CHUNK_BYTES)),e=>e.status===409);
 await assert.rejects(()=>f.store().admit('upload_command_000001',{bytes:bytes.length,digest:'a'.repeat(64)}),e=>e.status===409);
 await f.store().putChunk(root.body.id,1,bytes.subarray(UPLOAD_CHUNK_BYTES));
 const sealed=await f.store().seal(root.body.id);assert.deepEqual(sealed.bytes,bytes);assert.equal(sealed.root.body.state,'sealed');
 assert.deepEqual((await f.store().seal(root.body.id)).bytes,bytes);
});
test('reordered and corrupted stored chunks cannot produce a sealed workbook',async()=>{
 const f=fixture(),bytes=new Uint8Array(4).fill(2);
 const root=await f.store().admit('upload_command_000002',{bytes:4,digest:await sha256(bytes)});
 await f.store().putChunk(root.body.id,0,bytes);
 const chunk=f.rows.get(await f.store().chunkId(root.body.id,0));
 chunk.body=Object.fromEntries(Object.entries(chunk.body).reverse());
 await f.store().putChunk(root.body.id,0,bytes);
 chunk.body.index=1;
 await assert.rejects(()=>f.store().seal(root.body.id),e=>e.status===409);
 chunk.body.index=0;chunk.body.payload=btoa('xxxx');
 await assert.rejects(()=>f.store().seal(root.body.id),e=>e.status===409);
});

test('binding wins against expiration and expired command roots cannot be resurrected',async()=>{
 const {fixture}=await import('./fixtures.mjs');const f=await fixture();let now=1000;const uploads=new UploadStore(()=>f.documents('uploads'),{clock:()=>now});
 const bytes=new Uint8Array([1,2,3]),digest=await sha256(bytes),root=await uploads.admit('binding_upload_00001',{bytes:3,digest});
 await uploads.putChunk(root.body.id,0,bytes);await uploads.seal(root.body.id);
 const bound=await uploads.bind(root.body.id,'j_'+'a'.repeat(64));assert.equal(bound.body.state,'bound');
 now+=8*86400000;assert.equal(await uploads.expire(root.body.id),null);
 await assert.rejects(()=>uploads.bind(root.body.id,'j_'+'b'.repeat(64)),error=>error.status===409);
 await uploads.expire(root.body.id,'j_'+'a'.repeat(64));
 await assert.rejects(()=>uploads.admit('binding_upload_00001',{bytes:3,digest}),error=>error.status===410);
 await assert.rejects(()=>uploads.putChunk(root.body.id,0,bytes),error=>error.status===410);
});
