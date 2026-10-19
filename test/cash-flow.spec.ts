import { expect, type Page, test } from "@playwright/test";

/**
 * The cash-flow page, over a household this test seeds itself.
 *
 * The fake joins every sign-up to the demo household so the screens have
 * data; `joinDemoOnSignup = false` gives this account an empty space of its
 * own instead, so every figure asserted here traces to a document the test
 * wrote. The quarter is a past one -- Q2 2025 -- so the "last month" part of
 * the test, which is relative to the real clock, can never land in it.
 */
const EMAIL = "flow@rational.test";
const PASSWORD = "RationalDemo1!";
const QUARTER = "2025-Q2";

/** `2026-08` for a run in September 2026: the previous calendar month. */
function lastMonthKey(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
}

async function signUpIntoOwnSpace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const off = () => {
      if (window.rationalFake !== undefined) window.rationalFake.joinDemoOnSignup = false;
      else setTimeout(off, 0);
    };
    off();
  });
  await page.goto("/");
  await page.waitForFunction(() => window.rational !== undefined);
  await page.waitForFunction(() => window.rational.state.phase !== "starting");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => window.rational.state.phase === "ready");
  await page.waitForFunction(
    () => window.rational.state.directory?.initialSynced === true,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () =>
      window.rational.state.household?.initialSynced === true && window.rational.writes !== null,
    undefined,
    { timeout: 30_000 },
  );
}

/**
 * The writes this test makes beyond what `test-support/browser-globals.d.ts`
 * declares: groups, tags, a transfer pairing, and a tracked-asset update. The
 * application object has them; only the test-side declaration lags.
 */
interface CashFlowWrites extends RationalWritesWire {
  createGroup(name: string, kind: string): Promise<RationalDocumentWire>;
  createCategory(
    name: string,
    kind: string,
    options?: Record<string, unknown>,
  ): Promise<RationalDocumentWire>;
  createTag(name: string): Promise<RationalDocumentWire>;
  pairTransfer(outflowId: string, inflowId: string): Promise<string>;
  updateTrackedBalance(
    accountId: string,
    newBalance: number,
    date: string,
  ): Promise<RationalDocumentWire | null>;
}

interface Seeded {
  readonly checking: string;
  readonly savings: string;
  readonly house: string;
  readonly housing: string;
  readonly food: string;
  readonly rent: string;
  readonly groceries: string;
}

/**
 * A quarter of ordinary money -- three paychecks, three rents, three grocery
 * runs -- and the three things that must not count: a paired transfer to
 * savings, a hidden reimbursement, and a revaluation of the house. Then one
 * paycheck and one grocery run in last month, for the range picker.
 */
