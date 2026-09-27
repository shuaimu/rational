import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export class StageError extends Error {
  constructor(code, status = 0, retryAfterMs = 0) {
    super(code); this.name = 'StageError'; this.code = code;
    this.status = status; this.retryAfterMs = retryAfterMs;
  }
}
export const retryable = (error) => error.code === 'network_unavailable' || [408, 425, 429, 500, 502, 503, 504].includes(error.status);
export const mutationId = (body) => 'migration_' + createHash('sha256').update(JSON.stringify(body)).digest('hex');
export function verifyDocument(document, expected) {
  if (!document || document._deleted !== false || document.schemaVersion !== 1 || !isDeepStrictEqual(document.body, expected)) throw new StageError('destination_collision');
}

// After an ambiguous response, read every attempted key before retrying only
// missing records. Existing data is accepted only when its complete body matches.
export async function createRecords(kind, bodies, call, wait) {
  let pending = bodies;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const response = await call(kind === 'provider_requests'
        ? { action: 'cache_create_batch', kind, records: pending.map((body) => ({ body, mutationId: mutationId(body) })) }
        : { action: 'cache_mutate', kind, operation: 'create', expectedRevision: null, body: pending[0], mutationId: mutationId(pending[0]) });
      const results = kind === 'provider_requests' ? response.results : [{ id: pending[0].id, result: response }];
      if (!Array.isArray(results) || results.length !== pending.length) throw new StageError('invalid_gateway_response');
      for (const [index, item] of results.entries()) {
        if (item.id !== pending[index].id) throw new StageError('invalid_gateway_response');
        if (item.result.status === 'conflict') verifyDocument(await call({ action: 'cache_read', kind, id: item.id }), pending[index]);
        else {
          if (!['applied', 'replayed'].includes(item.result.status)) throw new StageError('invalid_gateway_response');
          verifyDocument(item.result.document, pending[index]);
        }
      }
      return bodies.length;
    } catch (error) {
      if (!retryable(error) && error.status !== 409) throw error;
      const missing = [];
      for (const body of pending) {
        const current = await call({ action: 'cache_read', kind, id: body.id });
        if (current === null) missing.push(body);
        else verifyDocument(current, body);
      }
      if (!missing.length) return bodies.length;
      pending = missing;
      if (attempt === 6) throw new StageError('gateway_retry_exhausted', error.status);
      await wait(Math.min(30000, Math.max(error.retryAfterMs || 0, 1000 * 2 ** attempt)));
    }
  }
  throw new StageError('gateway_retry_exhausted');
}
