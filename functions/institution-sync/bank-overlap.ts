import type { FunctionDocument, JsonObject } from "@mako-cloud/edge-sdk";
import type { PlaidStore } from "./plaid-mapped.ts";
import { digest, normalizeSource } from "../shared/monarch.ts";
import { transactionId } from "./institution.ts";
const STORE = "import_records";
export interface BankFields {
  account_id: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  external_id: string;
}
interface Identity {
  linkId: string;
  providerId: string;
  accountId: string;
  transactionId: string | null;
  state: "review" | "intent" | "applied" | "removed";
  fields: BankFields;
  previous: BankFields | null;
  candidates: string[];
  reason: string;
  removal: boolean;
  statement?: string;
  resolution?: "matched" | "separate" | "preserved-local-edit" | "preserved-local-deletion";
}
export interface OverlapReview {
  id: string;
  accountId: string;
  fields: BankFields;
  candidates: { id: string; date: string; description: string; amount: number; notes: string }[];
  reason: string;
  removal: boolean;
}
const sameMoney = (body: JsonObject, fields: BankFields) =>
  body.date === fields.date &&
  body.amount === fields.amount &&
  body.currency === fields.currency &&
  body.account_id === fields.account_id;
const matchText = (value: string) => normalizeSource(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const meaningful = (value: string) => value.length >= 3 &&
  !["payment", "transfer", "deposit", "withdrawal", "debit", "credit", "purchase"].includes(value);
interface ImportedCandidate { tx: FunctionDocument; statement: string; merchant: string }
export class BankOverlap {
  private store: PlaidStore;
  private now: () => number;
  private candidates = new Map<string, ImportedCandidate[]>();
  constructor(store: PlaidStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }
  private async identityId(linkId: string, accountId: string, providerId: string) {
    return `bank_${await digest([linkId, accountId, providerId])}`;
  }
  private async write(id: string, hh: string, identity: Identity, prior: FunctionDocument | null) {
    await this.store.write(
      STORE,
      id,
      {
        id,
        household_id: hh,
        kind: "bank-identity",
        account_id: identity.accountId,
        state: identity.state,
        created_at: prior?.body.created_at ?? this.now(),
        updated_at: this.now(),
        data: JSON.stringify(identity),
      },
      prior?.revision ?? null,
    );
  }
  private check(doc: FunctionDocument | null, hh: string) {
    if (doc && doc.body.household_id !== hh)
      throw new Error("Bank identity is unavailable in this household.");
  }
  async requireComplete(accountId: string, hh: string) {
    const marker = await this.store.read(STORE, `account_${accountId}`);
    this.check(marker, hh);
    if (marker && JSON.parse(String(marker.body.data)).state !== "complete")
      throw new Error("Finish and reconcile the Monarch import before linking this account.");
    const jobs = await this.store.list(STORE, "kind", "job");
    for (const doc of jobs) {
      if (doc._deleted || doc.body.household_id !== hh) continue;
      const job = JSON.parse(String(doc.body.data));
      if (
        job.state !== "complete" &&
        job.state !== "uploading" &&
        Object.values(job.accountIds).includes(accountId)
      )
        throw new Error(
          "This account has unfinished Monarch history. Complete the import before linking it.",
        );
    }
  }
  async ingest(
    linkId: string,
    hh: string,
    fields: BankFields,
    statement: string,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(fields.amount))
      throw new Error("The provider amount is not a safe integer.");
    const id = await this.identityId(linkId, fields.account_id, fields.external_id);
    let prior = await this.store.read(STORE, id);
    this.check(prior, hh);
    let identity: Identity;
    if (prior) {
      identity = JSON.parse(String(prior.body.data));
      if (identity.state === "intent") {
        await this.apply(id, hh, identity, prior);
        prior = await this.store.read(STORE, id);
        identity = JSON.parse(String(prior!.body.data));
      }
      if (
        JSON.stringify(identity.fields) === JSON.stringify(fields) &&
        identity.state === "applied"
      )
        return false;
      identity = {
        ...identity,
        state: "intent",
        previous: identity.fields,
        fields,
        removal: false,
        statement,
      };
      if (!identity.transactionId) identity = await this.match(id, hh, identity);
    } else {
      identity = await this.match(id, hh, {
        linkId,
        providerId: fields.external_id,
        accountId: fields.account_id,
        transactionId: null,
        state: "intent",
        fields,
        previous: null,
        candidates: [],
        reason: "",
        removal: false,
        statement,
      });
    }
    await this.write(id, hh, identity, prior);
    await this.apply(id, hh, identity, (await this.store.read(STORE, id))!);
    return false;
  }

  /** Match occurrences one-to-one, with source evidence before posting-date proximity. */
  private async match(id: string, hh: string, identity: Identity): Promise<Identity> {
    const fields = identity.fields;
    const key = JSON.stringify([hh, fields.account_id]);
    let imported = this.candidates.get(key);
    if (!imported) {
      const [sources, ledger] = await Promise.all([
        this.store.list(STORE, "account_id", fields.account_id),
        this.store.list("transactions", "account_id", fields.account_id),
      ]);
      const transactions = new Map(ledger.filter(tx => !tx._deleted && tx.body.household_id === hh)
        .map(tx => [String(tx.body.id), tx]));
      const unique = new Map<string, ImportedCandidate>();
      for (const source of sources) {
        if (source._deleted || source.body.household_id !== hh || source.body.kind !== "source") continue;
        const data = JSON.parse(String(source.body.data));
        const tx = transactions.get(String(data.transactionId));
        if (tx) unique.set(String(tx.body.id), { tx,
          statement: String(data.source.statement ?? ""), merchant: String(data.source.merchant ?? "") });
      }
      imported = [...unique.values()];
      this.candidates.set(key, imported);
    }
    const providerTexts = [identity.statement ?? "", fields.description].map(matchText).filter(meaningful);
    const ranked = imported.flatMap(candidate => {
      const tx = candidate.tx;
      if (tx.body.amount !== fields.amount || tx.body.currency !== fields.currency || tx.body.account_id !== fields.account_id) return [];
      const days = Math.abs(Date.parse(String(tx.body.date)) - Date.parse(fields.date)) / 86_400_000;
      if (!Number.isFinite(days) || days > 3) return [];
      const source = matchText(candidate.statement);
      const merchant = [candidate.merchant, String(tx.body.description)].map(matchText).filter(meaningful);
      const score = meaningful(source) && providerTexts.includes(source) ? 2
        : merchant.some(text => providerTexts.includes(text)) ? 1 : 0;
      // Equal amounts alone are not enough to collapse unrelated purchases.
      return score ? [{ ...candidate, days, score }] : [];
    }).sort((a, b) => b.score - a.score || a.days - b.days || String(a.tx.body.id).localeCompare(String(b.tx.body.id)));
    for (const candidate of ranked) {
      const target = String(candidate.tx.body.id);
      const claim = await this.store.read(STORE, `claim_${target}`);
      this.check(claim, hh);
      if (claim && JSON.parse(String(claim.body.data)).identityId !== id) continue;
      // A user edit or deletion may have arrived since this account's cache loaded.
      const tx = await this.store.read("transactions", target);
      this.check(tx, hh);
      if (!tx || tx._deleted || tx.body.account_id !== fields.account_id ||
        tx.body.amount !== fields.amount || tx.body.currency !== fields.currency ||
        tx.body.date !== candidate.tx.body.date) continue;
      return { ...identity, transactionId: target, state: "intent", candidates: [target], reason: "",
        previous: { ...fields, date: String(tx.body.date), description: String(tx.body.description) }, resolution: "matched" };
    }
    return { ...identity, transactionId: transactionId(fields.account_id, fields.external_id),
      state: "intent", previous: null, candidates: [], reason: "", resolution: "separate" };
  }

  /** Old queued reviews also finish without requiring another provider delivery or a browser. */
  async reconcilePending(linkId: string, hh: string, accountId: string, limit = 20): Promise<boolean> {
    const pending = (await this.store.list(STORE, "account_id", accountId)).filter(doc => {
      if (doc._deleted || doc.body.household_id !== hh || doc.body.kind !== "bank-identity" ||
        !["review", "intent"].includes(String(doc.body.state))) return false;
      return (JSON.parse(String(doc.body.data)) as Identity).linkId === linkId;
    }).sort((a, b) => String(a.body.id).localeCompare(String(b.body.id)));
    for (const prior of pending.slice(0, limit)) {
      const id = String(prior.body.id);
      let identity = JSON.parse(String(prior.body.data)) as Identity;
      if (!identity.transactionId && identity.removal) {
        await this.write(id, hh, { ...identity, state: "removed", reason: "" }, prior);
        continue;
      }
      identity = identity.transactionId ? { ...identity, state: "intent", reason: "" } : await this.match(id, hh, identity);
      await this.write(id, hh, identity, prior);
      await this.apply(id, hh, identity, (await this.store.read(STORE, id))!);
    }
    return pending.length > limit;
  }
  private async claim(id: string, hh: string, identity: Identity) {
    const key = `claim_${identity.transactionId}`,
      prior = await this.store.read(STORE, key);
    this.check(prior, hh);
    if (prior && JSON.parse(String(prior.body.data)).identityId !== id)
      return false;
    if (!prior)
      try { await this.store.write(
        STORE,
        key,
        {
          id: key,
          household_id: hh,
          kind: "bank-claim",
          account_id: identity.accountId,
          created_at: this.now(),
          updated_at: this.now(),
          data: JSON.stringify({ identityId: id }),
        },
        null,
      ); } catch (error) {
        const raced = await this.store.read(STORE, key);
        this.check(raced, hh);
        if (raced && JSON.parse(String(raced.body.data)).identityId !== id) return false;
        if (!raced) throw error;
      }
    return true;
  }
  private async apply(
    id: string,
    hh: string,
    identity: Identity,
    prior: FunctionDocument,
  ): Promise<void> {
    if (!identity.transactionId) throw new Error("Bank reconciliation has no transaction identity.");
    if (!(await this.claim(id, hh, identity))) {
      if (identity.transactionId === transactionId(identity.accountId, identity.providerId))
        throw new Error("This provider identity is already associated with another bank link.");
      const next = await this.match(id, hh, identity);
      await this.write(id, hh, next, prior);
      return this.apply(id, hh, next, (await this.store.read(STORE, id))!);
    }
    const tx = await this.store.read("transactions", identity.transactionId);
    this.check(tx, hh);
    if (
      tx &&
      identity.previous &&
      (tx._deleted || (!sameMoney(tx.body, identity.previous) && !sameMoney(tx.body, identity.fields)) ||
        (Array.isArray(tx.body.splits) && tx.body.splits.length > 0 && tx.body.amount !== identity.fields.amount))
    ) {
      await this.write(
        id,
        hh,
        {
          ...identity,
          state: identity.removal ? "removed" : "applied",
          previous: identity.fields,
          reason: "",
          resolution: tx._deleted ? "preserved-local-deletion" : "preserved-local-edit",
        },
        prior,
      );
      return;
    }
    if (identity.removal) {
      if (tx && !tx._deleted) await this.store.remove("transactions", tx);
      await this.write(id, hh, { ...identity, state: "removed" }, prior);
      return;
    }
    const fields = identity.fields;
    if (!tx || !sameMoney(tx.body, fields) || tx.body.external_id !== fields.external_id) {
      // Imported annotations and merchant labels remain on the same transaction.
      await this.store.write(
        "transactions",
        identity.transactionId,
        {
          tags: [],
          splits: [],
          ...tx?.body,
          ...fields,
          description: tx?.body.description ?? fields.description,
          id: identity.transactionId,
          household_id: hh,
          created_at: tx?.body.created_at ?? this.now(),
          updated_at: this.now(),
        },
        tx?.revision ?? null,
      );
    }
    await this.write(id, hh, { ...identity, state: "applied", previous: fields }, prior);
  }
  async remove(linkId: string, hh: string, accountId: string, providerId: string): Promise<void> {
    const id = await this.identityId(linkId, accountId, providerId),
      prior = await this.store.read(STORE, id);
    this.check(prior, hh);
    if (!prior) {
      const tx = await this.store.read("transactions", transactionId(accountId, providerId));
      this.check(tx, hh);
      if (tx && !tx._deleted) await this.store.remove("transactions", tx);
      return;
    }
    const identity = JSON.parse(String(prior.body.data)) as Identity;
    if (identity.state === "removed") return;
    if (identity.state === "review" && !identity.transactionId) {
      await this.write(id, hh, { ...identity, state: "removed", removal: true }, prior);
      return;
    }
    const next = { ...identity, state: "intent" as const, removal: true };
    await this.write(id, hh, next, prior);
    await this.apply(id, hh, next, (await this.store.read(STORE, id))!);
  }
  async reviews(hh: string, accountId?: string): Promise<OverlapReview[]> {
    const docs = await this.store.list(
        STORE,
        accountId ? "account_id" : "state",
        accountId ?? "review",
      ),
      result: OverlapReview[] = [];
    for (const doc of docs) {
      if (
        doc._deleted ||
        doc.body.household_id !== hh ||
        doc.body.kind !== "bank-identity" ||
        doc.body.state !== "review"
      )
        continue;
      const identity = JSON.parse(String(doc.body.data)) as Identity,
        candidates: OverlapReview["candidates"] = [];
      for (const candidate of identity.candidates) {
        const tx = await this.store.read("transactions", candidate);
        if (tx && !tx._deleted && tx.body.household_id === hh)
          candidates.push({
            id: candidate,
            date: String(tx.body.date),
            amount: Number(tx.body.amount),
            description: String(tx.body.description),
            notes: String(tx.body.notes ?? ""),
          });
      }
      result.push({
        id: String(doc.body.id),
        accountId: identity.accountId,
        fields: identity.fields,
        candidates,
        reason: identity.reason,
        removal: identity.removal,
      });
    }
    return result;
  }
  async resolve(hh: string, id: string, transaction: string | null): Promise<void> {
    const prior = await this.store.read(STORE, id);
    this.check(prior, hh);
    if (!prior || prior.body.kind !== "bank-identity") throw new Error("Review not found.");
    const identity = JSON.parse(String(prior.body.data)) as Identity;
    if (identity.state !== "review") return;
    if (transaction && !identity.candidates.includes(transaction))
      throw new Error("Choose one of the listed matching transactions.");
    if (identity.transactionId && transaction !== identity.transactionId)
      throw new Error(
        "This bank identity is already linked; review its correction on the original transaction.",
      );
    const tx = transaction ? await this.store.read("transactions", transaction) : null;
    this.check(tx, hh);
    if (transaction && (!tx || tx._deleted || tx.body.account_id !== identity.accountId))
      throw new Error("The selected transaction is no longer available.");
    const next: Identity = {
      ...identity,
      transactionId: transaction ?? transactionId(identity.accountId, identity.providerId),
      state: "intent",
      previous: tx
        ? {
            ...identity.fields,
            amount: Number(tx.body.amount),
            date: String(tx.body.date),
            currency: String(tx.body.currency),
          }
        : null,
    };
    if (!(await this.claim(id, hh, next))) throw new Error("That transaction is already matched.");
    await this.write(id, hh, next, prior);
    await this.apply(id, hh, next, (await this.store.read(STORE, id))!);
  }
}
