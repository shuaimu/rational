import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {MakoAuthClient,normalizeMakoRxdbConfig} from '@mako-cloud/rxdb';
const root=new URL('../../',import.meta.url),config=JSON.parse(await readFile(new URL('mako/runtime.json',root))),owner=JSON.parse(await readFile(new URL('.local/mako-migration/qualification-identities.json',root))).owner;
const dir=new URL('.local/mako-serverless/cutover-20260927/',root),auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}));
try{
const token=(await auth.signInWithPassword(owner.email,owner.password)).accessToken,headers={'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`};
const get=async(collection,id)=>{const response=await fetch(`${config.endpoint}/v1/projects/${config.projectId}/environments/${config.environmentId}/collections/${collection}/documents/${id}`,{headers,signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);return (await response.json()).body;};
const head=await get('portfolio_heads','portfolio'),cache=await get('cache_status','cache');
if(process.argv.includes('--before'))await writeFile(new URL('head-before.json',dir),JSON.stringify(head)+'\n',{mode:0o600,flag:'wx'});
else {const before=JSON.parse(await readFile(new URL('head-before.json',dir)));assert.deepEqual(head.public_root,before.public_root);assert.deepEqual(head.private_root,before.private_root);assert.deepEqual(head.next_ids,before.next_ids);await writeFile(new URL('empty-import-parity.json',dir),JSON.stringify({at:new Date().toISOString(),before:before.sequence,after:head.sequence,financialRootsUnchanged:true,countersUnchanged:true,cacheGeneration:cache.generation,cacheState:cache.state},null,2)+'\n',{mode:0o600});}
console.log(JSON.stringify({version:head.sequence,cacheGeneration:cache.generation,cacheState:cache.state}));
}finally{await auth.signOut().catch(()=>{});}
