import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {JobStore} from '../shared/jobs.js';
import {coalesceAutomatic,automaticJob} from '../shared/automatic-jobs.js';
import {dailyOptions,admitDaily} from '../jobs/dispatcher.js';
import {admitQuotes} from '../shared/quote-admission.js';
const providers={fmp_enabled:false,twelve_data_enabled:true,yahoo_finance_enabled:false};
async function setup(){const f=await fixture();return {...f,jobs:new JobStore(()=>f.documents('robinlab_jobs'),{clock:()=>Date.parse('2026-10-15T12:00:00Z')})};}
test('cleanup cancels only superseded never-started automatic work and retains receipts',async()=>{
 const {jobs}=await setup();
 const old=await jobs.admit('snaptrade_hourly_2026100810','snaptrade',dailyOptions);
 const fresh=await admitDaily(jobs,'2026-10-15');
 const manual=await jobs.admit('manual_broker_command_01','snaptrade',dailyOptions);
 const special=await jobs.admit('snaptrade_hourly_2026100811','snaptrade',{...dailyOptions,replace:true});
 const active=await jobs.admit('snaptrade_hourly_2026100510','snaptrade',dailyOptions);
 const claim=await jobs.claim(active.body.id,'cleanup_test_worker_01');
 const started=await jobs.checkpoint(claim,{phase:'capture_snaptrade',offset:7},{state:'retry',retryAt:jobs.clock()+1000});
 const oldPrice=await jobs.admit('market_quotes_2026100810','prefetch',{mode:'quotes_auto'});
 const price=await admitQuotes(jobs,'2026-10-15');
 const oldReport=await jobs.admit('cache_usage_5973409','summary',{today:'2026-10-15',providers});
 const report=await jobs.admit('cache_usage_5973424','summary',{today:'2026-10-15',providers});
 const dry=await coalesceAutomatic(jobs,{dryRun:true});assert.equal(dry.eligible,3);assert.equal(dry.cancelled,0);
 const result=await coalesceAutomatic(jobs);assert.equal(result.cancelled,3);
 for(const row of [old,oldPrice,oldReport]){
  const cancelled=await jobs.get(row.body.id);assert.equal(cancelled.body.state,'cancelled');assert.equal(cancelled.body.error,'superseded_automatic_request');
  assert.equal((await jobs.admit(row.body.commandId,row.body.kind,row.body.input)).body.state,'cancelled');
 }
 for(const row of [fresh,manual,special,started,price,report])assert.deepEqual(await jobs.get(row.body.id),row);
 assert.equal((await coalesceAutomatic(jobs)).eligible,0);
});
test('bounded cleanup drains large backlogs across restart without deleting identities',async()=>{
 const {jobs}=await setup();
 for(let i=0;i<70;i++)await jobs.admit('snaptrade_hourly_202609'+String(1+Math.floor(i/24)).padStart(2,'0')+String(i%24).padStart(2,'0'),'snaptrade',dailyOptions);
 const latest=await admitDaily(jobs,'2026-10-15');
 const counts=[];for(let i=0;i<3;i++)counts.push((await coalesceAutomatic(jobs)).cancelled);
 assert.deepEqual(counts,[32,32,6]);assert.equal((await jobs.get(latest.body.id)).body.state,'queued');
});
test('a concurrent claim fences automatic cancellation',async()=>{
 const {jobs}=await setup();
 const old=await jobs.admit('market_quotes_2026100810','prefetch',{mode:'quotes_auto'});await admitQuotes(jobs,'2026-10-15');
 const write=jobs.write.bind(jobs);let racing=true,claimed;
 jobs.write=async(id,row,body)=>{
  if(racing&&body.error==='superseded_automatic_request'){racing=false;claimed=await jobs.claim(id,'concurrent_worker_0001');}
  return write(id,row,body);
 };
 const result=await coalesceAutomatic(jobs);assert.equal(result.cancelled,0);assert.equal(result.conflicts,1);
 assert.deepEqual(await jobs.get(old.body.id),claimed);
});
test('partial inspection fails closed and unknown/manual shapes are ignored',async()=>{
 const {jobs}=await setup();const original=jobs.documents;
 jobs.documents=()=>({...original(),query:async()=>({documents:[],nextCursor:'more'})});
 const result=await coalesceAutomatic(jobs);assert.equal(result.incomplete,true);assert.equal(result.cancelled,0);
 assert.equal(automaticJob({kind:'prefetch',commandId:'manual_quotes_0000001',input:{mode:'quotes_auto'}}),null);
 assert.equal(automaticJob({kind:'snaptrade',commandId:'snaptrade_hourly_2026100810',input:{...dailyOptions,start_date:'2020-01-01'}}),null);
 assert.equal(automaticJob({kind:'prefetch',commandId:'market_quotes_bad',input:{mode:'quotes_auto'}}),null);
 assert.equal(automaticJob({kind:'prefetch',commandId:'market_quotes_2026023010',input:{mode:'quotes_auto'}}),null);
});
test('successive daily admissions retain only the latest queued request per purpose',async()=>{
 const {jobs}=await setup();
 for(const day of ['2026-10-13','2026-10-14','2026-10-15']){
  await admitDaily(jobs,day);await admitQuotes(jobs,day);await coalesceAutomatic(jobs);
 }
 const page=await jobs.pendingPage();assert.equal(page.jobs.length,2);
 for(const job of page.jobs)assert.match((await jobs.get(job.id)).body.commandId,/daily_20261015$/);
});
