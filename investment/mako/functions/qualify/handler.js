// Synthetic qualification only. This is not the production portfolio gateway.
const ID = /^q_[a-zA-Z0-9_-]{1,98}$/;
const own = (value, field) => Object.hasOwn(value, field);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && fields.length === Object.keys(value).length && fields.every((field) => own(value, field));
// Mako's HTTP transport owns Cache-Control and supplies no-store itself.
// Returning that reserved header from a function makes the gateway reject the response.
const respond = (body, status = 200) => Response.json(body, { status });

export function createQualificationHandler({ workerId, authenticate, documentClient }) {
  return async function handle(request) {
    try {
      if (!workerId) return respond({ error: 'not_configured' }, 503);
      const user = await authenticate(request);
      if (user?.id !== workerId || user?.status !== 'active') return respond({ error: 'permission_denied' }, 403);
      if (request.method !== 'POST') return respond({ error: 'method_not_allowed' }, 405);
      // The hosted gateway also limits payloads; enforce a small synthetic request bound here.
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 210_000) return respond({ error: 'payload_too_large' }, 413);
      let input;
      try { input = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return respond({ error: 'invalid_request' }, 400); }
      if (!object(input) || typeof input.id !== 'string' || !ID.test(input.id)) return respond({ error: 'invalid_request' }, 400);
      const large = input.action === 'stageLarge' || input.action === 'commitLarge' || input.kind === 'largePart';
      if (!large && bytes.byteLength > 12_000) return respond({ error: 'payload_too_large' }, 413);
      const partsCollection = large ? 'qualification_large_parts' : 'qualification_parts';
      // Each call creates a new SDK service client/request ID. Never reuse a quota request identity.
      const read = (collection, id) => documentClient(collection).get(id);
      if (input.action === 'read') {
        if (!exact(input, ['action', 'id', 'kind']) || !['head', 'part', 'largePart'].includes(input.kind)) return respond({ error: 'invalid_request' }, 400);
        return respond(await read(input.kind === 'head' ? 'qualification_heads' : partsCollection, input.id));
      }
      if (typeof input.mutationId !== 'string' || input.mutationId.length < 16 || input.mutationId.length > 200) return respond({ error: 'invalid_request' }, 400);
      if (input.action === 'stage' || input.action === 'stageLarge') {
        if (!exact(input, ['action', 'id', 'mutationId', 'payload']) || typeof input.payload !== 'string' || new TextEncoder().encode(input.payload).byteLength > (large ? 32768 : 4096)) return respond({ error: 'invalid_request' }, 400);
        const result = await documentClient(partsCollection).mutate(input.id, {
          mutationId: input.mutationId, operation: 'create', expectedRevision: null,
          schemaVersion: 1, body: { id: input.id, payload: input.payload },
        });
        return respond(result, result.status === 'conflict' ? 409 : 200);
      }
      if (input.action === 'commit' || input.action === 'commitLarge') {
        if (!exact(input, ['action', 'id', 'mutationId', 'expectedRevision', 'partIds', 'value']) ||
            !(input.expectedRevision === null || (typeof input.expectedRevision === 'string' && input.expectedRevision.length > 0 && input.expectedRevision.length <= 1024)) ||
            !Number.isSafeInteger(input.value) || input.value < 0 ||
            !Array.isArray(input.partIds) || input.partIds.length < 1 || input.partIds.length > 16 ||
            new Set(input.partIds).size !== input.partIds.length ||
            !input.partIds.every((id) => typeof id === 'string' && ID.test(id))) return respond({ error: 'invalid_request' }, 400);
        for (const id of input.partIds) {
          const part = await read(partsCollection, id);
          if (!part || part._deleted || part.body.id !== id) return respond({ error: 'incomplete_manifest' }, 409);
        }
        const result = await documentClient('qualification_heads').mutate(input.id, {
          mutationId: input.mutationId, operation: input.expectedRevision === null ? 'create' : 'update',
          expectedRevision: input.expectedRevision, schemaVersion: 1,
          body: { id: input.id, partIds: input.partIds, value: input.value },
        });
        return respond(result, result.status === 'conflict' ? 409 : 200);
      }
      return respond({ error: 'invalid_request' }, 400);
    } catch (error) {
      if (error?.status === 401 || error?.code === 'unauthenticated') return respond({ error: 'unauthenticated' }, 401);
      if (error?.status === 403 || error?.code === 'permission_denied') return respond({ error: 'permission_denied' }, 403);
      if (error?.status === 409 || error?.code === 'conflict') return respond({ error: 'conflict' }, 409);
      // Only fixed diagnostic reasons; never include arbitrary upstream messages or data.
      const reasons = ['document mutation is unavailable', 'document storage is unavailable',
        'document sequencer is unavailable', 'quota authority is unavailable',
        'collection schema is unavailable', 'service authorization is unavailable'];
      return respond({ error: 'unavailable',
        ...(Number.isInteger(error?.status) ? { upstreamStatus: error.status } : {}),
        ...(reasons.includes(error?.message) ? { upstreamReason: error.message } : {}) }, 503);
    }
  };
}
