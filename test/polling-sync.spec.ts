import { expect, test } from "@playwright/test";

test("polling sync loads cached accounts on refresh and receives remote edits without streams", async ({ page }) => {
  await page.addInitScript(() => { window.__RATIONAL__ = { liveStreams: false }; });
  await page.goto("/#/accounts/acc_demo_checking");
  await page.getByLabel("Email").fill("polling@rational.test");
  await page.getByLabel("Password").fill("RationalDemo1!");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Everyday checking", exact: true })).toBeVisible();
  await page.evaluate(() => window.rational.waitForSync());
  expect(await page.evaluate(() => window.rational.diagnostics().streamConnections)).toBe(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Everyday checking", exact: true })).toBeVisible();
  await page.evaluate(() => window.rational.waitForSync());
  await page.evaluate(() => {
    const original = window.rationalFake!.remoteDocument("accounts", "acc_demo_checking")!;
    window.rationalFake!.putRemote("accounts", {
      ...original, name: "Updated on another device", updated_at: original.updated_at + 1000,
    });
  });
  // No reSync call: the existing background poll must discover this change.
  await expect(page.getByRole("heading", { name: "Updated on another device", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.rational.diagnostics().streamConnections)).toBe(0);
});
