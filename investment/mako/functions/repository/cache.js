// Independent cache/log records use indexed pages and conditional point writes.
// The service key attached to these collections has no portfolio permissions.
export const CACHE_COLLECTIONS = ['historical_prices', 'latest_prices', 'provider_requests', 'split_fetch'];
const fields = {
  historical_prices: ['symbol', 'price_date', 'price', 'source', 'fetched_at', 'is_market_close'],
  latest_prices: ['symbol', 'latest_price_date', 'latest_price', 'source', 'fetched_at'],
  provider_requests: ['id', 'provider', 'endpoint', 'success', 'status_code', 'error', 'requested_at'],
  split_fetch: ['symbol', 'fetched_at'],
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const idValid = (v) => typeof v === 'string' && /^r_[0-9a-f]{64}$/.test(v);
const mutationIdValid = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(v);
const check = (condition) => { if (!condition) throw Object.assign(new Error('invalid_cache_request'), { status: 400 }); };
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256;
const timestamp = (v) => v === null || typeof v === 'string' && v.length <= 64;
const date = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const hex = (v) => [...new Uint8Array(v)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function validateDocument(kind, body) {
  check(exact(body, ['id', 'row']) && idValid(body.id) && exact(body.row, fields[kind]));
  const row = body.row;
  if (kind === 'provider_requests') {
    check(Number.isSafeInteger(row.id) && row.id > 0 && text(row.provider) && text(row.endpoint) && typeof row.success === 'boolean' && (row.status_code === null || Number.isInteger(row.status_code) && row.status_code >= 100 && row.status_code <= 599) && timestamp(row.requested_at));
    check(row.error === null || typeof row.error === 'string' && /^[a-z_]{1,64}$/.test(row.error));
  } else {
    check(text(row.symbol) && timestamp(row.fetched_at));
    if (kind === 'historical_prices') check(date(row.price_date) && Number.isFinite(row.price) && text(row.source) && typeof row.is_market_close === 'boolean');
    if (kind === 'latest_prices') check(date(row.latest_price_date) && Number.isFinite(row.latest_price) && text(row.source));
  }
  const key = kind === 'provider_requests' ? [row.id] : kind === 'historical_prices' ? [row.symbol, row.price_date] : [row.symbol];
  check(body.id === `r_${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(key))))}`);
}

function indexedQuery(kind, input) {
  check(exact(input, ['index', 'value', 'from', 'through', 'cursor', 'limit']));
  check(input.cursor === null || typeof input.cursor === 'string' && input.cursor.length <= 16384);
  check(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 500);
  const predicates = [], sort = [];
  if (input.index === 'all') {
    check(input.value === null && input.from === null && input.through === null);
    predicates.push({ field: 'id', operator: 'gte', value: 'r_' });
    sort.push({ field: 'id', direction: 'asc' });
  } else {
    const historical = kind === 'historical_prices';
    check(historical || kind === 'provider_requests');
    const time = historical ? 'row.price_date' : 'row.requested_at';
    if (input.index === (historical ? 'symbol' : 'provider')) {
      check(text(input.value));
      const field = historical ? 'row.symbol' : 'row.provider';
      predicates.push({ field, operator: 'eq', value: input.value });
      // Equality columns are implicit; Mako sort starts after that prefix.
    } else check(input.index === 'date' && input.value === null);
    check(typeof input.from === 'string' && input.from.length <= 64 && typeof input.through === 'string' && input.through.length <= 64 && input.from <= input.through);
    predicates.push({ field: time, operator: 'gte', value: input.from }, { field: time, operator: 'lte', value: input.through });
    sort.push({ field: time, direction: 'asc' }, { field: 'id', direction: 'asc' });
  }
  return { predicates, sort, cursor: input.cursor, limit: input.limit };
}

export async function cacheAction(input, documents) {
  check(CACHE_COLLECTIONS.includes(input.kind));
  if (input.action === 'cache_read') {
    check(exact(input, ['action', 'kind', 'id']) && idValid(input.id));
    return documents(input.kind).get(input.id);
  }
  if (input.action === 'cache_query') {
    check(exact(input, ['action', 'kind', 'query']));
    const query = indexedQuery(input.kind, input.query);
    return documents(input.kind).query(query);
  }
  if (input.action === 'cache_create_batch') {
    check(input.kind === 'provider_requests' && exact(input, ['action', 'kind', 'records']));
    check(Array.isArray(input.records) && input.records.length > 0 && input.records.length <= 16);
    for (const record of input.records) {
      check(exact(record, ['body', 'mutationId']) && mutationIdValid(record.mutationId));
      await validateDocument(input.kind, record.body);
    }
    check(new Set(input.records.map((r) => r.body.id)).size === input.records.length);
    check(new Set(input.records.map((r) => r.mutationId)).size === input.records.length);
    const results = [];
    for (let offset = 0; offset < input.records.length; offset += 4) {
      // Settle every started write before returning an error. A caller can then
      // reconcile/retry the same create-only records with their durable IDs.
      const settled = await Promise.allSettled(input.records.slice(offset, offset + 4).map(async (record) => ({
        id: record.body.id,
        result: await documents(input.kind).mutate(record.body.id, {
          mutationId: record.mutationId, operation: 'create', expectedRevision: null,
          schemaVersion: 1, body: record.body,
        }),
      })));
      const failure = settled.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      results.push(...settled.map((result) => result.value));
    }
    return { results };
  }
  check(input.action === 'cache_mutate' && exact(input, ['action', 'kind', 'mutationId', 'operation', 'expectedRevision', 'body']));
  check(mutationIdValid(input.mutationId));
  check(['create', 'update', 'delete'].includes(input.operation));
  check(input.expectedRevision === null || typeof input.expectedRevision === 'string' && input.expectedRevision.length > 0 && input.expectedRevision.length <= 1024);
  // Historical usage is append-only. No admin cache operation may erase it.
  check(input.kind !== 'provider_requests' || input.operation === 'create');
  await validateDocument(input.kind, input.body);
  const mutation = { mutationId: input.mutationId, operation: input.operation, expectedRevision: input.expectedRevision, schemaVersion: 1, body: input.body };
  const result = await documents(input.kind).mutate(input.body.id, mutation);
  // Point reads intentionally hide tombstones. A conflicting create exposes
  // their revision; restore only after proving there is no live record. The
  // revision check protects against a concurrent writer between these calls.
  if (input.operation === 'create' && input.kind !== 'provider_requests' && result.status === 'conflict' && result.currentRevision && !await documents(input.kind).get(input.body.id)) {
    return documents(input.kind).mutate(input.body.id, { ...mutation, mutationId: `${input.mutationId}_restore`, operation: 'update', expectedRevision: result.currentRevision });
  }
  return result;
}
