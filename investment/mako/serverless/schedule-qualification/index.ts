// No secrets, storage or provider access. Only prove platform schedule provenance.
Deno.serve(request => {
  const id=request.headers.get('x-mako-schedule-id');
  const run=request.headers.get('x-mako-schedule-run-id');
  const due=request.headers.get('x-mako-schedule-due-at');
  const allowed=request.method==='POST' && id?.startsWith('sch_') && run && due && Number.isFinite(Date.parse(due));
  if (!allowed) return Response.json({error:'schedule_required'},{status:403});
  console.info('serverless_schedule_provenance_verified');
  return Response.json({verified:true});
});
