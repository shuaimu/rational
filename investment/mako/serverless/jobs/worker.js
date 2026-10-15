import {ensure,ApiError,batches} from '../shared/errors.js';
const timestamp=milliseconds=>new Date(milliseconds).toISOString().slice(0,19).replace('T',' ');
// One bounded phase per invocation. Durable captures and conditional publication
// remain authoritative if an isolate disappears at any await boundary.
export class JobWorker {
 constructor({jobs,repository,uploads,artifacts,domain,parseWorkbook,snaptradeCapture,broker,cache,lanes,reports,maintenance,clock=()=>Date.now()}){Object.assign(this,{jobs,repository,uploads,artifacts,domain,parseWorkbook,snaptradeCapture,broker,cache,lanes,reports,maintenance,clock});}
 async advance(claim,checkpoint){
  if(claim.body.state==='committing')return this.jobs.checkpoint(claim,checkpoint,{state:'committing',retryAt:this.clock()+1000});
  return this.jobs.checkpoint(claim,checkpoint,{state:'retry',retryAt:this.clock()+1000});
 }
 async step(claim){
  const job=claim.body,id=job.id;let point=job.checkpoint;
  if(['cache-clear','prefetch'].includes(job.kind)){
   ensure(this.maintenance,503,'Cache maintenance is unavailable');
   const progress=await this.maintenance.step(job,point);
   if(progress.done)return this.jobs.checkpoint(claim,null,{state:'completed',result:progress.result});
   if(progress.committing)return this.jobs.checkpoint(claim,progress.checkpoint,{state:'committing',retryAt:this.clock()+1000});
   return this.advance(claim,progress.checkpoint);
  }
  if(job.kind==='summary'){
   ensure(this.reports,503,'Cache reporting is unavailable');
   const progress=await this.reports.step(job,point);
   return progress.done?this.jobs.checkpoint(claim,null,{state:'completed',result:progress.result}):this.advance(claim,progress.checkpoint);
  }
  if(job.kind==='register'&&(!point||point.phase==='register_pending')) {
   ensure(this.broker,503,'Broker registration is unavailable');
   let captured=await this.artifacts.named(id,'registration-response');
   if(!captured&&!point) {
    const {dataset}=await this.repository.load();
    if(this.broker.personal||dataset.private.snaptrade_users.length)captured=await this.artifacts.save(id,{mode:this.broker.personal?'personal':'commercial'},{name:'registration-response'});
    else {
     // This durable marker precedes the non-idempotent provider call. A cold
     // continuation may recover its response, but must never repeat the call.
     const userId=`robinlab_${id.slice(2)}`;
     claim=await this.jobs.checkpoint(claim,{phase:'register_pending',userId},{state:'committing'});
     try {
      const response=await this.broker.register(userId);
      ensure(response?.userId===userId&&typeof response.userSecret==='string'&&response.userSecret.length>0,503,'Invalid registration response');
      captured=await this.artifacts.save(id,{mode:'commercial',...response},{name:'registration-response'});
     } catch {
      captured=await this.artifacts.named(id,'registration-response');
      if(!captured)return this.jobs.checkpoint(claim,claim.body.checkpoint,{state:'needs-attention',error:'registration_requires_reconciliation'});
     }
    }
   }
   if(!captured)return this.jobs.checkpoint(claim,point,{state:'needs-attention',error:'registration_requires_reconciliation'});
   const input={},operation='register_snaptrade';
   return this.advance(claim,{phase:'history',operation,input,captured,identity:this.domain({action:'identity',id:job.commandId,operation,input}),now:timestamp(job.createdAt)});
  }
  if(job.kind==='snaptrade'&&!point&&job.input.apply&&!job.input.roll_detect) {
   return this.advance(claim,{phase:'history',afterHistory:'capture_snaptrade',operation:'import_snaptrade',input:job.input,identity:this.domain({action:'identity',id:job.commandId,operation:'import_snaptrade',input:job.input}),now:timestamp(job.createdAt)});
  }
  if(job.kind==='snaptrade'&&(!point||point.phase==='capture_snaptrade')) {
   ensure(this.snaptradeCapture,503,'Broker capture is unavailable');
   const capture=await this.snaptradeCapture.step(job,point?.capture);
   if(!capture.done)return this.advance(claim,{phase:'capture_snaptrade',capture:capture.reference});
   point={phase:!job.input.apply||job.input.roll_detect?'preview_snaptrade':'history',operation:'import_snaptrade',input:job.input,identity:this.domain({action:'identity',id:job.commandId,operation:'import_snaptrade',input:job.input}),captured:capture.captured,captureStartedAt:capture.captureStartedAt??this.clock(),captureCompletedAt:capture.captureCompletedAt??this.clock(),now:timestamp(capture.captureCompletedAt??this.clock())};
   return this.advance(claim,point);
  }
  if(point?.phase==='preview_snaptrade') {
   const loaded=await this.repository.snapshotStep(this.artifacts,id,point.snapshot);
   if(!loaded.done)return this.advance(claim,{...point,snapshot:loaded.reference});
   const {dataset}=loaded,captured=await this.artifacts.load(id,point.captured);
   const response=this.domain({action:'preview_snaptrade',dataset,captured,options:job.input,now:point.now});
   const responseArtifact=await this.artifacts.save(id,response);return this.jobs.checkpoint(claim,null,{state:'completed',result:{version:0,responseArtifact}});
  }
  if(!point){
   let operation,input,captured;
   if(job.kind==='excel') {
    const assembled=await this.uploads.assemble(job.input.uploadId);ensure(['sealed','bound'].includes(assembled.root.body.state)&&assembled.root.body.digest===job.input.sha256,409,'Import input is not sealed');
    const rows=JSON.parse(this.parseWorkbook(assembled.bytes));captured=await this.artifacts.save(id,rows);operation='import_excel';input={sha256:job.input.sha256};
   }else if(job.kind==='portfolio-command') {
    ({operation,input}=job.input);if(job.input.captured)captured=await this.artifacts.save(id,job.input.captured);ensure(['register_snaptrade','link_snaptrade_account','discover_snaptrade_accounts','create_account','create_transaction','update_transaction','delete_transaction','option_roll','option_close','option_expire','option_assign'].includes(operation),400,'Unsupported portfolio command');
   }else throw new ApiError(400,'Job kind is not implemented');
   const identity=this.domain({action:'identity',id:job.commandId,operation,input});
   point={phase:'history',operation,input,identity,now:timestamp(job.createdAt),...(captured?{captured}:{})};
   return this.advance(claim,point);
  }
  if(point.phase==='history') {
   const state=point.history?await this.artifacts.load(id,point.history):this.repository.history(await this.repository.head());
   await this.repository.historyPage(state,point.identity);
   if(!state.ref&&state.result)return this.jobs.checkpoint(claim,null,{state:'completed',result:state.result});
   const history=await this.artifacts.save(id,state);
   return this.advance(claim,{...point,history,phase:state.ref?'history':point.afterHistory??'plan'});
  }
  if(point.phase==='plan') {
   // Only unpublished work can be refreshed. Keep its command identity and run
   // history/replay checks again before applying fresh provider observations.
   if(job.kind==='snaptrade'&&(!Number.isSafeInteger(point.captureStartedAt)||this.clock()-point.captureStartedAt>=86400000))
    return this.advance(claim,{phase:'capture_snaptrade'});
   const history=await this.artifacts.load(id,point.history),head=await this.repository.head();
   if(head.revision!==history.head.revision){const {history:_,snapshot:__,...reset}=point;return this.advance(claim,{...reset,phase:'history'});}
   ensure(!history.ref&&!history.result);
   const loaded=await this.repository.snapshotStep(this.artifacts,id,point.snapshot);
   if(!loaded.done)return this.advance(claim,{...point,snapshot:loaded.reference});
   if(loaded.head.revision!==head.revision)return this.advance(claim,{...point,history:null,snapshot:null,phase:'history'});
   const {dataset}=loaded,captured=point.captured?await this.artifacts.load(id,point.captured):undefined;
   const prepared=this.domain({action:'prepare',dataset,nextIds:head.body.next_ids,previous:{head:head.body,revision:head.revision},identity:point.identity,operation:point.operation,input:point.input,now:point.now,captured});
   const plan=await this.artifacts.save(id,prepared);return this.advance(claim,{...point,phase:'stage',plan,offset:0});
  }
  if(point.phase==='stage') {
   const started=performance.now();
   const prepared=await this.artifacts.load(id,point.plan);
   const documents=[...prepared.public_content.map(body=>({kind:'public',body})),...prepared.private_content.map(body=>({kind:'private',body})),{kind:'command',body:prepared.command}];
   ensure(Number.isInteger(point.offset)&&point.offset>=0&&point.offset<=documents.length);
   const loaded=performance.now(),batch=documents.slice(point.offset,point.offset+8);await batches(batch,4,({kind,body})=>this.repository.stage(kind,body));
   const offset=point.offset+batch.length;console.log(JSON.stringify({event:'stage_progress',offset,total:documents.length,loadMs:Math.round(loaded-started),writeMs:Math.round(performance.now()-loaded)}));return this.advance(claim,{...point,offset,phase:offset===documents.length?'publish':'stage'});
  }
  if(point.phase==='publish') {
   const prepared=await this.artifacts.load(id,point.plan);
   // Once publishing begins, cancellation cannot claim that a lost response
   // undid a commit. Recovery remains in committing state until replay resolves it.
   claim=await this.jobs.checkpoint(claim,point,{state:'committing'});
   const result=await this.repository.publishHead(prepared);
   if(result){
    if(point.operation==='import_snaptrade')return this.jobs.checkpoint(claim,{...point,phase:'finalize_split',splitOffset:0,result},{state:'committing'});
    return this.jobs.checkpoint(claim,null,{state:'completed',result});
   }
   const {history:_,plan:__,offset:___,snapshot:____,...reset}=point;return this.advance(claim,{...reset,phase:'history'});
  }
  if(point.phase==='finalize_split') {
   const captured=await this.artifacts.load(id,point.captured),symbols=captured.refreshed_split_symbols;
   const batch=symbols.slice(point.splitOffset,point.splitOffset+16);
   await batches(batch,4,symbol=>this.cache.markSplit(symbol,point.now));const splitOffset=point.splitOffset+batch.length;
   if(splitOffset===symbols.length)return this.jobs.checkpoint(claim,null,{state:'completed',result:{...point.result,...(Number.isSafeInteger(point.captureStartedAt)?{syncedAt:timestamp(this.clock()),captureStartedAt:point.captureStartedAt,captureCompletedAt:point.captureCompletedAt}:{})}});
   return this.advance(claim,{...point,splitOffset});
  }
  throw new ApiError(503,'Job checkpoint is inconsistent');
 }
 async run(id,worker){
  const claim=await this.jobs.claim(id,worker);if(!claim||claim.body.state==='cancelled')return claim;
  try{
   if(this.lanes&&['snaptrade','summary','cache-clear','prefetch'].includes(claim.body.kind)&&!await this.lanes.acquire(claim.body.kind==='snaptrade'?'snaptrade':'cache',id))return this.jobs.checkpoint(claim,claim.body.checkpoint,{state:'retry',retryAt:this.clock()+10000});
   return await this.step(claim);
  }catch(error){
   console.error(JSON.stringify({event:'job_phase_failed',kind:claim.body.kind,phase:claim.body.checkpoint?.phase??'start',type:error?.constructor?.name,status:error?.status,code:error?.code,elapsed:this.clock()-claim.body.updatedAt}));
   // A newer worker/cancellation wins. Never replace its progress with our error.
   const latest=await this.jobs.get(id);if(latest.revision!==claim.revision)return latest;
   if(claim.body.leaseUntil<=this.clock())return latest;
   const validation=error instanceof ApiError&&[400,404,413].includes(error.status);
   const conflict=error instanceof ApiError&&error.status===409&&['cache-clear','prefetch'].includes(claim.body.kind);
   const state=conflict?'needs-attention':validation?'failed':claim.body.state==='committing'?'committing':'retry';
   return this.jobs.checkpoint(claim,claim.body.checkpoint,{state,error:conflict?'cache_requires_reconciliation':validation?'invalid_input':'operation_unavailable',...(['retry','committing'].includes(state)?{retryAt:Math.max(this.clock()+1000,Number.isSafeInteger(error.retryAt)?error.retryAt:this.clock()+60000)}:{})});
  }
 }
}
