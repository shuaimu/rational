import { cacheAction } from './cache.js';
const CONTENT_ID = /^[pmc]_[0-9a-f]{64}$/;
const PUBLIC_TABLES = ['accounts', 'tickers', 'transactions', 'ticker_splits', 'account_value_snapshots', 'broker_balances'];
const PRIVATE_TABLES = ['snaptrade_accounts', 'snaptrade_users'];
const PUBLIC_FIELDS = {
  broker_balances: ['account_id', 'balance'],
  accounts: ['id', 'code', 'name', 'account_type'],
  tickers: ['id', 'symbol', 'name'],
  transactions: ['id', 'account_id', 'ticker_id', 'transaction_type', 'quantity', 'price', 'cost', 'fees', 'date', 'option_type', 'strike_price', 'expiration_date', 'option_code', 'status', 'source', 'created_at', 'updated_at'],
  ticker_splits: ['symbol', 'split_date', 'multiplier'],
  account_value_snapshots: ['account_id', 'as_of_date', 'computed_value', 'broker_value', 'created_at'],
};
const COLLECTIONS = { public: 'portfolio_public', private: 'portfolio_private', command: 'portfolio_commands', head: 'portfolio_heads' };
const utf8 = new TextEncoder();
// Closed diagnostics only: upstream messages may contain document or credential data.
const UPSTREAM_REASONS = ['document mutation is unavailable', 'document storage is unavailable', 'document sequencer is unavailable', 'quota authority is unavailable', 'collection schema is unavailable', 'service authorization is unavailable'];
const UPSTREAM_CODES = ['invalid_request', 'unauthenticated', 'permission_denied', 'not_found', 'conflict', 'schema_mismatch', 'checkpoint_expired', 'rate_limited', 'quota_exceeded', 'unavailable', 'internal'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeId = (value) => Number.isSafeInteger(value) && value > 0;
const ref = (value, prefix) => exact(value, ['id', 'bytes']) && typeof value.id === 'string' && CONTENT_ID.test(value.id) && value.id.startsWith(`${prefix}_`) && Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= 32768;
const sameRef = (a, b) => a?.id === b?.id && a?.bytes === b?.bytes;
const counters = (value) => exact(value, ['account', 'ticker', 'transaction', 'brokerage_user']) && Object.values(value).every((id) => id === null || safeId(id));
const sameCounters = (a, b) => counters(a) && counters(b) && Object.keys(a).every((key) => a[key] === b[key]);
const identity = (value) => exact(value, ['id', 'request_hash']) && typeof value.id === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value.id) && /^[0-9a-f]{64}$/.test(value.request_hash);
class Failure extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const fail = (status, code) => { throw new Failure(status, code); };
const ensure = (condition, status = 400, code = 'invalid_request') => { if (!condition) fail(status, code); };

async function content(document, prefix) {
  ensure(exact(document, ['id', 'payload']) && typeof document.id === 'string' && CONTENT_ID.test(document.id) && document.id.startsWith(`${prefix}_`) && typeof document.payload === 'string');
  const bytes = utf8.encode(document.payload);
  ensure(bytes.length > 0 && bytes.length <= 32768, 413, 'payload_too_large');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  ensure(document.id === `${prefix}_${digest}`, 409, 'content_mismatch');
  try { return JSON.parse(document.payload); }
  catch { fail(400, 'invalid_payload'); }
}

const headValid = (value) => exact(value, ['id', 'format', 'sequence', 'public_root', 'private_root', 'command', 'next_ids']) && value.id === 'portfolio' && value.format === 1 && safeId(value.sequence) && ref(value.public_root, 'm') && ref(value.private_root, 'm') && ref(value.command, 'c') && counters(value.next_ids);
const commandValid = (value) => exact(value, ['format', 'identity', 'sequence', 'predecessor', 'public_root', 'private_root', 'next_ids', 'response']) && value.format === 1 && identity(value.identity) && safeId(value.sequence) && (value.predecessor === null || ref(value.predecessor, 'c')) && ref(value.public_root, 'm') && ref(value.private_root, 'm') && counters(value.next_ids);

