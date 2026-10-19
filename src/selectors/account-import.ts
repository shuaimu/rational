import type { ImportSummary } from "../data/monarch.js";

/** Navigation may proceed with unknown status; the cloud validates the actual link. */
export function accountImportStatus(jobs: readonly ImportSummary[], accountId: string): {
  blocked: boolean;
  message: string;
} {
  const relevant = jobs.filter(job => job.accounts.some(account => account.accountId === accountId));
  const unfinished = relevant.find(job => !["complete", "uploading"].includes(job.state));
  if (unfinished) {
    return {
      blocked: true,
      message: unfinished.state === "cancelled"
        ? "History import cancelled. Review import details before linking this account."
        : "History import is unfinished. Complete and reconcile it before linking this account.",
    };
  }
  return { blocked: false, message: "" };
}
