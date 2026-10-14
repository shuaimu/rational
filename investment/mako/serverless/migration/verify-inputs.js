// A temporary, read-only cross-environment verifier. Only its private journal is writable.
const encoder = new TextEncoder();
export const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = async value => [...new Uint8Array(await crypto.subtle.digest(
  'SHA-256', encoder.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
class Mismatch extends Error {}
const check = (condition, code) => { if (!condition) throw new Mismatch(code); };
const terminal = new Set(['verified', 'blocked']);

export class InputVerifier {
  constructor({ source, destination, journal, plan, clock = Date.now, maxPages = 128, budgetMs = 15000, pageSize = 32 }) {
    check(plan.sourceEnvironment !== plan.destinationEnvironment, 'distinct_environments_required');
    check(plan.collection === 'robinlab_inputs' && Number.isSafeInteger(plan.count) && plan.count > 0, 'invalid_plan');
    check(/^[a-f0-9]{64}$/.test(plan.sourceHeadDigest) && /^[a-f0-9]{64}$/.test(plan.sourceVerificationDigest), 'missing_source_proof');
    check(plan.otherCollectionsVerified === 13 && plan.nativeReportsVerified === 9, 'missing_prior_parity');
    check(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 32, 'invalid_page_size');
    Object.assign(this, { source, destination, journal, plan, clock, maxPages, budgetMs, pageSize });
  }

  async write(row, body, run) {
    const mutationId = `verify_${await digest(canonical({ revision: row?.revision ?? null, body, run }))}`;
    const result = await this.journal.mutate(this.plan.id, {
      operation: row ? 'update' : 'create', expectedRevision: row?.revision ?? null,
      mutationId, schemaVersion: 1, body,
    });
    if (!['applied', 'replayed'].includes(result.status)) return null;
    return result.document ?? await this.journal.get(this.plan.id);
  }

  async fences() {
    const [sourceHead, destinationHead] = await Promise.all([
      this.source.head.get(this.plan.headId), this.destination.head.get(this.plan.headId),
    ]);
    check(sourceHead && !sourceHead._deleted && await digest(canonical(sourceHead.body)) === this.plan.sourceHeadDigest, 'source_head_changed');
    check(!destinationHead || destinationHead._deleted, 'destination_head_published');
  }

  async run(run) {
    const started = this.clock(), planDigest = await digest(canonical(this.plan));
    let row = await this.journal.get(this.plan.id);
    if (row) {
      check(!row._deleted && row.body.planDigest === planDigest, 'journal_plan_changed');
      if (terminal.has(row.body.status) || row.body.leaseUntil > started) return row.body;
    }
    const initial = row?.body ?? {
      id: this.plan.id, planDigest, status: 'running', verifiedCount: 0,
      sourceCursor: null, destinationCursor: null, lastOrder: null, chain: '0'.repeat(64),
      failures: 0, reason: null, startedAt: started,
    };
    row = await this.write(row, { ...initial, status: 'running', worker: run, leaseUntil: started + 40000, updatedAt: started }, run);
    if (!row) return { status: 'busy' };
    try {
      await this.fences();
      for (let page = 0; page < this.maxPages && this.clock() - started < this.budgetMs; page++) {
        const query = cursor => ({ predicates: [{ field: 'jobId', operator: 'gte', value: '' }], sort: [
          { field: 'jobId', direction: 'asc' }, { field: 'id', direction: 'asc' },
        ], cursor, limit: this.pageSize });
        const [left, right] = await Promise.all([
          this.source.inputs.query(query(row.body.sourceCursor)),
          this.destination.inputs.query(query(row.body.destinationCursor)),
        ]);
        check(Array.isArray(left.documents) && Array.isArray(right.documents) && left.documents.length <= this.pageSize, 'invalid_page');
        check([left.nextCursor, right.nextCursor].every(value => value === null || typeof value === 'string' && value.length > 0), 'invalid_cursor');
        check(left.documents.length === right.documents.length, 'row_count_mismatch');
        check((left.nextCursor === null) === (right.nextCursor === null), 'page_boundary_mismatch');
        check(left.nextCursor === null || left.nextCursor !== row.body.sourceCursor, 'source_cursor_stalled');
        check(right.nextCursor === null || right.nextCursor !== row.body.destinationCursor, 'destination_cursor_stalled');
        let lastOrder = row.body.lastOrder;
        for (let index = 0; index < left.documents.length; index++) {
          const a = left.documents[index], b = right.documents[index];
          check(!a._deleted && !b._deleted && a.schemaVersion === 1 && b.schemaVersion === 1, 'invalid_document');
          check(typeof a.body.id === 'string' && typeof a.body.jobId === 'string', 'invalid_identity');
          const order = [a.body.jobId, a.body.id];
          check(!lastOrder || order[0] > lastOrder[0] || order[0] === lastOrder[0] && order[1] > lastOrder[1], 'document_order_changed');
          check(canonical(a.body) === canonical(b.body), 'document_mismatch');
          lastOrder = order;
        }
        const verifiedCount = row.body.verifiedCount + left.documents.length;
        check(verifiedCount <= this.plan.count, 'unexpected_extra_rows');
        const finished = left.nextCursor === null;
        if (finished) {
          check(verifiedCount === this.plan.count, 'incomplete_collection');
          await this.fences();
        } else check(left.documents.length > 0, 'empty_nonterminal_page');
        const next = await this.write(row, {
          ...row.body, verifiedCount, sourceCursor: left.nextCursor, destinationCursor: right.nextCursor,
          lastOrder, chain: await digest(row.body.chain + canonical(left.documents.map(x => x.body))),
          status: finished ? 'verified' : 'running', failures: 0, reason: null,
          leaseUntil: finished ? 0 : row.body.leaseUntil, updatedAt: this.clock(),
        }, run);
        if (!next) return { status: 'lease-lost' };
        row = next;
        if (finished) return row.body;
      }
      await this.fences();
      const released = await this.write(row, { ...row.body, leaseUntil: 0, updatedAt: this.clock() }, run);
      return released?.body ?? { status: 'lease-lost' };
    } catch (error) {
      // Preserve the last durable cursor. A timed-out invocation is also safe to
      // resume after its lease; it never writes investment data or a portfolio head.
      const retryable = !(error instanceof Mismatch) &&
        (error instanceof TypeError || [408, 429, 500, 502, 503, 504].includes(error?.status) ||
          error?.name === 'MakoEdgeSdkError' && error.message === 'Mako service is unavailable');
      const failures = row.body.failures + 1;
      const next = await this.write(row, {
        ...row.body, status: retryable && failures < 10 ? 'retry' : 'blocked', failures,
        reason: error instanceof Mismatch ? error.message : retryable ? 'service_unavailable' : 'unexpected_service_error',
        serviceStatus: Number.isInteger(error?.status) ? error.status : null,
        leaseUntil: 0, updatedAt: this.clock(),
      }, run);
      return next?.body ?? { status: 'lease-lost' };
    }
  }
}
