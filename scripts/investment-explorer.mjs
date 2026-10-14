// Audited administrative transport; credentials remain in the CLI profile.
import {writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export function auditedDocuments({cliPath,config,profile='robinlab',root,collection}){
 const flags=['--project',config.projectId,'--env',config.environmentId,'--endpoint',config.endpoint,'--profile',profile,'--json','--reason','Verified Rational Investment environment migration'];
 const request=async(method,id,body)=>{
  let words,input;
  if(method==='POST'){
   input=resolve(root,body.mutationId+'.json');
   // Explorer validates deletes against the existing schema-valid body too.
   await writeFile(input,JSON.stringify({kind:body.operation,documentId:id,schemaVersion:body.schemaVersion,expectedRevision:body.expectedRevision,idempotencyKey:body.mutationId,content:body.body}),{mode:0o600});
   words=['explorer','mutate',collection,'--mutation','@'+input,'--yes'];
  }else words=['explorer','get',collection,id];
  for(let attempt=0;attempt<8;attempt++){
   try{
    const {stdout}=await execute('node',[cliPath,...words,...flags],{maxBuffer:2*1024*1024,timeout:40000});
    const result=JSON.parse(stdout);
    // The server audit and reconciliation journal retain the operation identity.
    // Retire acknowledged request payloads so migration does not duplicate GBs.
    if(input)await rm(input,{force:true});
    return method==='POST'?{status:result.committed?'applied':'conflict'}:{body:result.content,_deleted:result.deleted,revision:result.revision};
   }catch(error){
    const message=String(error.stderr??'');
    if(method==='POST'&&message.includes('CLI_MUTATION_NOT_COMMITTED')){await rm(input,{force:true});return {status:'conflict'};}
    if(method==='GET'&&/error not_found:/.test(message))return null;
    await writeFile(resolve(root,'last-error.log'),message,{mode:0o600});
    if(!/rate_limit|unavailable|timeout|429|503|502/i.test(message)||attempt===7)throw Error('Audited document request failed; no overwrite attempted. Renew CLI authentication if expired.');
    await new Promise(resolve=>setTimeout(resolve,Math.min(60000,1000*2**attempt)));
   }
  }throw Error('Document retries exhausted');
 };
 return request;
}
