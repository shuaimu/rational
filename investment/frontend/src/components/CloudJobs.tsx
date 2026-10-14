import { useEffect, useState, useSyncExternalStore } from 'react';
import { cancelJob, dismissJob, getJobs, recoverJobs, subscribeJobs } from '../api/jobs';
const names: Record<string, string> = { excel: 'Excel import', snaptrade: 'Broker import', register: 'Broker registration', prefetch: 'Price refresh', 'cache-clear': 'Cache cleanup', summary: 'Cache report', 'portfolio-command': 'Portfolio update' };
const states: Record<string, string> = { queued: 'Accepted', running: 'Running in cloud', committing: 'Saving results', retry: 'Waiting to continue', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', 'needs-attention': 'Needs review' };
export function CloudJobs() {
  const jobs = useSyncExternalStore(subscribeJobs, getJobs);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { recoverJobs(); const timer = setInterval(recoverJobs, 5000); return () => clearInterval(timer); }, []);
  if (!jobs.length) return null;
  return <section className="mb-5 rounded-lg border border-indigo-200 bg-white p-4 text-sm" aria-label="Cloud operations">
    <p className="font-medium text-gray-900">Cloud operations continue if you close this page.</p>
    <ul className="mt-2 space-y-2">{jobs.map(job => <li key={job.id} className="flex flex-wrap items-center justify-between gap-3">
      <span role="status">{names[job.kind] ?? 'Cloud operation'} · {job.waitingForSync ? 'Saved · updating this device' : job.cancelRequested && !['cancelled', 'completed'].includes(job.state) ? 'Cancellation requested' : states[job.state]}{job.retryAt && job.state === 'retry' ? ` · next check after ${new Date(job.retryAt).toLocaleTimeString()}` : ''}</span>
      {['queued', 'running', 'retry'].includes(job.state) ? <button disabled={job.cancelRequested} className="text-indigo-700 underline disabled:opacity-50" onClick={() => { setError(null); void cancelJob(job.id).catch(e => setError(e instanceof Error ? e.message : 'Cancellation failed.')); }}>Cancel</button> : job.state !== 'committing' && !job.waitingForSync ? <button className="text-gray-600 underline" onClick={() => dismissJob(job.id)}>Dismiss</button> : null}
    </li>)}</ul>
    {error && <p className="mt-2 text-red-700" role="alert">{error}</p>}
  </section>;
}
