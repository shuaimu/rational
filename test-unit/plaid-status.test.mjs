import assert from "node:assert/strict";
import { test } from "node:test";
import { MakoPlaidClient } from "../dist/src/data/plaid.js";

test("old or unrecognized Plaid deployments remain explicitly sandbox-only", async () => {
  for (const environment of [undefined, "sandbox", "typo", "production"]) {
    const client = new MakoPlaidClient({
      url: "https://functions.example.test/institution-sync",
      auth: { client: { validAccessToken: async () => "test-token" } },
      fetch: async () => Response.json({ configured: true, environment }),
    });
    assert.deepEqual(await client.status(), {
      configured: true,
      environment: environment === "production" ? "production" : "sandbox",
    });
  }
});

test("a failed Plaid status request is surfaced instead of claiming the service is unconfigured", async () => {
  const client = new MakoPlaidClient({
    url: "https://functions.example.test/institution-sync",
    auth: { client: { validAccessToken: async () => "test-token" } },
    fetch: async () => { throw new TypeError("offline"); },
  });
  await assert.rejects(client.status(), error => error.code === "unavailable");
});

test("read-only Plaid checks recover when another function request holds the slot", async () => {
  for (const route of ["status", "pending"]) {
    let calls = 0;
    const answer = route === "status" ? { configured: true, environment: "production" } : { links: [] };
    const client = new MakoPlaidClient({
      url: "https://functions.example.test/institution-sync",
      auth: { client: { validAccessToken: async () => "test-token" } },
      fetch: async () => ++calls < 3
        ? Response.json({ code: "concurrency_limited", retryable: true }, { status: 429 })
        : Response.json(answer),
    });
    assert.deepEqual(await (route === "status" ? client.status() : client.pending("hh_test")),
      route === "status" ? answer : []);
    assert.equal(calls, 3);
  }
});

test("busy bank linking writes are not replayed automatically", async () => {
  let calls = 0;
  const client = new MakoPlaidClient({
    url: "https://functions.example.test/institution-sync",
    auth: { client: { validAccessToken: async () => "test-token" } },
    fetch: async () => { calls++; return Response.json({ code: "concurrency_limited" }, { status: 429 }); },
  });
  await assert.rejects(client.exchange({ publicToken: "fake", householdId: "hh_test", institution: "Test" }),
    error => error.status === 429 && /cloud is busy/i.test(error.message));
  assert.equal(calls, 1);
});

test("read-only Plaid retries stop after a bounded number of attempts", async () => {
  let calls = 0;
  const client = new MakoPlaidClient({
    url: "https://functions.example.test/institution-sync",
    auth: { client: { validAccessToken: async () => "test-token" } },
    fetch: async () => { calls++; return Response.json({ code: "concurrency_limited" }, { status: 429 }); },
  });
  await assert.rejects(client.status(), error => error.status === 429 && /retry/i.test(error.message));
  assert.equal(calls, 6);
});
