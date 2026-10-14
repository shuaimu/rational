import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materialize, digest, IncompleteManifest, InvalidManifest } from '../../frontend/src/api/manifest.ts';
const encode=async(prefix,value)=>{const payload=JSON.stringify(value);return {id:`${prefix}_${await digest(payload)}`,payload};};
const ref=d=>({id:d.id,bytes:Buffer.byteLength(d.payload)});
const account={id:1,code:'A',name:null,account_type:null};
async function fixture(rows=[account],table='accounts') {
 const part=await encode('p',{format:1,table,bucket:'fixture',rows});
 const root=await encode('m',{format:1,visibility:'public',children:rows.length?[{kind:'partition',table,bucket:'fixture',content:ref(part)}]:[]});
 const docs=new Map([part,root].map(d=>[d.id,d]));
 const head={id:'portfolio',format:1,sequence:1,public_root:ref(root),private_root:{id:`m_${'0'.repeat(64)}`,bytes:10},command:{id:`c_${'0'.repeat(64)}`,bytes:10},next_ids:{account:2,ticker:1,transaction:1,brokerage_user:1}};
 return {head,docs,part,root,get:async(id)=>docs.get(id)??null};
}
test('head arriving before its parts never exposes partial tables',async()=>{
 const f=await fixture();f.docs.delete(f.part.id);
 await assert.rejects(materialize(f.head,f.get),IncompleteManifest);
 f.docs.set(f.part.id,f.part);assert.equal((await materialize(f.head,f.get)).tables.accounts.length,1);
});
test('deletion publishes a complete new generation without mutating the prior one',async()=>{
 const before=await fixture();const active=await materialize(before.head,before.get);
 const after=await fixture([]);after.head.sequence=2;const next=await materialize(after.head,after.get);
 assert.equal(next.tables.accounts.length,0);assert.equal(active.tables.accounts.length,1);assert.equal(active.version,1);
});
test('exact byte corruption and private table injection are rejected',async()=>{
 const f=await fixture();f.docs.set(f.part.id,{...f.part,payload:f.part.payload+' '});await assert.rejects(materialize(f.head,f.get),InvalidManifest);
 const secret=await fixture([{user_secret:'synthetic'}],'snaptrade_users');await assert.rejects(materialize(secret.head,secret.get),InvalidManifest);
});
test('broken cross-table references and duplicate keys are rejected',async()=>{
 const broken=await fixture([{account_id:99,balance:12}],'broker_balances');await assert.rejects(materialize(broken.head,broken.get),InvalidManifest);
 const dup=await fixture([account,account]);await assert.rejects(materialize(dup.head,dup.get),InvalidManifest);
});
test('unknown fields, invalid dates and unsupported formats fail closed',async()=>{
 const extra=await fixture([{...account,user_secret:'synthetic'}]);await assert.rejects(materialize(extra.head,extra.get),InvalidManifest);
 const bad=await fixture([{symbol:'TEST',split_date:'2025-99-99',multiplier:2}],'ticker_splits');await assert.rejects(materialize(bad.head,bad.get),InvalidManifest);
 const format=await fixture();format.head.format=2;await assert.rejects(materialize(format.head,format.get),InvalidManifest);
});
