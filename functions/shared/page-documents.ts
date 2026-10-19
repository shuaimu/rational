/** Never publish an aggregate from a silently truncated query. Runtime deadlines fail the pass instead. */
export async function allDocumentPages<T>(fetchPage: (cursor: string | null) => Promise<{
  documents: T[]; nextCursor?: string | null;
}>): Promise<T[]> {
  const documents: T[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await fetchPage(cursor);
    documents.push(...page.documents);
    cursor = page.nextCursor ?? null;
    if (cursor !== null) {
      if (seen.has(cursor)) throw new Error("The document query repeated a cursor; no partial balance snapshot was published.");
      seen.add(cursor);
    }
  } while (cursor !== null);
  return documents;
}
