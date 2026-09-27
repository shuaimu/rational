import {ensure} from './errors.js';
// A lane points at a durable job, not an expiring worker. Recovery keeps the
// same lane until that job has finished. Claim leases only fence its phases.
export class JobLanes {
 constructor(documents,jobs){this.documents=documents;this.jobs=jobs;}
 // Waiting jobs must not consume the dispatcher slot ahead of the job that
 // owns their lane. Fetch owners directly even when they are outside the due page.
 async runnable(candidates,now=Date.now(),{draining=false}={}){
  const owners=new Map(),rows=new Map(candidates.map(row=>[row.body.id,row]));
  for(const lane of ['snaptrade','cache']){
   const row=await this.documents().get(lane);
   if(!row||row._deleted)continue;
   const owner=await this.jobs.get(row.body.jobId);
   if(['completed','cancelled','failed'].includes(owner.body.state))continue;
   owners.set(lane,owner.body.id);rows.set(owner.body.id,owner);
  }
  return [...rows.values()].filter(row=>{
   const job=row.body;
   if(row._deleted||!['queued','retry','running','committing'].includes(job.state)||job.dueAt>now||job.leaseUntil>now)return false;
   // Preserve accepted, unstarted work for the destination. Checkpointed work
   // must finish here because captures can contain source document revisions.
   if(draining&&!job.checkpoint&&job.state!=='committing')return false;
   const lane=job.kind==='snaptrade'?'snaptrade':['summary','cache-clear','prefetch'].includes(job.kind)?'cache':null;
   return !lane||!owners.has(lane)||owners.get(lane)===job.id;
  }).sort((a,b)=>a.body.dueAt-b.body.dueAt||a.body.id.localeCompare(b.body.id));
 }
 async acquire(lane,jobId){
  ensure(/^[a-z_]{1,32}$/.test(lane));
  for(let attempt=0;attempt<4;attempt++){
   const row=await this.documents().get(lane);
   if(row&&!row._deleted){
    if(row.body.jobId===jobId)return true;
    const previous=await this.jobs.get(row.body.jobId);
    // Needs-attention retains ownership until explicitly reconciled.
    if(!['completed','cancelled','failed'].includes(previous.body.state))return false;
   }
   const result=await this.documents().mutate(lane,{mutationId:`lane_${crypto.randomUUID()}`,operation:row?'update':'create',expectedRevision:row?.revision??null,schemaVersion:1,body:{id:lane,jobId}});
   if(result.status==='conflict')continue;ensure(['applied','replayed'].includes(result.status));return true;
  }return false;
 }
}
