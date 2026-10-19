import type { PlaidStore } from "./plaid-mapped.ts";

/** Counts and durations only; never record source rows, IDs, credentials or amounts. */
export class ImportPerformance {
  private readonly startedAt: number;
  private active = 0;
  private peak = 0;
  private readonly calls = { read: 0, write: 0, list: 0, remove: 0 };
  private readonly milliseconds = { read: 0, write: 0, list: 0, remove: 0 };
  rows = 0;
  phase = "unknown";
  readonly store: PlaidStore;
  private readonly now: () => number;
  constructor(store: PlaidStore, now = Date.now) {
    this.now = now;
    this.startedAt = now();
    const measure = async <T>(kind: keyof typeof this.calls, run: () => Promise<T>): Promise<T> => {
      const start = now();
      this.calls[kind]++;
      this.peak = Math.max(this.peak, ++this.active);
      try { return await run(); }
      finally { this.milliseconds[kind] += now() - start; this.active--; }
    };
    this.store = {
      read: (...args) => measure("read", () => store.read(...args)),
      write: (...args) => measure("write", () => store.write(...args)),
      list: (...args) => measure("list", () => store.list(...args)),
      remove: (...args) => measure("remove", () => store.remove(...args)),
    };
  }
  snapshot() {
    return {
      phase: this.phase, rows: this.rows, startedAt: this.startedAt,
      beforeCheckpointMs: this.now() - this.startedAt,
      calls: { ...this.calls }, milliseconds: { ...this.milliseconds }, peakRequests: this.peak,
    };
  }
}
