import test from 'node:test';
import assert from 'node:assert/strict';
import {SnapTrade,snaptradeSignature,encodeQuery,ProviderLimiter} from '../shared/providers.js';
import {domain} from './fixtures.mjs';
const canonical=value=>domain({action:'canonical',value}).payload;
test('hosted signing matches native reference and reuses exact encoded query bytes',async()=>{
 assert.equal(await snaptradeSignature('test-consumer-key','/api/v1/snapTrade/registerUser','clientId=PASSIVTEST&timestamp=1635790389',{userId:'new_user_123'},canonical),'8r1jUvUOS5v8LWRQEfA/xStc3zzvyO+ut2VU1XlnCTs=');
 assert.equal(await snaptradeSignature('test-consumer-key','/api/v1/accounts','clientId=PASSIVTEST&userId=robinlab&userSecret=s3cr3t%2Fabc&timestamp=1635790389',null,canonical),'EQfhVEedpLwzSNAPR7WCQ/YlRkckE5PyfQ3bvRYQK0M=');
 assert.equal(encodeQuery([['userSecret','a+b/c=d'],['startDate','2025-01-31']]),'userSecret=a%2Bb%2Fc%3Dd&startDate=2025-01-31');
});
test('provider errors redact sensitive response/URL and flag ambiguous registration',async()=>{
 const client=new SnapTrade({clientId:'commercial',consumerKey:'fixture',canonical,http:async()=>new Response('sensitive provider payload',{status:503})});
 await assert.rejects(()=>client.register('fixture_user'),error=>error.ambiguous&&error.code==='http_error'&&!error.message.includes('sensitive'));
 const personal=new SnapTrade({clientId:'PERS-fixture',consumerKey:'fixture',canonical,http:async url=>{assert.ok(!url.includes('userSecret'));return Response.json([]);}});
 assert.deepEqual(await personal.accounts(personal.user({private:{snaptrade_users:[]}})),[]);
});
test('concurrent cold provider admissions share minute, daily and cooldown limits',async()=>{
 const rows=new Map();let now=Date.parse('2026-09-26T00:00:00Z'),revision=0;
 const documents=()=>({get:async id=>structuredClone(rows.get(id)??null),mutate:async(id,m)=>{const old=rows.get(id);if((old?.revision??null)!==m.expectedRevision)return {status:'conflict'};const document={revision:String(++revision),body:structuredClone(m.body)};rows.set(id,document);return {status:'applied',document};}});
 const limiter=()=>new ProviderLimiter(documents,{clock:()=>now});
 const results=await Promise.all(Array.from({length:10},()=>limiter().reserve('twelve_data',{minute:2,day:3})));
 assert.equal(results.filter(r=>r.allowed).length,2);assert.ok(results.filter(r=>!r.allowed).every(r=>r.retryAt===now+60000));
 now+=60000;assert.equal((await limiter().reserve('twelve_data',{minute:2,day:3})).allowed,true);assert.equal((await limiter().reserve('twelve_data',{minute:2,day:3})).retryAt,Date.parse('2026-09-27T00:00:00Z'));
 await limiter().cooldown('twelve_data',now+2*86400000);now+=86400000;assert.equal((await limiter().reserve('twelve_data')).allowed,false);
});
