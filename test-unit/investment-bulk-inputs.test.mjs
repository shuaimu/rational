import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inputParts,missingIds,importInputs} from '../scripts/investment-bulk-inputs.mjs';

test('bulk input planning refuses changed or extra destination rows and bounds UTF-8 parts',async()=>{
 const source=new Map([['a',{id:'a',payload:'é'.repeat(12)}],['b',{id:'b'}],['c',{id:'c'}]]);
 assert.deepEqual(await missingIds(source,new Map([['b',{id:'b'}]])),['a','c']);
 await assert.rejects(()=>missingIds(source,new Map([['a',{id:'a',payload:'other'}]])),/exact immutable subset/);
 await assert.rejects(()=>missingIds(source,new Map([['z',{id:'z'}]])),/exact immutable subset/);
 const stale=new Map([['z',{id:'z',payload:'rehearsal'}]]);
 assert.deepEqual(await missingIds(source,stale,stale),['a','b','c']);
 await assert.rejects(()=>missingIds(source,stale,new Map([['z',{id:'z',payload:'unexplained'}]])),/verified rehearsal/);
 await assert.rejects(()=>missingIds(source,new Map([['a',{id:'a',payload:'other'}]]),new Map([['a',{id:'a',payload:'other'}]])),/exact immutable subset/);
 const parts=[];for await(const part of inputParts(source,['a','b','c'],64,2))parts.push(part);
 assert.ok(parts.length>1);assert.ok(parts.every(p=>p.bytes<=64&&p.rows<=2));
 assert.deepEqual(parts.flatMap(p=>p.content.toString().trim().split('\n').map(JSON.parse)),[...source.values()]);
});

