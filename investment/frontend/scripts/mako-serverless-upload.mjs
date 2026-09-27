import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {MakoAuthClient,normalizeMakoRxdbConfig} from '@mako-cloud/rxdb';
import {maximumWorkbook} from '../../mako/serverless/qualification/workbooks.js';
import {sha256} from '../../mako/serverless/shared/errors.js';
const root=new URL('../../',import.meta.url);
const config=JSON.parse(await readFile(new URL('mako/runtime.json',root)));
const identities=JSON.parse(await readFile(new URL('.local/mako-migration/qualification-identities.json',root)));
const auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}));
const report={at:new Date().toISOString(),commandId:`qa_upload_${crypto.randomUUID().replaceAll('-','')}`};
const url=`${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/robinlab-serverless-qualify`;
let token;
const save=()=>writeFile(new URL('.local/mako-serverless/upload-report.json',root),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function invoke(body,status=200) {
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const text=await response.text();assert.ok(text,`${body.action}: empty HTTP ${response.status}`);const result=JSON.parse(text);
 assert.equal(response.status,status,`${body.action}: ${response.status} ${result.type??result.error??''} ${result.upstreamCode??''}`);return result;
}
try {
 token=(await auth.signInWithPassword(identities.owner.email,identities.owner.password)).accessToken;
 const bytes=maximumWorkbook();assert.equal(bytes.length,50*1024*1024);
 const input={action:'uploadAdmit',commandId:report.commandId,bytes:bytes.length,digest:await sha256(bytes)};
 const admitted=(await invoke(input)).root;report.root=admitted;await save();
 const chunk=index=>({action:'uploadChunk',id:admitted.id,index,payload:Buffer.from(bytes.subarray(index*admitted.chunkBytes,Math.min((index+1)*admitted.chunkBytes,bytes.length))).toString('base64')});
 await invoke(chunk(0));await invoke({action:'uploadSeal',id:admitted.id},409);report.interruptionRejected=true;
 const changed=chunk(0);changed.payload=Buffer.alloc(admitted.chunkBytes,1).toString('base64');await invoke(changed,409);report.changedChunkRejected=true;
 await invoke({...input,digest:'a'.repeat(64)},409);report.changedIdentityRejected=true;
 await invoke(chunk(0));report.sameChunkReplayed=true;await save();
 for(let offset=1;offset<admitted.chunks;offset+=2) {
  const settled=await Promise.allSettled(Array.from({length:Math.min(2,admitted.chunks-offset)},(_,i)=>invoke(chunk(offset+i))));
  const failed=settled.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  report.uploaded=Math.min(offset+2,admitted.chunks);await save();if(offset%20===1)console.log(`Uploaded ${report.uploaded}/${admitted.chunks} chunks`);
 }
 report.seal=await invoke({action:'uploadSeal',id:admitted.id});assert.equal(report.seal.bytes,bytes.length);assert.equal(report.seal.rows,2);assert.equal(report.seal.sealed,true);await save();console.log('Sealed:',report.seal);
 report.replay=await invoke({action:'uploadSeal',id:admitted.id});assert.equal(report.replay.rows,2);
 const denied=await fetch(`${config.endpoint}/v1/projects/${config.projectId}/environments/${config.environmentId}/collections/serverless_qualification_uploads/documents/${admitted.id}`,{headers:{'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`}});assert.equal(denied.status,404);report.directOwnerDenied=true;
 for(let offset=0;offset<admitted.chunks;offset+=16)await invoke({action:'uploadCleanup',id:admitted.id,offset});
 await invoke({action:'uploadCleanup',id:admitted.id,offset:admitted.chunks});report.cleaned=true;report.complete=true;
} catch(error){report.failure={type:error.name,message:error.message};console.error(error.message);process.exitCode=1;}
finally {await save();try{await auth.signOut();}catch{}}
