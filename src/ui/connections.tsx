import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mako-cloud/ui";
import { CircleAlert, Landmark, Plug } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { compatibleAccount, providerAccountType, type AccountSelection } from "../../functions/shared/plaid-mapping.js";
import { openPlaidLink, type PlaidLinkSession } from "../data/plaid.js";
import type { RationalApp } from "../data/rational.js";
import type { ScopeSession } from "../data/scope.js";
import type { ConnectionDocument, HouseholdCollectionId } from "../model/types.js";
import { settingFor } from "../selectors/alerts.js";
import { useQuery } from "./hooks.js";
import { routeHash } from "./router.js";

/**
 * Connected accounts and what the scheduled sync last did with them.
 *
 * The connection is written from here; from then on the `institution-sync`
 * function owns its last sync time and outcome. Nothing on this screen syncs
 * anything: the schedule does that with nobody signed in, which is the point
 * of it. What the screen shows is whether that is working -- and, when it is
 * not, whether the household has asked to be told.
 */

/** A connection's status in words; a document from before statuses existed reads as connected. */
type ConnectionStatus = NonNullable<ConnectionDocument["status"]>;

const STATUS_LABELS: Readonly<Record<ConnectionStatus, string>> = {
  connected: "connected",
  error: "error",
  disconnected: "disconnected",
};

/** The one place a connection earns a colour: green while it lands, red once it failed. */
const STATUS_VARIANTS: Readonly<
  Record<ConnectionStatus, "positive" | "destructive" | "secondary">
> = {
  connected: "positive",
  error: "destructive",
  disconnected: "secondary",
};

