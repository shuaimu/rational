import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from '../functions/shared/monarch.ts';
import { BankOverlap } from '../functions/institution-sync/bank-overlap.ts';
function fixture() {
 const docs=new Map();let rev=0,fail=()=>false;
 const store={async read(c,id){return structuredClone(docs.get(c+'/'+id)??null)},async write(c,id,body,expected){if(fail(c,body))throw Error('interrupted');assert.equal(docs.get(c+'/'+id)?.revision??null,expected);docs.set(c+'/'+id,{body:structuredClone(body),revision:String(++rev),_deleted:false})},async remove(c,d){docs.set(c+'/'+d.body.id,{...d,_deleted:true,revision:String(++rev)})},async list(c,k,v){return structuredClone([...docs].filter(([key,d])=>key.startsWith(c+'/')&&d.body[k]===v).map(([,d])=>d))}};
 const engine=new BankOverlap(store),fields={account_id:'a',date:'2026-10-01',amount:-525,currency:'USD',description:'Provider coffee',external_id:'bank1'};
 async function imported(id='csv1',date='2026-10-01',amount=-525,extra={},source={}){await store.write('transactions',id,{id,household_id:'h',account_id:'a',date,amount,currency:'USD',description:'My coffee',notes:'Keep notes',tags:['trip'],reviewed:true,...extra},null);await store.write('import_records','source_'+id,{id:'source_'+id,household_id:'h',kind:'source',account_id:'a',data:JSON.stringify({transactionId:id,source:{statement:'COFFEE STORE',merchant:'My coffee',...source}})},null)}
 return{docs,store,engine,fields,imported,fail(fn){fail=fn}};
}
test('unique exact original statement attaches to existing ID and preserves annotations through retries and corrections',async()=>{
 const f=fixture();await f.imported();f.fail(c=>c==='transactions');await assert.rejects(f.engine.ingest('link','h',f.fields,'coffee store'),/interrupted/);f.fail(()=>false);
 await f.engine.ingest('link','h',f.fields,'coffee store');assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,1);
 let tx=f.docs.get('transactions/csv1').body;assert.equal(tx.notes,'Keep notes');assert.equal(tx.description,'My coffee');assert.equal(tx.reviewed,true);
 await f.engine.ingest('link','h',{...f.fields,amount:-600},'coffee store');assert.equal(f.docs.get('transactions/csv1').body.amount,-600);
 await f.engine.remove('link','h','a','bank1');await f.engine.remove('link','h','a','bank1');assert.equal(f.docs.get('transactions/csv1')._deleted,true);
});
test('posting-date differences and identical purchases match one-to-one automatically',async()=>{
 const f=fixture();await f.imported('csv1','2026-10-02');await f.imported('csv2','2026-10-02');
 await f.engine.ingest('link','h',f.fields,'coffee store');
 assert.equal(f.docs.get('transactions/csv1').body.external_id,'bank1');
 await f.engine.ingest('link','h',{...f.fields,external_id:'bank2'},'coffee store');
 assert.equal(f.docs.get('transactions/csv2').body.external_id,'bank2');
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,2);
 await f.engine.ingest('link','h',{...f.fields,external_id:'bank3'},'coffee store');
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,3,'a third genuine purchase remains a third occurrence');
 assert.equal((await f.engine.reviews('h')).length,0);
 await new BankOverlap(f.store).ingest('link','h',{...f.fields,external_id:'bank2'},'coffee store');
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,3,'fresh worker replay does not add another occurrence');
});
test('manual financial edits and deletions are preserved without holding up synchronization',async()=>{
 const f=fixture();await f.imported();await f.engine.ingest('link','h',f.fields,'COFFEE STORE');
 const tx=f.docs.get('transactions/csv1');await f.store.write('transactions','csv1',{...tx.body,amount:-700},tx.revision);
 await f.engine.ingest('link','h',{...f.fields,amount:-600},'COFFEE STORE');assert.equal(f.docs.get('transactions/csv1').body.amount,-700);
 assert.equal((await f.engine.reviews('h')).length,0);assert.equal((await f.engine.reviews('other')).length,0);
 await assert.rejects(f.engine.ingest('link','other',f.fields,''),/household/);
 await f.engine.remove('link','h','a','bank1');assert.equal(f.docs.get('transactions/csv1')._deleted,false,'a bank removal does not erase a manually changed amount');
 const g=fixture();await g.imported();await g.engine.ingest('link','h',g.fields,'COFFEE STORE');
 await g.store.remove('transactions',g.docs.get('transactions/csv1'));
 await g.engine.ingest('link','h',{...g.fields,amount:-900},'COFFEE STORE');
 assert.equal(g.docs.get('transactions/csv1')._deleted,true,'a later bank correction cannot resurrect a user deletion');
});
test('a matching merchant or original payment description handles the legacy one-day posting gap',async()=>{
 const f=fixture();
 await f.imported('costco','2026-05-31',-525,{description:'Costco'},{merchant:'Costco',statement:'COSTCO WHSE #0237 MELVILLE NY'});
 await f.imported('payment','2026-07-20',-1000,{description:'Bank of America'},{merchant:'Bank of America',statement:'PAYMENT FROM CHK 6130 CONF#example'});
 for (const [providerId,date,amount,description,candidate] of [
  ['bank1','2026-06-01',-525,'Costco','costco'],
  ['bank2','2026-07-21',-1000,'PAYMENT FROM CHK 6130 CONF#example','payment'],
 ]) {
  const id='bank_'+await digest(['link','a',providerId]);
  await f.store.write('import_records',id,{id,household_id:'h',account_id:'a',kind:'bank-identity',state:'review',data:JSON.stringify({
   linkId:'link',providerId,accountId:'a',transactionId:null,state:'review',fields:{...f.fields,date,amount,description,external_id:providerId},
   previous:null,candidates:[candidate],reason:'Possible overlap',removal:false,
  })},null);
 }
 assert.equal(await f.engine.reconcilePending('link','h','a',1),true,'migration phases stay bounded');
 assert.equal(await new BankOverlap(f.store).reconcilePending('link','h','a',1),false);
 assert.equal((await f.engine.reviews('h')).length,0);
 assert.equal(f.docs.get('transactions/costco').body.external_id,'bank1');
 assert.equal(f.docs.get('transactions/payment').body.external_id,'bank2');
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,2);
 assert.equal(f.docs.get('transactions/payment').body.notes,'Keep notes');
});
test('equal amounts without merchant evidence, outside the date window, or in another currency remain separate',async()=>{
 const f=fixture();await f.imported();
 for (const fields of [
  {...f.fields,description:'Parking',external_id:'other-merchant'},
  {...f.fields,date:'2026-10-05',description:'My coffee',external_id:'outside-window'},
  {...f.fields,currency:'EUR',description:'My coffee',external_id:'other-currency'},
 ]) await f.engine.ingest('link','h',fields,'');
 assert.equal(f.docs.get('transactions/csv1').body.external_id,undefined);
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,4);
 assert.equal((await f.engine.reviews('h')).length,0);
});
test('another bank identity winning a claim automatically uses the next unclaimed occurrence',async()=>{
 const f=fixture();await f.imported('csv1');await f.imported('csv2');let raced=false;
 f.fail((collection,body)=>{
  if(collection==='import_records'&&body.id==='claim_csv1'&&!raced){
   raced=true;f.docs.set('import_records/claim_csv1',{body:{...body,data:JSON.stringify({identityId:'another-bank-record'})},revision:'raced',_deleted:false});return true;
  }
  return false;
 });
 await f.engine.ingest('link','h',f.fields,'COFFEE STORE');
 assert.equal(f.docs.get('transactions/csv1').body.external_id,undefined);
 assert.equal(f.docs.get('transactions/csv2').body.external_id,'bank1');
 assert.equal((await f.engine.reviews('h')).length,0);
});
test('provider corrections preserve split totals and imported annotations',async()=>{
 const f=fixture();await f.imported('csv1','2026-10-01',-525,{splits:[{category_id:'food',amount:-525}],category_id:'food'});
 await f.engine.ingest('link','h',f.fields,'COFFEE STORE');
 await f.engine.ingest('link','h',{...f.fields,amount:-600},'COFFEE STORE');
 const tx=f.docs.get('transactions/csv1').body;
 assert.equal(tx.amount,-525);assert.equal(tx.splits[0].amount,-525);assert.equal(tx.category_id,'food');assert.equal(tx.notes,'Keep notes');
 assert.equal((await f.engine.reviews('h')).length,0);
});
