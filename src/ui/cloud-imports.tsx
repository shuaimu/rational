import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@mako-cloud/ui";
import type { ImportSummary, MonarchClient } from "../data/monarch.js";
import { routeHash } from "./router.js";

interface ImportStatus {
  jobs: ImportSummary[];
  checkedAt: number | null;
  error: string;
  enabled: boolean;
  online: boolean;
  refresh: () => Promise<void>;
}
const CloudImports = createContext<ImportStatus>({ jobs: [], checkedAt: null, error: "", enabled: false, online: false, refresh: async () => {} });
export const useCloudImports = () => useContext(CloudImports);

/** One read-only poll for the household, shared by the banner and import page. */
export function CloudImportsProvider({ client, householdId, online, children }: {
  client: MonarchClient | null;
  householdId: string | null;
  online: boolean;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<Pick<ImportStatus, "jobs" | "checkedAt" | "error">>({ jobs: [], checkedAt: null, error: "" });
  const inFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback((): Promise<void> => {
    if (!client || !householdId || !online) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    inFlight.current = client.list(householdId).then(({ jobs }) => {
      setSnapshot({ jobs, checkedAt: Date.now(), error: "" });
    }).catch(() => {
      setSnapshot(previous => ({ ...previous, error: "Import status is temporarily unavailable. Retrying automatically." }));
    }).finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, [client, householdId, online]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      // Schedule after completion: a busy cloud function must not pile up requests.
      if (active) timer = setTimeout(() => void poll(), 60_000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);
  return <CloudImports.Provider value={{ ...snapshot, refresh, enabled: !!client && !!householdId, online }}>{children}</CloudImports.Provider>;
}

export function CloudImportBanner() {
  const { jobs, checkedAt, error, enabled, online } = useCloudImports();
  const pending = jobs.filter(job => !["complete", "cancelled"].includes(job.state));
  if (!enabled || (!pending.length && !error && (checkedAt || !online))) return null;
  return (
    <Alert role="status" data-testid="cloud-import-status" className="rounded-none border-x-0 border-t-0">
      <AlertDescription className="grid gap-1 text-foreground">
        {!checkedAt && !error ? <div>Checking cloud import status…</div> : null}
        {pending.map(job => (
          <div key={job.id}>
            <strong>Monarch import · {job.state === "needs-review" ? "needs attention" : job.state}</strong>
            {" · "}{job.processed.toLocaleString()} / {job.rowCount.toLocaleString()} transactions
            {job.state === "importing" ? ` (${Math.floor(job.processed / Math.max(job.rowCount, 1) * 100)}%)` : ""}
            {". "}{job.state === "importing" ? "Bank linking waits for history and balance checks to finish." : job.message}
          </div>
        ))}
        <div className="text-xs text-muted-foreground">
          {!online ? "Offline · showing last known import status. " : error ? `${error} ` : "Progress refreshes automatically. "}
          {checkedAt ? `Last checked ${new Date(checkedAt).toLocaleTimeString()}. ` : ""}
          <a href={routeHash({ name: "settings", page: "import" })}>View import details</a>
        </div>
      </AlertDescription>
    </Alert>
  );
}
