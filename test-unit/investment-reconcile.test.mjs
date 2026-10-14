import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileExact} from '../scripts/investment-reconcile.mjs';
test('reconciliation updates with destination revision, never a source revision',async()=>{
 const before={id:'x',value:1},after={id:'x',value:2};let writes=0;
 await reconcileExact({id:'x',before,after,schemaVersion:1,mutationId:'stable',request:async(method,id,mutation)=>{
  if(method==='GET')return {body:before,revision:'destination-revision'};
  writes++;assert.equal(mutation.expectedRevision,'destination-revision');assert.equal(mutation.operation,'update');return {status:'applied'};
 }});assert.equal(writes,1);
});
test('reconciliation refuses writes accepted after the baseline',async()=>{
 await assert.rejects(()=>reconcileExact({id:'x',before:{id:'x',value:1},after:{id:'x',value:2},schemaVersion:1,mutationId:'stable',request:async method=>{assert.equal(method,'GET');return {body:{id:'x',value:3},revision:'new-write'};}}),/destination changed/);
});
test('deletion carries the verified current body for explorer simulation',async()=>{
 const before={id:'stale',kind:'manifest',bytes:42};
 await reconcileExact({id:before.id,before,after:null,schemaVersion:1,mutationId:'delete',request:async(method,id,mutation)=>{
  if(method==='GET')return {body:before,revision:'destination'};
  assert.equal(mutation.operation,'delete');assert.deepEqual(mutation.body,before);assert.equal(mutation.expectedRevision,'destination');return {status:'applied'};
 }});
});
test('a lost reconciliation response resumes without a duplicate mutation',async()=>{
 const after={id:'x',value:2};let writes=0;
 await reconcileExact({id:'x',before:{id:'x',value:1},after,schemaVersion:1,mutationId:'stable',request:async method=>{if(method==='POST')writes++;return {body:after,revision:'committed'};}});assert.equal(writes,0);
});

test('bounded existing-row reconciliation resumes successes and leaves missing rows for bulk import',async()=>{
 const {mkdtemp,writeFile,readFile,mkdir,rm,readdir}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const {createHash}=await import('node:crypto');const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');const execute=promisify(execFile);
 const root=await mkdtemp(join(tmpdir(),'investment-reconcile-'));
 try{
  const desired=['a','b','c','d','e','f'].map(id=>({id,value:2}));
  const previous=desired.map(row=>({...row,value:1}));
  desired.push({id:'new-bulk-row',value:2});
  for(const [directory,environment,rows] of [['source','source',desired],['baseline','destination',previous]]){
   await mkdir(join(root,directory));const content=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
   await writeFile(join(root,directory,'cache_status.jsonl'),content);
   await writeFile(join(root,directory,'manifest.json'),JSON.stringify({scope:{project:'project',endpoint:'https://fixture.invalid',environment},collections:{cache_status:{count:rows.length,sha256:createHash('sha256').update(content).digest('hex')}}}));
  }
  await writeFile(join(root,'config.json'),JSON.stringify({projectId:'project',environmentId:'destination',endpoint:'https://fixture.invalid'}));
  for(const row of previous)await writeFile(join(root,row.id+'.json'),JSON.stringify({body:row,revision:'destination'}));
  await writeFile(join(root,'fail'),'b');
  await writeFile(join(root,'cli.mjs'),`import{readFile,writeFile,appendFile}from'node:fs/promises';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';
const root=dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2);
if(args[1]==='get'){const id=args[3];let fail;try{fail=await readFile(join(root,'fail'),'utf8');}catch{}if(id===fail){console.error('forced permanent refusal');process.exit(1);}const row=JSON.parse(await readFile(join(root,id+'.json'),'utf8'));console.log(JSON.stringify({content:row.body,revision:row.revision,deleted:false}));}
else{const m=JSON.parse(await readFile(args[args.indexOf('--mutation')+1].slice(1),'utf8'));await writeFile(join(root,m.documentId+'.json'),JSON.stringify({body:m.content,revision:'migrated'}));await appendFile(join(root,m.documentId+'.writes'),'1');console.log(JSON.stringify({committed:true}));}`);
  const args=[resolve('scripts/investment-reconcile.mjs'),join(root,'source'),join(root,'baseline'),join(root,'config.json'),join(root,'cli.mjs'),join(root,'journal'),'cache_status','--apply','--concurrency','4','--existing-only'];
  await assert.rejects(()=>execute(process.execPath,args));
  const first=JSON.parse(await readFile(join(root,'journal/reconcile.json'),'utf8'));
  assert.deepEqual(Object.keys(first.done).sort(),['cache_status:a','cache_status:c','cache_status:d']);
  await rm(join(root,'fail'));await execute(process.execPath,args);
  for(const row of desired.slice(0,-1)){assert.deepEqual(JSON.parse(await readFile(join(root,row.id+'.json'),'utf8')).body,row);assert.equal(await readFile(join(root,row.id+'.writes'),'utf8'),'1');}
  await assert.rejects(()=>readFile(join(root,'new-bulk-row.json')), {code:'ENOENT'});
  assert.equal(Object.keys(JSON.parse(await readFile(join(root,'journal/reconcile.json'),'utf8')).done).length,6);
  assert.equal((await readdir(join(root,'journal'))).filter(name=>name.startsWith('migration_')).length,0,'acknowledged payloads do not accumulate on disk');
 }finally{await rm(root,{recursive:true,force:true});}
});
