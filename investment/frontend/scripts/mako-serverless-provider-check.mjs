import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {MakoAuthClient,normalizeMakoRxdbConfig} from '@mako-cloud/rxdb';
const root=new URL('../../',import.meta.url),config=JSON.parse(await readFile(new URL('mako/runtime.json',root))),identity=JSON.parse(await readFile(new URL('.local/mako-migration/qualification-identities.json',root))).owner;
const auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}));
const report={at:new Date().toISOString()};
try{const {accessToken}=await auth.signInWithPassword(identity.email,identity.password);
 const response=await fetch(`${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/robinlab-serverless-qualify`,{method:'POST',headers:{'content-type':'application/json','x-mako-key':config.publicProjectKey,authorization:`Bearer ${accessToken}`},body:JSON.stringify({action:'twelvedata'}),signal:AbortSignal.timeout(30000)});
 report.status=response.status;report.result=await response.json();assert.equal(response.status,200);assert.equal(report.result.normalizedQuote,true);report.complete=true;console.log('Live hosted Twelve Data quote normalized successfully');
}catch(error){report.failure={name:error.name,message:error.message};console.error(error.message);process.exitCode=1;}finally{await writeFile(new URL('.local/mako-serverless/twelvedata-egress.json',root),JSON.stringify(report,null,2)+'\n',{mode:0o600});await auth.signOut().catch(()=>{});}
