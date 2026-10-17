import { useEffect, useState } from "react";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader } from "@mako-cloud/ui";
import type { RationalApp } from "../data/rational.js";
import { formatMinorUnits } from "../selectors/money.js";
interface Review {
  id: string;
  accountId: string;
  fields: { date: string; amount: number; currency: string; description: string };
  candidates: { id: string; date: string; description: string; amount: number; notes: string }[];
  reason: string;
  removal: boolean;
}
export function BankOverlapReview({ app }: { app: RationalApp }) {
  const [reviews, setReviews] = useState<Review[]>([]),
    [problem, setProblem] = useState(""),
    [busy, setBusy] = useState(false);
  const hh = app.state.currentHouseholdId;
  const load = async () => {
    if (app.monarch && hh)
      setReviews((await app.monarch.call<{ reviews: Review[] }>("reviews", hh)).reviews);
  };
  useEffect(() => {
    void load().catch((error) =>
      setProblem(error instanceof Error ? error.message : "Bank review is unavailable."),
    );
  }, [app, hh]);
  const resolve = async (id: string, transactionId: string | null) => {
    if (!app.monarch || !hh) return;
    setBusy(true);
    setProblem("");
    try {
      await app.monarch.call("resolve", hh, { id, transactionId });
      await load();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not save review.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <h3>Bank overlap review</h3>
        <p>
          {reviews.length} bank entries waiting for review. Unresolved entries are not added to your
          ledger.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {problem ? (
          <Alert variant="destructive">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void load().catch((error) => setProblem(String(error)))}
        >
          Refresh bank review
        </Button>
        {reviews.map((review) => (
          <article key={review.id} className="rounded-md border p-4 grid gap-3">
            <p className="font-semibold">
              {review.fields.date} · {review.fields.description} ·{" "}
              {formatMinorUnits(review.fields.amount, review.fields.currency)}
            </p>
            <p>{review.reason}</p>
            {review.candidates.map((candidate) => (
              <div key={candidate.id} className="flex flex-wrap items-center justify-between gap-2">
                <p>
                  {candidate.date} · {candidate.description} ·{" "}
                  {formatMinorUnits(candidate.amount, review.fields.currency)}
                  {candidate.notes ? ` · ${candidate.notes}` : ""}
                </p>
                <Button disabled={busy} onClick={() => void resolve(review.id, candidate.id)}>
                  {review.removal
                    ? "Accept bank removal"
                    : review.reason.startsWith("Financial")
                      ? "Accept bank correction"
                      : "Merge with existing"}
                </Button>
              </div>
            ))}
            {!review.removal && !review.reason.startsWith("Financial") ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void resolve(review.id, null)}
              >
                Keep separate
              </Button>
            ) : null}
          </article>
        ))}
      </CardContent>
    </Card>
  );
}
