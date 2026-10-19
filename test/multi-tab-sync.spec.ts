import { expect, test } from "@playwright/test";

test("one leader syncs all tabs, including follower writes and leader handoff", async ({ page, context }) => {
  await page.goto("/#/accounts/acc_demo_checking");
  await page.getByLabel("Email").fill("multi-tab@rational.test");
  await page.getByLabel("Password").fill("RationalDemo1!");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.evaluate(() => window.rational.waitForSync());
  await expect(page.getByRole("heading", { name: "Everyday checking", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.rational.diagnostics().streamConnections)).toBe(2);
  const follower = await context.newPage();
  await follower.goto("/#/accounts/acc_demo_checking");
  await expect(follower.getByRole("heading", { name: "Everyday checking", exact: true })).toBeVisible();
  await follower.waitForFunction(() => window.rational.state.household?.initialSynced);
  expect(await follower.evaluate(() => window.rational.diagnostics().streamConnections)).toBe(0);
  expect(await follower.evaluate(() => window.rational.diagnostics().pullRequests)).toBe(0);
  await follower.evaluate(() => window.rational.writes!.updateAccount("acc_demo_checking", { name: "Edited in follower" }));
  await expect(page.getByRole("heading", { name: "Edited in follower", exact: true })).toBeVisible();
  await follower.evaluate(() => window.rational.waitForSync());
  await expect.poll(() => page.evaluate(() => window.rationalFake!.remoteDocument("accounts", "acc_demo_checking")?.name)).toBe("Edited in follower");
  await follower.reload();
  await expect(follower.getByRole("heading", { name: "Edited in follower", exact: true })).toBeVisible();
  await follower.waitForFunction(() => window.rational.state.household?.initialSynced);
  expect(await follower.evaluate(() => window.rational.diagnostics().streamConnections)).toBe(0);
  await page.evaluate(() => (window.rational as unknown as { refreshLocalReplica(): Promise<void> }).refreshLocalReplica());
  await expect(follower.getByRole("heading", { name: "Edited in follower", exact: true })).toBeVisible();
  await follower.waitForFunction(() => window.rational.state.household?.initialSynced);
  await page.close();
  await expect.poll(() => follower.evaluate(() => window.rational.diagnostics().streamConnections)).toBe(2);
  await follower.evaluate(() => window.rational.waitForSync());
  await follower.evaluate(() => {
    const original = window.rationalFake!.remoteDocument("accounts", "acc_demo_checking")!;
    window.rationalFake!.putRemote("accounts", { ...original, name: "Received after handoff", updated_at: Date.now() + 1000 });
  });
  await expect(follower.getByRole("heading", { name: "Received after handoff", exact: true })).toBeVisible();
  const lastTab = await context.newPage();
  await lastTab.goto("/#/accounts/acc_demo_checking");
  await expect(lastTab.getByRole("heading", { name: "Received after handoff", exact: true })).toBeVisible();
  await follower.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(lastTab.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("access changes reopen the shared replica in follower tabs", async ({ page, context }) => {
  await page.goto("/#/accounts/acc_demo_checking");
  await page.getByLabel("Email").fill("multi-tab-access@rational.test");
  await page.getByLabel("Password").fill("RationalDemo1!");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.evaluate(() => window.rational.waitForSync());
  const follower = await context.newPage();
  await follower.goto("/#/accounts/acc_demo_checking");
  await follower.waitForFunction(() => window.rational.state.household?.initialSynced);
  // Each test window owns a fake server. Give both the same authoritative
  // access change before the leader's live stream announces it.
  await follower.evaluate(async () => {
    const fake = window.rationalFake! as unknown as { fetch: typeof fetch; setRole(email: string, household: string, role: string): void };
    await fake.fetch(`${location.origin}/v1/projects/prj_rational0/environments/env_rational0/auth/signup`, {
      method: "POST", body: JSON.stringify({ email: "multi-tab-access@rational.test", password: "RationalDemo1!" }),
    });
    fake.setRole("multi-tab-access@rational.test", "hh_demo", "editor");
  });
  await page.evaluate(() => window.rationalFake!.setRole("multi-tab-access@rational.test", "hh_demo", "editor"));
  await expect.poll(() => page.evaluate(() => window.rational.state.memberships[0]?.role)).toBe("editor");
  await expect.poll(() => follower.evaluate(() => window.rational.state.memberships[0]?.role)).toBe("editor");
  await follower.waitForFunction(() => window.rational.state.household?.initialSynced);
  await expect(follower.getByRole("heading", { name: "Everyday checking", exact: true })).toBeVisible();
  await follower.evaluate(() => window.rational.writes!.updateAccount("acc_demo_checking", { name: "After access changed" }));
  await expect(page.getByRole("heading", { name: "After access changed", exact: true })).toBeVisible();
  await follower.evaluate(() => window.rational.waitForSync());
  await expect.poll(async () => (await Promise.all([page, follower].map(tab => tab.evaluate(() =>
    window.rationalFake!.remoteDocument("accounts", "acc_demo_checking")?.name)))).includes("After access changed")).toBe(true);
});
