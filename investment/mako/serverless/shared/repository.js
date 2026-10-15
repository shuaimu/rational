import { ensure, ApiError, ContinuationRequired, batches, sha256 } from './errors.js';
const encoder = new TextEncoder();
const collections = {public:'portfolio_public',private:'portfolio_private',command:'portfolio_commands',head:'portfolio_heads'};
const contentId = /^[pmc]_[0-9a-f]{64}$/;
const same = (a,b) => a?.id===b?.id && a?.bytes===b?.bytes;

// Every instance pins its own head; warm module state is never authoritative.
export class PortfolioRepository {
  constructor({documents,domain,deadline=performance.now()+22000,names=collections}) {
    this.documents=documents;this.domain=domain;this.deadline=deadline;this.names=names;
    this.content=new Map();this.requests=0;
  }
  budget() { if(performance.now()>=this.deadline)throw new ContinuationRequired(); }
  async get(kind,id) {
    this.budget();this.requests++;
    return this.documents(this.names[kind]).get(id);
  }
  async head() {
    const record=await this.get('head','portfolio');
    ensure(record&&!record._deleted&&record.schemaVersion===1);
    const head=record.body;
    ensure(head?.id==='portfolio'&&head.format===1&&Number.isSafeInteger(head.sequence)&&head.sequence>0&&typeof record.revision==='string');
    return record;
  }
  async verified(kind,reference,prefix) {
    ensure(reference&&contentId.test(reference.id)&&reference.id.startsWith(prefix+'_')&&Number.isInteger(reference.bytes)&&reference.bytes>0&&reference.bytes<=32768);
    const key=`${kind}:${reference.id}`;
    let body=this.content.get(key);
    if (!body) {
      const row=await this.get(kind,reference.id);
      ensure(row&&!row._deleted&&row.schemaVersion===1&&row.body?.id===reference.id&&typeof row.body.payload==='string');
      body=row.body;
      const bytes=encoder.encode(body.payload);
      ensure(bytes.length===reference.bytes&&await sha256(bytes)===reference.id.slice(2));
      this.content.set(key,body);
    } else ensure(encoder.encode(body.payload).length===reference.bytes);
    try {return {body,value:JSON.parse(body.payload)};} catch {throw new ApiError(503,'Portfolio content is invalid');}
  }
  async branch(kind,root) {
    let queue=[{ref:root,depth:0}];const documents=[];const seen=new Set();let bytes=0;
    while(queue.length) {
      const batch=queue.splice(0,8);
      const result=await batches(batch,8,async ({ref,depth})=>{
        ensure(!seen.has(ref.id)&&depth<=16&&seen.size<8192);seen.add(ref.id);bytes+=ref.bytes;
        ensure(bytes<=64*1024*1024);
        const prefix=ref.id.slice(0,1);
        ensure(prefix==='m'||prefix==='p');
        const row=await this.verified(kind,ref,prefix);
        documents.push(row.body);
        if(prefix==='m') {
          ensure(row.value.format===1&&row.value.visibility===kind&&Array.isArray(row.value.children)&&row.value.children.length<=16);
          return row.value.children.map(child=>({ref:child.content,depth:depth+1}));
        }
        return [];
      });
      queue.push(...result.flat());
    }
    return {root,documents};
  }
  async load(head) {
    head ??= await this.head();
    const publicBranch=await this.branch('public',head.body.public_root);
    const privateBranch=await this.branch('private',head.body.private_root);
    const dataset=this.domain({action:'decode',public:publicBranch,private:privateBranch});
    return {head,dataset};
  }
  // Status reads need broker metadata, not the full public transaction graph.
  // Pin one head and verify every traversed manifest/selected partition by hash.
  async brokerAccounts() {
    const head=await this.head(),queue=[{ref:head.body.private_root,depth:0}],seen=new Set(),rows=[];
    let bytes=0;
    const visit=ref=>{ensure(!seen.has(ref.id)&&seen.size<8192);seen.add(ref.id);bytes+=ref.bytes;ensure(bytes<=64*1024*1024);};
    while(queue.length) {
      const {ref,depth}=queue.shift();ensure(depth<=16);visit(ref);
      const {value:manifest}=await this.verified('private',ref,'m');
      ensure(manifest.format===1&&manifest.visibility==='private'&&Array.isArray(manifest.children)&&manifest.children.length<=16);
      for(const child of manifest.children) {
        if(child.kind==='manifest')queue.push({ref:child.content,depth:depth+1});
        else {
          ensure(child.kind==='partition'&&['snaptrade_accounts','snaptrade_users'].includes(child.table)&&typeof child.bucket==='string');
          if(child.table!=='snaptrade_accounts')continue;
          visit(child.content);
          const {value:part}=await this.verified('private',child.content,'p');
          ensure(part.format===1&&part.table===child.table&&part.bucket===child.bucket&&Array.isArray(part.rows));
          for(const row of part.rows) {
            ensure(row&&(row.account_id===null||Number.isSafeInteger(row.account_id))&&(row.updated_at===null||typeof row.updated_at==='string'));
            rows.push(row);
          }
        }
      }
    }
    return rows;
  }
  history(head) {return {head,ref:head.body.command,sequence:head.body.sequence,seen:[],result:null};}
  async historyPage(state,identity,limit=24) {
    const {head}=state;const seen=new Set(state.seen);
    for(let count=0;state.ref&&count<limit;count++) {
      ensure(seen.size<10000&&state.sequence>=1);
      const {value:record}=await this.verified('command',state.ref,'c');
      ensure(record.format===1&&record.sequence===state.sequence&&(!record.predecessor)===(state.sequence===1));
      ensure(record.identity&&typeof record.identity.id==='string'&&!seen.has(record.identity.id));seen.add(record.identity.id);
      if(state.sequence===head.body.sequence)ensure(same(record.public_root,head.body.public_root)&&same(record.private_root,head.body.private_root)&&this.domain({action:'canonical',value:record.next_ids}).payload===this.domain({action:'canonical',value:head.body.next_ids}).payload);
      if(record.identity.id===identity.id){ensure(record.identity.request_hash===identity.request_hash,409,'Operation identity was already used with different input');state.result={version:record.sequence,response:record.response,replayed:true};}
      state.ref=record.predecessor;state.sequence--;
    }
    state.seen=[...seen];if(!state.ref)ensure(state.sequence===0);return state;
  }
  async replay(head,identity) {
    const state=this.history(head);
    while(state.ref)await this.historyPage(state,identity);
    return state.result;
  }
  async stage(kind,document) {
    const key=`${kind}:${document.id}`;
    if(this.content.has(key)) {ensure(this.content.get(key).payload===document.payload);return;}
    this.budget();this.requests++;
    const result=await this.documents(this.names[kind]).mutate(document.id,{mutationId:`stage_${document.id}`,operation:'create',expectedRevision:null,schemaVersion:1,body:document});
    if(result.status==='conflict') {
      const previous=await this.get(kind,document.id);
      ensure(previous&&!previous._deleted&&previous.body.id===document.id&&previous.body.payload===document.payload,409,'Immutable content differs');
    } else ensure(['applied','replayed'].includes(result.status));
    this.content.set(key,document);
  }
  async publish(prepared) {
    // All referenced content must be durable before the only visibility change.
    for(const [kind,documents] of [['public',prepared.public_content],['private',prepared.private_content]]) {
      await batches(documents.filter(d=>d.id.startsWith('p_')),4,d=>this.stage(kind,d));
      for(const doc of documents.filter(d=>d.id.startsWith('m_'))) await this.stage(kind,doc);
    }
    await this.stage('command',prepared.command);
    return this.publishHead(prepared);
  }
  async publishHead(prepared) {
    this.budget();this.requests++;
    const result=await this.documents(this.names.head).mutate('portfolio',{mutationId:`publish_${prepared.command.id}`,operation:'update',expectedRevision:prepared.expected_head_revision,schemaVersion:1,body:prepared.head});
    if(result.status==='conflict') return null;
    ensure(['applied','replayed'].includes(result.status));
    const command=JSON.parse(prepared.command.payload);
    return {version:prepared.head.sequence,response:command.response,replayed:result.status==='replayed'};
  }
  async execute({identity,operation,input,now,captured}) {
    for(let attempt=0;attempt<4;attempt++) {
      const head=await this.head();
      const replay=await this.replay(head,identity);
      if(replay) return replay;
      const {dataset}=await this.load(head);
      const prepared=this.domain({action:'prepare',dataset,nextIds:head.body.next_ids,previous:{head:head.body,revision:head.revision},identity,operation,input,now,captured});
      const result=await this.publish(prepared);
      if(result) return result;
    }
    throw new ApiError(409,'Concurrent portfolio update; retry with the same command');
  }
}