async function seed(page: Page): Promise<Seeded> {
  return page.evaluate(async (lastMonth) => {
    const writes = window.rational.writes as CashFlowWrites | null;
    if (writes === null) throw new Error("no household is open");
    const account = (name: string, type: "checking" | "savings" | "real_estate", opening: number) =>
      writes.createAccount({
        name,
        type,
        currency: "USD",
        opening_balance: opening,
        opening_date: "2025-01-01",
      });
    const checking = await account("Checking", "checking", 100_000);
    const savings = await account("Savings", "savings", 500_000);
    const house = await account("House", "real_estate", 30_000_000);
    const income = await writes.createGroup("Wages", "income");
    const housing = await writes.createGroup("Home", "expense");
    const food = await writes.createGroup("Food", "expense");
    const paychecks = await writes.createCategory("Paychecks", "income", { groupId: income.id });
    const rent = await writes.createCategory("Rent", "expense", { groupId: housing.id });
    const groceries = await writes.createCategory("Groceries", "expense", { groupId: food.id });
    const transferCategory = await writes.createCategory("Transfer", "transfer");
    const cardPaymentCategory = await writes.createCategory("Credit Card Payment", "transfer");
    const buyCategory = await writes.createCategory("Buy", "expense");
    const sellCategory = await writes.createCategory("Sell", "income");
    const shared = await writes.createTag("shared");
    const book = (
      accountId: string,
      date: string,
      amount: number,
      description: string,
      extra: { category_id?: string; tags?: string[]; hidden?: boolean } = {},
    ) =>
      writes.createTransaction({
        account_id: accountId,
        date,
        amount,
        currency: "USD",
        description,
        tags: extra.tags ?? [],
        splits: [],
        ...(extra.category_id === undefined ? {} : { category_id: extra.category_id }),
        ...(extra.hidden === true ? { hidden: true } : {}),
      });
    for (const month of ["2025-04", "2025-05", "2025-06"]) {
      await book(checking.id, `${month}-01`, 400_000, "ACME payroll", {
        category_id: paychecks.id,
      });
      await book(checking.id, `${month}-02`, -150_000, "Rent", { category_id: rent.id });
      await book(checking.id, `${month}-12`, -30_000, "Corner Grocer", {
        category_id: groceries.id,
        tags: month === "2025-05" ? [shared.id] : [],
      });
    }
    // The three that must appear nowhere: a transfer (paired, so both legs
    // leave cash flow), a hidden inflow, and a balance update of the house.
    const out = await book(checking.id, "2025-05-15", -50_000, "Transfer to savings");
    const into = await book(savings.id, "2025-05-15", 50_000, "Transfer from checking");
    await writes.pairTransfer(out.id, into.id);
    await book(checking.id, "2025-05-20", 9_999, "Venmo reimbursement", { hidden: true });
    await writes.updateTrackedBalance(house.id, 31_000_000, "2025-05-25");
    // CSV imports carry the transfer category without a paired transfer_id.
    await book(checking.id, "2025-05-16", 150_000_000, "Imported transfer in", { category_id: transferCategory.id });
    await book(checking.id, "2025-05-17", -140_000_000, "Imported transfer out", { category_id: transferCategory.id });
    await book(checking.id, "2025-05-18", 20_000_000, "Imported card payment in", { category_id: cardPaymentCategory.id });
    await book(checking.id, "2025-05-19", -30_000_000, "Imported card payment out", { category_id: cardPaymentCategory.id });
    await book(checking.id, "2025-05-20", -50_000_000, "Imported Buy", { category_id: buyCategory.id });
    await book(checking.id, "2025-05-21", 70_000_000, "Imported Sell", { category_id: sellCategory.id });
    // Last month, for period navigation: one paycheck and one grocery run.
    await book(checking.id, `${lastMonth}-03`, 10_000, "ACME payroll", {
      category_id: paychecks.id,
    });
    await book(checking.id, `${lastMonth}-10`, -2_500, "Corner Grocer", {
      category_id: groceries.id,
    });
    return {
      checking: checking.id,
      savings: savings.id,
      house: house.id,
      housing: housing.id,
      food: food.id,
      rent: rent.id,
      groceries: groceries.id,
    };
  }, lastMonthKey());
}

test("a quarter's tiles count only the ordinary transactions", async ({ page }) => {
  await signUpIntoOwnSpace(page);
  const ids = await seed(page);
  await page.goto(`/#/cash-flow?range=${QUARTER}`);

  await expect(page.getByTestId("range-label")).toHaveText("Q2 2025");
  const tiles = page.getByTestId("cash-flow-summary-USD");
  // 3 × 4,000 in; 3 × 1,500 rent and 3 × 300 groceries out.
  await expect(tiles.getByTestId("income")).toHaveText("$12,000.00");
  await expect(tiles.getByTestId("spending")).toHaveText("$5,400.00");
  await expect(tiles.getByTestId("savings")).toHaveText("$6,600.00");
  await expect(tiles.getByTestId("savings-rate")).toHaveText("55%");

  // The transfer legs carry no category, so had they counted they would be
  // an "Uncategorized" row; the hidden inflow and the balance update would
  // have inflated income. None of them is anywhere.
  const categories = page.getByTestId("breakdown-table-category");
  await expect(categories.getByTestId("category-uncategorized")).toHaveCount(0);
  await expect(categories.getByTestId(`category-${ids.rent}`).getByTestId("amount")).toHaveText(
    "$4,500.00",
  );
  await expect(
    categories.getByTestId(`category-${ids.groceries}`).getByTestId("amount"),
  ).toHaveText("$900.00");

  await page.getByTestId("breakdown-account").click();
  const accounts = page.getByTestId("breakdown-table-account");
  await expect(accounts.getByTestId(`account-${ids.checking}`)).toBeVisible();
  await expect(accounts.getByTestId(`account-${ids.savings}`)).toHaveCount(0);
  await expect(accounts.getByTestId(`account-${ids.house}`)).toHaveCount(0);

  await page.getByTestId("breakdown-merchant").click();
  const merchants = page.getByTestId("breakdown-table-merchant");
  await expect(merchants).not.toContainText("Transfer");
  await expect(merchants).not.toContainText("Venmo");
  await expect(merchants).not.toContainText("Balance update");
  await expect(merchants.getByTestId("total")).toHaveText("$5,400.00");

  await expect(page.getByTestId("exclusions-note")).toContainText("balance updates");
  await expect(page.getByTestId("exclusions-note")).toContainText("without a linked transfer pair");
});

