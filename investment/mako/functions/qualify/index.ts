import { createFunctionClientFromRequest, createServiceClient } from '@mako-cloud/edge-sdk';
import { createQualificationHandler } from './handler.js';

const scope = {
  endpoint: Deno.env.get('MAKO_API_URL')!,
  projectId: Deno.env.get('MAKO_PROJECT_ID')!,
  environmentId: Deno.env.get('MAKO_ENVIRONMENT_ID')!,
};

Deno.serve(createQualificationHandler({
  workerId: Deno.env.get('ROBINLAB_QUALIFICATION_WORKER_ID'),
  authenticate: (request: Request) => createFunctionClientFromRequest({ ...scope, request }).auth.getUser(),
  documentClient: (collectionId: string) => createServiceClient({
    ...scope,
    serviceCredential: Deno.env.get('ROBINLAB_QUALIFICATION_SERVICE_KEY')!,
    reason: 'RobinLab synthetic migration qualification',
    requestId: `req_${crypto.randomUUID()}`,
  }).documents(collectionId),
}));
