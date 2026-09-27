import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserAuthSessionPersistence, normalizeMakoRxdbConfig } from '@mako-cloud/rxdb';
import { SharedAuthClient, sessionKey } from '../dist/shared/auth.js';

const config = normalizeMakoRxdbConfig({ endpoint: 'https://example.invalid', publicProjectKey: 'mako_pk.test.public', projectId: 'prj_fixture0', environmentId: 'env_fixture0', collectionId: 'accounts', schemaVersion: 1, rxdbVersion: '17.4.0', runtime: 'browser' });
const user = { id: 'owner', email: 'owner@example.invalid', status: 'active', authorizationEpoch: 1 };
function fixture() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const persistence = new BrowserAuthSessionPersistence(config, { key: sessionKey(config), storage });
  return { persistence, storage };
}
function session(accessToken = 'old', expiresAtUnixMilliseconds = 0) {
  return { accessToken, refreshToken: 'refresh', expiresAtUnixMilliseconds, user };
}

test('both applications retain the existing Rational session key', () => {
  assert.equal(sessionKey(config), 'rational.auth.prj_fixture0.env_fixture0');
});
test('concurrent app refreshes rotate once under the shared browser lock', async () => {
  const { persistence } = fixture();
  await persistence.save(session());
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let queue = Promise.resolve();
  const locks = { request: (_name, action) => { const result = queue.then(action); queue = result.catch(() => {}); return result; } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  try {
    let requests = 0;
    const fetch = async () => {
      requests++;
      return Response.json({ accessToken: 'new', refreshToken: 'rotated', expiresIn: 3600, user });
    };
    const a = new SharedAuthClient(config, { persistence, fetch });
    const b = new SharedAuthClient(config, { persistence, fetch });
    await Promise.all([a.restoreSession(), b.restoreSession()]);
    const sessions = await Promise.all([a.refreshSession(), b.refreshSession()]);
    assert.equal(requests, 1);
    assert.deepEqual(sessions.map(s => s.accessToken), ['new', 'new']);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});
test('another app signing out prevents stale cached-token requests', async () => {
  const { persistence } = fixture();
  await persistence.save(session('still-valid', Date.now() + 3600000));
  const client = new SharedAuthClient(config, { persistence, fetch: async () => { throw new Error('network must not run'); } });
  await client.restoreSession();
  await persistence.clear();
  await assert.rejects(client.validAccessToken(), /sign in|session/i);
  assert.equal(client.accessToken(), null);
});
test('token reads refuse a new identity until the application restores its scope', async () => {
  const { persistence } = fixture();
  await persistence.save(session('old-owner', Date.now() + 3600000));
  const client = new SharedAuthClient(config, { persistence });
  await client.restoreSession();
  await persistence.save({ ...session('other-owner', Date.now() + 3600000), user: { ...user, id: 'other' } });
  await assert.rejects(client.validAccessToken(), /session changed/i);
  await client.restoreSession();
  assert.equal(await client.validAccessToken(), 'other-owner');
  assert.equal(client.currentSession().user.id, 'other');
});
for(const method of ['completeProviderSignIn','redeemMagicLink'])test(`${method} cannot be overwritten by an older in-flight refresh`,async()=>{
 const {persistence}=fixture();await persistence.save(session());
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');let queue=Promise.resolve();
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:(_name,action)=>{const result=queue.then(action);queue=result.catch(()=>{});return result;}}}});
 try{
  let begin,release;const started=new Promise(resolve=>{begin=resolve;}),pause=new Promise(resolve=>{release=resolve;});const calls=[];
  const fetch=async request=>{
   const path=new URL(request instanceof Request?request.url:String(request)).pathname;calls.push(path);
   if(path.endsWith('/token')){begin();await pause;return Response.json({accessToken:'old-user-refreshed',refreshToken:'rotated',expiresIn:3600,user});}
   return Response.json({accessToken:'new-user',refreshToken:'new-refresh',expiresIn:3600,user:{...user,id:'other'}});
  };
  const old=new SharedAuthClient(config,{persistence,fetch}),login=new SharedAuthClient(config,{persistence,fetch});await old.restoreSession();
  const refresh=old.refreshSession();await started;
  const signingIn=login[method](method==='completeProviderSignIn'?'#code=fixture_code':'fixture_magic_token');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);
  release();await Promise.all([refresh,signingIn]);assert.equal((await persistence.load()).user.id,'other');assert.equal((await persistence.load()).accessToken,'new-user');
 }finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;}
});
