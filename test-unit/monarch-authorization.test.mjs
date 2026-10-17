import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// Exercise the real HTTP router with the runtime's verified-user and storage boundaries stubbed.
const compiled = await build({ entryPoints:['functions/institution-sync/index.ts'], bundle:true, write:false,
  format:'esm', platform:'node', plugins:[{name:'runtime-boundary',setup(builder){
    builder.onResolve({filter:/^@mako-cloud\/edge-sdk$/},()=>({path:'sdk',namespace:'stub'}));
    builder.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:`
      export function createFunctionClientFromRequest({request}) { return {auth:{async getUser(){
        if(request.headers.get('authorization') !== 'Bearer verified') throw Error('invalid caller');
        return {id:'user'};
      }}}; }
      export function createServiceClient(){ return {documents(){return {async query(){return {documents:[],cursor:null};}}}};}
    `,loader:'js'}));
  }}]});
const handler=(await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'))).default;
globalThis.Deno={env:{get:()=> 'test'}};
function request(route,role,body={},authenticated=true){
 const claims=Buffer.from(JSON.stringify({trusted_claims:{households:{home:role}}})).toString('base64url');
 return new Request('https://function.test/monarch/'+route,{method:'POST',headers:{
  authorization:authenticated?'Bearer verified':'Bearer invalid','x-mako-caller-authorization':`header.${claims}.signature`,
  'content-type':'application/json'},body:JSON.stringify({version:1,householdId:'home',...body})});
}
test('Monarch routes require verified authentication even with forged owner claims',async()=>{
 assert.equal((await handler.fetch(request('list','owner',{},false))).status,401);
});
test('read-only members cannot admit, upload, advance, cancel, or resolve imports',async()=>{
 for(const route of ['start','upload','seal','advance','cancel','resume','resolve','keep-source'])
  assert.equal((await handler.fetch(request(route,'viewer'))).status,403,route);
 assert.equal((await handler.fetch(request('list','viewer'))).status,200);
 assert.equal((await handler.fetch(request('list','owner',{householdId:'other'}))).status,403);
});
test('old clients and oversized uploads fail before importer admission',async()=>{
 assert.equal((await handler.fetch(request('start','owner',{version:0}))).status,409);
 assert.equal((await handler.fetch(request('upload','owner',{padding:'x'.repeat(300001)}))).status,413);
});
