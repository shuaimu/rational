import { expect, test } from "@playwright/test";

test("source balances stay authoritative and historical gaps are explicitly estimated", async ({ page }) => {
  await page.goto("/#/accounts");
  await page.getByLabel("Email").fill("source-balances@rational.test");
  await page.getByLabel("Password").fill("RationalDemo1!");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => window.rational.state.phase === "ready" && window.rational.household?.session);
  await page.evaluate(() => window.rational.waitForSync());
  const dates = await page.evaluate(() => {
    const fake = window.rationalFake!;
    const today = new Date().toISOString().slice(0, 10);
    const before = new Date(Date.parse(today) - 2 * 86400000).toISOString().slice(0, 10);
    const household_id = window.rational.state.currentHouseholdId!;
    const base = { household_id, created_at: Date.now(), updated_at: Date.now() };
    const account = { ...base, id: "balance-fixture", name: "Source checking", type: "checking", currency: "USD", opening_balance: 999999, opening_date: before };
    fake.putRemote("accounts", account);
    fake.putRemote("transactions", { ...base, id: "history-purchase", account_id: account.id, date: today, amount: -2500, currency: "USD", description: "Coffee supplies", tags: [], splits: [] });
    fake.putRemote("account_balance_snapshots", { ...base, id: `abs_${account.id}.${today}`, account_id: account.id, date: today, balance: 50000, currency: "USD", source: "plaid", connection_id: "fixture", observed_at: Date.now() });
    return { today, before };
  });
  await expect(page.locator('tr[data-name="Source checking"]').getByTestId("balance")).toHaveText("$500.00");
  await page.getByRole("link", { name: "Source checking", exact: true }).click();
  await expect(page.getByTestId("account-balance")).toContainText("Reported by Plaid");
  await expect(page.getByTestId("balance-history-source")).toContainText("estimated from transactions");
  const table = page.getByRole("table", { name: "Balance of Source checking over time" });
  await expect(table).toContainText("Estimated from transactions");
  await expect(table).toContainText("Reported by Plaid");
  await expect(table).toContainText("$525.00");
  await expect(table).toContainText("$500.00");
  await expect(page.getByRole("table", { name: "Transactions", exact: true })).not.toContainText("Bank balance reconciliation");
  await page.evaluate(async ({ today }) => {
    await window.rational.writes?.createTransaction({ account_id: "balance-fixture", date: today, amount: -10000, currency: "USD", description: "Later manual purchase" });
  }, dates);
  await expect(page.getByTestId("account-balance").getByTestId("balance")).toHaveText("$500.00");
  await expect(table).toContainText("$625.00");
  await page.reload();
  await expect(page.getByTestId("account-balance").getByTestId("balance")).toHaveText("$500.00");
  await expect(table).toContainText("Reported by Plaid");
});
