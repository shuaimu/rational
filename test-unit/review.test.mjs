import assert from "node:assert/strict";
import { test } from "node:test";

import { needsReview, reviewCount, reviewQueue } from "../dist/src/selectors/review.js";

const base = { household_id: "hh_test", created_at: 1, updated_at: 1 };

function transaction(id, date, fields = {}) {
  return {
    ...base,
    id,
    account_id: "acc_a",
    date,
    amount: -100,
    currency: "USD",
    description: id,
    tags: [],
    splits: [],
    ...fields,
  };
}

test("only uncategorized bank arrivals or explicit requests need review", () => {
  assert.equal(needsReview(transaction("typed", "2026-08-01")), false, "typed by hand");
  assert.equal(needsReview(transaction("synced", "2026-08-01", { external_id: "e1" })), true);
  assert.equal(
    needsReview(transaction("imported", "2026-08-01", { import_batch_id: "b1" })),
    false,
  );
  assert.equal(
    needsReview(transaction("seen", "2026-08-01", { external_id: "e1", reviewed: true })),
    false,
  );
  assert.equal(needsReview(transaction("blank", "2026-08-01", { external_id: "" })), false);
});

test("the queue is newest first and the count agrees with it", () => {
  const transactions = [
    transaction("a", "2026-08-01", { external_id: "e1" }),
    transaction("b", "2026-08-03", { import_batch_id: "b1", reviewed: false }),
    transaction("c", "2026-08-02", { external_id: "e2", reviewed: true }),
    transaction("d", "2026-08-04"),
  ];
  assert.deepEqual(
    reviewQueue(transactions).map((entry) => entry.id),
    ["b", "a"],
  );
  assert.equal(reviewCount(transactions), 2);
});

test("Monarch blank, Needs Review and Reviewed remain distinct, including after bank linking", () => {
  for (const external_id of [undefined, "linked-bank-id"]) {
    const fields = { import_batch_id: "imp_monarch", external_id };
    assert.equal(needsReview(transaction("neutral", "2026-08-01", fields)), false);
    assert.equal(needsReview(transaction("requested", "2026-08-01", { ...fields, reviewed: false })), true);
    assert.equal(needsReview(transaction("seen", "2026-08-01", { ...fields, reviewed: true })), false);
  }
});

test("explicit manual requests survive categorization and do not need provider IDs", () => {
  assert.equal(needsReview(transaction("manual", "2026-08-01", { category_id: "food", reviewed: false })), true);
  assert.equal(needsReview(transaction("bank", "2026-08-01", { external_id: "bank", category_id: "food" })), false);
  assert.equal(needsReview(transaction("bank", "2026-08-01", { external_id: "bank", reviewed: true })), false);
});

test("uncategorized bank review recognizes named placeholders and unfiled splits", () => {
  const categories = [{ ...base, id: "uncat", kind: "category", name: " Uncategorized " }];
  const bank = { external_id: "bank" };
  assert.equal(needsReview(transaction("named", "2026-08-01", { ...bank, category_id: "uncat" }), categories), true);
  assert.equal(needsReview(transaction("split", "2026-08-01", { ...bank, splits: [{ category_id: "food", amount: -50 }, { amount: -50 }] }), categories), true);
  assert.equal(needsReview(transaction("split", "2026-08-01", { ...bank, splits: [{ category_id: "food", amount: -100 }] }), categories), false);
  assert.equal(needsReview(transaction("adjustment", "2026-08-01", { ...bank, adjustment: true }), categories), false);
  assert.equal(needsReview(transaction("transfer", "2026-08-01", { ...bank, transfer_id: "pair" }), categories), false);
});
