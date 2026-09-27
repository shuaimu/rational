import {readFile} from 'node:fs/promises';
import {initSync,domain_invoke} from '../generated/robinlab_function_wasm.js';
import {domainCall,sha256} from '../shared/errors.js';
import {PortfolioRepository} from '../shared/repository.js';
initSync({module:await readFile(new URL('../generated/robinlab_function_wasm_bg.wasm',import.meta.url))});
export const domain=input=>domainCall(domain_invoke,input);
const encoder=new TextEncoder();
export async function fixture() {
 const data={public:{accounts:[],tickers:[],transactions:[],ticker_splits:[],account_value_snapshots:[]},private:{snaptrade_accounts:[],snaptrade_users:[]}};
 const encoded=domain({action:'encode',dataset:data});
 const ids={account:1,ticker:1,transaction:1,brokerage_user:1};
 const identity=domain({action:'identity',id:'precutover_command_0001',operation:'fixture',input:{}});
 const record={format:1,identity,sequence:1,predecessor:null,public_root:encoded.public.root,private_root:encoded.private.root,next_ids:ids,response:{accepted:'before compute cutover'}};
 const payload=domain({action:'canonical',value:record}).payload;
 const command={id:`c_${await sha256(encoder.encode(payload))}`,payload};
 const state={rows:new Map(),revision:1,writes:0,failStage:false,loseResponse:false};
 for(const kind of ['public','private']) for(const body of encoded[kind].documents) state.rows.set(`portfolio_${kind}:${body.id}`,{schemaVersion:1,revision:'r0',body});
 state.rows.set(`portfolio_commands:${command.id}`,{schemaVersion:1,revision:'r0',body:command});
 state.rows.set('portfolio_heads:portfolio',{schemaVersion:1,revision:'r1',body:{id:'portfolio',format:1,sequence:1,public_root:encoded.public.root,private_root:encoded.private.root,command:{id:command.id,bytes:encoder.encode(payload).length},next_ids:ids}});
 const assertMutation=(a,b)=>{if(a!==b)throw Error('Mutation identity reused with different input');};
 const receipts=new Map();
 const documents=collection=>({
  query:async query=>{
   const field=(row,path)=>path.split('.').reduce((value,key)=>value?.[key],row.body);
   const compare=(a,b)=>{for(let i=0;i<query.sort.length;i++){const direction=query.sort[i].direction==='desc'?-1:1;if(a[i]<b[i])return -direction;if(a[i]>b[i])return direction;}return 0;};
   const key=row=>query.sort.map(sort=>field(row,sort.field));
   let rows=[...state.rows].filter(([id,row])=>id.startsWith(collection+':')&&!row._deleted).map(([,row])=>row).filter(row=>query.predicates.every(p=>{const v=field(row,p.field);return p.operator==='eq'?v===p.value:p.operator==='gte'?v!=null&&v>=p.value:p.operator==='lte'?v!=null&&v<=p.value:false;}));
   rows.sort((a,b)=>compare(key(a),key(b)));
   if(query.cursor){const cursor=JSON.parse(query.cursor);rows=rows.filter(row=>compare(key(row),cursor)>0);}
   const documents=structuredClone(rows.slice(0,query.limit));return {documents,nextCursor:rows.length>query.limit?JSON.stringify(key(documents.at(-1))):null};
  },
  get:async id=>structuredClone(state.rows.get(`${collection}:${id}`)??null),
  mutate:async(id,mutation)=>{
   if(mutation.body?.id!==id)throw Error('Mutation body must retain its document primary key, including deletes');
   const key=`${collection}:${id}`,old=state.rows.get(key),receipt=receipts.get(mutation.mutationId);
   if(receipt){assertMutation(receipt.input,JSON.stringify([collection,id,mutation]));return {...structuredClone(receipt.result),status:'replayed'};}
   if(state.failStage&&collection!=='portfolio_heads') throw new Error('simulated interruption');
   if(mutation.operation==='create'&&old || mutation.operation!=='create'&&old?.revision!==mutation.expectedRevision) return {status:'conflict'};
   const document={schemaVersion:mutation.schemaVersion,_deleted:mutation.operation==='delete',revision:`r${++state.revision}`,body:structuredClone(mutation.body)};
   state.rows.set(key,document);state.writes++;receipts.set(mutation.mutationId,{input:JSON.stringify([collection,id,mutation]),result:{status:'applied',document:structuredClone(document)}});
   if(state.loseResponse&&collection==='portfolio_heads') {state.loseResponse=false;throw new Error('response lost after commit');}
   return {status:'applied',document:structuredClone(document)};
  }
 });
 const repository=()=>new PortfolioRepository({documents,domain});
 const commandInput=(id,code)=>({identity:domain({action:'identity',id,operation:'create_account',input:{code,name:null,account_type:null}}),operation:'create_account',input:{code,name:null,account_type:null},now:'2026-09-26 00:00:00'});
 return {state,repository,commandInput,identity,documents};
}
