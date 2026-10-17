import type { RationalAuth } from "../auth.js";
import type { AccountMapping, AccountSelection, ProviderAccount } from "../../functions/shared/plaid-mapping.js";

export interface PlaidLinkSession { linkId: string; institution: string; accounts: ProviderAccount[]; mappings?: Pick<AccountMapping, "providerAccountId" | "accountId">[] }

/**
 * Rational's Plaid routes on the `institution-sync` function, from the
 * browser. The browser's part in a Plaid link is deliberately small: ask the
 * function for a Link token, hand Plaid's widget the token, and hand the
 * short-lived public token straight back to the function. The access token
 * that comes out of the exchange never exists in this file's world — the
 * function writes it to a collection whose policy allows no application user
 * anything, and answers with a connection id.
 */
export class PlaidError extends Error {
  override readonly name = "PlaidError";
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    message: string,
    options: { status?: number | undefined; code?: string | undefined } = {},
  ) {
    super(message);
    this.status = options.status;
    this.code = options.code;
  }
}

export interface PlaidClient {
  /** Whether the deployment holds Plaid credentials; the UI asks before offering. */
  configured(): Promise<boolean>;
  status(): Promise<{ configured: boolean; environment: "sandbox" | "production" }>;
  linkToken(): Promise<string>;
  exchange(input: {
    readonly publicToken: string;
    readonly householdId: string;
    readonly institution: string;
  }): Promise<PlaidLinkSession>;
  pending(householdId: string): Promise<PlaidLinkSession[]>;
  map(linkId: string, householdId: string, mappings: AccountSelection[]): Promise<string>;
  sync(linkId: string, householdId: string): Promise<{ pending: boolean; outcome: string }>;
}

export interface PlaidClientOptions {
  /** The institution-sync function's URL; routes live under `/plaid`. */
  readonly url: string;
  readonly auth: RationalAuth;
  readonly fetch: typeof globalThis.fetch;
}

export class MakoPlaidClient implements PlaidClient {
  readonly #url: string;
  readonly #auth: RationalAuth;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: PlaidClientOptions) {
    this.#url = options.url;
    this.#auth = options.auth;
    this.#fetch = options.fetch;
  }

  async configured(): Promise<boolean> {
    return (await this.status()).configured;
  }

  async status(): Promise<{ configured: boolean; environment: "sandbox" | "production" }> {
    const answer = await this.#call<{ configured?: unknown; environment?: unknown }>("GET", "status", undefined);
    // Older deployments were sandbox-only. Never interpret missing metadata
    // as permission to offer real bank linking.
    return { configured: answer.configured === true, environment: answer.environment === "production" ? "production" : "sandbox" };
  }

  async linkToken(): Promise<string> {
    const answer = await this.#call<{ linkToken?: unknown }>("POST", "link-token", { mappingVersion: 4 });
    if (typeof answer.linkToken !== "string" || answer.linkToken === "") {
      throw new PlaidError("The institution did not issue a link token.");
    }
    return answer.linkToken;
  }

  async exchange(input: {
    readonly publicToken: string;
    readonly householdId: string;
    readonly institution: string;
  }): Promise<PlaidLinkSession> {
    const answer = await this.#call<PlaidLinkSession>("POST", "exchange", input);
    if (typeof answer.linkId !== "string" || !Array.isArray(answer.accounts)) {
      throw new PlaidError("The link was not recorded. Reload Connections to resume setup.");
    }
    return answer;
  }

  async pending(householdId: string): Promise<PlaidLinkSession[]> {
    return (await this.#call<{ links: PlaidLinkSession[] }>("POST", "pending", { householdId })).links;
  }

  async map(linkId: string, householdId: string, mappings: AccountSelection[]): Promise<string> {
    return (await this.#call<{ connectionId: string }>("POST", "map", { linkId, householdId, mappings })).connectionId;
  }

  async sync(linkId: string, householdId: string): Promise<{ pending: boolean; outcome: string }> {
    return this.#call("POST", "sync-one", { linkId, householdId });
  }

  async #call<T>(method: "GET" | "POST", route: string, body: unknown): Promise<T> {
    let accessToken: string;
    try {
      accessToken = await this.#auth.client.validAccessToken();
    } catch {
      throw new PlaidError("Sign in again to connect an institution.", {
        code: "unauthenticated",
      });
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/plaid/${route}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new PlaidError("The institution is unreachable while you are offline.", {
        code: "unavailable",
      });
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = errorOf(payload);
      throw new PlaidError(error.message, { status: response.status, code: error.code });
    }
    return payload as T;
  }
}

function errorOf(payload: unknown): { message: string; code: string | undefined } {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const record = error as { message?: unknown; code?: unknown };
      return {
        message: typeof record.message === "string" ? record.message : "The request was refused.",
        code: typeof record.code === "string" ? record.code : undefined,
      };
    }
  }
  return { message: "The request was refused.", code: undefined };
}

declare global {
  interface Window {
    Plaid?: {
      create(options: {
        token: string;
        onSuccess: (publicToken: string, metadata: unknown) => void;
        onExit: (error: unknown) => void;
      }): { open(): void };
    };
  }
}

/**
 * Plaid's Link widget, opened for one token. The script comes from Plaid's
 * own CDN and only when a person asks to link — never at page load, so a copy
 * of Rational that ignores Plaid never talks to it. Tests define
 * `window.Plaid` themselves, which is also the seam that keeps CI off the
 * network.
 */
export async function openPlaidLink(
  token: string,
): Promise<{ publicToken: string; institution: string }> {
  if (window.Plaid === undefined) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new PlaidError("Plaid's Link script could not be loaded."));
      document.head.append(script);
    });
  }
  const plaid = window.Plaid;
  if (plaid === undefined) throw new PlaidError("Plaid's Link script did not initialize.");
  return await new Promise((resolve, reject) => {
    const handler = plaid.create({
      token,
      onSuccess: (publicToken, metadata) => {
        resolve({ publicToken, institution: institutionNameOf(metadata) });
      },
      onExit: () => reject(new PlaidError("The link was not completed.")),
    });
    handler.open();
  });
}

function institutionNameOf(metadata: unknown): string {
  if (typeof metadata === "object" && metadata !== null && "institution" in metadata) {
    const institution = (metadata as { institution: unknown }).institution;
    if (typeof institution === "object" && institution !== null && "name" in institution) {
      const name = (institution as { name: unknown }).name;
      if (typeof name === "string" && name !== "") return name;
    }
  }
  return "Plaid";
}
