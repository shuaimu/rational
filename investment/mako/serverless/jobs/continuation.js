// Successful progress or independent healthy work may opt in. A failed lane
// alone falls back to hourly recovery.
// Delays preserve provider retry-at values and claim leases; terminal and held
// lanes have already been excluded by the dispatcher.
export function continuationResponse({processed,cleanup,progressed,pending,failedJobId=null,now=Date.now()}) {
 const body={processed,cleanup};
 // A failed lane must not stop independent healthy work. The caller supplies
 // only lane-eligible rows; a failed job alone still falls back to hourly retry.
 const eligible=progressed?pending:failedJobId?pending.filter(row=>row.body.id!==failedJobId&&!row.body.error):[];
 if(!eligible.length)return body;
 const next=Math.min(...eligible.map(row=>Math.max(row.body.dueAt,row.body.leaseUntil)));
 const delaySeconds=Math.max(5,Math.ceil((next-now)/1000));
 return delaySeconds<=300?{...body,makoContinuation:{delaySeconds}}:body;
}
