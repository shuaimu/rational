import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMonarch, parseBalances, decimalMinor, strictCsv, digest, tagsFor } from '../functions/shared/monarch.ts';
import { MonarchImport } from '../functions/institution-sync/monarch-import.ts';
const header = 'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id';
const source = (overrides = {}) => ({ line:2,date:'2026-10-01',merchant:'Coffee',category:'Food',account:'Checking',statement:'COFFEE STORE',notes:'A note',amount:'-5.25',tags:'Trip',owner:'Source owner',reviewed:'Reviewed',sourceId:'123456789012345678',...overrides });
function fixture() {
  const docs = new Map(); let revision = 0, fail = () => false;
  const store = {
    async read(c,id) { return structuredClone(docs.get(`${c}/${id}`) ?? null); },
    async write(c,id,body,expected) {
      if (fail(c,body)) throw new Error('interrupted');
      assert.equal(docs.get(`${c}/${id}`)?.revision ?? null,expected);
      docs.set(`${c}/${id}`, { body:structuredClone(body), revision:String(++revision), _deleted:false });
    },
    async list(c,field,value) { return structuredClone([...docs].filter(([key,d]) => key.startsWith(c+'/') && d.body[field] === value).map(([,d]) => d)); },
    async remove(c,doc) { docs.set(`${c}/${doc.body.id}`,{...doc,_deleted:true,revision:String(++revision)}); },
  };
  return { docs, store, engine:new MonarchImport(store), fail(fn) { fail = fn; } };
}
async function admitted(f, rows, extra = {}) {
  const chunks = []; for (let i=0;i<rows.length;i+=200) chunks.push(rows.slice(i,i+200));
  const manifest = { version:1,accounts:[{source:'Checking',accountId:null,name:'Checking',type:'checking',currency:'USD',identityConfirmed:true,balance:{date:'2026-10-01',amount:'100',sign:1},opening:'0',replaceOpening:false,expectedRevision:null}],categories:{Food:'expense'},tagEncoding:'single',rowCount:rows.length,chunkHashes:await Promise.all(chunks.map(digest)),...extra };
  const job = await f.engine.start('home','user',manifest);
  for (const [i,chunk] of chunks.entries()) await f.engine.upload(job.id,'home',i,chunk);
  await f.engine.seal(job.id,'home'); return job;
}
async function finish(f,id) {
  for(let i=0;i<1000;i++) { const job=await f.engine.advance(id,'home'); if (['complete','needs-review'].includes(job.state)) return job; }
  throw new Error('did not finish');
}
test('strict CSV preserves long IDs, Unicode, multiline notes and explicit review metadata', () => {
  const rows=parseMonarch(`${header}\r\n2026-12-24,"Café, 雪",Food,Checking,STORE,"first\nsecond ""quoted""",-5.25,Trip,Owner,Reviewed,123456789012345678\r\n`);
  assert.equal(rows[0].sourceId,'123456789012345678'); assert.equal(rows[0].notes,'first\nsecond "quoted"'); assert.equal(rows[0].merchant,'Café, 雪');
  assert.equal(rows[0].date,'2026-12-24'); assert.equal(rows[0].reviewed,'Reviewed');
  const legacy=parseMonarch(header.split(',').slice(0,8).join(',')+'\n2026-01-01,Coffee,Food,Checking,STORE,,-2,Trip');
  assert.equal(legacy[0].sourceId,''); assert.equal(legacy[0].reviewed,'');
  assert.throws(()=>strictCsv('a,b\n"unclosed,x'),/Line 2/); assert.throws(()=>strictCsv('a,b\nx'),/Line 2/);
  assert.throws(()=>parseMonarch(header+'\n2026-02-30,Coffee,Food,Checking,STORE,,-2,,,unknown,1'),/calendar/);
  assert.throws(()=>decimalMinor('1.234','USD'),/decimal/); assert.throws(()=>decimalMinor('9007199254740992','JPY'),/safe/);
  assert.equal(decimalMinor('-1.2300','USD'),-123); assert.deepEqual(tagsFor('Trip,Family','single'),['Trip,Family']); assert.deepEqual(tagsFor('Trip,Family','comma'),['Trip','Family']);
  assert.equal(parseBalances('Date,Balance,Account\n2026-10-01,-20,Card')[0].balance,'-20');
});
test('import is resumable, preserves metadata, and balances at evidence date while retaining later/future transactions', async()=>{
  const f=fixture(), job=await admitted(f,[source(),source({line:3,date:'2026-12-24',amount:'10',sourceId:'223456789012345678'})]);
  await f.engine.advance(job.id,'home');
  f.fail((c)=>c==='transactions'); await assert.rejects(f.engine.advance(job.id,'home'),/interrupted/);
  f.fail(()=>false); const completed=await finish(f,job.id); assert.equal(completed.state,'complete'); assert.equal(completed.created,2);
  const account=[...f.docs].find(([k])=>k.startsWith('accounts/'))[1].body;
  assert.equal(account.opening_balance,10525);
  const txs=[...f.docs].filter(([k])=>k.startsWith('transactions/')).map(([,d])=>d.body);
  assert.equal(txs.reduce((sum,t)=>sum+t.amount,account.opening_balance),11000);
  assert.equal(txs[0].notes,'A note'); assert.equal(txs[0].reviewed,true); assert.equal(txs[0].tags.length,1);
  assert.equal((await finish(f,job.id)).created,2);
  const replay=await admitted(f,[source({line:7}),source({line:8,date:'2026-12-24',amount:'10',sourceId:'223456789012345678'})]);
  assert.equal((await finish(f,replay.id)).duplicates,2); assert.equal(txs.length,2);
});
test('identical legitimate legacy purchases survive, duplicate IDs do not inflate balances, changed source metadata is reviewed',async()=>{
  const f=fixture(), rows=[source({sourceId:''}),source({line:3,sourceId:''}),source({line:4}),source({line:5})];
  const job=await admitted(f,rows); const result=await finish(f,job.id); assert.equal(result.created,3); assert.equal(result.duplicates,1);
  const account=[...f.docs].find(([k])=>k.startsWith('accounts/'))[1].body; assert.equal(account.opening_balance,11575);
  const changed=await admitted(f,[source({notes:'Changed source note'})]); const review=await finish(f,changed.id); assert.equal(review.state,'needs-review');
  assert.equal([...f.docs].filter(([k])=>k.startsWith('transactions/')).length,3);
});
test('household isolation, manifest checksums, invalid mapping and cancellation prevent writes',async()=>{
  const f=fixture(), job=await admitted(f,[source()]);
  await assert.rejects(f.engine.status(job.id,'other'),/household/);
  await assert.rejects(f.engine.upload(job.id,'home',0,[source({amount:'9'})]),/checksum/);
  await f.engine.cancel(job.id,'home'); assert.equal((await f.engine.advance(job.id,'home')).state,'cancelled');
  assert.equal([...f.docs].filter(([k])=>k.startsWith('transactions/')).length,0);
  await f.engine.resume(job.id,'home'); assert.equal((await finish(f,job.id)).created,1);
});
test('more than twenty thousand rows complete through bounded phases with a fresh worker after every call',async()=>{
 const f=fixture(),rows=Array.from({length:20001},(_,i)=>source({line:i+2,sourceId:String(100000000000000000n+BigInt(i)),category:'',tags:'',notes:''}));
 const job=await admitted(f,rows);let result;
 for(let i=0;i<1000;i++) {f.engine=new MonarchImport(f.store);result=await f.engine.advance(job.id,'home',100);if(result.state==='complete')break;}
 assert.equal(result.state,'complete');assert.equal(result.created,20001);assert.equal(result.processed,20001);
 assert.equal([...f.docs.keys()].filter(key=>key.startsWith('transactions/')).length,20001);
});

