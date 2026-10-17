import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  Field,
  Input,
  NativeSelect,
} from "@mako-cloud/ui";
import {
  ACCOUNT_TYPES,
  checkedSum,
  decimalMinor,
  digest,
  parseBalances,
  parseMonarch,
  validateManifest,
  type AccountPlan,
  type BalanceRow,
  type CategoryKind,
  type SourceRow,
  type TagEncoding,
} from "../../functions/shared/monarch.js";
import type { RationalApp } from "../data/rational.js";
import type { ImportSummary } from "../data/monarch.js";
import type { Account } from "../model/types.js";
import { formatMinorUnits } from "../selectors/money.js";

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return groups;
}
function suggestedKind(name: string): CategoryKind {
  return /transfer|credit card payment|savings|investment contribution/iu.test(name)
    ? "transfer"
    : /income|paycheck|interest earned|dividend/iu.test(name)
      ? "income"
      : "expense";
}
export function MonarchImportPanel({
  app,
  accounts,
  currency,
}: {
  app: RationalApp;
  accounts: readonly Account[];
  currency: string;
}) {
  const [rows, setRows] = useState<SourceRow[]>([]),
    [balances, setBalances] = useState<BalanceRow[]>([]);
  const [plans, setPlans] = useState<AccountPlan[]>([]),
    [categories, setCategories] = useState<Record<string, CategoryKind>>({});
  const [encoding, setEncoding] = useState<TagEncoding>("single"),
    [filename, setFilename] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [jobs, setJobs] = useState<ImportSummary[]>([]);
  const [sourceReviews, setSourceReviews] = useState<
    { id: string; transactionId: string; original: SourceRow; incoming: SourceRow }[]
  >([]);
  const [confirmed, setConfirmed] = useState(false),
    [message, setMessage] = useState("");
  const householdId = app.state.currentHouseholdId;
  const refresh = async () => {
    if (app.monarch && householdId) {
      setJobs((await app.monarch.list(householdId)).jobs);
      setSourceReviews(
        (await app.monarch.call<{ reviews: typeof sourceReviews }>("source-reviews", householdId))
          .reviews,
      );
    }
  };
  useEffect(() => {
    void refresh().catch((error) =>
      setError(error instanceof Error ? error.message : "Cloud imports could not be loaded."),
    );
  }, [app, householdId]);
  const groups = useMemo(() => groupBy(rows, (row) => row.account), [rows]);
  const balanceGroups = useMemo(() => groupBy(balances, (row) => row.account), [balances]);
  const update = (source: string, patch: Partial<AccountPlan>) => {
    setPlans((plans) =>
      plans.map((plan) => (plan.source === source ? { ...plan, ...patch } : plan)),
    );
    setConfirmed(false);
  };
  const choose = async (file: File | undefined, kind: "transactions" | "balances") => {
    if (!file) return;
    try {
      setError("");
      setConfirmed(false);
      if (kind === "balances") {
        setBalances(parseBalances(await file.text()));
        return;
      }
      const parsed = parseMonarch(await file.text());
      setRows(parsed);
      setFilename(file.name);
      setPlans(
        [...new Set(parsed.map((row) => row.account))]
          .sort()
          .map((source) => ({
            source,
            accountId: null,
            name: source,
            type: "",
            currency,
            identityConfirmed: false,
            balance: null,
            opening: "0",
            replaceOpening: false,
            expectedRevision: null,
          })),
      );
      setCategories(
        Object.fromEntries(
          [...new Set(parsed.map((row) => row.category).filter(Boolean))]
            .sort()
            .map((name) => [name, suggestedKind(name)]),
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not read CSV.");
    }
  };
  const run = async () => {
    if (!app.monarch || !householdId || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const chunks: SourceRow[][] = [];
      let chunk: SourceRow[] = [];
      for (const row of rows) {
        if (
          chunk.length >= 200 ||
          new TextEncoder().encode(JSON.stringify([...chunk, row])).length > 240000
        ) {
          chunks.push(chunk);
          chunk = [];
        }
        chunk.push(row);
      }
      if (chunk.length) chunks.push(chunk);
      const manifest = {
        version: 1 as const,
        accounts: plans,
        categories,
        tagEncoding: encoding,
        rowCount: rows.length,
        chunkHashes: await Promise.all(chunks.map(digest)),
      };
      validateManifest(manifest);
      const job = await app.monarch.start(householdId, manifest);
      if (["uploading", "validating"].includes(job.state)) {
        for (const [index, part] of chunks.entries()) {
          setMessage(`Uploading ${index + 1} of ${chunks.length} chunks…`);
          await app.monarch.upload(householdId, job.id, index, part);
        }
        await app.monarch.action(householdId, job.id, "seal");
      }
      setMessage(
        "Upload is durable in Mako Cloud. The hourly dispatcher continues after this page closes. Continue runs one cloud phase now.",
      );
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Import could not start.");
    } finally {
      setBusy(false);
    }
  };
  const action = async (id: string, action: "advance" | "status" | "cancel" | "resume") => {
    if (!app.monarch || !householdId) return;
    setBusy(true);
    setError("");
    try {
      const result = await app.monarch.action(householdId, id, action);
      setJobs((jobs) => jobs.map((job) => (job.id === id ? result : job)));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Import could not continue.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-4" aria-label="Monarch history import">
      <Card>
        <CardHeader>
          <h2>Import Monarch history</h2>
          <p className="text-sm text-muted-foreground">
            Export transactions from Monarch, preview their accounts and categories, then import
            history before linking your banks.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Monarch transaction CSV" htmlFor="monarch-transactions">
            <Input
              id="monarch-transactions"
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(event) => void choose(event.target.files?.[0], "transactions")}
            />
          </Field>
          <Field label="Optional Monarch balance CSV" htmlFor="monarch-balances">
            <Input
              id="monarch-balances"
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(event) => void choose(event.target.files?.[0], "balances")}
            />
          </Field>
          <p className="text-sm">
            Source owner labels are retained as history, without granting household access. Notes,
            original statements, tags, and review status are preserved.
          </p>
        </CardContent>
      </Card>
      <Button variant="outline" disabled={busy} onClick={() => {
        setError("");
        void refresh().catch(error => setError(error instanceof Error ? error.message : "Imports could not be loaded."));
      }}>Refresh imports</Button>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {rows.length > 0 ? (
        <>
          <Card>
            <CardHeader>
              <h3>Preview: {filename}</h3>
              <p>
                {rows.length.toLocaleString()} transactions · {groups.size} accounts ·{" "}
                {[...rows].map((row) => row.date).sort()[0]} through{" "}
                {[...rows]
                  .map((row) => row.date)
                  .sort()
                  .at(-1)}
              </p>
              <p className="text-sm">
                {rows.filter((row) => row.notes).length} notes ·{" "}
                {rows.filter((row) => row.tags).length} tagged ·{" "}
                {rows.filter((row) => row.sourceId).length} source IDs ·{" "}
                {rows.filter((row) => row.reviewed === "Reviewed").length} reviewed ·{" "}
                {rows.filter((row) => row.reviewed === "Needs Review").length} needing review
              </p>
              <p className="text-sm">
                {rows.length -
                  new Set(
                    rows.map((row) =>
                      row.sourceId
                        ? JSON.stringify([row.account, row.sourceId])
                        : JSON.stringify([
                            row.account,
                            row.date,
                            row.amount,
                            row.statement || row.merchant,
                            row.line,
                          ]),
                    ),
                  ).size}{" "}
                repeated source IDs. Identical purchases with distinct IDs remain separate.
              </p>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field label="Tags in this export" htmlFor="monarch-tags">
                <NativeSelect
                  id="monarch-tags"
                  value={encoding}
                  onChange={(e) => {
                    setEncoding(e.target.value as TagEncoding);
                    setConfirmed(false);
                  }}
                >
                  <option value="single">Keep each cell as one label (no delimiter assumed)</option>
                  <option value="comma">Separate tags by comma</option>
                  <option value="semicolon">Separate tags by semicolon</option>
                </NativeSelect>
              </Field>
              <p>
                Each source name must identify one account. If Monarch contains two accounts with
                the same name, rename them there and export again before importing that history.
              </p>
              {plans.map((plan) => {
                const sourceRows = groups.get(plan.source) ?? [],
                  evidence = balanceGroups.get(plan.source) ?? [];
                const latest = [...evidence]
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .slice(0, 20);
                const duplicateDates =
                  evidence.length - new Set(evidence.map((row) => row.date)).size;
                let effect =
                  "Choose an account type and balance evidence, or explicitly accept an unverified opening balance.";
                try {
                  const before = checkedSum(
                    sourceRows
                      .filter((row) => !plan.balance || row.date <= plan.balance.date)
                      .map((row) => decimalMinor(row.amount, plan.currency)),
                  );
                  const after = checkedSum(
                    sourceRows
                      .filter((row) => plan.balance && row.date > plan.balance.date)
                      .map((row) => decimalMinor(row.amount, plan.currency)),
                  );
                  const opening = plan.balance
                    ? checkedSum([
                        decimalMinor(plan.balance.amount, plan.currency) * plan.balance.sign,
                        -before,
                      ])
                    : decimalMinor(plan.opening, plan.currency);
                  effect = `Opening balance: ${formatMinorUnits(opening, plan.currency)}. History after evidence date: ${formatMinorUnits(after, plan.currency)}. ${plan.balance ? "Balance evidence selected." : "Balance unverified."}`;
                } catch (error) {
                  effect = error instanceof Error ? error.message : "Invalid amount.";
                }
                return (
                  <fieldset key={plan.source} className="grid gap-3 rounded-md border p-4">
                    <legend className="px-2 font-semibold">
                      {plan.source} · {sourceRows.length.toLocaleString()} transactions
                    </legend>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="Destination" htmlFor={`dest-${plan.source}`}>
                        <NativeSelect
                          id={`dest-${plan.source}`}
                          value={plan.accountId ?? ""}
                          onChange={(e) => {
                            const account = accounts.find((a) => a.id === e.target.value);
                            update(plan.source, {
                              accountId: account?.id ?? null,
                              type: account?.type ?? "",
                              currency: account?.currency ?? currency,
                              identityConfirmed: false,
                              balance: null,
                            });
                          }}
                        >
                          <option value="">Create from this history</option>
                          {accounts
                            .filter((a) => !a.closed_at)
                            .map((a) => (
                              <option value={a.id} key={a.id}>
                                {a.name}
                              </option>
                            ))}
                        </NativeSelect>
                      </Field>
                      <Field label="Account type" htmlFor={`type-${plan.source}`}>
                        <NativeSelect
                          id={`type-${plan.source}`}
                          value={plan.type}
                          disabled={!!plan.accountId}
                          onChange={(e) => update(plan.source, { type: e.target.value })}
                        >
                          <option value="">Choose type</option>
                          {ACCOUNT_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {type.replaceAll("_", " ")}
                            </option>
                          ))}
                        </NativeSelect>
                      </Field>
                      <Field label="Currency" htmlFor={`currency-${plan.source}`}>
                        <Input
                          id={`currency-${plan.source}`}
                          value={plan.currency}
                          disabled={!!plan.accountId}
                          maxLength={3}
                          onChange={(e) =>
                            update(plan.source, { currency: e.target.value.toUpperCase() })
                          }
                        />
                      </Field>
                    </div>
                    {plan.accountId ? (
                      <p>
                        Existing opening balance is retained. Reconcile its balance after importing;
                        source history may overlap existing entries.
                      </p>
                    ) : (
                      <>
                        <Field label="Balance evidence" htmlFor={`balance-${plan.source}`}>
                          <NativeSelect
                            id={`balance-${plan.source}`}
                            value={
                              plan.balance ? `${plan.balance.date}:${plan.balance.amount}` : ""
                            }
                            onChange={(e) => {
                              const row = latest.find(
                                (row) => `${row.date}:${row.balance}` === e.target.value,
                              );
                              update(plan.source, {
                                balance: row
                                  ? { date: row.date, amount: row.balance, sign: 1 }
                                  : null,
                              });
                            }}
                          >
                            <option value="">No evidence — use an explicit opening balance</option>
                            {latest.map((row) => (
                              <option key={row.line} value={`${row.date}:${row.balance}`}>
                                {row.date}: {row.balance} {plan.currency}
                              </option>
                            ))}
                          </NativeSelect>
                        </Field>
                        {plan.balance ? (
                          <Field label="Source balance convention" htmlFor={`sign-${plan.source}`}>
                            <NativeSelect
                              id={`sign-${plan.source}`}
                              value={plan.balance.sign}
                              onChange={(e) =>
                                update(plan.source, {
                                  balance: {
                                    ...plan.balance!,
                                    sign: Number(e.target.value) as 1 | -1,
                                  },
                                })
                              }
                            >
                              <option value={1}>Already signed (debts negative)</option>
                              <option value={-1}>Positive debt owed — reverse sign</option>
                            </NativeSelect>
                          </Field>
                        ) : (
                          <Field
                            label="Opening balance (signed; debts negative)"
                            htmlFor={`opening-${plan.source}`}
                          >
                            <Input
                              id={`opening-${plan.source}`}
                              value={plan.opening}
                              onChange={(e) => update(plan.source, { opening: e.target.value })}
                            />
                          </Field>
                        )}
                        <p className="text-sm">{effect}</p>
                      </>
                    )}
                    {duplicateDates > 0 ? (
                      <p className="text-destructive">
                        {duplicateDates} repeated balance dates. This name may combine multiple
                        source accounts; resolve it in Monarch before importing.
                      </p>
                    ) : null}
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={plan.identityConfirmed}
                        disabled={duplicateDates > 0}
                        onChange={(e) =>
                          update(plan.source, { identityConfirmed: e.target.checked })
                        }
                      />
                      I verified this name identifies one account and reviewed its type, currency,
                      and balance.
                    </label>
                  </fieldset>
                );
              })}
              <details>
                <summary>Review {Object.keys(categories).length} category kinds</summary>
                <div className="grid gap-3 sm:grid-cols-3 mt-3">
                  {Object.entries(categories).map(([name, kind]) => (
                    <Field key={name} label={name} htmlFor={`category-${name}`}>
                      <NativeSelect
                        id={`category-${name}`}
                        value={kind}
                        onChange={(e) => {
                          setCategories({ ...categories, [name]: e.target.value as CategoryKind });
                          setConfirmed(false);
                        }}
                      >
                        <option value="custom">Custom (preserve source label)</option>
                        <option value="expense">Expense</option>
                        <option value="income">Income</option>
                        <option value="transfer">Transfer (excluded from spending)</option>
                      </NativeSelect>
                    </Field>
                  ))}
                </div>
              </details>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I reviewed every account, category kind, and the tag encoding above.
              </label>
              <Button
                disabled={
                  busy || !confirmed || plans.some((plan) => !plan.identityConfirmed || !plan.type)
                }
                onClick={() => void run()}
              >
                Import {rows.length.toLocaleString()} transactions in Mako Cloud
              </Button>
            </CardContent>
          </Card>
        </>
      ) : null}
      {sourceReviews.map((review) => (
        <Card key={review.id}>
          <CardHeader>
            <h3>Changed Monarch source record</h3>
            <p>
              {review.incoming.account} · {review.incoming.date} · {review.incoming.merchant}
            </p>
          </CardHeader>
          <CardContent>
            <p>
              Previously {review.original.amount}; new export {review.incoming.amount}. Imported
              annotations or financial fields changed in the source. Your Rational transaction has
              been preserved.
            </p>
            <Button
              disabled={busy}
              onClick={() => {
                if (app.monarch && householdId) {
                  setBusy(true);
                  void app.monarch
                    .call("keep-source", householdId, { id: review.id })
                    .then(refresh)
                    .catch((error) => setError(String(error)))
                    .finally(() => setBusy(false));
                }
              }}
            >
              Keep existing Rational transaction
            </Button>
          </CardContent>
        </Card>
      ))}
      {jobs.map((job) => (
        <Card key={job.id}>
          <CardHeader>
            <h3>Monarch import · {job.state}</h3>
            <p>
              {job.processed.toLocaleString()} / {job.rowCount.toLocaleString()} rows ·{" "}
              {job.created} created · {job.duplicates} already imported · {job.conflicts} conflicts
            </p>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p>{job.message}</p>
            <div className="flex gap-2">
              <Button
                disabled={busy}
                variant="outline"
                onClick={() => void action(job.id, "status")}
              >
                Refresh status
              </Button>
              {["validating", "importing", "reconciling"].includes(job.state) ? (
                <Button disabled={busy} onClick={() => void action(job.id, "advance")}>
                  Continue in cloud
                </Button>
              ) : null}
              {job.state === "cancelled" ? (
                <Button disabled={busy} onClick={() => void action(job.id, "resume")}>Resume import</Button>
              ) : null}
              {!["complete", "cancelled"].includes(job.state) ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void action(job.id, "cancel")}
                >
                  Cancel remaining work
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
