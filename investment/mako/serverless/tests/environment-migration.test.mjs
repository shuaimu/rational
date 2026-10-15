import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';

function transfer(source,target,{publishHead=false}={}){
 for(const [key,row] of source.state.rows){
  if(key==='portfolio_heads:portfolio'&&!publishHead)continue;
  target.state.rows.set(key,{...structuredClone(row),revision:'destination-'+row.revision});
 }
}
test('staged migration is invisible until its head is published and replays lost responses',async()=>{
 const source=await fixture(),destination=await fixture();destination.state.rows.clear();
 const input=source.commandInput('migration_lost_response_001','Fixture');source.state.loseResponse=true;
 await assert.rejects(()=>source.repository().execute(input));
 transfer(source,destination);
 await assert.rejects(()=>destination.repository().head());
 transfer(source,destination,{publishHead:true});
 const before=destination.state.writes;
 const replay=await destination.repository().execute(input);
 assert.equal(replay.replayed,true);assert.equal(replay.version,2);assert.equal(destination.state.writes,before);
 assert.deepEqual((await destination.repository().load()).dataset,(await source.repository().load()).dataset);
});
test('rollback after a destination write transfers current state rather than restoring the old source',async()=>{
 const source=await fixture(),destination=await fixture();transfer(source,destination,{publishHead:true});
 const input=destination.commandInput('migration_destination_01','New destination account');
 await destination.repository().execute(input);
 assert.equal((await source.repository().head()).body.sequence,1);
 transfer(destination,source,{publishHead:true});
 const replay=await source.repository().execute(input);
 assert.equal(replay.replayed,true);assert.equal(replay.version,2);
 assert.deepEqual((await source.repository().load()).dataset,(await destination.repository().load()).dataset);
});
test('moving accepted jobs retains hourly command identity across environment revisions',async()=>{
 const {JobStore}=await import('../shared/jobs.js'),{dailyOptions}=await import('../jobs/dispatcher.js');
 const source=await fixture(),destination=await fixture();
 const sourceJobs=new JobStore(()=>source.documents('robinlab_jobs'));
 const accepted=await sourceJobs.admit('snaptrade_hourly_2026092723','snaptrade',dailyOptions);
 transfer(source,destination,{publishHead:true});
 const destinationJobs=new JobStore(()=>destination.documents('robinlab_jobs'));
 const replay=await destinationJobs.admit('snaptrade_hourly_2026092723','snaptrade',dailyOptions);
 assert.equal(replay.body.id,accepted.body.id);assert.equal(replay.body.attempt,0);
 assert.equal([...destination.state.rows.keys()].filter(k=>k.startsWith('robinlab_jobs:')).length,1);
});
