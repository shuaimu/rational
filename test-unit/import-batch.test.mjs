import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapImportBatch, IMPORT_BATCH_ROWS } from '../functions/institution-sync/import-batch.ts';
import { ImportPerformance } from '../functions/institution-sync/import-performance.ts';

test('independent rows overlap but repeated identities remain ordered and all requests drain on failure', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  let finished = false;
  const pending = mapImportBatch(['a','b','a'], key => key, async (key, index) => {
    events.push(`start${index}`);
    if (key === 'b') { await gate; events.push('finish1'); return index; }
    throw new Error('write interrupted');
  }).catch(error => { finished = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'failure cannot return while a sibling is still writing');
  assert.deepEqual(events, ['start0','start1'], 'a repeated failed identity must not start');
  release();
  assert.match((await pending).message, /interrupted/);
  assert.deepEqual(events, ['start0','start1','finish1']);
  let active = 0, peak = 0;
  const values = await mapImportBatch(Array.from({length:IMPORT_BATCH_ROWS}, (_,i)=>i), String, async i => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve)); active--; return i;
  });
  assert.equal(peak, IMPORT_BATCH_ROWS);
  assert.deepEqual(values, Array.from({length:IMPORT_BATCH_ROWS}, (_,i)=>i));
  await assert.rejects(mapImportBatch(Array(IMPORT_BATCH_ROWS+1).fill(1),String,async x=>x), /bound/);
});

test('performance captures failed database work without including documents or credentials', async () => {
  let time = 100;
  const metrics = new ImportPerformance({
    read: async () => { time += 7; return {body:{secret:'never recorded'}}; },
    write: async () => { time += 11; throw new Error('failure'); },
    list: async () => [], remove: async () => {},
  }, () => time);
  await metrics.store.read('private','sensitive-id');
  await assert.rejects(metrics.store.write('private','id',{},null));
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.beforeCheckpointMs,18);
  assert.equal(snapshot.calls.read,1); assert.equal(snapshot.calls.write,1);
  assert.equal(snapshot.milliseconds.read,7); assert.equal(snapshot.milliseconds.write,11);
  assert.equal(snapshot.peakRequests,1);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
});
