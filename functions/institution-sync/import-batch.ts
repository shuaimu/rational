export const IMPORT_BATCH_ROWS = 8;

/** Independent identities overlap I/O; repeats keep source order. Drain before checkpoint/error. */
export async function mapImportBatch<T, R>(
  rows: readonly T[], key: (row: T) => string, work: (row: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (rows.length > IMPORT_BATCH_ROWS) throw new Error("Import batch exceeds its concurrency bound.");
  // Resolve keys before launching anything, including when malformed input throws.
  const keys = rows.map(key);
  const tails = new Map<string, Promise<R>>();
  const pending = rows.map((row, index) => {
    const previous = tails.get(keys[index]!);
    const next = (previous ?? Promise.resolve()).then(() => work(row, index));
    tails.set(keys[index]!, next);
    return next;
  });
  const results = await Promise.allSettled(pending);
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.map(result => (result as PromiseFulfilledResult<R>).value);
}
