import test from 'node:test';
import assert from 'node:assert/strict';
import {checkAdmission} from '../shared/admission.js';
import {createApi} from '../api/handler.js';
import {fixture,domain} from './fixtures.mjs';
import {retiredWriter} from '../retired-writer/handler.js';
test('retired source gateway rejects every request without credentials or clients',async()=>{
 for(const method of ['GET','POST','PUT','PATCH','DELETE','OPTIONS']){
  const result=retiredWriter(new Request('https://fixture/collections/portfolio_heads',{method}));
  assert.equal(result.status,503);assert.equal(result.headers.get('cache-control'),'no-store');
  assert.match((await result.json()).error,/closed for migration/);
 }
});
test('migration fence blocks new operations including side-effectful GETs',()=>{
 for(const mode of ['closed','draining','read-only','invalid']){
  for(const [method,path] of [['POST','/accounts'],['POST','/import/excel'],['PUT','/uploads/u_x/chunks/0'],['GET','/admin/api-usage'],['GET','/snaptrade/connect'],['GET','/snaptrade/accounts']])assert.throws(()=>checkAdmission(mode,method,path),/paused/);
 }
 checkAdmission('draining','GET','/jobs/j_'+'a'.repeat(64));
 assert.throws(()=>checkAdmission('closed','GET','/jobs/j_'+'a'.repeat(64)),/paused/);
});
test('read-only provider status and cache reports avoid provider calls and mutations',async()=>{
 const f=await fixture();
 const forbidden=()=>{throw Error('read-only route attempted a side effect');};
 const api=createApi({mode:'read-only',authorize:async()=>{},repository:f.repository(),domain,cache:{status:async()=>null,range:async()=>[]},jobs:{admit:forbidden},broker:{connect:forbidden,accounts:forbidden}});
 for(const path of ['/snaptrade/status','/admin/cache-coverage?symbol=TEST','/admin/cache-price-trend?symbol=TEST']){
  const response=await api(new Request('https://fixture'+path));
  assert.equal(response.status,200);assert.equal(f.state.writes,0);
 }
});
test('read-only positions do not admit quote jobs and retain calculations',async()=>{
 const f=await fixture();let admissions=0;
 const api=createApi({mode:'read-only',authorize:async()=>{},repository:f.repository(),domain,cache:{latest:async()=>[]},jobs:{admit:async()=>{admissions++;}}});
 const response=await api(new Request('https://fixture/positions'));
 assert.equal(response.status,200);assert.equal(admissions,0);assert.equal(f.state.writes,0);
 const mutation=await api(new Request('https://fixture/accounts',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
 assert.equal(mutation.status,503);assert.equal(f.state.writes,0);
});
