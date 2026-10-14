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
