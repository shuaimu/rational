// Large private captures exceed the bulk importer's internal request budget.
// Use short-lived audited explorer grants, without exposing service credentials.
import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {auditedDocuments} from './investment-explorer.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export async function createExact({request,id,body,mutationId}) {
 const result=await request('POST',id,{operation:'create',mutationId,expectedRevision:null,schemaVersion:1,body});
 if(['applied','replayed'].includes(result.status))return;
 assert.equal(result.status,'conflict','unexpected mutation result');
 const current=await request('GET',id);
 assert.ok(current&&!current._deleted&&canonical(current.body)===canonical(body),'destination contains different immutable content');
}
async function main(){
 const [snapshot,configPath,cliPath,journalDirectory,profile='robinlab']=process.argv.slice(2);
 assert.ok(journalDirectory,'Usage: node scripts/investment-large-import.mjs SNAPSHOT TARGET_CONFIG CLI_ENTRY PRIVATE_JOURNAL [PROFILE]');
 const config=JSON.parse(await readFile(configPath,'utf8')),manifest=JSON.parse(await readFile(resolve(snapshot,'manifest.json'),'utf8'));
 assert.equal(manifest.scope.project,config.projectId);assert.equal(manifest.scope.endpoint,config.endpoint);assert.notEqual(manifest.scope.environment,config.environmentId);
 const content=await readFile(resolve(snapshot,'robinlab_inputs.jsonl'));
 assert.equal(hash(content),manifest.collections.robinlab_inputs.sha256);
 const rows=content.toString().split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x));
 assert.equal(rows.length,new Set(rows.map(x=>x.id)).size);assert.equal(rows.length,manifest.collections.robinlab_inputs.count);
 const root=resolve(journalDirectory);await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
 const path=resolve(root,'large-import.json'),scope={endpoint:config.endpoint,project:config.projectId,environment:config.environmentId,snapshot:hash(content)};
 let state;try{state=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(state.scope,scope);}catch(error){if(error.code!=='ENOENT')throw error;state={scope,done:{}};}
 const save=async()=>{const temp=path+'.tmp';await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,path);};await save();
 const request=auditedDocuments({cliPath,config,profile,root,collection:'robinlab_inputs'});
 let imported=0;
 for(let offset=0;offset<rows.length;offset+=4){
  const results=await Promise.allSettled(rows.slice(offset,offset+4).map(async body=>{
   const digest=hash(canonical(body));if(state.done[body.id]){assert.equal(state.done[body.id],digest);return;}
   await createExact({request,id:body.id,body,mutationId:'migration_'+hash(config.environmentId+body.id+digest)});state.done[body.id]=digest;imported++;
  }));await save();
  const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
  if(offset%100===0)console.log('Verified private captures',Math.min(offset+4,rows.length),'/',rows.length);
 }
 console.log(JSON.stringify({verified:rows.length,imported}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
