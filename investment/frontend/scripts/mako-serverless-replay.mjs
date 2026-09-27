import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {MakoAuthClient,normalizeMakoRxdbConfig} from '@mako-cloud/rxdb';
const root=new URL('../../',import.meta.url),config=JSON.parse(await readFile(new URL('mako/runtime.json',root))),identities=JSON.parse(await readFile(new URL('.local/mako-migration/qualification-identities.json',root)));
const journal=JSON.parse(await readFile(new URL('.local/mako-migration/final-20260925/api-smoke-journal.json',root)));
assert.ok(journal.cleaned&&journal.steps.update_trade);
const auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}));
const url=`${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/robinlab-api`,report={at:new Date().toISOString()};let token;
async function call(path,method='GET',body,key){const headers={'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`};if(key)headers['idempotency-key']=key;if(body)headers['content-type']='application/json';const response=await fetch(url+path,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});return {status:response.status,version:Number(response.headers.get('x-robinlab-version')),data:await response.json()};}
try{
 token=(await auth.signInWithPassword(identities.owner.email,identities.owner.password)).accessToken;
 report.before=(await call('/portfolio/version')).data.version;
 const id=journal.steps.rollback_trade.result.id,key=`smoke_${journal.run}_update_trade`,result=await call(`/transactions/${id}`,'PUT',{fees:0.25},key);
 assert.equal(result.status,200);assert.equal(result.version,journal.steps.update_trade.version);assert.deepEqual(result.data,journal.steps.update_trade.result);report.originalVersion=result.version;
 assert.equal((await call(`/transactions/${id}`,'PUT',{fees:0.26},key)).status,409);report.changedInputDenied=true;
 assert.equal((await call(`/transactions/${id}`)).status,404);report.deletedRowRemainsAbsent=true;
 report.after=(await call('/portfolio/version')).data.version;assert.equal(report.after,report.before);report.complete=true;console.log('Pre-cutover command replay passed; no portfolio publication');
}catch(error){report.failure={type:error.name,message:error.message};console.error(error.message);process.exitCode=1;}
finally{await writeFile(new URL('.local/mako-serverless/hosted-replay.json',root),JSON.stringify(report,null,2)+'\n',{mode:0o600});try{await auth.signOut();}catch{}}
