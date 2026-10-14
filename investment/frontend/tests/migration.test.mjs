import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
const binding=JSON.parse(await readFile(new URL('../../mako/environment-migration.json',import.meta.url),'utf8'));
const result=await build({entryPoints:[new URL('../src/api/migration.ts',import.meta.url).pathname],bundle:true,format:'esm',write:false});
const {migratePendingOperations}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const scope=(side)=>JSON.stringify([side.endpoint,side.projectId,side.environmentId,side.ownerId,1,3,2]);
const old=scope(binding.source),next=scope(binding.destination),fingerprint='a'.repeat(64),uploadHash='b'.repeat(64),id='j_'+'c'.repeat(64),commandId='migration_command_0001';
const key=(prefix,scope)=>'robinlab.'+prefix+'.'+encodeURIComponent(scope);
function storage(){return {getItem(name){return this[name]??null;},setItem(name,value){this[name]=String(value);},removeItem(name){delete this[name];}};}
function seed(s){
 s.setItem(key('commands',old),JSON.stringify({[fingerprint]:{id:commandId,acceptedVersion:12}}));
 s.setItem(key('uploads',old),JSON.stringify({[uploadHash]:{commandId:'upload_stable_command',id:'u_'+'d'.repeat(64),next:3,sealed:true}}));
 s.setItem(key('jobs',old),JSON.stringify([{scope:old,id,kind:'excel',state:'retry',attempt:2,command:{scope:old,fingerprint,id:commandId}}]));
}
test('migration preserves retry, upload and job identities under the verified destination owner',()=>{
 const s=storage();seed(s);s.setItem('robinlab.auth.fixture','credential-not-to-copy');
 migratePendingOperations(s,next);
 assert.deepEqual(JSON.parse(s.getItem(key('commands',next))),{[fingerprint]:{id:commandId,acceptedVersion:12}});
 assert.equal(JSON.parse(s.getItem(key('uploads',next)))[uploadHash].commandId,'upload_stable_command');
 const [job]=JSON.parse(s.getItem(key('jobs',next)));assert.equal(job.scope,next);assert.equal(job.command.scope,next);assert.equal(job.command.id,commandId);assert.equal(job.id,id);
 assert.equal(s.getItem(key('commands',old)),null);assert.equal(s.getItem('robinlab.auth.fixture'),'credential-not-to-copy');
 migratePendingOperations(s,next);assert.equal(JSON.parse(s.getItem(key('jobs',next))).length,1);
});
test('unrelated users cannot adopt the previous owner retry journal',()=>{
 const s=storage();seed(s);migratePendingOperations(s,scope({...binding.destination,ownerId:'usr_other'}));
 assert.ok(s.getItem(key('commands',old)));assert.equal(s.getItem(key('commands',next)),null);
});
test('conflicting pending IDs fail closed and retain all originals',()=>{
 const s=storage();seed(s);s.setItem(key('commands',next),JSON.stringify({[fingerprint]:{id:'different_command_001'}}));
 assert.throws(()=>migratePendingOperations(s,next),/reconciliation/);assert.ok(s.getItem(key('commands',old)));assert.ok(s.getItem(key('uploads',old)));assert.equal(s.getItem(key('uploads',next)),null);
});
test('interrupted local persistence resumes without losing originals or duplicating jobs',()=>{
 const s=storage();seed(s);const write=s.setItem;let n=0;s.setItem=function(key,value){if(++n===2)throw Error('quota');write.call(this,key,value);};
 assert.throws(()=>migratePendingOperations(s,next),/quota/);assert.ok(s.getItem(key('commands',old)));assert.ok(s.getItem(key('jobs',old)));
 s.setItem=write;migratePendingOperations(s,next);assert.equal(JSON.parse(s.getItem(key('jobs',next))).length,1);assert.equal(s.getItem(key('jobs',old)),null);
});
