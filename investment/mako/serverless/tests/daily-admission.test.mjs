import test from 'node:test';
import assert from 'node:assert/strict';
import {JobStore} from '../shared/jobs.js';
import {admitDaily,dailyOptions} from '../jobs/dispatcher.js';
import {admitQuotes} from '../shared/quote-admission.js';
import {createApi} from '../api/handler.js';
import {fixture,domain} from './fixtures.mjs';

test('automatic jobs deduplicate throughout a UTC day and change at midnight',async()=>{
 const f=await fixture(),jobs=new JobStore(()=>f.documents('robinlab_jobs'));
 for(const admit of [admitDaily,admitQuotes]){
  const first=await admit(jobs,'2026-10-14T00:00:00Z');
  const repeats=await Promise.all([
   admit(jobs,'2026-10-14T12:00:00Z'),
   admit(jobs,new Date('2026-10-14T23:59:59.999Z')),
   admit(jobs,'2026-10-15T01:59:59+02:00'),
  ]);
  assert.ok(repeats.every(row=>row.body.id===first.body.id));
  const next=await admit(jobs,'2026-10-15T00:00:00Z');
  assert.notEqual(next.body.id,first.body.id);
  await jobs.cancel(first.body.id);
  assert.equal((await admit(jobs,'2026-10-14T23:00:00Z')).body.state,'cancelled');
  await assert.rejects(()=>admit(jobs,'invalid'),error=>error.status===400);
 }
 assert.equal([...f.state.rows.keys()].filter(key=>key.startsWith('robinlab_jobs:')).length,4);
});

test('daily admission preserves historical hourly checkpoints and manual commands',async()=>{
 const f=await fixture(),jobs=new JobStore(()=>f.documents('robinlab_jobs'));
 const legacy=await jobs.admit('snaptrade_hourly_2026101400','snaptrade',dailyOptions);
 const claim=await jobs.claim(legacy.body.id,'cadence_test_worker_01');
 const checkpoint=await jobs.checkpoint(claim,{phase:'capturing',offset:10},{state:'retry',retryAt:Date.now()+60000});
 const manual=await jobs.admit('manual_sync_cadence_01','snaptrade',dailyOptions);
 await admitDaily(jobs,'2026-10-14T20:00:00Z');
 assert.deepEqual(await jobs.get(legacy.body.id),checkpoint);
 assert.deepEqual(await jobs.find('manual_sync_cadence_01'),manual);
});

test('positions API and dispatcher share one daily automatic price job',async()=>{
 const f=await fixture(),jobs=new JobStore(()=>f.documents('robinlab_jobs'));
 const scheduled=await admitQuotes(jobs,'2026-10-14T00:00:00Z');
 const api=createApi({authorize:async()=>{},repository:f.repository(),domain,jobs,
  cache:{latest:async()=>[],pricesAt:async()=>[]},clock:()=>new Date('2026-10-14T23:00:00Z')});
 const response=await api(new Request('https://fixture/scope/functions/v1/robinlab-api/positions'));
 assert.equal(response.status,200,await response.text());
 const rows=[...f.state.rows.entries()].filter(([key])=>key.startsWith('robinlab_jobs:'));
 assert.equal(rows.length,1);
 assert.equal(rows[0][1].body.id,scheduled.body.id);
});