export function ConnectionsScreen({
  app,
  session,
}: {
  app: RationalApp;
  session: ScopeSession<HouseholdCollectionId>;
}) {
  const requestedAccount = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("account");
  const connections = useQuery(session.collection("connections")?.find() ?? null);
  const accounts = useQuery(
    session.collection("accounts")?.find({ sort: [{ name: "asc" }] }) ?? null,
  );
  const alerts = useQuery(session.collection("alerts")?.find() ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  // Keep the linking entry point visible while checking availability or retrying.
  const [plaidReady, setPlaidReady] = useState(false);
  const [plaidLoading, setPlaidLoading] = useState(true);
  const [plaidProblem, setPlaidProblem] = useState<string | null>(null);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const householdId = app.state.currentHouseholdId;
  const [plaidEnvironment, setPlaidEnvironment] = useState<"sandbox" | "production">("sandbox");
  const [plaidBusy, setPlaidBusy] = useState(false);
  const [pendingLinks, setPendingLinks] = useState<PlaidLinkSession[]>([]);
  const [pendingLoaded, setPendingLoaded] = useState(app.config.mode !== "live");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPlaidLoading(true);
    setPlaidReady(false);
    setPlaidProblem(null);
    setPendingLoaded(app.config.mode !== "live");
    setPendingLinks([]);
    const load = async () => {
      if (app.plaid === null) return;
      const status = await app.plaid.status();
      if (cancelled) return;
      setPlaidReady(status.configured);
      setPlaidEnvironment(status.environment);
      if (status.configured && householdId && app.config.mode === "live") {
        const links = await app.plaid.pending(householdId);
        if (!cancelled) { setPendingLinks(links); setPendingLoaded(true); }
      }
    };
    void load().catch((error) => {
      if (!cancelled) setPlaidProblem(error instanceof Error ? error.message : "Bank linking is temporarily unavailable.");
    }).finally(() => { if (!cancelled) setPlaidLoading(false); });
    return () => { cancelled = true; };
  }, [app.plaid, app.config.mode, householdId, statusAttempt]);
  const institutions = connections.filter(
    (entry) => entry.kind === "institution" || entry.kind === "plaid",
  );
  const failing = institutions.filter((entry) => entry.status === "error");
  const syncAlert = settingFor(alerts, "sync_error");
  const accountName = (id: string | undefined) =>
    id === undefined ? "—" : (accounts.find((account) => account.id === id)?.name ?? id);

  const connectPlaid = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const client = app.plaid;
    const householdId = app.state.currentHouseholdId;
    if (client === null || householdId === null) return;
    setPlaidBusy(true);
    try {
      // Token from the function, widget from Plaid, public token straight
      // back to the function. No token that outlives this handler ever
      // touches the browser.
      const linked = await openPlaidLink(await client.linkToken());
      const pending = await client.exchange({
        publicToken: linked.publicToken,
        householdId,
        institution: linked.institution,
      });
      setPendingLinks(links => [...links.filter(link => link.linkId !== pending.linkId), pending]);
      form.reset();
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "the institution could not be linked");
    } finally {
      setPlaidBusy(false);
    }
  };

  const mapAccounts = async (event: FormEvent<HTMLFormElement>, link: PlaidLinkSession) => {
    event.preventDefault();
    const householdId = app.state.currentHouseholdId;
    if (!householdId || !app.plaid) return;
    const data = new FormData(event.currentTarget);
    const mappings = link.accounts.flatMap<AccountSelection>(account => {
      const accountId = String(data.get(account.id) ?? "");
      if (accountId === "__create__") return [{ providerAccountId: account.id, create: true }];
      return accountId ? [{ providerAccountId: account.id, accountId }] : [];
    });
    setPlaidBusy(true);
    try {
      await app.plaid.map(link.linkId, householdId, mappings);
      setPendingLinks(links => links.filter(candidate => candidate.linkId !== link.linkId));
      setProblem(null);
      setSyncMessage("Bank accounts linked. The cloud will import history and reconcile balances.");
      const result = await app.plaid.sync(link.linkId, householdId);
      setSyncMessage(result.outcome);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Account linking failed.");
    } finally { setPlaidBusy(false); }
  };

  const syncBank = async (linkId: string) => {
    const householdId = app.state.currentHouseholdId;
    if (!householdId || !app.plaid) return;
    setPlaidBusy(true);
    try { setSyncMessage((await app.plaid.sync(linkId, householdId)).outcome); setProblem(null); }
    catch (error) { setProblem(error instanceof Error ? error.message : "Bank sync failed."); }
    finally { setPlaidBusy(false); }
  };

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await app.writes?.connectInstitution({
        account_id: String(data.get("account_id") ?? ""),
        institution: String(data.get("institution") ?? ""),
        external_id: String(data.get("external_id") ?? ""),
      });
      form.reset();
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "the connection could not be saved");
    }
  };

  return (
    <section
      aria-labelledby="connections-title"
      data-testid="connections-screen"
      className="grid gap-6"
    >
      <div className="grid gap-1">
        <h1 id="connections-title" className="text-2xl">
          Connections
        </h1>
        <p className="text-sm text-muted-foreground">
          The institutions this household is linked to, and what the scheduled sync last did with
          them.
        </p>
      </div>
      {problem === null ? null : (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription className="block">{problem}</AlertDescription>
        </Alert>
      )}

      <Card aria-labelledby="plaid-title">
        <CardHeader>
          <h3 id="plaid-title" className="text-base font-semibold leading-none">
            Link a bank
          </h3>
          <CardDescription>
            {requestedAccount
              ? `Connect your bank, then match its account to ${accountName(requestedAccount)} to keep your imported history.`
              : "Connect your bank through Plaid to add accounts or link existing accounts, then sync automatically."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {plaidLoading ? <p role="status">Checking bank-linking availability…</p>
            : plaidProblem ? <Alert variant="destructive"><AlertDescription>
              Bank linking could not be loaded: {plaidProblem}
            </AlertDescription></Alert>
            : !plaidReady ? <p>Bank linking is not configured for this deployment. Plaid credentials must be configured before you can connect a bank.</p>
            : null}
          {!plaidLoading && (plaidProblem !== null || !plaidReady) ? (
            <Button variant="outline" onClick={() => setStatusAttempt(attempt => attempt + 1)}>Retry bank linking</Button>
          ) : null}
          {plaidReady && !plaidLoading && !plaidProblem ? <>
          {app.config.mode === "live" && plaidEnvironment === "sandbox" ? (
            <p className="text-sm text-muted-foreground">
              Real bank linking requires Plaid production access and production credentials configured for Rational.
              Your manually imported accounts remain available.
            </p>
          ) : <form
            className="grid gap-4"
            aria-label="Connect through Plaid"
            data-testid="plaid-connect"
            onSubmit={(event) => void connectPlaid(event)}
          >
            <div className="flex gap-2">
              <Button type="submit" disabled={plaidBusy || !pendingLoaded || pendingLinks.length > 0}>
                <Landmark />
                {plaidBusy ? "Linking…" : "Connect through Plaid"}
              </Button>
            </div>
          </form>}
          </> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-base font-semibold leading-none">Connected accounts</h3>
        </CardHeader>
        <CardContent className="grid gap-4">
          {institutions.length === 0 ? (
            <EmptyState
              icon={<Plug />}
              title="No connected accounts."
              description="A connected account syncs on its own."
            />
          ) : (
            <Table aria-label="Connected accounts">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Institution</TableHead>
                  <TableHead scope="col">Account</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Last sync</TableHead>
                  <TableHead scope="col">Outcome</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {institutions.map((connection) => {
                  const status: ConnectionStatus = connection.status ?? "connected";
                  return (
                    <TableRow
                      key={connection.id}
                      data-testid={`connection-${connection.id}`}
                      data-status={status}
                    >
                      <TableHead scope="row" className="h-auto p-2 text-foreground">
                        {connection.institution}
                      </TableHead>
                      <TableCell>{connection.account_ids?.length ? connection.account_ids.map(accountName).join(", ") : accountName(connection.account_id)}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANTS[status]} data-testid="status">
                          {STATUS_LABELS[status]}
                        </Badge>
                        {connection.kind === "plaid" && status !== "disconnected" ? <Button size="sm" variant="outline" disabled={plaidBusy} onClick={() => void syncBank(connection.id)}>Sync now</Button> : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground" data-testid="last-sync">
                        {connection.last_sync_at === undefined
                          ? "never"
                          : new Date(connection.last_sync_at).toLocaleString()}
                      </TableCell>
                      <TableCell data-testid="outcome">
                        {connection.last_sync_outcome ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          onClick={() =>
                            void app.writes?.setConnectionStatus(
                              connection.id,
                              status === "connected" ? "disconnected" : "connected",
                            )
                          }
                        >
                          {status === "connected" ? "Disconnect" : "Reconnect"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {/* A failing sync is decided server-side and arrives as a notification
              -- but only if the household asked for that kind. Say where that
              stands rather than letting a broken connection go quiet. */}
          <p
            className="max-w-prose text-sm text-muted-foreground"
            data-testid="sync-error-hint"
            data-alert={syncAlertState(syncAlert)}
          >
            {failing.length === 0
              ? "When a connection's sync fails, the sync itself raises a notification naming the institution; a connection that keeps failing stays one notification until it is fixed. "
              : `${failing.length === 1 ? "One connection is" : `${failing.length} connections are`} failing to sync; the sync raised a notification for each. `}
            {syncAlert === null
              ? "That notification is not set up yet — save “A connection that stopped syncing” under "
              : syncAlert.enabled === false
                ? "That notification is turned off — turn it on under "
                : "That notification is on; change it under "}
            <a href={routeHash({ name: "settings", page: "notifications" })}>Notifications</a>.
          </p>
        </CardContent>
      </Card>


      {requestedAccount ? <p>Choose the bank account that belongs to {accountName(requestedAccount)}. Other accounts stay skipped until explicitly selected.</p> : null}
      {syncMessage ? <p role="status">{syncMessage}</p> : null}
      {pendingLinks.map(link => (
        <Card key={link.linkId}>
          <CardHeader><h3>Add accounts from {link.institution}</h3>
            <CardDescription>Create accounts directly from your bank, including their balances and available transaction history. You can skip an account or connect it to an existing Rational account. Investment accounts currently import balances only.</CardDescription>
          </CardHeader>
          <CardContent>
            <form aria-label={`Add ${link.institution} accounts`} className="grid gap-4" onSubmit={event => void mapAccounts(event, link)}>
              {link.accounts.map(provider => {
                const saved = link.mappings?.find(mapping => mapping.providerAccountId === provider.id);
                const canCreate = providerAccountType(provider) !== null && provider.balance !== null;
                return (
                <Field key={provider.id} label={`${provider.name}${provider.mask ? ` (…${provider.mask})` : ""} · ${provider.currency}`} htmlFor={`map-${provider.id}`}>
                  <NativeSelect id={`map-${provider.id}`} name={provider.id} defaultValue={saved?.accountId ?? (link.mappings ? "" : requestedAccount && accounts.some(account=>account.id===requestedAccount && compatibleAccount(provider,account)) ? requestedAccount : "")}>
                    <option value="">Skip this account</option>
                    {canCreate ? <option value="__create__">Create account from bank</option> : null}
                    {saved && !accounts.some(account => account.id === saved.accountId) ? <option value={saved.accountId}>Resume creating account from bank</option> : null}
                    {accounts.filter(account => account.closed_at == null && compatibleAccount(provider, account)).map(account => (
                      <option key={account.id} value={account.id}>{account.name}</option>
                    ))}
                  </NativeSelect>
                </Field>
              ); })}
              <Button type="submit" disabled={plaidBusy}>{plaidBusy ? "Saving…" : "Add selected accounts"}</Button>
            </form>
          </CardContent>
        </Card>
      ))}

      {app.config.mode === "fake" ? <Card aria-labelledby="connect-title">
        <CardHeader>
          <h3 id="connect-title" className="text-base font-semibold leading-none">
            Connect an account
          </h3>
          <CardDescription>
            The simulated institution: it hands the scheduled sync a few transactions for whatever
            account id it is asked about.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            aria-label="Connect an account"
            onSubmit={(event) => void connect(event)}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Account" htmlFor="connect-account">
                <NativeSelect id="connect-account" name="account_id" defaultValue="" required>
                  <option value="">Choose an account</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Institution" htmlFor="connect-institution">
                <Input
                  id="connect-institution"
                  name="institution"
                  required
                  maxLength={200}
                  defaultValue="Simulated Bank"
                />
              </Field>
              <Field label="Their account id" htmlFor="connect-external-id">
                <Input
                  id="connect-external-id"
                  name="external_id"
                  required
                  maxLength={64}
                  placeholder="acct-1"
                />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button type="submit">
                <Plug />
                Connect
              </Button>
            </div>
          </form>
        </CardContent>
      </Card> : null}
    </section>
  );
}

/** Where the household stands on being told about a failing sync, for the hint's attribute. */
function syncAlertState(setting: { readonly enabled?: boolean } | null): "unset" | "off" | "on" {
  if (setting === null) return "unset";
  return setting.enabled === false ? "off" : "on";
}
