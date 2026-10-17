import type { FunctionDocument, JsonObject } from "@mako-cloud/edge-sdk";
import { holdingsValue } from "../shared/balances.ts";
import { compatibleAccount, providerAccounts, providerAccountType, reconciliationAmount, validateMappings, type AccountMapping, type ProviderAccount } from "../shared/plaid-mapping.ts";
import { parseExchange, parseSyncPage, plaidItemBody, minorUnitsFromPlaid } from "../shared/plaid.ts";
import { BankOverlap } from "./bank-overlap.ts";
import { transactionId } from "./institution.ts";

type Mapping = AccountMapping & { cycleStartCursor?: string };
export interface PlaidStore {
  read(collection: string, id: string): Promise<FunctionDocument | null>;
  write(collection: string, id: string, body: JsonObject, revision: string | null): Promise<void>;
  remove(collection: string, document: FunctionDocument): Promise<void>;
  list(collection: string, field: string, value: string): Promise<FunctionDocument[]>;
}
export interface LinkSession { linkId: string; institution: string; accounts: ProviderAccount[]; mappings?: Pick<AccountMapping, "providerAccountId" | "accountId">[] }

/** One Item is exchanged once, then explicitly mapped; provider credentials never leave this class. */
export class MappedPlaid {
  private readonly store: PlaidStore;
  private readonly call: (path: string, body: JsonObject) => Promise<unknown>;
  private readonly environment: "sandbox" | "production";
  private readonly now: () => number;
  constructor(
    store: PlaidStore,
    call: (path: string, body: JsonObject) => Promise<unknown>,
    environment: "sandbox" | "production",
    now: () => number = Date.now,
  ) { this.store = store; this.call = call; this.environment = environment; this.now = now; }

