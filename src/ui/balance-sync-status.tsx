import { LoaderCircle } from "lucide-react";
import { useMemo } from "react";
import { distinctUntilChanged, map, of, switchMap, timer } from "rxjs";

import type { RationalApp } from "../data/rational.js";
import type { ScopeSession } from "../data/scope.js";
import type { HouseholdCollectionId } from "../model/types.js";
import { useBehavior, useObservable } from "./hooks.js";

/** Balances use the local replica, which can contain only part of a pull. */
export function BalanceSyncStatus({ app, session, transactionCount }: {
  app: RationalApp;
  session: ScopeSession<HouseholdCollectionId>;
  transactionCount: number;
}) {
  const state = useBehavior(app.state$);
  const activity$ = useMemo(() => {
    return app.state$.pipe(
      map(state => state.household?.syncing ?? false),
      distinctUntilChanged(),
      // Keep the indicator through short gaps between batches and let local
      // query subscriptions render the last batch before removing it.
      switchMap((active) => active ? of(true) : timer(300).pipe(map(() => false))),
    );
  }, [app, session]);
  const active = useObservable(activity$, true);
  const initial = state.household?.initialSynced !== true;
  const offline = state.connectivity !== "online";
  const paused = state.household?.recovery.kind !== "active" ||
    (initial && state.household.lastError !== null);
  if (!offline && !paused && !initial && !active) return null;

  const refreshing = !offline && !paused;
  return (
    <div data-testid="balance-sync-status" className="grid gap-1 text-sm text-muted-foreground">
      <p role="status" className="m-0 flex items-center gap-2">
        {refreshing ? <LoaderCircle aria-hidden="true" className="size-3.5 motion-safe:animate-spin" /> : null}
        <span>{offline ? "Offline — showing saved balances." : paused
          ? "Balance refresh paused. Totals may be incomplete."
          : "Refreshing balances… Totals may change."}</span>
      </p>
      {refreshing || initial ? (
        <p className="m-0 text-xs tabular-nums">
          {transactionCount.toLocaleString()} transactions loaded on this device
        </p>
      ) : null}
    </div>
  );
}
