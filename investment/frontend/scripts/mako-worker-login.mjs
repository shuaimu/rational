// One-time provisioning helper. Runtime only uses the renewable session file.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { MakoAuthClient, MemoryAuthSessionPersistence, normalizeMakoRxdbConfig } from '@mako-cloud/rxdb';
const [identityPath,outputPath]=process.argv.slice(2);
if(!identityPath||!outputPath) throw new Error('Usage: mako-worker-login.mjs PRIVATE_IDENTITIES NEW_SESSION_FILE');
const config=JSON.parse(await readFile(new URL('../../mako/runtime.json',import.meta.url),'utf8'));
if((await stat(identityPath)).mode&0o077) throw new Error('Identity file must be private.');
const identity=JSON.parse(await readFile(identityPath,'utf8')).worker;
const output=resolve(outputPath);await mkdir(dirname(output),{mode:0o700,recursive:true});
if((await stat(dirname(output))).mode&0o077) throw new Error('Session directory must be private.');
const persistence=new MemoryAuthSessionPersistence();
const auth=new MakoAuthClient(normalizeMakoRxdbConfig({...config,collectionId:'portfolio_heads',schemaVersion:1,rxdbVersion:'17.4.0',runtime:'node'}),{persistence,fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(20000)})});
await auth.signInWithPassword(identity.email,identity.password);
const session=await persistence.load();
if(session.user.id!==config.workerId||session.user.status!=='active') throw new Error('Worker identity mismatch.');
await writeFile(output,JSON.stringify({format:1,endpoint:config.endpoint,projectId:config.projectId,environmentId:config.environmentId,expiresAt:Math.floor(session.expiresAtUnixMilliseconds/1000),revoked:false,session:{accessToken:session.accessToken,refreshToken:session.refreshToken,expiresIn:Math.floor((session.expiresAtUnixMilliseconds-Date.now())/1000),user:session.user}})+'\n',{mode:0o600,flag:'wx'});
console.log('Protected worker session initialized.');
