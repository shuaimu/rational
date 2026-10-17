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
export class BankOverlap {
  private store: PlaidStore;
  private now: () => number;
  private candidates = new Map<string, { tx: FunctionDocument; statement: string }[]>();
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
      if (identity.state === "review") {
        identity.fields = fields;
        identity.removal = false;
        await this.write(id, hh, identity, prior);
        return true;
      }
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
      };
    } else {
      const candidates: FunctionDocument[] = [];
      let imported = this.candidates.get(fields.account_id);
      if (!imported) {
        const [sources, ledger] = await Promise.all([
          this.store.list(STORE, "account_id", fields.account_id),
          this.store.list("transactions", "account_id", fields.account_id),
        ]);
        const transactions = new Map(
          ledger
            .filter((tx) => !tx._deleted && tx.body.household_id === hh)
            .map((tx) => [String(tx.body.id), tx]),
        );
        imported = [];
        for (const source of sources) {
          if (source._deleted || source.body.household_id !== hh || source.body.kind !== "source")
            continue;
          const data = JSON.parse(String(source.body.data)),
            tx = transactions.get(String(data.transactionId));
          if (tx) imported.push({ tx, statement: String(data.source.statement) });
        }
        this.candidates.set(fields.account_id, imported);
      }
      for (const { tx, statement: original } of imported) {
        if (tx.body.amount !== fields.amount || tx.body.currency !== fields.currency) continue;
        const delta =
          Math.abs(Date.parse(String(tx.body.date)) - Date.parse(fields.date)) / 86400000;
        if (delta <= 3)
          candidates.push({ ...tx, body: { ...tx.body, source_statement: original } });
      }
      const exact = candidates.filter(
        (tx) =>
          tx.body.date === fields.date &&
          statement.trim() !== "" &&
          normalizeSource(String(tx.body.source_statement)) === normalizeSource(statement),
      );
      const unique = exact.length === 1 && candidates.length === 1 ? exact[0] : null;
      const claim = unique ? await this.store.read(STORE, `claim_${unique.body.id}`) : null;
      const target =
        unique && !claim
          ? String(unique.body.id)
          : candidates.length
            ? null
            : transactionId(fields.account_id, fields.external_id);
      identity = {
        linkId,
        providerId: fields.external_id,
        accountId: fields.account_id,
        transactionId: target,
        state: target ? "intent" : "review",
        fields,
        previous:
          unique && !claim
            ? {
                ...fields,
                date: String(unique.body.date),
                amount: Number(unique.body.amount),
                description: String(unique.body.description),
              }
            : null,
        candidates: candidates.map((tx) => String(tx.body.id)),
        reason: target
          ? ""
          : "Possible overlap with imported history; choose one transaction to merge or keep it separate.",
        removal: false,
      };
    }
    await this.write(id, hh, identity, prior);
    if (identity.state === "review") return true;
    await this.apply(id, hh, identity, (await this.store.read(STORE, id))!);
    return false;
  }
  private async claim(id: string, hh: string, identity: Identity) {
    const key = `claim_${identity.transactionId}`,
      prior = await this.store.read(STORE, key);
    this.check(prior, hh);
    if (prior && JSON.parse(String(prior.body.data)).identityId !== id)
      throw new Error(
        "That transaction is already matched to a different bank transaction. Keep this entry separate.",
      );
    if (!prior)
      await this.store.write(
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
      );
  }
  private async apply(
    id: string,
    hh: string,
    identity: Identity,
    prior: FunctionDocument,
  ): Promise<void> {
    if (!identity.transactionId) throw new Error("Choose an overlap resolution first.");
    await this.claim(id, hh, identity);
    const tx = await this.store.read("transactions", identity.transactionId);
    this.check(tx, hh);
    if (
      tx &&
      !tx._deleted &&
      identity.previous &&
      !sameMoney(tx.body, identity.previous) &&
      !sameMoney(tx.body, identity.fields)
    ) {
      await this.write(
        id,
        hh,
        {
          ...identity,
          state: "review",
          candidates: [identity.transactionId],
          reason:
            "Financial fields changed after the prior import. Review this bank correction before replacing your edits.",
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
    await this.claim(id, hh, next);
    await this.write(id, hh, next, prior);
    await this.apply(id, hh, next, (await this.store.read(STORE, id))!);
  }
}
