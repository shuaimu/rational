// Offline parity against the retained cloud dataset. No cloud writes or credentials.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initSync, domain_invoke, parse_workbook } from '../../mako/serverless/generated/robinlab_function_wasm.js';
const root = new URL('../../', import.meta.url);
initSync({module:await readFile(new URL('mako/serverless/generated/robinlab_function_wasm_bg.wasm',root))});
const source=JSON.parse(await readFile(new URL('.local/mako-migration/final-20260925/source.json',root)));
const dataset={public:source.public,private:source.private};
const checks=[];
function sameFinancial(a,b) {
  if(typeof a==='number'&&typeof b==='number') return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8+1e-12*Math.abs(b);
  if(Array.isArray(a)&&Array.isArray(b)) return a.length===b.length&&a.every((v,i)=>sameFinancial(v,b[i]));
  if(a&&b&&typeof a==='object'&&typeof b==='object') return JSON.stringify(Object.keys(a).sort())===JSON.stringify(Object.keys(b).sort())&&Object.keys(a).every(k=>sameFinancial(a[k],b[k]));
  return a===b;
}
function parity(name,input) {
  const payload=JSON.stringify({interfaceVersion:1,...input});
  const native=spawnSync(new URL('target/debug/examples/invoke',root).pathname,[],{input:payload,encoding:'utf8',maxBuffer:128*1024*1024});
  assert.equal(native.status,0,`${name}: native exit`);
  const start=performance.now();
  const wasm=domain_invoke(payload);
  const milliseconds=performance.now()-start;
  const expected=native.stdout.trim();
  const financial=input.action==='read'&&['summary','performance','ticker_pnl','positions','yield','accounts_performance'].includes(input.operation);
  assert.ok(financial ? sameFinancial(JSON.parse(wasm),JSON.parse(expected)) : wasm===expected, `${name}: native/Wasm parity`);
  const parsed=JSON.parse(wasm);
  assert.equal(parsed.ok,true,`${name}: successful result`);
  checks.push({name,milliseconds,sha256:createHash('sha256').update(wasm).digest('hex')});
  return parsed.result;
}
const encoded=parity('full frozen portfolio encoding',{action:'encode',dataset});
parity('authenticated manifest decoding',{action:'decode',...encoded});
const identity=parity('canonical float request identity',{action:'identity',id:'serverless_parity_0001',operation:'create_transaction',input:{price:0.1234567890123456,cost:-1e-12,fees:null,nested:{z:1,a:2}}});
for (const operation of ['accounts','tickers','transactions','summary','performance','ticker_pnl']) parity(operation,{action:'read',operation,dataset,input:{limit:7,offset:3,account_id:null}});
for (const operation of ['positions','yield','accounts_performance']) parity(operation,{action:'read',operation,dataset,input:{account_id:null,include_closed:true,today:'2026-09-26',latest:[],historical:[]}});
const previous={head:{id:'portfolio',format:1,sequence:26,public_root:encoded.public.root,private_root:encoded.private.root,command:{id:'c_'+'0'.repeat(64),bytes:1},next_ids:source.nextIds},revision:'parity_revision'};
parity('prepare account and immutable command',{action:'prepare',operation:'create_account',input:{code:'__SERVERLESS_PARITY_ONLY__',name:null,account_type:null},now:'2026-09-26 00:00:00',identity,dataset,nextIds:source.nextIds,previous});
const report={at:new Date().toISOString(),checks,publicDocuments:encoded.public.documents.length,privateDocuments:encoded.private.documents.length,publicRoot:encoded.public.root,privateRoot:encoded.private.root,workbookExport:typeof parse_workbook};
await writeFile(new URL('.local/mako-serverless/domain-parity.json',root),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({checks:checks.length,publicDocuments:report.publicDocuments,privateDocuments:report.privateDocuments,totalMilliseconds:checks.reduce((n,c)=>n+c.milliseconds,0)}));