function manifestValid(value, visibility) {
  return exact(value, ['format', 'visibility', 'children']) && value.format === 1 && value.visibility === visibility && Array.isArray(value.children) && value.children.length <= 16 && value.children.every((child) => {
    if (!object(child)) return false;
    if (child.kind === 'manifest') return exact(child, ['kind', 'content']) && ref(child.content, 'm');
    return exact(child, ['kind', 'table', 'bucket', 'content']) && child.kind === 'partition' && (visibility === 'public' ? PUBLIC_TABLES : PRIVATE_TABLES).includes(child.table) && typeof child.bucket === 'string' && child.bucket.length <= 256 && ref(child.content, 'p');
  }) && new Set(value.children.map((child) => child.content.id)).size === value.children.length;
}

function partitionValid(value, visibility) {
  return exact(value, ['format', 'table', 'bucket', 'rows']) && value.format === 1 && (visibility === 'public' ? PUBLIC_TABLES : PRIVATE_TABLES).includes(value.table) && typeof value.bucket === 'string' && value.bucket.length <= 256 && Array.isArray(value.rows) && value.rows.length > 0 && value.rows.every((row) => visibility === 'public' ? exact(row, PUBLIC_FIELDS[value.table]) : object(row));
}

function respond(value, status = 200) {
  const serialized = JSON.stringify(value);
  if (utf8.encode(serialized).length > 900000) return Response.json({ error: 'response_too_large' }, { status: 413 });
  // The Mako transport owns Cache-Control, including on authentication failures.
  return new Response(serialized, { status, headers: { 'Content-Type': 'application/json' } });
}

