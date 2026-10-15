import test from 'node:test';
import assert from 'node:assert/strict';
import {continuationResponse} from '../jobs/continuation.js';
test('successful progress continues within bounds while errors and idle ticks stop',()=>{
 const base={processed:1,cleanup:{},progressed:true,now:100000};
 const row=(dueAt,leaseUntil=0)=>({body:{dueAt,leaseUntil}});
 assert.deepEqual(continuationResponse({...base,pending:[row(101000)]}).makoContinuation,{delaySeconds:5});
 assert.deepEqual(continuationResponse({...base,pending:[row(101000,160000)]}).makoContinuation,{delaySeconds:60});
 assert.deepEqual(continuationResponse({...base,pending:[row(400000)]}).makoContinuation,{delaySeconds:300});
 for(const extra of [{pending:[]},{pending:[row(400001)]},{progressed:false,pending:[row(101000)]}])assert.equal(continuationResponse({...base,...extra}).makoContinuation,undefined);
});
test('a failed price lane does not stop a healthy broker lane or erase retry delays',()=>{
 const failed={body:{id:'prices',error:'operation_unavailable',dueAt:160000,leaseUntil:0}};
 const healthy={body:{id:'broker',error:null,dueAt:101000,leaseUntil:120000}};
 const base={processed:1,cleanup:{},progressed:false,failedJobId:'prices',now:100000};
 assert.deepEqual(continuationResponse({...base,pending:[failed,healthy]}).makoContinuation,{delaySeconds:20});
 assert.equal(continuationResponse({...base,pending:[failed]}).makoContinuation,undefined);
 assert.equal(continuationResponse({...base,pending:[failed,{...healthy,body:{...healthy.body,error:'operation_unavailable'}}]}).makoContinuation,undefined);
});