test("the flow conserves: groups and categories both total the spending tile", async ({ page }) => {
  await signUpIntoOwnSpace(page);
  const ids = await seed(page);
  await page.goto(`/#/cash-flow?range=${QUARTER}`);

  const tiles = page.getByTestId("cash-flow-summary-USD");
  await expect(tiles.getByTestId("spending")).toHaveText("$5,400.00");
  await expect(page.getByRole("img", { name: "Where the money went" })).toBeVisible();

  // Groups is the default tab; its rows and its total are the Sankey's middle column.
  const groups = page.getByTestId("breakdown-table-group");
  await expect(groups.getByTestId(`group-${ids.housing}`).getByTestId("amount")).toHaveText(
    "$4,500.00",
  );
  await expect(groups.getByTestId(`group-${ids.food}`).getByTestId("amount")).toHaveText("$900.00");
  await expect(groups.getByTestId("total")).toHaveText("$5,400.00");
  // The categories are the right column, and they total the same.
  await expect(page.getByTestId("breakdown-table-category").getByTestId("total")).toHaveText(
    "$5,400.00",
  );

  // Tags overlap by design and say so; only one grocery run was tagged.
  await page.getByTestId("breakdown-tag").click();
  await expect(page.getByTestId("breakdown-table-tag").getByTestId("total")).toHaveText("$300.00");
  await expect(page.getByRole("tabpanel")).toContainText("need not add up");

  // The breakdown export is the table as a file.
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export breakdown CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`spending-by-tag-${QUARTER}.csv`);
});

test("the range picker moves the address and the tiles", async ({ page }) => {
  await signUpIntoOwnSpace(page);
  await seed(page);
  await page.goto(`/#/cash-flow?range=${QUARTER}`);
  const tiles = page.getByTestId("cash-flow-summary-USD");
  await expect(tiles.getByTestId("income")).toHaveText("$12,000.00");

  await page.getByRole("button", { name: "Monthly", exact: true }).click();
  await expect(page.getByTestId("range-label")).toHaveText("April 2025");
  await page.getByRole("button", { name: /^Choose period:/u }).click();
  await page.getByRole("button", { name: "This month", exact: true }).click();
  await page.getByRole("button", { name: "Previous period" }).click();
  const lastMonth = lastMonthKey();
  await expect(page).toHaveURL(new RegExp(`#/cash-flow\\?range=${lastMonth}$`, "u"));
  await expect(tiles.getByTestId("income")).toHaveText("$100.00");
  await expect(tiles.getByTestId("spending")).toHaveText("$25.00");
  await expect(tiles.getByTestId("savings")).toHaveText("$75.00");
  await expect(tiles.getByTestId("savings-rate")).toHaveText("75%");

  // The arrows step a month at a time; a month before last month holds nothing.
  await page.getByRole("button", { name: "Previous period" }).click();
  await expect(page).not.toHaveURL(new RegExp(`range=${lastMonth}$`, "u"));
  await expect(tiles.getByTestId("income")).toHaveText("$0.00");
  await expect(tiles.getByTestId("savings-rate")).toHaveText("—");

  // A reload shows the same range, because the range is the address.
  await page.goto(`/#/cash-flow?range=${QUARTER}`);
  await expect(page.getByTestId("range-label")).toHaveText("Q2 2025");
  await expect(tiles.getByTestId("income")).toHaveText("$12,000.00");
});