test('a lost import response resumes the recorded job and retires bounded staging payloads',async t=>{
 const root=await mkdtemp(join(tmpdir(),'bulk-inputs-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const rows=[{id:'a',payload:'existing'},{id:'b',payload:'x'.repeat(350000)},{id:'c',payload:'new'}];
 for(const [name,environment,values] of [['source','source',rows],['baseline','destination',rows.slice(0,1)]]){
  await mkdir(join(root,name));const content=values.map(JSON.stringify).join('\n')+'\n';await writeFile(join(root,name,'robinlab_inputs.jsonl'),content);
  await writeFile(join(root,name,'manifest.json'),JSON.stringify({scope:{project:'project',endpoint:'https://fixture.invalid',environment},collections:{robinlab_inputs:{count:values.length,sha256:createHash('sha256').update(content).digest('hex')}}}));
 }
 await writeFile(join(root,'config.json'),JSON.stringify({projectId:'project',environmentId:'destination',endpoint:'https://fixture.invalid'}));
 await writeFile(join(root,'cli.mjs'),`import{readFile,writeFile,appendFile}from'node:fs/promises';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';
const root=dirname(fileURLToPath(import.meta.url)),a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1],jobId='djob_fixture';
if(!a.includes('--job')){await appendFile(join(root,'created'),'1');console.error('job '+jobId);process.exit(1);}
if(get('--job')!==jobId)throw Error('wrong resumed job');
const content=await readFile(get('--input')),rows=content.toString().trim().split('\\n').map(JSON.parse);if(rows.length!==2||rows[0].payload.length!==350000)throw Error('wrong input');
console.log(JSON.stringify({jobId,state:'succeeded',collectionId:'robinlab_inputs',conflictStrategy:'create_only',tenant:{projectId:'project',environmentId:'destination'},manifest:{digest:'sha256:'+createHash('sha256').update(content).digest('hex'),rowCount:rows.length,byteCount:content.length},progress:{processed:rows.length,committed:rows.length,failed:0,skipped:0}}));`);
 const args={source:join(root,'source'),baseline:join(root,'baseline'),configFile:join(root,'config.json'),cliPath:join(root,'cli.mjs'),output:join(root,'journal')};
 await assert.rejects(()=>importInputs(args),/Import incomplete/);
 assert.equal(JSON.parse(await readFile(join(root,'journal/import.json'),'utf8')).parts['0'].jobId,'djob_fixture');
 assert.deepEqual(await importInputs(args),{created:2,baseline:1,total:3});
 assert.equal(await readFile(join(root,'created'),'utf8'),'1');
 assert.equal((await readdir(join(root,'journal'))).includes('active-part.jsonl'),false);
 await importInputs(args);assert.equal(await readFile(join(root,'created'),'utf8'),'1');
});

test('bounded concurrent imports drain receipts on failure and resume only original jobs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'bulk-concurrent-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const rows=Array.from({length:8193},(_,i)=>({id:'r'+String(i).padStart(5,'0'),payload:'immutable'}));
 for(const [name,environment,values] of [['source','source',rows],['baseline','destination',[]]]){
  await mkdir(join(root,name));const content=values.map(JSON.stringify).join('\n')+'\n';await writeFile(join(root,name,'robinlab_inputs.jsonl'),content);
  await writeFile(join(root,name,'manifest.json'),JSON.stringify({scope:{project:'project',endpoint:'https://fixture.invalid',environment},collections:{robinlab_inputs:{count:values.length,sha256:createHash('sha256').update(content).digest('hex')}}}));
 }
 await writeFile(join(root,'config.json'),JSON.stringify({projectId:'project',environmentId:'destination',endpoint:'https://fixture.invalid'}));
 await writeFile(join(root,'cli.mjs'),`import{readFileSync,writeFileSync,appendFileSync}from'node:fs';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';
const root=dirname(fileURLToPath(import.meta.url)),a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];
const content=readFileSync(get('--input')),rows=content.toString().trim().split('\\n').map(JSON.parse),jobId='djob_'+rows[0].id;
const record=event=>appendFileSync(join(root,'events'),JSON.stringify({event,jobId})+'\\n');
if(!a.includes('--job')){writeFileSync(join(root,jobId),'created',{flag:'wx'});console.error('job '+jobId);record('created');}else if(get('--job')!==jobId)throw Error('wrong resumed job');
record('start');
// Hold the first admitted batch until all four siblings exist. Wall-clock
// delays alone race filesystem/process scheduling on a busy development host.
const deadline=Date.now()+10000;
while(readFileSync(join(root,'events'),'utf8').trim().split('\\n').map(JSON.parse).filter(e=>e.event==='created').length<4){if(Date.now()>deadline)throw Error('fixture admission barrier timed out');await new Promise(r=>setTimeout(r,10));}
if(jobId==='djob_r00000'&&!a.includes('--job')){await new Promise(r=>setTimeout(r,150));record('end');process.exit(1);}
await new Promise(r=>setTimeout(r,700));record('end');
console.log(JSON.stringify({jobId,state:'succeeded',collectionId:'robinlab_inputs',conflictStrategy:'create_only',tenant:{projectId:'project',environmentId:'destination'},manifest:{digest:'sha256:'+createHash('sha256').update(content).digest('hex'),rowCount:rows.length,byteCount:content.length},progress:{processed:rows.length,committed:rows.length,failed:0,skipped:0}}));`);
 const args={source:join(root,'source'),baseline:join(root,'baseline'),configFile:join(root,'config.json'),cliPath:join(root,'cli.mjs'),output:join(root,'journal'),concurrency:4};
 await assert.rejects(()=>importInputs({...args,concurrency:5}),/concurrency/);
 await assert.rejects(()=>importInputs(args),/Import incomplete/);
 let journal=JSON.parse(await readFile(join(root,'journal/import.json'),'utf8'));
 assert.equal(journal.parts['0'].jobId,'djob_r00000');assert.equal(journal.parts['0'].succeeded,undefined);
 assert.equal(Object.values(journal.parts).filter(p=>p.succeeded).length,3,'all admitted sibling receipts must drain before rejection');
 assert.equal(journal.parts['4'],undefined,'a failed sibling stops further admission');
 assert.equal((await readdir(join(root,'journal'))).includes('owner.lock'),false);
 assert.deepEqual(await importInputs(args),{created:rows.length,baseline:0,total:rows.length});
 journal=JSON.parse(await readFile(join(root,'journal/import.json'),'utf8'));
 assert.equal(journal.complete,true);assert.equal(Object.values(journal.parts).filter(p=>p.succeeded).length,5);
 assert.equal((await readdir(join(root,'journal'))).some(p=>p.startsWith('active-part')),false);
 const before=await readFile(join(root,'events'),'utf8');await importInputs(args);assert.equal(await readFile(join(root,'events'),'utf8'),before);
 let active=0,peak=0;const created=new Set();
 for(const {event,jobId} of before.trim().split('\n').map(JSON.parse)){
  if(event==='start'){active++;peak=Math.max(peak,active);}
  if(event==='end')active--;
  if(event==='created'){assert.equal(created.has(jobId),false,'never create a replacement job');created.add(jobId);}
 }
 assert.equal(active,0);assert.equal(peak,4);assert.equal(created.size,5);
});
