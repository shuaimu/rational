import { createFunctionClientFromRequest, createServiceClient } from '@mako-cloud/edge-sdk';
import { CACHE_COLLECTIONS } from './cache.js';
import { createRepositoryHandler } from './handler.js';

const scope = {
  endpoint: Deno.env.get('MAKO_API_URL')!,
  projectId: Deno.env.get('MAKO_PROJECT_ID')!,
  environmentId: Deno.env.get('MAKO_ENVIRONMENT_ID')!,
};

Deno.serve(createRepositoryHandler({
  workerId: Deno.env.get('ROBINLAB_WORKER_ID'),
  authenticate: (request: Request) => createFunctionClientFromRequest({ ...scope, request }).auth.getUser(),
  documents: (collectionId: string) => createServiceClient({
    ...scope,
    serviceCredential: Deno.env.get(collectionId === 'provider_requests' ? 'ROBINLAB_LOG_KEY' : CACHE_COLLECTIONS.includes(collectionId) ? 'ROBINLAB_CACHE_KEY' : 'ROBINLAB_SERVICE_KEY')!,
    reason: 'RobinLab authenticated repository operation',
    requestId: `req_${crypto.randomUUID()}`,
  }).documents(collectionId),
}));
