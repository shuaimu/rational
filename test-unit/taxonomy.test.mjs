import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTaxonomyDocuments } from "../scripts/default-taxonomy.mjs";
import { importedTaxonomyPlan, taxonomyTree } from "../dist/src/selectors/taxonomy.js";
import { suggestedGroup } from "../functions/shared/taxonomy.ts";
import { cashFlowSummary, spendingBy } from "../dist/src/selectors/cashflow.js";
const base = { household_id: "home", created_at: 1, updated_at: 1 };
const category = (id, name, kind = "expense", extra = {}) => ({ ...base, kind: "category", id, name, ...(kind === "custom" ? {} : { category_kind: kind }), ...extra });
const apply = (entries, plan) => [...entries.map(entry => {
  const patch = plan.updates.find(patch => patch.id === entry.id);
  return { ...entry, ...patch, ...(plan.archived.includes(entry.id) ? { archived: true, updated_at: 2 } : {}) };
}), ...plan.created];
test("import grouping is idempotent and never changes IDs, custom types or user choices", () => {
  const originals = [category("tax_m_food", "GROCERIES"), category("tax_m_buy", "Buy", "custom"), category("tax_m_sell", "Sell", "custom"), category("tax_m_unknown", "Family hobby"), category("tax_m_moved", "Rent", "expense", { parent_id: "own" }), category("tax_m_loose", "Phone", "expense", { sort_order: 1000 })];
  const plan = importedTaxonomyPlan(originals, "home", 2, new Set());
  assert.equal(plan.created.length, 3);
  const after = apply(originals, plan);
  assert.equal(after.find(entry => entry.id === "tax_m_food").parent_id, "grp_home.food_and_dining");
  assert.equal(after.find(entry => entry.id === "tax_m_unknown").parent_id, "grp_home.other");
  for (const name of ["buy", "sell"]) { const c = after.find(entry => entry.id === `tax_m_${name}`); assert.equal(c.parent_id, "grp_home.custom"); assert.equal(c.category_kind, undefined); }
  assert.deepEqual(importedTaxonomyPlan(after, "home", 3, new Set()), { created: [], updates: [], archived: [] });
  assert.equal(suggestedGroup("Groceries", "income"), "Income");
  assert.equal(suggestedGroup("Buy", "transfer"), "Transfers");
});
test("only untouched and unreferenced same-type starter duplicates are archived", () => {
  const seeds = defaultTaxonomyDocuments("home", 1);
  const imported = [category("tax_m_food", "Groceries"), category("tax_m_rent", "Rent"), category("tax_m_gas", "Gas"), category("tax_m_phone", "Phone", "income")];
  const entries = seeds.map(entry => entry.name === "Gas" ? { ...entry, updated_at: 10 } : entry).concat(imported);
  const plan = importedTaxonomyPlan(entries, "home", 20, new Set(["cat_home.rent"]));
  assert.deepEqual(plan.archived, ["cat_home.groceries"]);
  assert.equal(plan.created.length, 0);
  assert.equal(plan.updates.find(entry => entry.id === "tax_m_food").icon, "🛒");
});
test("repair does not overwrite a standard group whose type was changed", () => {
  const entries = [{ ...base, id: "grp_home.food_and_dining", kind: "group", name: "Salary", category_kind: "income" }, category("tax_m_food", "Groceries")];
  const plan = importedTaxonomyPlan(entries, "home", 2, new Set());
  assert.equal(plan.created[0].id, "grp_home.food_and_dining_import_expense");
  assert.equal(plan.updates[0].parent_id, plan.created[0].id);
});
test("regrouping preserves full cash flow and sums split spending into groups", () => {
  const entries = [category("tax_m_food", "Groceries"), category("tax_m_rent", "Rent"), category("tax_m_buy", "Buy", "custom"), category("tax_m_pay", "Paychecks", "income")];
  const tx = (id, amount, category_id, splits = []) => ({ ...base, id, account_id: "account", currency: "USD", date: "2026-10-01", description: "Test", amount, category_id, splits, tags: [] });
  const transactions = [tx("pay", 20000, "tax_m_pay"), tx("buy", -50000, "tax_m_buy"), tx("split", -9000, undefined, [{ id: "s1", category_id: "tax_m_food", amount: -1000 }, { id: "s2", category_id: "tax_m_rent", amount: -8000 }])];
  const after = apply(entries, importedTaxonomyPlan(entries, "home", 2, new Set()));
  assert.deepEqual(cashFlowSummary(transactions, after, null), cashFlowSummary(transactions, entries, null));
  const grouped = spendingBy(transactions, null, "group", { categories: after, groups: after, tags: [], merchants: [] });
  assert.deepEqual(grouped.map(slice => [slice.name, slice.amount]).sort(), [["Food & Dining", 1000], ["Housing", 8000]]);
  assert.deepEqual(taxonomyTree(after).map(section => section.type), ["income", "expense", "expense", "custom"]);
});
