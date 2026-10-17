import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BankOverlap } from '../functions/institution-sync/bank-overlap.ts';
function fixture() {
 const docs=new Map();let rev=0,fail=()=>false;
 const store={async read(c,id){return structuredClone(docs.get(c+'/'+id)??null)},async write(c,id,body,expected){if(fail(c,body))throw Error('interrupted');assert.equal(docs.get(c+'/'+id)?.revision??null,expected);docs.set(c+'/'+id,{body:structuredClone(body),revision:String(++rev),_deleted:false})},async remove(c,d){docs.set(c+'/'+d.body.id,{...d,_deleted:true,revision:String(++rev)})},async list(c,k,v){return structuredClone([...docs].filter(([key,d])=>key.startsWith(c+'/')&&d.body[k]===v).map(([,d])=>d))}};
 const engine=new BankOverlap(store),fields={account_id:'a',date:'2026-10-01',amount:-525,currency:'USD',description:'Provider coffee',external_id:'bank1'};
 async function imported(id='csv1',date='2026-10-01',amount=-525){await store.write('transactions',id,{id,household_id:'h',account_id:'a',date,amount,currency:'USD',description:'My coffee',notes:'Keep notes',tags:['trip'],reviewed:true},null);await store.write('import_records','source_'+id,{id:'source_'+id,household_id:'h',kind:'source',account_id:'a',data:JSON.stringify({transactionId:id,source:{statement:'COFFEE STORE'}})},null)}
 return{docs,store,engine,fields,imported,fail(fn){fail=fn}};
}
test('unique exact original statement attaches to existing ID and preserves annotations through retries and corrections',async()=>{
 const f=fixture();await f.imported();f.fail(c=>c==='transactions');await assert.rejects(f.engine.ingest('link','h',f.fields,'coffee store'),/interrupted/);f.fail(()=>false);
 await f.engine.ingest('link','h',f.fields,'coffee store');assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,1);
 let tx=f.docs.get('transactions/csv1').body;assert.equal(tx.notes,'Keep notes');assert.equal(tx.description,'My coffee');assert.equal(tx.reviewed,true);
 await f.engine.ingest('link','h',{...f.fields,amount:-600},'coffee store');assert.equal(f.docs.get('transactions/csv1').body.amount,-600);
 await f.engine.remove('link','h','a','bank1');await f.engine.remove('link','h','a','bank1');assert.equal(f.docs.get('transactions/csv1')._deleted,true);
});
test('date-window and ambiguous matches are staged, then explicitly merged or kept separate',async()=>{
 const f=fixture();await f.imported('csv1','2026-10-02');await f.imported('csv2','2026-10-02');await f.engine.ingest('link','h',f.fields,'coffee store');
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,2);let reviews=await f.engine.reviews('h');assert.equal(reviews.length,1);assert.equal(reviews[0].candidates.length,2);
 await f.engine.resolve('h',reviews[0].id,'csv1');assert.equal((await f.engine.reviews('h')).length,0);assert.equal(f.docs.get('transactions/csv1').body.external_id,'bank1');
 await f.engine.ingest('link','h',{...f.fields,external_id:'bank2'},'coffee store');reviews=await f.engine.reviews('h');assert.equal(reviews.length,1);
 await assert.rejects(f.engine.resolve('h',reviews[0].id,'csv1'),/already matched/);
 await f.engine.resolve('h',reviews[0].id,null); assert.equal([...f.docs.keys()].filter(k=>k.startsWith('transactions/')).length,3);
});
test('manual financial edits cause a correction review and cross-household access fails',async()=>{
 const f=fixture();await f.imported();await f.engine.ingest('link','h',f.fields,'COFFEE STORE');
 const tx=f.docs.get('transactions/csv1');await f.store.write('transactions','csv1',{...tx.body,amount:-700},tx.revision);
 await f.engine.ingest('link','h',{...f.fields,amount:-600},'COFFEE STORE');assert.equal(f.docs.get('transactions/csv1').body.amount,-700);
 assert.equal((await f.engine.reviews('h')).length,1);assert.equal((await f.engine.reviews('other')).length,0);
 await assert.rejects(f.engine.ingest('link','other',f.fields,''),/household/);
});