export function createRepositoryHandler({ workerId, authenticate, documents }) {
  // Always obtain a fresh client: each SDK client carries one quota request ID.
  const read = (collection, id) => documents(collection).get(id);
  const verifiedRead = async (collection, reference, prefix) => {
    const record = await read(collection, reference.id);
    ensure(record && !record._deleted && record.schemaVersion === 1, 409, 'incomplete_manifest');
    ensure(utf8.encode(record.body?.payload ?? '').length === reference.bytes, 409, 'content_mismatch');
    const value = await content(record.body, prefix);
    ensure(record.body.id === reference.id, 409, 'content_mismatch');
    return value;
  };
  const roots = async (value) => {
    const publicRoot = await verifiedRead(COLLECTIONS.public, value.public_root, 'm');
    const privateRoot = await verifiedRead(COLLECTIONS.private, value.private_root, 'm');
    ensure(manifestValid(publicRoot, 'public') && manifestValid(privateRoot, 'private'), 409, 'content_mismatch');
  };
  return async (request) => {
    try {
      ensure(workerId, 503, 'not_configured');
      const user = await authenticate(request);
      ensure(user?.id === workerId && user.status === 'active', 403, 'permission_denied');
      ensure(request.method === 'POST', 405, 'method_not_allowed');
      const bytes = await request.arrayBuffer();
      ensure(bytes.byteLength <= 210000, 413, 'payload_too_large');
      let input;
      try { input = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { fail(400, 'invalid_request'); }
      ensure(object(input));
      if (typeof input.action === 'string' && input.action.startsWith('cache_')) {
        const result = await cacheAction(input, documents);
        return respond(result, result?.status === 'conflict' ? 409 : 200);
      }
      if (input.action === 'read') {
        ensure(exact(input, ['action', 'kind', 'id']) && typeof input.kind === 'string' && Object.hasOwn(COLLECTIONS, input.kind));
        ensure(input.kind === 'head' ? input.id === 'portfolio' : typeof input.id === 'string' && CONTENT_ID.test(input.id));
        return respond(await read(COLLECTIONS[input.kind], input.id));
      }
      if (input.action === 'stage') {
        ensure(exact(input, ['action', 'kind', 'document']) && ['public', 'private', 'command'].includes(input.kind));
        const prefix = typeof input.document?.id === 'string' ? input.document.id.slice(0, 1) : null;
        ensure(input.kind === 'command' ? prefix === 'c' : ['p', 'm'].includes(prefix));
        const value = await content(input.document, prefix);
        if (prefix === 'p') ensure(partitionValid(value, input.kind));
        if (prefix === 'm') {
          ensure(manifestValid(value, input.kind));
          for (const child of value.children) {
            const childValue = await verifiedRead(COLLECTIONS[input.kind], child.content, child.kind === 'manifest' ? 'm' : 'p');
            ensure(child.kind === 'manifest' ? manifestValid(childValue, input.kind) : partitionValid(childValue, input.kind) && childValue.table === child.table && childValue.bucket === child.bucket, 409, 'content_mismatch');
          }
        }
        if (prefix === 'c') {
          ensure(commandValid(value));
          await roots(value);
          if (value.predecessor) {
            const parent = await verifiedRead(COLLECTIONS.command, value.predecessor, 'c');
            ensure(commandValid(parent) && parent.sequence + 1 === value.sequence, 409, 'content_mismatch');
          } else ensure(value.sequence === 1);
        }
        const result = await documents(COLLECTIONS[input.kind]).mutate(input.document.id, {
          mutationId: `stage_${input.document.id}`, operation: 'create', expectedRevision: null, schemaVersion: 1, body: input.document,
        });
        if (result.status === 'conflict') {
          // Receipts may expire; matching immutable content remains safe to reuse.
          const stored = await read(COLLECTIONS[input.kind], input.document.id);
          ensure(stored && !stored._deleted && stored.body.id === input.document.id && stored.body.payload === input.document.payload, 409, 'content_mismatch');
          return respond({ status: 'reused', id: input.document.id });
        }
        return respond({ status: result.status, id: input.document.id });
      }
      if (input.action === 'commit') {
        ensure(exact(input, ['action', 'expectedRevision', 'head']) && headValid(input.head));
        ensure(input.expectedRevision === null || typeof input.expectedRevision === 'string' && input.expectedRevision.length > 0 && input.expectedRevision.length <= 1024);
        const previous = await read(COLLECTIONS.head, 'portfolio');
        if ((previous?.revision ?? null) !== input.expectedRevision) return respond({ status: 'conflict' }, 409);
        ensure(!previous || !previous._deleted && headValid(previous.body), 409, 'content_mismatch');
        ensure(input.head.sequence === (previous?.body.sequence ?? 0) + 1, 409, 'sequence_conflict');
        if (previous) for (const key of Object.keys(previous.body.next_ids)) {
          const before = previous.body.next_ids[key], after = input.head.next_ids[key];
          ensure(before === null ? after === null : after === null || after >= before, 409, 'identifier_reuse');
        }
        const command = await verifiedRead(COLLECTIONS.command, input.head.command, 'c');
        ensure(commandValid(command) && command.sequence === input.head.sequence && sameRef(command.public_root, input.head.public_root) && sameRef(command.private_root, input.head.private_root) && sameCounters(command.next_ids, input.head.next_ids), 409, 'content_mismatch');
        ensure(previous ? sameRef(command.predecessor, previous.body.command) : command.predecessor === null, 409, 'history_conflict');
        await roots(input.head);
        const result = await documents(COLLECTIONS.head).mutate('portfolio', {
          mutationId: `publish_${input.head.command.id}`, operation: previous ? 'update' : 'create', expectedRevision: input.expectedRevision, schemaVersion: 1, body: input.head,
        });
        return respond(result, result.status === 'conflict' ? 409 : 200);
      }
      fail(400, 'invalid_request');
    } catch (error) {
      if (error instanceof Failure) return respond({ error: error.code }, error.status);
      if (error?.status === 400) return respond({ error: 'invalid_request' }, 400);
      if ([401, 403, 409].includes(error?.status)) return respond({ error: ({ 401: 'unauthenticated', 403: 'permission_denied', 409: 'conflict' })[error.status] }, error.status);
      if (error?.status === 429) return respond({ error: 'throttled', retryAfterMs: Math.max(1000, Math.min(60000, Number(error?.retry?.afterMs) || 1000)) }, 429);
      return respond({ error: 'unavailable', retryAfterMs: 1000,
        ...(Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? { upstreamStatus: error.status } : {}),
        ...(UPSTREAM_CODES.includes(error?.code) ? { upstreamCode: error.code } : {}),
        ...(UPSTREAM_REASONS.includes(error?.message) ? { upstreamReason: error.message } : {}),
      }, 503);
    }
  };
}
