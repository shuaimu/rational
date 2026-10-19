import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserAuthSessionPersistence, MakoAuthClient, normalizeMakoRxdbConfig } from '@mako-cloud/rxdb';
import { retryableRefreshFetch } from '../dist/shared/auth-refresh.js';

const config = normalizeMakoRxdbConfig({ endpoint: 'https://example.invalid', publicProjectKey: 'mako_pk.test.public', projectId: 'prj_fixture0', environmentId: 'env_fixture0', collectionId: 'accounts', schemaVersion: 1, rxdbVersion: '17.4.0', runtime: 'browser' });
const user = { id: 'owner', email: 'owner@example.invalid', status: 'active', authorizationEpoch: 1 };
function storageFixture() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('lost renewal response survives a browser restart two hours later', async () => {
  const storage = storageFixture();
  const persistence = new BrowserAuthSessionPersistence(config, { storage });
  await persistence.save({ accessToken: 'expired', refreshToken: 'original', expiresAtUnixMilliseconds: 0, user });
  let now = 1000, consumed, requests = 0;
  const server = async (_input, init) => {
    requests++;
    const body = JSON.parse(init.body);
    if (!consumed) {
      consumed = body;
      // Cloud committed the rotation, but the response never reached the app.
      throw new TypeError('connection lost');
    }
    assert.deepEqual(body, consumed, 'restart must retry the saved operation');
    assert.match(body.requestId, /^[a-f0-9-]{36}$/);
    return Response.json({ accessToken: 'renewed', refreshToken: 'replacement', expiresIn: 300, user });
  };
  const client = () => new MakoAuthClient(config, { persistence, now: () => now, fetch: retryableRefreshFetch(server, 'retry', storage) });
  await assert.rejects(client().validAccessToken(), error => error.retryable);
  assert.equal((await persistence.load()).refreshToken, 'original');
  now += 2 * 3600_000;
  assert.equal(await client().validAccessToken(), 'renewed');
  assert.equal((await persistence.load()).refreshToken, 'replacement');
  assert.equal(requests, 2);
  assert.ok(!storage.getItem('retry').includes('original'), 'journal stores no refresh credential');
});

test('each replacement credential gets a new operation, while retries keep the same one', async () => {
  const storage = storageFixture(), seen = [];
  const fetch = retryableRefreshFetch(async (_input, init) => { seen.push(JSON.parse(init.body)); return new Response(); }, 'retry', storage);
  const call = token => fetch('https://example.invalid/auth/token', { method: 'POST', body: JSON.stringify({ refreshToken: token }) });
  await call('first'); await call('first'); await call('second');
  assert.equal(seen[0].requestId, seen[1].requestId);
  assert.notEqual(seen[0].requestId, seen[2].requestId);
});

test('storage failures never send a rotation without saving its request identity', async () => {
  const storage = storageFixture(); let requests = 0, attempts = 0;
  const save = storage.setItem;
  storage.setItem = (key, value) => { attempts++; if (attempts <= 2) throw new Error('storage unavailable'); save(key, value); };
  const fetch = retryableRefreshFetch(async () => { requests++; return new Response(); }, 'retry', storage);
  const call = () => fetch('https://example.invalid/auth/token', { method: 'POST', body: JSON.stringify({ refreshToken: 'first' }) });
  await assert.rejects(call(), /storage unavailable/);
  await assert.rejects(call(), /storage unavailable/);
  assert.equal(requests, 0);
  await call(); assert.equal(requests, 1); assert.equal(attempts, 3);
});

test('ordinary requests are unchanged', async () => {
  const init = { method: 'POST', body: '{"example":true}' };
  const fetch = retryableRefreshFetch(async (_input, passed) => { assert.equal(passed, init); return new Response(); }, 'retry', null);
  await fetch('https://example.invalid/auth/signout', init);
});
