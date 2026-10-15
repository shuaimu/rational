// Only a successful phase may opt in. Errors fall back to hourly recovery.
// Delays preserve provider retry-at values and claim leases; terminal and held
// lanes have already been excluded by the dispatcher.
export function continuationResponse({processed,cleanup,progressed,pending,now=Date.now()}) {
 const body={processed,cleanup};
 if(!progressed||!pending.length)return body;
 const next=Math.min(...pending.map(row=>Math.max(row.body.dueAt,row.body.leaseUntil)));
 const delaySeconds=Math.max(5,Math.ceil((next-now)/1000));
 return delaySeconds<=300?{...body,makoContinuation:{delaySeconds}}:body;
}
