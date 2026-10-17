import type { JsonObject, FunctionDocument } from "@mako-cloud/edge-sdk";
import type { PlaidStore } from "./plaid-mapped.ts";
import {
  checkedSum,
  decimalMinor,
  digest,
  legacyKey,
  normalizeSource,
  tagsFor,
  validateManifest,
  validateSource,
  type MonarchManifest,
  type SourceRow,
} from "../shared/monarch.ts";

export const IMPORT_STORE = "import_records";
type Phase =
  | "uploading"
  | "validating"
  | "importing"
  | "reconciling"
  | "needs-review"
  | "complete"
  | "cancelled";
interface Totals {
  count: number;
  before: number;
  after: number;
  first: string;
  last: string;
}
export interface ImportJob {
  id: string;
  householdId: string;
  actor: string;
  manifest: MonarchManifest;
  state: Phase;
  resumeState?: Phase;
  chunk: number;
  row: number;
  processed: number;
  created: number;
  duplicates: number;
  conflicts: number;
  totals: Record<string, Totals>;
  accountIds: Record<string, string>;
  message: string;
}
interface Provenance {
  source: SourceRow;
  hash: string;
  transactionId: string;
  intended: JsonObject;
  state: "intent" | "complete";
  jobId: string;
  position: string;
}
export interface ImportSummary {
  id: string;
  state: Phase;
  processed: number;
  rowCount: number;
  created: number;
  duplicates: number;
  conflicts: number;
  message: string;
  accounts: { source: string; accountId: string; verified: boolean }[];
}
export class MonarchImport {
  private store: PlaidStore;
  private now: () => number;
  constructor(store: PlaidStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }
  private async get<T>(
    id: string,
    householdId: string,
  ): Promise<{ doc: FunctionDocument; data: T } | null> {
    const doc = await this.store.read(IMPORT_STORE, id);
    if (!doc || doc._deleted) return null;
    if (doc.body.household_id !== householdId)
      throw new Error("Import record is unavailable in this household.");
    return { doc, data: JSON.parse(String(doc.body.data)) as T };
  }
  private async put(
    id: string,
    householdId: string,
    kind: string,
    data: unknown,
    old: FunctionDocument | null,
    fields: JsonObject = {},
  ) {
    await this.store.write(
      IMPORT_STORE,
      id,
      {
        id,
        household_id: householdId,
        kind,
        created_at: old?.body.created_at ?? this.now(),
        updated_at: this.now(),
        data: JSON.stringify(data),
        ...fields,
      },
      old?.revision ?? null,
    );
  }
  private async job(id: string, householdId: string) {
    const record = await this.get<ImportJob>(id, householdId);
    if (!record || record.doc.body.kind !== "job") throw new Error("Import job not found.");
    return record;
  }
  private summary(job: ImportJob): ImportSummary {
    return {
      id: job.id,
      state: job.state,
      processed: job.processed,
      rowCount: job.manifest.rowCount,
      created: job.created,
      duplicates: job.duplicates,
      conflicts: job.conflicts,
      message: job.message,
      accounts: job.manifest.accounts.map((plan) => ({
        source: plan.source,
        accountId: job.accountIds[plan.source]!,
        verified: plan.balance !== null && !plan.accountId,
      })),
    };
  }
  async start(
    householdId: string,
    actor: string,
    manifest: MonarchManifest,
  ): Promise<ImportSummary> {
    validateManifest(manifest);
    const id = `imp_${await digest([householdId, manifest])}`;
    const existing = await this.get<ImportJob>(id, householdId);
    if (existing) return this.summary(existing.data);
    const accountIds: Record<string, string> = Object.create(null);
    for (const plan of manifest.accounts) {
      accountIds[plan.source] =
        plan.accountId ?? `acc_m_${(await digest([householdId, plan.source])).slice(0, 32)}`;
      if (plan.accountId) {
        const account = await this.store.read("accounts", plan.accountId);
        if (
          !account ||
          account._deleted ||
          account.body.household_id !== householdId ||
          account.body.currency !== plan.currency ||
          account.body.type !== plan.type ||
          account.body.closed_at != null
        )
          throw new Error("Choose an open, compatible account in this household.");
        if (
          plan.replaceOpening &&
          (!plan.expectedRevision || account.revision !== plan.expectedRevision)
        )
          throw new Error("The existing account changed; refresh the opening-balance preview.");
      }
    }
    const job: ImportJob = {
      id,
      householdId,
      actor,
      manifest,
      accountIds,
      state: "uploading",
      chunk: 0,
      row: 0,
      processed: 0,
      created: 0,
      duplicates: 0,
      conflicts: 0,
      totals: {},
      message: "Upload all chunks, then seal the import.",
    };
    await this.put(id, householdId, "job", job, null, { state: job.state });
    return this.summary(job);
  }
  async upload(id: string, householdId: string, index: number, rows: SourceRow[]) {
    const { data: job } = await this.job(id, householdId);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= job.manifest.chunkHashes.length ||
      !Array.isArray(rows) ||
      !rows.length ||
      rows.length > 200 ||
      new TextEncoder().encode(JSON.stringify(rows)).length > 256000
    )
      throw new Error("Invalid upload chunk size or index.");
    if ((await digest(rows)) !== job.manifest.chunkHashes[index])
      throw new Error("Upload checksum does not match the immutable manifest.");
    const chunkId = `${id}_${index}`,
      prior = await this.get<SourceRow[]>(chunkId, householdId);
    if (prior) {
      if ((await digest(prior.data)) !== job.manifest.chunkHashes[index])
        throw new Error("Stored upload checksum mismatch.");
      return;
    }
    if (!["uploading", "validating"].includes(job.state))
      throw new Error("This import no longer accepts chunks.");
    await this.put(chunkId, householdId, "chunk", rows, null, { job_id: id });
  }
  async seal(id: string, householdId: string) {
    const { doc, data: job } = await this.job(id, householdId);
    if (job.state !== "uploading") return this.summary(job);
    // Validation is a bounded cloud phase; seal never loads the whole export.
    job.state = "validating";
    job.message = "Validating all source rows before writing accounts.";
    await this.save(job, doc);
    return this.summary(job);
  }
  async status(id: string, householdId: string) {
    return this.summary((await this.job(id, householdId)).data);
  }
  async list(householdId: string) {
    return (await this.store.list(IMPORT_STORE, "kind", "job"))
      .filter((doc) => !doc._deleted && doc.body.household_id === householdId)
      .map((doc) => this.summary(JSON.parse(String(doc.body.data)) as ImportJob));
  }
  async source(householdId: string, transactionId: string) {
    return (await this.get<Provenance>(`src_${transactionId}`, householdId))?.data.source ?? null;
  }
  async sourceReviews(householdId: string) {
    return (await this.store.list(IMPORT_STORE, "kind", "source-review"))
      .filter(
        (doc) =>
          !doc._deleted && doc.body.household_id === householdId && doc.body.state === "pending",
      )
      .map((doc) => ({ id: String(doc.body.id), ...JSON.parse(String(doc.body.data)) }));
  }
  async keepSource(householdId: string, id: string) {
    const review = await this.get<Record<string, unknown>>(id, householdId);
    if (!review || review.doc.body.kind !== "source-review")
      throw new Error("Source review not found.");
    if (review.doc.body.state !== "resolved")
      await this.put(id, householdId, "source-review", review.data, review.doc, {
        state: "resolved",
        job_id: String(review.doc.body.job_id),
        account_id: String(review.doc.body.account_id),
      });
    const saved = await this.job(String(review.doc.body.job_id), householdId);
    const pending = (await this.store.list(IMPORT_STORE, "job_id", saved.data.id)).filter(
      (doc) => !doc._deleted && doc.body.kind === "source-review" && doc.body.state === "pending",
    );
    saved.data.conflicts = pending.length;
    if (!pending.length && saved.data.state === "needs-review") {
      saved.data.state = "reconciling";
      saved.data.chunk = 0;
      saved.data.message = "Source edits preserved. Continue to recheck account balances.";
    }
    await this.save(saved.data, saved.doc);
  }
  async cancel(id: string, householdId: string) {
    const { doc, data: job } = await this.job(id, householdId);
    if (job.state === "complete") throw new Error("Completed imports cannot be cancelled.");
    if (job.state !== "cancelled") job.resumeState = job.state;
    job.state = "cancelled";
    job.message =
      "Cancelled. Previously imported rows remain; incomplete accounts cannot be linked until reconciled.";
    await this.save(job, doc);
    return this.summary(job);
  }
  async resume(id: string, householdId: string) {
    const { doc, data: job } = await this.job(id, householdId);
    if (job.state !== "cancelled") return this.summary(job);
    if (!job.resumeState || job.resumeState === "cancelled") throw new Error("This import cannot be resumed.");
    job.state = job.resumeState;
    delete job.resumeState;
    job.message = "Import resumed from its saved cloud checkpoint.";
    await this.save(job, doc);
    return this.summary(job);
  }
  private async save(job: ImportJob, old: FunctionDocument) {
    await this.put(job.id, job.householdId, "job", job, old, { state: job.state });
  }
  private async chunk(job: ImportJob, index: number): Promise<SourceRow[]> {
    const saved = await this.get<SourceRow[]>(`${job.id}_${index}`, job.householdId);
    if (!saved || (await digest(saved.data)) !== job.manifest.chunkHashes[index])
      throw new Error(
        `Chunk ${index + 1} is missing or has an invalid checksum. Upload it before sealing.`,
      );
    return saved.data;
  }
  /** One bounded invocation. Every row has its own durable intent before the ledger write. */
  async advance(
    id: string,
    householdId: string,
    maxRows = 100,
    deadline = this.now() + 25000,
  ): Promise<ImportSummary> {
    try {
      return await this.step(id, householdId, maxRows, deadline);
    } catch (error) {
      const saved = await this.job(id, householdId);
      saved.data.message =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Import paused after a cloud error; retry this phase.";
      await this.save(saved.data, saved.doc);
      throw error;
    }
  }
  private async step(
    id: string,
    householdId: string,
    maxRows: number,
    deadline: number,
  ): Promise<ImportSummary> {
    let saved = await this.job(id, householdId),
      job = saved.data;
    if (["complete", "cancelled", "uploading", "needs-review"].includes(job.state))
      return this.summary(job);
    if (job.state === "validating") {
      const rows = await this.chunk(job, job.chunk);
      let worked = 0;
      for (const [index, row] of rows.entries()) {
        if (index < job.row) continue;
        if (worked >= maxRows || this.now() >= deadline) break;
        worked++;
        job.row = index + 1;
        job.processed++;
        validateSource(row);
        const plan = job.manifest.accounts.find((plan) => plan.source === row.account);
        if (!plan || (row.category && !Object.hasOwn(job.manifest.categories, row.category)))
          throw new Error(`Line ${row.line}: missing account or category mapping.`);
        const amount = decimalMinor(row.amount, plan.currency);
        tagsFor(row.tags, job.manifest.tagEncoding);
        if (row.sourceId) {
          const key = `seen_${await digest([job.id, row.account, row.sourceId])}`;
          const hash = await digest({ ...row, line: 0 });
          const prior = await this.get<{ hash: string; position: string }>(key, householdId);
          const position = `${job.chunk}:${index}`;
          if (prior && prior.data.hash !== hash)
            throw new Error(`Line ${row.line}: the same source ID has conflicting rows.`);
          if (prior && prior.data.position !== position) continue;
          if (!prior)
            await this.put(key, householdId, "validation", { hash, position }, null, {
              job_id: job.id,
            });
        }
        if (!row.sourceId) {
          const counterId = `occ_${await digest([job.id, legacyKey(row, amount)])}`;
          const ordinalId = `ord_${job.id}_${job.chunk}_${index}`;
          let ordinal = await this.get<{ value: number }>(ordinalId, householdId);
          let counter = await this.get<{ value: number }>(counterId, householdId);
          if (!ordinal) {
            await this.put(
              ordinalId,
              householdId,
              "ordinal",
              { value: (counter?.data.value ?? 0) + 1 },
              null,
              { job_id: job.id },
            );
            ordinal = await this.get(ordinalId, householdId);
          }
          if (!ordinal) throw new Error("Cannot persist a legacy occurrence identity.");
          if ((counter?.data.value ?? 0) < ordinal.data.value)
            await this.put(
              counterId,
              householdId,
              "occurrence",
              ordinal.data,
              counter?.doc ?? null,
              { job_id: job.id },
            );
        }
        const totals = (Object.hasOwn(job.totals, row.account)
          ? job.totals[row.account]
          : undefined) ?? { count: 0, before: 0, after: 0, first: row.date, last: row.date };
        totals.count++;
        totals.first = row.date < totals.first ? row.date : totals.first;
        totals.last = row.date > totals.last ? row.date : totals.last;
        const field = !plan.balance || row.date <= plan.balance.date ? "before" : "after";
        totals[field] = checkedSum([totals[field], amount]);
        job.totals[row.account] = totals;
      }
      if (job.row === rows.length) {
        job.chunk++;
        job.row = 0;
      }
      if (job.chunk === job.manifest.chunkHashes.length) {
        if (job.processed !== job.manifest.rowCount)
          throw new Error("The uploaded row count differs from the preview.");
        job.state = "importing";
        job.chunk = 0;
        job.processed = 0;
        job.message = "Importing history; bank linking is blocked until reconciliation completes.";
      }
      await this.save(job, saved.doc);
      return this.summary(job);
    }
    if (job.state === "importing") {
      const rows = await this.chunk(job, job.chunk);
      let worked = 0;
      const ensured = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!,
          plan = job.manifest.accounts.find((plan) => plan.source === row.account)!;
        const amount = decimalMinor(row.amount, plan.currency),
          fingerprint = legacyKey(row, amount);
        if (i < job.row) continue;
        if (worked >= maxRows || this.now() >= deadline) break;
        const accountId = job.accountIds[row.account]!;
        if (!ensured.has(row.account)) {
          await this.ensureAccount(job, row.account);
          ensured.add(row.account);
        }
        const ordinal = row.sourceId
          ? null
          : await this.get<{ value: number }>(`ord_${job.id}_${job.chunk}_${i}`, householdId);
        if (!row.sourceId && !ordinal) throw new Error("Missing validated legacy identity.");
        const identity = row.sourceId
          ? ["id", row.sourceId]
          : ["legacy", fingerprint, ordinal!.data.value];
        const txid = `txn_m_${await digest([householdId, accountId, identity])}`;
        const result = await this.importRow(job, row, txid, accountId, amount);
        job[result]++;
        job.processed++;
        job.row = i + 1;
        worked++;
      }
      if (job.row === rows.length) {
        job.chunk++;
        job.row = 0;
      }
      if (job.chunk === job.manifest.chunkHashes.length) {
        job.state = "reconciling";
        job.chunk = 0;
      }
      await this.save(job, saved.doc);
      return this.summary(job);
    }
    if (job.state === "reconciling") {
      const plan = job.manifest.accounts[job.chunk];
      if (plan) {
        await this.ensureAccount(job, plan.source);
        const accountId = job.accountIds[plan.source]!;
        if (plan.balance && !plan.accountId && !job.conflicts) {
          const account = await this.store.read("accounts", accountId);
          const ledger = await this.store.list("transactions", "account_id", accountId);
          const actual = checkedSum([
            Number(account!.body.opening_balance),
            ...ledger
              .filter((tx) => !tx._deleted && String(tx.body.date) <= plan.balance!.date)
              .map((tx) => Number(tx.body.amount)),
          ]);
          if (actual !== decimalMinor(plan.balance.amount, plan.currency) * plan.balance.sign)
            throw new Error(
              "The account balance differs from the preview. Review manual changes before completing the import.",
            );
        }
        const markerId = `account_${job.accountIds[plan.source]}`;
        const marker = await this.get<Record<string, unknown>>(markerId, householdId);
        if (!marker) throw new Error("Missing account import marker.");
        await this.put(
          markerId,
          householdId,
          "account",
          {
            ...marker.data,
            state: job.conflicts ? "needs-review" : "complete",
            verified: plan.balance !== null && !plan.accountId,
          },
          marker.doc,
          { account_id: job.accountIds[plan.source]! },
        );
        job.chunk++;
      }
      if (job.chunk === job.manifest.accounts.length) {
        job.state = job.conflicts ? "needs-review" : "complete";
        job.message = job.conflicts
          ? "Source changes need review; existing transactions were preserved."
          : "History imported. Accounts without balance evidence remain unverified.";
      }
      await this.save(job, saved.doc);
      return this.summary(job);
    }
    return this.summary(job);
  }
  private async ensureAccount(job: ImportJob, source: string) {
    const plan = job.manifest.accounts.find((plan) => plan.source === source)!;
    const id = job.accountIds[source]!,
      markerId = `account_${id}`;
    let marker = await this.get<{ jobId: string; state: string; intended: JsonObject }>(
      markerId,
      job.householdId,
    );
    let account = await this.store.read("accounts", id);
    if (marker?.data.jobId === job.id && marker.data.state === "complete") return;
    if (marker && marker.data.jobId !== job.id && marker.data.state !== "complete")
      throw new Error("Another unfinished import owns this account.");
    if (!marker || marker.data.jobId !== job.id) {
      if (
        account &&
        (account._deleted ||
          account.body.household_id !== job.householdId ||
          account.body.currency !== plan.currency ||
          account.body.type !== plan.type)
      )
        throw new Error("The destination account is unavailable or changed.");
      if (!plan.accountId && account && !marker)
        throw new Error("Account identity collision; choose an existing account explicitly.");
      if (plan.accountId && plan.replaceOpening && account?.revision !== plan.expectedRevision)
        throw new Error("Opening balance changed since preview.");
      const total = job.totals[source];
      const opening = plan.balance
        ? checkedSum([
            decimalMinor(plan.balance.amount, plan.currency) * plan.balance.sign,
            -(total?.before ?? 0),
          ])
        : decimalMinor(plan.opening, plan.currency);
      const intended: JsonObject = account
        ? { ...account.body, ...(plan.replaceOpening ? { opening_balance: opening } : {}) }
        : {
            id,
            household_id: job.householdId,
            created_at: this.now(),
            updated_at: this.now(),
            name: plan.name,
            type: plan.type,
            currency: plan.currency,
            opening_balance: opening,
            opening_date: total?.first ?? plan.balance?.date ?? "1970-01-01",
          };
      await this.put(
        markerId,
        job.householdId,
        "account",
        {
          jobId: job.id,
          state: "importing",
          intended,
          expectedRevision: account?.revision ?? null,
          verified: !!plan.balance,
        },
        marker?.doc ?? null,
        { account_id: id },
      );
      marker = await this.get(markerId, job.householdId);
    }
    if (!marker) throw new Error("Could not save account intent.");
    const intended = marker.data.intended;
    if (!account) await this.store.write("accounts", id, intended, null);
    else if (plan.replaceOpening && account.body.opening_balance !== intended.opening_balance) {
      const data = marker.data as unknown as { expectedRevision: string | null };
      if (account.revision !== data.expectedRevision)
        throw new Error("Account changed while importing; reconcile it before continuing.");
      await this.store.write(
        "accounts",
        id,
        { ...account.body, opening_balance: intended.opening_balance!, updated_at: this.now() },
        account.revision,
      );
    }
  }
  private async taxonomy(job: ImportJob, kind: "category" | "tag", name: string): Promise<string> {
    const categoryKind = kind === "category" ? job.manifest.categories[name] : undefined;
    const id = `tax_m_${await digest([job.householdId, kind, name, categoryKind ?? ""])}`;
    const existing = await this.store.read("taxonomy", id);
    if (!existing)
      await this.store.write(
        "taxonomy",
        id,
        {
          id,
          household_id: job.householdId,
          created_at: this.now(),
          updated_at: this.now(),
          kind,
          name,
          ...(categoryKind ? { category_kind: categoryKind } : {}),
        },
        null,
      );
    else if (existing._deleted || existing.body.household_id !== job.householdId)
      throw new Error("Imported taxonomy is unavailable.");
    return id;
  }
  private async importRow(
    job: ImportJob,
    row: SourceRow,
    id: string,
    accountId: string,
    amount: number,
  ): Promise<"created" | "duplicates" | "conflicts"> {
    const provenanceId = `src_${id}`,
      hash = await digest({ ...row, line: 0 }),
      prior = await this.get<Provenance>(provenanceId, job.householdId);
    if (prior && prior.data.hash !== hash) {
      const conflictId = `review_${await digest([job.id, id, hash])}`;
      if (!(await this.get(conflictId, job.householdId)))
        await this.put(
          conflictId,
          job.householdId,
          "source-review",
          { transactionId: id, original: prior.data.source, incoming: row },
          null,
          { account_id: accountId, job_id: job.id, state: "pending" },
        );
      return "conflicts";
    }
    if (prior?.data.state === "complete")
      return prior.data.jobId === job.id && prior.data.position === `${job.chunk}:${job.row}`
        ? "created"
        : "duplicates";
    let intent = prior;
    if (!intent) {
      const tags = [];
      for (const name of tagsFor(row.tags, job.manifest.tagEncoding))
        tags.push(await this.taxonomy(job, "tag", name));
      const intended: JsonObject = {
        id,
        household_id: job.householdId,
        account_id: accountId,
        created_at: this.now(),
        updated_at: this.now(),
        date: row.date,
        amount,
        currency: job.manifest.accounts.find((plan) => plan.source === row.account)!.currency,
        description: row.merchant,
        normalized_description: normalizeSource(row.merchant),
        tags,
        splits: [],
        import_batch_id: job.id,
        ...(row.notes ? { notes: row.notes } : {}),
        ...(row.category
          ? { category_id: await this.taxonomy(job, "category", row.category) }
          : {}),
        ...(row.reviewed ? { reviewed: row.reviewed === "Reviewed" } : {}),
      };
      await this.put(
        provenanceId,
        job.householdId,
        "source",
        {
          source: row,
          hash,
          transactionId: id,
          intended,
          state: "intent",
          jobId: job.id,
          position: `${job.chunk}:${job.row}`,
        },
        null,
        { account_id: accountId },
      );
      intent = await this.get<Provenance>(provenanceId, job.householdId);
    }
    if (!intent) throw new Error("Could not persist the transaction intent.");
    const existing = await this.store.read("transactions", id);
    if (!existing) await this.store.write("transactions", id, intent.data.intended, null);
    else if (JSON.stringify(existing.body) !== JSON.stringify(intent.data.intended))
      throw new Error(
        "An imported transaction changed during recovery. Existing edits were preserved.",
      );
    await this.put(
      provenanceId,
      job.householdId,
      "source",
      { ...intent.data, state: "complete" },
      intent.doc,
      { account_id: accountId },
    );
    return "created";
  }
}
