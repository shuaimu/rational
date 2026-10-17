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
