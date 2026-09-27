import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
const compiled=await build({entryPoints:[new URL('../src/api/uploads.ts',import.meta.url).pathname],bundle:true,format:'esm',write:false,plugins:[{name:'upload-fixture',setup(build){build.onResolve({filter:/^\.\/(auth|http|jobs)$/},args=>({path:args.path,namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const requireOwnerScope=()=> 'owner';export const onClearProtectedState=()=>{};export class ApiRequestError extends Error{};export class JobFailure extends Error{};export const api={post:(...args)=>globalThis.uploadFixture.post(...args),put:async()=>({data:{}})};`,loader:'js'}));}}]});
let counter=0;const load=()=>import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text+'\n// '+counter++).toString('base64'));
test('reload after background completion reuses the original import identity',async()=>{
 const rows=new Map();globalThis.localStorage={getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v)};
 const identities=[];let interrupted=true;
 globalThis.uploadFixture={post:async(path,body,config)=>{
 if(path==='/uploads')return {data:{id:'u_'+'a'.repeat(64),chunkBytes:256*1024,chunks:1}};
 if(path.endsWith('/seal'))return {data:{}};
 identities.push(config?.headers?.['Idempotency-Key']);
 if(interrupted)throw new Error('page closed after admission');
 return {data:{accounts_created:0,tickers_created:0,transactions_imported:0}};
 }};
 const file=new File(['fixture'],'empty.xlsx');let app=await load();await assert.rejects(app.uploadWorkbook(file),/page closed/);
 // General HTTP command tracking may already be gone after background recovery.
 app=await load();interrupted=false;await app.uploadWorkbook(file);
 assert.equal(identities.length,2);assert.ok(identities[0]);assert.equal(identities[1],identities[0]);
});