  async exchange(publicToken: string, householdId: string, institution: string): Promise<LinkSession> {
    if (!publicToken || publicToken.length > 1000) throw new Error("A valid public token is required.");
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicToken)));
    const id = `con_plaid_${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    let saved = await this.store.read("plaid_items", id);
    if (saved === null) {
      const exchanged = parseExchange(await this.call("/item/public_token/exchange", { public_token: publicToken }));
      await this.store.write("plaid_items", id, {
        ...plaidItemBody({ connectionId: id, householdId, ...exchanged, cursor: "", now: this.now() }),
        environment: this.environment, institution: institution.slice(0, 200) || "Plaid", mappings: [],
      } as JsonObject, null);
      saved = await this.store.read("plaid_items", id);
    }
    this.requireItem(saved, householdId);
    return this.describe(saved!);
  }

  async pending(householdId: string): Promise<LinkSession[]> {
    const items = await this.store.list("plaid_items", "household_id", householdId);
    const result: LinkSession[] = [];
    for (const item of items) {
      if (item._deleted || item.body.environment !== this.environment) continue;
      const connection = await this.store.read("connections", String(item.body.id));
      if (connection !== null && !connection._deleted) continue;
      // A partially completed mapping can be retried after a reload without exchanging another token.
      result.push(await this.describe(item));
    }
    return result;
  }

  async map(linkId: string, householdId: string, input: unknown): Promise<string> {
    const item = await this.store.read("plaid_items", linkId);
    this.requireItem(item, householdId);
    const available = await this.accounts(item!);
    if (!Array.isArray(input) || !input.length || input.length > 64) throw new Error("Choose between 1 and 64 accounts.");
    const generatedIds = new Map(await Promise.all(available.map(async provider => [provider.id, await this.accountId(linkId, provider.id)] as const)));
    const mappings = validateMappings(input.map(selection => {
      if (selection?.create === true) {
        if (selection.accountId !== undefined) throw new Error("Choose either a new or an existing account.");
        return { providerAccountId: selection.providerAccountId, accountId: generatedIds.get(selection.providerAccountId) };
      }
      return selection;
    }), available);
    const prior = (item!.body.mappings ?? []) as unknown as Mapping[];
    if (prior.length && JSON.stringify(prior.map(({ providerAccountId, accountId }) => ({ providerAccountId, accountId }))) !==
      JSON.stringify(mappings.map(({ providerAccountId, accountId }) => ({ providerAccountId, accountId })))) {
      throw new Error("This connection already has a different account mapping.");
    }
    const overlap = new BankOverlap(this.store, this.now);
    const creations: JsonObject[] = [];
    const connections = await this.store.list("connections", "household_id", householdId);
    for (const mapping of mappings) {
      await overlap.requireComplete(mapping.accountId, householdId);
      const provider = available.find(candidate => candidate.id === mapping.providerAccountId)!;
      const account = await this.store.read("accounts", mapping.accountId);
      const generated = mapping.accountId === generatedIds.get(provider.id);
      if (!account && generated) {
        const type = providerAccountType(provider);
        if (!type || provider.balance === null) throw new Error("The bank must supply a supported account type, currency and current balance before creating this account.");
        creations.push({
          id: mapping.accountId, household_id: householdId, created_at: this.now(), updated_at: this.now(),
          name: `${provider.name}${provider.mask ? ` (…${provider.mask})` : ""}`.trim().slice(0, 200) || "Bank account",
          type, currency: provider.currency, opening_balance: provider.balance,
          opening_date: new Date(this.now()).toISOString().slice(0, 10),
          institution: String(item!.body.institution ?? "Plaid"), connection_id: linkId, external_id: provider.id,
        });
      } else if (!account || account._deleted || account.body.household_id !== householdId || account.body.closed_at != null ||
        (generated && (account.body.connection_id !== linkId || account.body.external_id !== provider.id))) {
        throw new Error("Choose an open account in this household.");
      }
      if (account && !compatibleAccount(provider, account.body)) {
        throw new Error("Bank and Rational account types and currencies must match.");
      }
      if (connections.some(connection => !connection._deleted && connection.body.kind === "plaid" &&
        connection.body.status !== "disconnected" && connection.body.id !== linkId &&
        (connection.body.account_id === mapping.accountId || (connection.body.account_ids as string[] | undefined)?.includes(mapping.accountId)))) {
        throw new Error("This Rational account already has a bank connection.");
      }
    }
    // Save the plan before creating anything. A partial failure resumes the same
    // deterministic accounts, without duplicate accounts or resetting balances.
    if (!prior.length) await this.store.write("plaid_items", linkId, { ...item!.body, mappings: mappings as unknown as JsonObject[], updated_at: this.now() }, item!.revision);
    for (const body of creations) await this.store.write("accounts", String(body.id), body, null);
    const connection = await this.store.read("connections", linkId);
    if (connection === null) await this.store.write("connections", linkId, {
      id: linkId, household_id: householdId, created_at: this.now(), updated_at: this.now(),
      kind: "plaid", status: "connected", institution: String(item!.body.institution ?? "Plaid"),
      external_id: String(item!.body.item_id), account_ids: mappings.map(mapping => mapping.accountId),
    }, null);
    return linkId;
  }

  /** A bounded phase: one account, at most 150 transactions. An hourly dispatcher continues unfinished accounts. */
  async sync(linkId: string, householdId: string, force = false): Promise<{ pending: boolean; outcome: string }> {
    let item = await this.store.read("plaid_items", linkId);
    this.requireItem(item, householdId);
    const connection = await this.store.read("connections", linkId);
    if (!connection || connection._deleted || connection.body.household_id !== householdId || connection.body.status === "disconnected") {
      throw new Error("This bank connection is not active.");
    }
    const mappings = (item!.body.mappings ?? []) as unknown as Mapping[];
    if (!mappings.length) throw new Error("Reconnect this bank and map its accounts before syncing.");
    const due = (mapping: Mapping) => this.now() - mapping.lastSyncedAt >= 86_400_000;
    const selected = mappings.filter(due).sort((a, b) => a.lastSyncedAt - b.lastSyncedAt)[0] ??
      (force ? [...mappings].sort((a, b) => a.lastSyncedAt - b.lastSyncedAt)[0] : undefined);
    if (!selected) return { pending: false, outcome: "All accounts synced within the last day." };
    const account = await this.store.read("accounts", selected.accountId);
    if (!account || account._deleted || account.body.household_id !== householdId) throw new Error("The mapped account is unavailable.");
    const overlap = new BankOverlap(this.store, this.now);
    await overlap.requireComplete(selected.accountId, householdId);
    const providers = await this.accounts(item!);
    const provider = providers.find(candidate => candidate.id === selected.providerAccountId);
    if (!provider || !compatibleAccount(provider, account.body)) throw new Error("The bank account changed; review the connection.");
    let changed = 0;
    // Investment history uses a separate Plaid product; these accounts refresh balances only.
    let complete = !["depository", "credit", "loan"].includes(provider.type);
    let cursor = selected.cursor;
    const cycleStart = selected.cycleStartCursor ?? cursor;
    for (let pageNumber = 0; !complete && pageNumber < 1; pageNumber++) {
      let answer: unknown;
      try {
        answer = await this.call("/transactions/sync", {
          access_token: String(item!.body.access_token), count: 20,
          options: { account_id: selected.providerAccountId, include_original_description: true },
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        if ((error as { providerCode?: string }).providerCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
          selected.cursor = cycleStart;
          delete selected.cycleStartCursor;
          await this.saveMappings(item!, mappings);
        }
        throw error;
      }
      const page = parseSyncPage(answer);
      for (const entry of [...page.added, ...page.modified]) {
        if (entry.account_id !== selected.providerAccountId) throw new Error("The bank returned a transaction for an unmapped account.");
        if (entry.iso_currency_code !== null && entry.iso_currency_code !== provider.currency) throw new Error("The bank returned an unexpected currency.");
        if (entry.pending) {
          await overlap.remove(linkId, householdId, selected.accountId, entry.transaction_id);
          continue;
        }
        const fields = { account_id: selected.accountId, date: entry.date, amount: minorUnitsFromPlaid(entry.amount, provider.currency),
          currency: provider.currency, description: entry.merchant_name ?? entry.name, external_id: entry.transaction_id };
        await overlap.ingest(linkId, householdId, fields, entry.original_description ?? "");
        changed++;
      }
      for (const removal of page.removed) {
        await overlap.remove(linkId, householdId, selected.accountId, removal.transaction_id);
        changed++;
      }
      cursor = page.next_cursor;
      selected.cursor = cursor;
      const historyPending = page.transactions_update_status === "NOT_READY" || page.transactions_update_status === "INITIAL_UPDATE_COMPLETE";
      complete = !page.has_more && !historyPending;
      if (!page.has_more) delete selected.cycleStartCursor;
      else selected.cycleStartCursor = cycleStart;
      // Account-scoped cursor advances only after all writes in its page succeeded.
      item = await this.saveMappings(item!, mappings);
      // A finished page can still precede Plaid's historical pull. Let the
      // hourly dispatcher retry instead of claiming a successful daily sync.
      if (!page.has_more) break;
    }
    // A reconciliation entry keeps the imported opening balance and provider history from counting twice.
    // Do this even on bounded partial phases, so unfinished history does not inflate the displayed balance.
    const latest = (await this.accounts(item!)).find(candidate => candidate.id === selected.providerAccountId);
    if (!latest || latest.balance === null) throw new Error("The bank has not supplied a current balance; sync is incomplete.");
    await this.reconcile(account, latest.balance, linkId, householdId);
    const reviews = await overlap.reviews(householdId, selected.accountId);
    if (complete && reviews.length === 0) selected.lastSyncedAt = this.now();
    await this.saveMappings(item!, mappings);
    const pending = mappings.some(due);
    const remaining = mappings.filter(due).length;
    const outcome = reviews.length ? `Provider history ${complete ? "ready" : "pending"}; ${reviews.length} overlaps need review; balance reconciled, daily sync incomplete.` : pending ? `${remaining} account(s) still syncing; ${changed} transaction changes this phase.` : `${mappings.length} account(s) synced; balances reconciled.`;
    const current = await this.store.read("connections", linkId);
    if (current && current.body.status !== "disconnected") await this.store.write("connections", linkId, {
      ...current.body, status: "connected", updated_at: this.now(), last_sync_outcome: outcome,
      ...(!pending ? { last_sync_at: this.now() } : {}),
    }, current.revision);
    return { pending, outcome };
  }

  private async reconcile(account: FunctionDocument, balance: number, linkId: string, householdId: string): Promise<void> {
    const accountId = String(account.body.id);
    const id = transactionId(accountId, `balance-${linkId}`);
    const booked = await this.store.list("transactions", "account_id", accountId);
    const otherAmounts = booked.filter(entry => !entry._deleted && entry.body.id !== id).map(entry => {
      if (entry.body.household_id !== householdId || typeof entry.body.amount !== "number") throw new Error("Cannot reconcile an invalid account ledger.");
      return entry.body.amount;
    });
    const amount = reconciliationAmount(balance, Number(account.body.opening_balance),
      holdingsValue(account.body.holdings as unknown as Parameters<typeof holdingsValue>[0]), otherAmounts);
    const existing = await this.store.read("transactions", id);
    if (existing && !existing._deleted && existing.body.amount === amount) return;
    if (!existing && amount === 0) return;
    await this.store.write("transactions", id, {
      id, household_id: householdId, account_id: accountId, created_at: existing?.body.created_at ?? this.now(), updated_at: this.now(),
      date: new Date(this.now()).toISOString().slice(0, 10), amount, currency: String(account.body.currency),
      description: "Bank balance reconciliation", external_id: `balance-${linkId}`, tags: [], splits: [],
      adjustment: true, hidden: true, reviewed: true,
    }, existing?.revision ?? null);
  }

  private requireItem(item: FunctionDocument | null, householdId: string): void {
    if (!item || item._deleted || item.body.household_id !== householdId || item.body.environment !== this.environment) {
      throw new Error("The bank link is unavailable for this household and environment.");
    }
  }
  private async accounts(item: FunctionDocument): Promise<ProviderAccount[]> {
    return providerAccounts(await this.call("/accounts/get", { access_token: String(item.body.access_token) }));
  }
  private async describe(item: FunctionDocument): Promise<LinkSession> {
    const mappings = (item.body.mappings ?? []) as unknown as Mapping[];
    return { linkId: String(item.body.id), institution: String(item.body.institution ?? "Plaid"), accounts: await this.accounts(item),
      ...(mappings.length ? { mappings: mappings.map(({ providerAccountId, accountId }) => ({ providerAccountId, accountId })) } : {}) };
  }
  private async accountId(linkId: string, providerId: string): Promise<string> {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([linkId, providerId]))));
    // 128-bit identity leaves room for provider transaction IDs in transactionId().
    return `acc_plaid_${Array.from(hash.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  private async saveMappings(item: FunctionDocument, mappings: Mapping[]): Promise<FunctionDocument> {
    await this.store.write("plaid_items", String(item.body.id), { ...item.body, mappings: mappings as unknown as JsonObject[], updated_at: this.now() }, item.revision);
    const saved = await this.store.read("plaid_items", String(item.body.id));
    if (!saved) throw new Error("The sync cursor could not be saved.");
    return saved;
  }
}
