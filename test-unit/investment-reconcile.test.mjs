import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileExact} from '../scripts/investment-reconcile.mjs';
test('reconciliation updates with destination revision, never a source revision',async()=>{
 const before={id:'x',value:1},after={id:'x',value:2};let writes=0;
 await reconcileExact({id:'x',before,after,schemaVersion:1,mutationId:'stable',request:async(method,id,mutation)=>{
  if(method==='GET')return {body:before,revision:'destination-revision'};
  writes++;assert.equal(mutation.expectedRevision,'destination-revision');assert.equal(mutation.operation,'update');return {status:'applied'};
 }});assert.equal(writes,1);
});
test('reconciliation refuses writes accepted after the baseline',async()=>{
 await assert.rejects(()=>reconcileExact({id:'x',before:{id:'x',value:1},after:{id:'x',value:2},schemaVersion:1,mutationId:'stable',request:async method=>{assert.equal(method,'GET');return {body:{id:'x',value:3},revision:'new-write'};}}),/destination changed/);
});
test('a lost reconciliation response resumes without a duplicate mutation',async()=>{
 const after={id:'x',value:2};let writes=0;
 await reconcileExact({id:'x',before:{id:'x',value:1},after,schemaVersion:1,mutationId:'stable',request:async method=>{if(method==='POST')writes++;return {body:after,revision:'committed'};}});assert.equal(writes,0);
});
