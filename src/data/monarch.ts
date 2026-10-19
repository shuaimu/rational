import type { RationalAuth } from "../auth.js";
import type { MonarchManifest, SourceRow } from "../../functions/shared/monarch.js";
export interface ImportSummary {
  id: string;
  state: string;
  processed: number;
  rowCount: number;
  created: number;
  duplicates: number;
  conflicts: number;
  message: string;
  accounts: { source: string; accountId: string; verified: boolean }[];
}
export class MonarchClient {
  readonly #url: string;
  readonly #auth: RationalAuth;
  readonly #fetch: typeof fetch;
  constructor(url: string, auth: RationalAuth, fetcher: typeof fetch) {
    this.#url = url;
    this.#auth = auth;
    this.#fetch = fetcher;
  }
  async call<T>(
    route: string,
    householdId: string,
    input: Record<string, unknown> = {},
  ): Promise<T> {
    const token = await this.#auth.client.validAccessToken();
    if (!token) throw new Error("Sign in before importing history.");
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await this.#fetch(`${this.#url}/monarch/${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, householdId, ...input }),
      });
      // A bounded cloud phase holds the single writer slot. Retry only a rejected
      // admission; never automatically replay an accepted phase after a timeout.
      if (response.status !== 429 || attempt >= 8) break;
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 10000)));
    }
    const payload = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) throw new Error(response.status === 429 ? "The cloud is busy with another request. Please retry shortly." : payload.error?.message ?? "The cloud import is unavailable.");
    return payload as T;
  }
  list(householdId: string) {
    return this.call<{ jobs: ImportSummary[] }>("list", householdId);
  }
  start(householdId: string, manifest: MonarchManifest) {
    return this.call<ImportSummary>("start", householdId, { manifest });
  }
  upload(householdId: string, id: string, index: number, rows: SourceRow[]) {
    return this.call("upload", householdId, { id, index, rows });
  }
  action(householdId: string, id: string, action: "seal" | "advance" | "status" | "cancel" | "resume") {
    return this.call<ImportSummary>(action, householdId, { id });
  }
}
