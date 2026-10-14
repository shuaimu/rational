import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {MakoAuthClient,normalizeMakoRxdbConfig} from '@mako-cloud/rxdb';
const root=new URL('../../',import.meta.url);
const config=JSON.parse(await readFile(new URL('mako/runtime.json',root)));
const identities=JSON.parse(await readFile(new URL('.local/mako-migration/qualification-identities.json',root)));
const auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}));
const report={at:new Date().toISOString(),results:[],stagedIds:[]};
const url=`${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/robinlab-serverless-qualify`;
let token;
const save=()=>writeFile(new URL('.local/mako-serverless/resources.json',root),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function invoke(body) {
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`,'idempotency-key':'resource_qualification_0001'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const result=await response.json();
 assert.ok(response.status===200,`${body.action}: status ${response.status}, type ${result.type??result.error??'unknown'}, upstream ${result.upstreamStatus??''} ${result.upstreamCode??''} ${result.upstreamReason??''} request ${result.upstreamRequestId??''}`);
 return result;
}
try {
 token=(await auth.signInWithPassword(identities.owner.email,identities.owner.password)).accessToken;
 for(const kind of ['representative','maximum']) {
  const result=await invoke({action:'workbook',kind});
  report.results.push({workbook:result.workbook,memoryBytes:result.memoryBytes});await save();
  console.log(`Workbook ${kind}: ${result.workbook.bytes} bytes, ${result.workbook.rows} rows, ${Math.round(result.workbook.milliseconds)} ms`);
 }
 const egress=await invoke({action:'egress'});report.results.push({egress:egress.egress});await save();console.log('Egress:',egress.egress);
 for(let offset=0,total=1;offset<total;offset+=32) {
  const result=await invoke({action:'stage',offset});
  const stage=result.portfolio.staging;total=stage.total;
  report.stagedIds.push(...stage.ids);
  report.results.push({staging:{offset:stage.offset,count:stage.count,total,milliseconds:stage.milliseconds},portfolioMilliseconds:result.portfolio.totalMilliseconds,memoryBytes:result.memoryBytes});
  await save();console.log(`Staging: ${offset+stage.count}/${total}, ${Math.round(stage.milliseconds)} ms`);
 }
 const replay=await invoke({action:'stage',offset:0});assert.equal(replay.portfolio.staging.count,32);report.stagedIds.push(...replay.portfolio.staging.ids);
 report.replay=true;await save();
 // Direct owner access to the private qualification collection must remain denied.
 const denied=await fetch(`${config.endpoint}/v1/projects/${config.projectId}/environments/${config.environmentId}/collections/serverless_qualification_content/documents/${report.stagedIds[0]}`,{headers:{'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`}});
 assert.equal(denied.status,404);report.directOwnerDenied=true;
 for(let offset=0;offset<report.stagedIds.length;offset+=32) await invoke({action:'cleanup',ids:report.stagedIds.slice(offset,offset+32)});
 report.cleaned=true;
 const revoked=token;await auth.signOut();
 const response=await fetch(url,{method:'POST',headers:{'x-mako-key':config.publicProjectKey,authorization:`Bearer ${revoked}`},body:'{}'});
 assert.equal(response.status,401);report.revokedOwnerDenied=true;report.complete=true;
} catch(error) {report.failure={type:error.name,message:error.message};console.error(error.message);process.exitCode=1;}
finally {await save();try {await auth.signOut();} catch {/* private report retains prior failure */}}
