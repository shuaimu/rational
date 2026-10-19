import assert from "node:assert/strict";
import { test } from "node:test";
import { ReconnectLoop, reconnectMessage } from "../dist/src/data/reconnect.js";
import { Transport } from "../dist/src/data/transport.js";

function clock(t) {
  let now = 1000;
  let id = 0;
  const timers = new Map();
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    timers.set(++id, { callback, at: now + delay });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (key) => timers.delete(key));
  return {
    now: () => now,
    timers,
    next() {
      const [key, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      now = timer.at;
      timers.delete(key);
      timer.callback();
    },
  };
}

test("one retry deadline survives repeated failures, backs off and resets on recovery", (t) => {
  const time = clock(t);
  let attempts = 0, deadline = null;
  const retry = new ReconnectLoop(() => { attempts++; }, (at) => { deadline = at; }, time.now);
  retry.setDisconnected(true);
  assert.equal(deadline, 6000);
  retry.setDisconnected(true);
  assert.equal(time.timers.size, 1);
  for (const delay of [10000, 20000, 40000, 60000, 60000]) {
    time.next();
    assert.equal(deadline - time.now(), delay);
    assert.equal(time.timers.size, 1);
  }
  assert.equal(attempts, 5);
  retry.setDisconnected(false);
  assert.equal(deadline, null);
  assert.equal(time.timers.size, 0);
  retry.setDisconnected(true);
  assert.equal(deadline - time.now(), 5000);
  retry.stop();
  assert.equal(time.timers.size, 0);
});

test("network return retries immediately and successful reconnect cancels the countdown", (t) => {
  const time = clock(t);
  let attempts = 0, deadline;
  const retry = new ReconnectLoop(() => {
    attempts++;
    retry.setDisconnected(false);
  }, (at) => { deadline = at; }, time.now);
  retry.setDisconnected(true);
  retry.retryNow();
  assert.equal(attempts, 1);
  assert.equal(deadline, null);
  assert.equal(time.timers.size, 0);
});

test("countdown uses the real deadline, with singular units and no negative values", () => {
  assert.equal(reconnectMessage(6000, 1000), "Offline — trying to reconnect in 5 seconds.");
  assert.equal(reconnectMessage(6000, 5100), "Offline — trying to reconnect in 1 second.");
  assert.equal(reconnectMessage(61000, 1000), "Offline — trying to reconnect in 1 minute.");
  assert.equal(reconnectMessage(1000, 2000), "Offline — reconnecting…");
});

test("transport remains unreachable until a request succeeds; HTTP refusals are not offline", async () => {
  let result = new TypeError("network lost");
  const transport = new Transport(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const url = new URL("https://example.test/replication/pull");
  await assert.rejects(transport.fetch(url));
  assert.equal(transport.reachable, false);
  transport.setOnline(true);
  assert.equal(transport.reachable, false, "enabling requests is not evidence of recovery");
  result = new Response(null, { status: 503 });
  await transport.fetch(url);
  assert.equal(transport.reachable, false);
  result = new Response(null, { status: 200 });
  await transport.fetch(url);
  assert.equal(transport.reachable, true);
  for (const status of [401, 403, 429]) {
    result = new Response(null, { status });
    await transport.fetch(url);
    assert.equal(transport.reachable, true, "auth/rate-limit responses have separate UI");
  }
});

test("intentional cancellation is not a lost network, including live streams", async () => {
  const transport = new Transport(async (_input, init) => {
    throw init.signal.reason ?? new DOMException("Cancelled", "AbortError");
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(transport.fetch(new URL("https://example.test/replication/pull"), { signal: abort.signal }));
  assert.equal(transport.reachable, true);
  const streamTransport = new Transport(async (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
  }));
  const stream = streamTransport.fetch(new URL("https://example.test/replication/stream"));
  streamTransport.disconnectStreams();
  await assert.rejects(stream);
  assert.equal(streamTransport.reachable, true);
});
