import {ensure,ContinuationRequired,sha256} from '../shared/errors.js';
const encoder=new TextEncoder();
const metadata=account=>({id:account.id,brokerage_authorization:account.brokerage_authorization??null,institution_name:account.institution_name??null,number:account.number??null,name:account.name??null});
export async function brokerRoute({request,path,query,repository,domain,broker,jobs,reply,body,now}) {
 const submit=async(id,operation,input,captured)=>{
  const identity=domain({action:'identity',id,operation,input});
  const jobInput={operation,input,...(captured?{captured}:{})};
  if(await jobs.find(id)){const job=await jobs.admit(id,'portfolio-command',jobInput);return {job};}
  try{return {result:await repository.execute({identity,operation,input,captured,now:now()})};}
  catch(error){if(!(error instanceof ContinuationRequired))throw error;return {job:await jobs.admit(id,'portfolio-command',jobInput)};}
 };
 const respond=outcome=>outcome.job?reply(jobs.status(outcome.job),202):reply(outcome.result.response,200,outcome.result.version);
 const command=()=>{const id=request.headers.get('idempotency-key');ensure(id,400,'Idempotency-Key is required');return id;};
 if(path==='/snaptrade/status'&&request.method==='GET') {
  const {dataset}=await repository.load(),dates=dataset.private.snaptrade_accounts.filter(a=>a.account_id!==null&&a.updated_at!==null).map(a=>a.updated_at).sort();return reply({last_synced_at:dates.at(-1)??null});
 }
 if(path==='/snaptrade/connect'&&request.method==='GET') {
  const {dataset}=await repository.load(),result=await broker.connect(broker.user(dataset),query.get('broker'));
  ensure(typeof result.redirectURI==='string',503,'Broker connection response is invalid');return reply({redirect_uri:result.redirectURI});
 }
 const link=/^\/snaptrade\/accounts\/([^/]+)\/link$/.exec(path);
 if(link&&request.method==='POST') {
  let sid;try{sid=decodeURIComponent(link[1]);}catch{ensure(false,400,'Invalid brokerage account');}
  const input={snaptrade_account_id:sid,account_id:(await body()).account_id};return respond(await submit(command(),'link_snaptrade_account',input));
 }
 if(path==='/snaptrade/register'&&request.method==='POST') {
  const id=command(),{dataset}=await repository.load();
  if(broker.personal||dataset.private.snaptrade_users.length)return respond(await submit(id,'register_snaptrade',{}, {mode:broker.personal?'personal':'commercial'}));
  return reply(jobs.status(await jobs.admit('snaptrade_registration_v1','register',{})),202);
 }
 if(path==='/snaptrade/accounts'&&request.method==='GET') {
  const pinned=await repository.load(),user=broker.user(pinned.dataset),remote=await broker.accounts(user);ensure(Array.isArray(remote)&&remote.length<=1000,503,'Broker account response is invalid');
  const accounts=remote.map(metadata);for(const account of accounts)ensure(typeof account.id==='string'&&account.id.length>0,503,'Broker account response is invalid');
  const changed=accounts.some(a=>!pinned.dataset.private.snaptrade_accounts.some(r=>r.snaptrade_account_id===a.id&&r.brokerage_authorization===a.brokerage_authorization&&r.institution_name===a.institution_name&&r.account_number===a.number&&r.account_name===a.name));
  if(changed){
   const input={head:pinned.head.revision,accounts},id=`discovery_${await sha256(encoder.encode(domain({action:'canonical',value:input}).payload))}`;
   const outcome=await submit(id,'discover_snaptrade_accounts',input,{userId:user?.[0]??'personal'});if(outcome.job)return reply({...jobs.status(outcome.job),resumePath:'/snaptrade/accounts'},202);
  }
  const {dataset}=changed?await repository.load():pinned;
  return reply({accounts:accounts.map(a=>{const mapping=dataset.private.snaptrade_accounts.find(r=>r.snaptrade_account_id===a.id);return {snaptrade_account_id:a.id,institution_name:a.institution_name,number:a.number,name:a.name,linked_account_code:dataset.public.accounts.find(r=>r.id===mapping?.account_id)?.code??null};})});
 }
 return null;
}
