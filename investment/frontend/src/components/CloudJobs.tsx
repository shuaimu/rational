import { useEffect, useState, useSyncExternalStore } from 'react';
import { cancelJob, dismissJob, getJobs, getJobDiscoveryState, recoverJobs, subscribeJobs } from '../api/jobs';
const names: Record<string, string> = { excel: 'Excel import', snaptrade: 'Broker import', register: 'Broker registration', prefetch: 'Price refresh', 'cache-clear': 'Cache cleanup', summary: 'Cache report', 'portfolio-command': 'Portfolio update' };
const states: Record<string, string> = { queued: 'Accepted', running: 'Running in cloud', committing: 'Saving results', retry: 'Waiting to continue', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', 'needs-attention': 'Needs review' };
export function CloudJobs() {
  const jobs = useSyncExternalStore(subscribeJobs, getJobs);
  const discovery = useSyncExternalStore(subscribeJobs, getJobDiscoveryState);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queued = jobs.filter(job => job.state === 'queued').length;
  const active = jobs.filter(job => ['running', 'committing'].includes(job.state)).length;
  const waiting = jobs.filter(job => job.state === 'retry').length;
  useEffect(() => { recoverJobs(); const timer = setInterval(() => recoverJobs(), 5000); return () => clearInterval(timer); }, []);
  if (!jobs.length && discovery === 'current') return null;
  return <section className="mb-5 rounded-lg border border-indigo-200 bg-white p-4 text-sm" aria-label="Cloud operations">
    <p className="font-medium text-gray-900">Cloud operations continue if you close this page.</p>
    {discovery === 'current' ? <p className="mt-1 text-gray-600">{queued} queued · {active} running · {waiting} waiting to resume</p> : <p className="mt-1 text-gray-600" role="status">{discovery === 'checking' ? 'Checking cloud operations… Saved entries may be out of date.' : 'Could not refresh cloud operations. Showing saved entries.'}</p>}
    {discovery === 'unavailable' && <button className="mt-2 text-indigo-700 underline" onClick={() => recoverJobs(true)}>Retry queue refresh</button>}
    {jobs.length > 4 && <button className="mt-2 text-indigo-700 underline" aria-expanded={expanded} aria-controls="cloud-operation-list" onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide operations' : `Show ${jobs.length}${discovery === 'current' ? '' : ' saved'} operations`}</button>}
    {jobs.some(job => ['failed', 'needs-attention'].includes(job.state)) && <p className="mt-2 text-amber-800" role="alert">Some cloud operations need review. Open the operation list for details.</p>}
    {(jobs.length <= 4 || expanded) && <ul id="cloud-operation-list" className="mt-2 max-h-64 space-y-2 overflow-y-auto">{jobs.map(job => <li key={job.id} className="flex flex-wrap items-center justify-between gap-3">
      <span role="status">{names[job.kind] ?? 'Cloud operation'} · {job.waitingForSync ? 'Saved · updating this device' : job.cancelRequested && !['cancelled', 'completed'].includes(job.state) ? 'Cancellation requested' : states[job.state]}{job.retryAt && job.state === 'retry' ? ` · next check after ${new Date(job.retryAt).toLocaleTimeString()}` : ''}</span>
      {['queued', 'running', 'retry'].includes(job.state) ? <button disabled={job.cancelRequested} className="text-indigo-700 underline disabled:opacity-50" onClick={() => { setError(null); void cancelJob(job.id).catch(e => setError(e instanceof Error ? e.message : 'Cancellation failed.')); }}>Cancel</button> : job.state !== 'committing' && !job.waitingForSync ? <button className="text-gray-600 underline" onClick={() => dismissJob(job.id)}>Dismiss</button> : null}
    </li>)}</ul>}
    {error && <p className="mt-2 text-red-700" role="alert">{error}</p>}
  </section>;
}