test("calendar periods keep the chosen month, support year jumps, and survive reloads", async ({ page }) => {
  await signUpIntoOwnSpace(page);
  await seed(page);
  await page.goto("/#/cash-flow?range=2025-05&view=account");
  const picker = page.getByTestId("range-bar");
  const label = page.getByTestId("range-label");
  const income = page.getByTestId("cash-flow-summary-USD").getByTestId("income");
  await expect(income).toHaveText("$4,000.00");

  await picker.getByRole("button", { name: "Quarterly", exact: true }).click();
  await expect(label).toHaveText("Q2 2025");
  await expect(income).toHaveText("$12,000.00");
  await picker.getByRole("button", { name: "Yearly", exact: true }).click();
  await expect(label).toHaveText("2025");
  await picker.getByRole("button", { name: "Monthly", exact: true }).click();
  await expect(label).toHaveText("May 2025");
  await expect(page).toHaveURL(/range=2025-05&view=account$/u);

  await picker.getByRole("button", { name: /^Choose period:/u }).click();
  const dialog = page.getByRole("dialog", { name: "Choose cash flow period" });
  await dialog.getByRole("button", { name: "Choose year: 2025" }).click();
  await dialog.getByRole("button", { name: "2024", exact: true }).click();
  await dialog.getByRole("button", { name: "December 2024", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(label).toHaveText("December 2024");
  await picker.getByRole("button", { name: "Next period" }).click();
  await expect(label).toHaveText("January 2025");
  await picker.getByRole("button", { name: "Quarterly", exact: true }).click();
  await picker.getByRole("button", { name: "Previous period" }).click();
  await expect(label).toHaveText("Q4 2024");
  await picker.getByRole("button", { name: /^Choose period:/u }).click();
  await dialog.getByRole("button", { name: "Q2 2024", exact: true }).click();
  await expect(label).toHaveText("Q2 2024");

  await picker.getByRole("button", { name: "Yearly", exact: true }).click();
  await picker.getByRole("button", { name: /^Choose period:/u }).click();
  await dialog.getByRole("button", { name: "2025", exact: true }).click();
  await expect(income).toHaveText("$12,000.00");
  await page.reload();
  await expect(label).toHaveText("2025");
  await expect(picker.getByRole("button", { name: "Yearly", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/range=2025&view=account$/u);
});

test("custom dates and all time stay available in the compact picker on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUpIntoOwnSpace(page);
  await seed(page);
  await page.goto(`/#/cash-flow?range=${QUARTER}`);
  const picker = page.getByTestId("range-bar");
  const plotWidth = await page.getByTestId("comparison-scroll").evaluate((element) => element.clientWidth);
  expect(plotWidth).toBeLessThan(390);
  const trigger = picker.getByRole("button", { name: /^Choose period:/u });
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Choose cash flow period" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await dialog.getByRole("button", { name: "Custom dates", exact: true }).click();
  // Reversed endpoints are normalized, and the custom range drives the real totals.
  await dialog.getByLabel("From", { exact: true }).fill("2025-06-30");
  await dialog.getByLabel("To", { exact: true }).fill("2025-04-01");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByTestId("range-label")).toHaveText("Apr 1, 2025 – Jun 30, 2025");
  await expect(page.getByTestId("cash-flow-summary-USD").getByTestId("income")).toHaveText("$12,000.00");
  await expect(picker.getByRole("button", { name: "Previous period" })).toHaveCount(0);
  await trigger.click();
  await dialog.getByRole("button", { name: "Back to calendar" }).click();
  await dialog.getByRole("button", { name: "All time", exact: true }).click();
  await expect(page.getByTestId("range-label")).toHaveText("All time");
  await expect(page.getByTestId("cash-flow-summary-USD").getByTestId("income")).toHaveText("$12,100.00");
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("chart modes compare full years, quarters, and months; selecting bars changes only the details", async ({ page }) => {
  await signUpIntoOwnSpace(page);
  await seed(page);
  await page.goto(`/#/cash-flow?range=${QUARTER}&view=account`);
  const chart = page.getByTestId("cash-flow-comparison");
  const income = page.getByTestId("cash-flow-summary-USD").getByTestId("income");
  const picker = page.getByTestId("range-bar");
  await picker.getByRole("button", { name: "Yearly", exact: true }).click();
  await expect(chart.getByRole("heading")).toHaveText("Income and spending by year");
  const otherYear = lastMonthKey().slice(0, 4);
  const yearSpan = await chart.getByTestId("comparison-span").innerText();
  await chart.getByRole("button", { name: `${otherYear} — Income: $100.00`, exact: true }).click();
  await expect(income).toHaveText("$100.00");
  await expect(page.getByTestId("selected-period-heading")).toHaveText(otherYear);
  await expect(chart.getByTestId("comparison-span")).toHaveText(yearSpan);
  await chart.getByRole("button", { name: "2025 — Income: $12,000.00", exact: true }).press("Enter");
  await expect(income).toHaveText("$12,000.00");
  await expect(page).toHaveURL(/range=2025&view=account$/u);
  await expect(chart.getByRole("button", { name: "2025 — Spending: $5,400.00", exact: true })).toHaveAttribute("aria-pressed", "true");

  await picker.getByRole("button", { name: "Quarterly", exact: true }).click();
  await expect(chart.getByRole("heading")).toHaveText("Income and spending by quarter");
  await chart.getByRole("button", { name: "Q2 '25 — Income: $12,000.00", exact: true }).click();
  await expect(income).toHaveText("$12,000.00");
  await expect(page.getByTestId("selected-period-heading")).toHaveText("Q2 2025");
  await chart.getByText("Quarter by quarter", { exact: true }).click();
  await expect(chart.getByTestId("period-2025-Q2").getByTestId("spending")).toHaveText("$5,400.00");

  await picker.getByRole("button", { name: "Monthly", exact: true }).click();
  await expect(chart.getByRole("heading")).toHaveText("Income and spending by month");
  await chart.getByRole("button", { name: "May '25 — Income: $4,000.00", exact: true }).click();
  await expect(income).toHaveText("$4,000.00");
  await expect(page.getByTestId("selected-period-heading")).toHaveText("May 2025");
  await expect(page).toHaveURL(/range=2025-05&view=account$/u);
  await chart.getByRole("button", { name: "Later months", exact: true }).click();
  await expect(chart.getByRole("button", { name: "Earlier months", exact: true })).toBeEnabled();
  await expect(page.getByTestId("selected-period-heading")).toHaveText("May 2025");
  await expect(income).toHaveText("$4,000.00");
  await page.reload();
  await expect(chart.getByRole("button", { name: "May '25 — Income: $4,000.00", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("picking a category in the treemap trends it", async ({ page }) => {
  await signUpIntoOwnSpace(page);
  const ids = await seed(page);
  await page.goto(`/#/cash-flow?range=${QUARTER}`);

  // The largest category is trended until one is picked.
  await expect(page.getByTestId("trend-title")).toHaveText("Trend: Rent");
  await page.getByRole("button", { name: /^Groceries:/u }).click();
  await expect(page.getByTestId("trend-title")).toHaveText("Trend: Groceries");
  await expect(page.getByTestId(`category-${ids.groceries}`)).toHaveClass(/selected/u);
  await expect(page.getByTestId("trend-transactions")).toHaveAttribute(
    "href",
    `#/transactions?from=2025-04-01&to=2025-06-30&category=${ids.groceries}`,
  );

  // The table's own names pick too.
  await page.getByTestId(`category-${ids.rent}`).getByRole("button", { name: "Rent" }).click();
  await expect(page.getByTestId("trend-title")).toHaveText("Trend: Rent");
});
