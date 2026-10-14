import 'fake-indexeddb/auto';import {build} from 'esbuild';import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {historicalDigest} from '../../mako/serverless/shared/cache-generation.js';
const root=new URL('../../',import.meta.url),frontend=new URL('frontend/',root),config=JSON.parse(await readFile(new URL('mako/runtime.json',root))),identities=JSON.parse(await readFile(new URL('.local/mako-migration/qualification-identities.json',root)));
class Storage {getItem(k){return this[k]??null;}setItem(k,v){this[k]=String(v);}removeItem(k){delete this[k];}clear(){for(const k of Object.keys(this))delete this[k];}}
const storage=new Storage(),target=new EventTarget();target.localStorage=storage;target.indexedDB=globalThis.indexedDB;
for(const [key,value]of Object.entries({localStorage:storage,window:target,document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},navigator:{onLine:true}}))Object.defineProperty(globalThis,key,{value,configurable:true});
const realFetch=fetch;let offline=false,requests=0,app;
globalThis.fetch=async(...args)=>{if(offline)throw new TypeError('Offline fixture');requests++;return realFetch(...args);};
const output=new URL(`node_modules/.cache/serverless-replication-${process.pid}.mjs`,frontend),report={at:new Date().toISOString(),checks:[]};
const save=()=>writeFile(new URL('.local/mako-serverless/hosted-frontend-replication.json',root),JSON.stringify({...report,requests},null,2)+'\n',{mode:0o600});
async function check(name){report.checks.push(name);await save();console.log('Cloud frontend: '+name);}
async function until(predicate){const deadline=Date.now()+600000;let progress=Date.now();while(!await predicate()){if(app.getSyncStatus().phase==='error')throw new Error(app.getSyncStatus().message);if(Date.now()>deadline)throw new Error('Replication timeout');if(Date.now()-progress>30000){console.log(JSON.stringify({requests,...app.getSyncStatus()}));progress=Date.now();}await new Promise(r=>setTimeout(r,500));}}
try{
 await mkdir(new URL('node_modules/.cache/',frontend),{recursive:true});
 await build({stdin:{contents:"export * from './src/api/auth.ts';export * from './src/api/rxdb.ts';",resolveDir:frontend.pathname},bundle:true,format:'esm',platform:'node',packages:'external',outfile:output.pathname,define:{'import.meta.hot':'undefined','import.meta.env.VITE_API_RUNTIME':'"cloud"'},logLevel:'silent'});
 app=await import(pathToFileURL(output.pathname));await app.initializeAuth();assert.equal(app.getAuthState().status,'signed-out');await app.signIn(identities.owner.email,identities.owner.password);await check('fresh owner sign-in');
 const token=await app.auth.validAccessToken(),headers={'x-mako-key':config.publicProjectKey,authorization:`Bearer ${token}`};
 const statusResponse=await realFetch(`${config.endpoint}/v1/projects/${config.projectId}/environments/${config.environmentId}/collections/cache_status/documents/cache`,{headers});assert.equal(statusResponse.status,200);const cache=(await statusResponse.json()).body;assert.equal(cache.state,'ready');
 await app.startReplication();await until(()=>app.getSyncStatus().readable);await app.waitForCacheGeneration(cache.generation);
 const dataset=await app.getDataset();assert.equal(dataset.historical.length,cache.historicalCount);assert.equal(await historicalDigest(dataset.historical),cache.historicalDigest);
 assert.deepEqual(dataset.prices,cache.latest.map(r=>({symbol:r.symbol,price:r.latest_price,price_date:r.latest_price_date})));report.version=dataset.version;report.cacheGeneration=cache.generation;await check('complete cloud price generation and portfolio replicated');
 await app.closeLocalData();offline=true;navigator.onLine=false;await app.startReplication();const reopened=await app.getDataset();assert.deepEqual(reopened.historical,dataset.historical);assert.equal(reopened.version,dataset.version);await check('offline reopen retains verified prices and portfolio');
 await app.closeLocalData();offline=false;navigator.onLine=true;await app.startReplication();await app.resync();await app.waitForCacheGeneration(cache.generation);await check('reconnect retains the complete generation');
 await app.signOut();assert.equal(app.getSyncStatus().readable,false);assert.equal(app.getAuthState().status,'signed-out');await check('sign-out clears protected views');report.complete=true;
}catch(error){report.failure={name:error.name,message:error.message};console.error(error.message);process.exitCode=1;}
finally{offline=false;navigator.onLine=true;if(app){try{await app.signOut();await app.closeLocalData();}catch{}}await save();await unlink(output).catch(()=>{});}
