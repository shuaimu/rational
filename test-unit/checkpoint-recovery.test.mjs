import assert from "node:assert/strict";
import { test } from "node:test";
import { MakoReplicationError } from "@mako-cloud/rxdb";
import { recoverInvalidCheckpoint } from "../dist/src/data/replication.js";

const invalid = () => new MakoReplicationError({
  code: "invalid_request",
  message: "replication checkpoint or pull request is invalid",
  requestId: "req_test",
  retry: { kind: "never" },
}, 400);

test("a rejected checkpoint requests safe recovery only after a successful initial pull", async () => {
  const calls = [];
  const pull = recoverInvalidCheckpoint(async (checkpoint) => {
    calls.push(checkpoint);
    if (checkpoint) throw invalid();
    return { documents: [], checkpoint: { token: "fresh" } };
  });
  await assert.rejects(pull({ token: "obsolete" }, 100), error => error.code === "checkpoint_expired");
  assert.deepEqual(calls, [{ token: "obsolete" }, undefined]);
});

test("an invalid initial request cannot trigger a reset loop", async () => {
  let calls = 0;
  const pull = recoverInvalidCheckpoint(async () => { calls++; throw invalid(); });
  await assert.rejects(pull(undefined, 100), error => error.code === "invalid_request");
  assert.equal(calls, 1);
  await assert.rejects(pull({ token: "old" }, 100), error => error.code === "invalid_request");
  assert.equal(calls, 3);
});

test("network and policy errors never trigger a replica reset", async () => {
  for (const error of [new TypeError("offline"), new MakoReplicationError({
    code: "permission_denied", message: "denied", requestId: "req_test", retry: { kind: "never" },
  }, 403)]) {
    let calls = 0;
    const pull = recoverInvalidCheckpoint(async () => { calls++; throw error; });
    await assert.rejects(pull({ token: "old" }, 100), candidate => candidate === error);
    assert.equal(calls, 1);
  }
});
