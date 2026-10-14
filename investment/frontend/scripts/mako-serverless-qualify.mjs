import { readFile, writeFile } from 'node:fs/promises';
import { MakoAuthClient, normalizeMakoRxdbConfig } from '@mako-cloud/rxdb';
const runtime = JSON.parse(await readFile(new URL('../../mako/runtime.json', import.meta.url)));
const identities = JSON.parse(await readFile(new URL('../../.local/mako-migration/qualification-identities.json', import.meta.url)));
const config = normalizeMakoRxdbConfig({...runtime, collectionId:'portfolio_heads', schemaVersion:1, rxdbVersion:'17.4.0', runtime:'node'});
const url = `${runtime.endpoint}/${runtime.projectId}--${runtime.environmentId}/functions/v1/robinlab-serverless-qualify`;
const report = { at:new Date().toISOString(), results:[] };
for (const role of ['anonymous', 'foreign', 'worker', 'owner']) {
  const auth = new MakoAuthClient(config);
  try {
    const session = role === 'anonymous' ? null : await auth.signInWithPassword(identities[role].email, identities[role].password);
    const started = performance.now();
    const response = await fetch(url, {method:'POST', headers:{'idempotency-key':'qualification_command_0001','x-mako-schedule-id':'spoofed_qualification','content-type':'application/json', 'x-mako-key':runtime.publicProjectKey, origin:'http://localhost:5173', ...(session ? {authorization:`Bearer ${session.accessToken}`} : {})}, body:JSON.stringify({action:process.argv.includes('--portfolio')?'portfolio':'runtime'}),signal:AbortSignal.timeout(30000)});
    const body = await response.json();
    report.results.push({role,status:response.status,milliseconds:Math.round(performance.now()-started),body,allowOrigin:response.headers.get('access-control-allow-origin'),exposeHeaders:response.headers.get('access-control-expose-headers')});
  } catch (error) {report.results.push({role,error:error.name});}
  finally {try {await auth.signOut();} catch { /* preserve primary result */ }}
}
const preflight = await fetch(url,{method:'OPTIONS',headers:{origin:'http://localhost:5173','access-control-request-method':'POST','access-control-request-headers':'authorization,content-type,x-mako-key,idempotency-key'},signal:AbortSignal.timeout(30000)});
report.preflight={status:preflight.status,allowOrigin:preflight.headers.get('access-control-allow-origin'),allowHeaders:preflight.headers.get('access-control-allow-headers')};
await writeFile(new URL('../../.local/mako-serverless/hosted-runtime.json', import.meta.url),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report,null,2));
