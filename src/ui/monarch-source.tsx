import { useEffect, useState } from "react";
import type { RationalApp } from "../data/rational.js";
import type { SourceRow } from "../../functions/shared/monarch.js";
export function MonarchSource({ app, transactionId }: { app: RationalApp; transactionId: string }) {
  const [source, setSource] = useState<SourceRow | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const hh = app.state.currentHouseholdId;
    if (app.monarch && hh && transactionId.startsWith("txn_m_"))
      void app.monarch
        .call<{ source: SourceRow | null }>("source", hh, { transactionId })
        .then((result) => {
          if (active) setSource(result.source);
        })
        .catch(() => {
          if (active) setError("Source metadata could not be loaded.");
        });
    return () => {
      active = false;
    };
  }, [app, transactionId]);
  if (error) return <p>{error}</p>;
  if (!source) return null;
  return (
    <details className="rounded-md border p-3">
      <summary>Original Monarch record</summary>
      <dl className="grid gap-2 mt-3 text-sm">
        <dt>Original statement</dt>
        <dd className="whitespace-pre-wrap">{source.statement || "Not supplied"}</dd>
        <dt>Source owner label</dt>
        <dd>{source.owner || "Not supplied"}</dd>
        <dt>Source review status</dt>
        <dd>{source.reviewed || "Unspecified"}</dd>
        <dt>Source tags</dt>
        <dd>{source.tags || "None"}</dd>
        <dt>Monarch transaction ID</dt>
        <dd>{source.sourceId || "Legacy export without ID"}</dd>
      </dl>
    </details>
  );
}
