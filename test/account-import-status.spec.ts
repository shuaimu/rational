import { expect, test } from "@playwright/test";

test("a completed import leaves no status across account navigation or separate cloud check", async ({ page }) => {
  await page.goto("/#/accounts");
  await page.getByLabel("Email").fill("account-status@rational.test");
  await page.getByLabel("Password").fill("RationalDemo1!");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => window.rational.state.household?.initialSynced === true);
  await page.evaluate(() => {
    const app = window.rational as unknown as { config: { mode: string }; monarch: unknown };
    app.config.mode = "live";
    Object.assign(window, { accountStatusCalls: 0 });
    app.monarch = {
      list: async () => ({ jobs: [{
        id: "import-complete", state: "complete", processed: 60, rowCount: 60,
        accounts: [{ source: "Checking", accountId: "acc_demo_checking", verified: true }],
      }] }),
      call: async () => {
        const counters = window as unknown as { accountStatusCalls: number };
        counters.accountStatusCalls++;
        throw new Error("The cloud is busy with another request.");
      },
    };
  });
  await page.locator('a[href="#/accounts/acc_demo_checking"]').click();
  await expect(page.getByText("History import complete", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Link bank", exact: true })).toBeEnabled();
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Accounts" }).click();
  await page.locator('a[href="#/accounts/acc_demo_checking"]').click();
  await expect(page.getByText("History import complete", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Checking import readiness…", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { accountStatusCalls: number }).accountStatusCalls)).toBe(0);
  await page.getByRole("button", { name: "Link bank", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".local/account-import-complete.png" });
  await page.getByRole("button", { name: "Link bank", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\/connections\?account=acc_demo_checking$/);
});
