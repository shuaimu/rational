import {createServiceClient} from '@mako-cloud/edge-sdk';
import {InputVerifier} from './verify-inputs.js';
import {freshDocuments} from './request-documents.js';

const plan = JSON.parse(Deno.env.get('ROBINLAB_MIGRATION_PLAN')!);
if (plan.projectId !== Deno.env.get('MAKO_PROJECT_ID') || plan.destinationEnvironment !== Deno.env.get('MAKO_ENVIRONMENT_ID')) {
  throw new Error('Migration deployment scope mismatch');
}
const client = (environmentId, secret) => createServiceClient({
  endpoint: Deno.env.get('MAKO_API_URL')!, projectId: plan.projectId, environmentId,
  serviceCredential: Deno.env.get(secret)!, reason: 'Read-only final investment migration parity', requestId: `req_${crypto.randomUUID()}`,
});
Deno.serve(async request => {
  const schedule = request.headers.get('x-mako-schedule-id');
  const run = request.headers.get('x-mako-schedule-run-id');
  const due = request.headers.get('x-mako-schedule-due-at');
  if (request.method !== 'POST' || !schedule?.startsWith('sch_') || !run || !due || !Number.isFinite(Date.parse(due))) {
    return Response.json({error: 'Forbidden'}, {status: 403});
  }
  const documents = (environment, secret, collection) => freshDocuments(() => client(environment, secret), collection);
  try {
    const verifier = new InputVerifier({plan,
      source: {
        head: documents(plan.sourceEnvironment, 'ROBINLAB_MIGRATION_SOURCE_READ', 'portfolio_heads'),
        inputs: documents(plan.sourceEnvironment, 'ROBINLAB_MIGRATION_SOURCE_READ', 'robinlab_inputs'),
      },
      destination: {
        head: documents(plan.destinationEnvironment, 'ROBINLAB_MIGRATION_DESTINATION_READ', 'portfolio_heads'),
        inputs: documents(plan.destinationEnvironment, 'ROBINLAB_MIGRATION_DESTINATION_READ', 'robinlab_inputs'),
      },
      journal: documents(plan.destinationEnvironment, 'ROBINLAB_MIGRATION_JOURNAL', 'robinlab_migration_checks'),
    });
    const state = await verifier.run(run);
    return Response.json({status: state.status, verifiedCount: state.verifiedCount ?? 0, target: plan.count, reason: state.reason ?? null});
  } catch (error) {
    // Never serialize provider payloads, credentials, cursors, or SDK errors.
    console.error(JSON.stringify({event: 'migration_verification_unavailable',
      type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.name ?? '') ? error.name : 'Error',
      code: /^[a-z_]{1,64}$/.test(error?.code ?? '') ? error.code : null,
      status: Number.isInteger(error?.status) ? error.status : null,
    }));
    return Response.json({error: 'Migration verification unavailable'}, {status: 503});
  }
});
