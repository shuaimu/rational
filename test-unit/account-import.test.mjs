import assert from "node:assert/strict";
import { test } from "node:test";
import { accountImportStatus } from "../dist/src/selectors/account-import.js";

const job = (state, accountId = "account-a", verified = true) => ({ state, accounts: [{ accountId, verified }] });

test("completed imports leave no account status, including unverified balances", () => {
  assert.deepEqual(accountImportStatus([job("complete")], "account-a"), {
    blocked: false, message: "",
  });
  assert.deepEqual(accountImportStatus([job("complete", "account-a", false)], "account-a"), {
    blocked: false, message: "",
  });
});

test("unfinished or cancelled history blocks linking only for the affected account", () => {
  for (const state of ["validating", "importing", "reconciling", "needs-review", "failed", "cancelled"]) {
    assert.equal(accountImportStatus([job("complete"), job(state)], "account-a").blocked, true);
    assert.equal(accountImportStatus([job(state, "account-b")], "account-a").blocked, false);
  }
});

test("unknown status and unsealed uploads do not block navigation or claim import is running", () => {
  assert.deepEqual(accountImportStatus([], "account-a"), { blocked: false, message: "" });
  assert.deepEqual(accountImportStatus([job("uploading")], "account-a"), { blocked: false, message: "" });
});