test('a crash after the second ledger commit recovers exact counters without overwriting a later edit',async()=>{
 const f=fixture(),job=await admitted(f,[source(),source({line:3,sourceId:'2'})]);await f.engine.advance(job.id,'home');
 let writes=0;f.fail((c,b)=>c==='import_records'&&b.kind==='source'&&JSON.parse(b.data).state==='complete'&&++writes===2);
 await assert.rejects(f.engine.advance(job.id,'home'),/interrupted/);f.fail(()=>false);
 const result=await finish(f,job.id);assert.equal(result.created,2);assert.equal(result.duplicates,0);
 const tx=[...f.docs].find(([k])=>k.startsWith('transactions/'))[1];await f.store.write('transactions',tx.body.id,{...tx.body,notes:'Manual note'},tx.revision);
 const replay=await admitted(f,[source({line:8}),source({line:9,sourceId:'2'})]);await finish(f,replay.id);assert.equal(f.docs.get('transactions/'+tx.body.id).body.notes,'Manual note');
});

test('immutable admission and upload bounds reject malformed chunks and stale opening revisions',async()=>{
 const f=fixture(),job=await admitted(f,[source()]);
 const manifest=structuredClone(JSON.parse(f.docs.get('import_records/'+job.id).body.data).manifest);
 assert.equal((await f.engine.start('home','user',manifest)).id,job.id);
 const changed=await f.engine.start('home','user',{...manifest,tagEncoding:'comma'});
 assert.notEqual(changed.id,job.id,'changed manifest has a distinct immutable identity');
 await assert.rejects(f.engine.upload(job.id,'home',1,[source()]),/size or index/);
 await assert.rejects(f.engine.upload(job.id,'home',0,Array(201).fill(source())),/size or index/);
 await assert.rejects(f.engine.upload(job.id,'other',0,[source()]),/household/);
 await f.store.write('accounts','existing',{id:'existing',household_id:'home',type:'checking',currency:'USD',opening_balance:100},null);
 const plan={...manifest.accounts[0],accountId:'existing',replaceOpening:true,expectedRevision:'stale'};
 await assert.rejects(f.engine.start('home','user',{...manifest,accounts:[plan]}),/changed/);
 const bad=await admitted(f,[source({date:'2026-02-30'})]);
 await assert.rejects(f.engine.advance(bad.id,'home'),/calendar/);
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,0);
});

test('custom Buy and Sell labels preserve source amounts without standard classification or transfer flags',async()=>{
 const f=fixture(),rows=[source({category:'Buy',amount:'-5.25'}),source({line:3,sourceId:'sell-id',category:'Sell',amount:'10'})];
 const job=await admitted(f,rows,{categories:{Buy:'custom',Sell:'custom'}});
 assert.equal((await finish(f,job.id)).created,2);
 const categories=[...f.docs].filter(([k,d])=>k.startsWith('taxonomy/')&&d.body.kind==='category').map(([,d])=>d.body);
 assert.deepEqual(categories.map(c=>c.name).sort(),['Buy','Sell']);
 assert.ok(categories.every(c=>!Object.hasOwn(c,'category_kind')));
 const txs=[...f.docs].filter(([k])=>k.startsWith('transactions/')).map(([,d])=>d.body);
 assert.deepEqual(txs.map(t=>t.amount),[-525,1000]);
 assert.ok(txs.every(t=>!t.transfer_id&&!t.hidden));
 for(const tx of txs)assert.equal((await f.engine.source('home',tx.id)).category,categories.find(c=>c.id===tx.category_id).name);
});
