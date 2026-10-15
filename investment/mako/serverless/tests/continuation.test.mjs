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
