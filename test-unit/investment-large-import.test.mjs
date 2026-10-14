import test from 'node:test';
import assert from 'node:assert/strict';
import {createExact} from '../scripts/investment-large-import.mjs';
test('capture migration resumes an exact existing document without overwriting',async()=>{
 const body={id:'capture',payload:'a'.repeat(350000)},methods=[];
 await createExact({id:body.id,body,mutationId:'stable',request:async(method)=>{methods.push(method);return method==='POST'?{status:'conflict'}:{body};}});
 assert.deepEqual(methods,['POST','GET']);
});
test('capture migration fails closed on an unrelated destination row',async()=>{
 await assert.rejects(()=>createExact({id:'capture',body:{id:'capture',payload:'expected'},mutationId:'stable',request:async method=>method==='POST'?{status:'conflict'}:{body:{id:'capture',payload:'different'}}}),/different immutable/);
});
test('capture migration preserves the exact idempotent create request',async()=>{
 const body={id:'capture',payload:'large'};
 await createExact({id:body.id,body,mutationId:'stable',request:async(method,id,mutation)=>{assert.equal(method,'POST');assert.equal(id,body.id);assert.deepEqual(mutation,{operation:'create',mutationId:'stable',expectedRevision:null,schemaVersion:1,body});return {status:'replayed'};}});
});
