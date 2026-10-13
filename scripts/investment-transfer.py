#!/usr/bin/env python3
"""Resumable Mako collection snapshots and imports. Private artifacts stay local.

Snapshotting alone does not prove quiescence. Cutover requires the admission and
writer-fence evidence described in the integration runbook.
"""
import argparse, hashlib, json, re, subprocess
from pathlib import Path

def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as content:
  for chunk in iter(lambda:content.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def atomic(path,value):
 tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(value,indent=2)+'\n');tmp.chmod(0o600);tmp.replace(path)
def documents(path):
 result={}
 with path.open() as content:
  for line in content:
   if not line.strip():continue
   row=json.loads(line);key=row['id']
   if key in result:raise ValueError('Duplicate document id in '+path.name)
   result[key]=row
 return result

def logical_digest(rows):
 h=hashlib.sha256()
 for chunk in json.JSONEncoder(sort_keys=True,separators=(',',':'),ensure_ascii=False).iterencode(rows):h.update(chunk.encode())
 return h.hexdigest()

def snapshot_summary(path):
 # Index byte ranges rather than retaining capture payloads. The canonical
 # digest remains identical to logical_digest(documents(path)), including for
 # files whose document IDs are not already sorted.
 ranges={};digest=hashlib.sha256();offset=0
 with path.open('rb') as content:
  for line in content:
   digest.update(line)
   if line.strip():
    row=json.loads(line);key=row['id']
    if not isinstance(key,str):raise ValueError('Invalid document id in '+path.name)
    if key in ranges:raise ValueError('Duplicate document id in '+path.name)
    ranges[key]=(offset,len(line))
   offset+=len(line)
  logical=hashlib.sha256();logical.update(b'{')
  for index,key in enumerate(sorted(ranges)):
   start,length=ranges[key];content.seek(start);row=json.loads(content.read(length))
   if row['id']!=key:raise ValueError('Snapshot changed while reading '+path.name)
   if index:logical.update(b',')
   logical.update(json.dumps(key,ensure_ascii=False).encode());logical.update(b':')
   for chunk in json.JSONEncoder(sort_keys=True,separators=(',',':'),ensure_ascii=False).iterencode(row):logical.update(chunk.encode())
  logical.update(b'}')
 return {'sha256':digest.hexdigest(),'logicalDigest':logical.hexdigest(),'count':len(ranges),'bytes':offset}

def import_parts(rows):
 # The deployed importer groups up to 32 records per RPC. Small rows may share
 # an artifact; larger rows are isolated so their combined batch stays bounded.
 lines=[(json.dumps(row,separators=(',',':'),ensure_ascii=False)+'\n').encode() for row in rows.values()]
 if not lines:return []
 if max(map(len,lines))>1024*1024:raise ValueError('Document exceeds platform one-MiB limit')
 if max(map(len,lines))*min(32,len(lines))<=200000:return [b''.join(lines)]
 parts=[];content=b''
 for line in lines:
  if content and len(content)+len(line)>200000:parts.append(content);content=b''
  if len(line)>200000:parts.append(line)
  else:content+=line
 if content:parts.append(content)
 return parts

def successful(job):
 if job.get('state')!='succeeded' or job.get('progress',{}).get('failed',0):
  raise ValueError('Cloud job is incomplete or contains failed records')

class Transfer:
 def __init__(self,args):
  self.args=args;self.root=Path(args.output).resolve();self.root.mkdir(parents=True,exist_ok=True,mode=0o700);self.root.chmod(0o700)
  config=json.loads(Path(args.config).read_text())
  self.flags=['--project',config['projectId'],'--env',args.environment,'--endpoint',config['endpoint'],'--profile',args.profile,'--json']
  self.state_path=self.root/'journal.json';self.state=json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
  expected={'environment':args.environment,'project':config['projectId'],'endpoint':config['endpoint']}
  if self.state.get('scope',expected)!=expected:raise ValueError('Journal belongs to another environment')
  self.state['scope']=expected;atomic(self.state_path,self.state)
 def run(self,key,args):
  log=self.root/(key+'.log')
  with log.open('w') as stderr:
   log.chmod(0o600)
   try:result=subprocess.run(['node',self.args.cli,*args,*self.flags],stdout=subprocess.PIPE,stderr=stderr,text=True,timeout=310)
   except subprocess.TimeoutExpired:result=None
  ids=re.findall(r'\bdjob_[A-Za-z0-9_-]+',log.read_text())
  if ids:self.state.setdefault(key,{})['jobId']=ids[0];atomic(self.state_path,self.state)
  if result is None or result.returncode:raise RuntimeError('Cloud job incomplete: '+key+'; inspect protected log and rerun to resume')
  data=json.loads(result.stdout);job=data.get('job',data)
  if 'jobId' in job:self.state.setdefault(key,{})['jobId']=job['jobId'];atomic(self.state_path,self.state)
  return data
 def paged_snapshot(self,key,name,path):
  cursor=None;snapshot=None;last=None;pages=0;count=0
  with path.open('w') as output:
   path.chmod(0o600)
   while True:
    words=['explorer','browse',name,'--limit','200','--duration','300','--reason','Verified Rational Investment migration snapshot']
    if cursor is not None:words+=['--cursor',cursor]
    page=self.run(key+'-page',words)
    if snapshot is None:snapshot=page['snapshot']
    if not snapshot or page['snapshot']!=snapshot:raise ValueError('Explorer snapshot changed: '+name)
    for document in page['items']:
     row=document['content'];ident=row['id']
     if last is not None and ident<=last:raise ValueError('Explorer snapshot order repeated: '+name)
     last=ident
     if not document['deleted']:output.write(json.dumps(row,separators=(',',':'),ensure_ascii=False)+'\n');count+=1
    pages+=1;next_cursor=page.get('nextCursor')
    if next_cursor is None:
     if not page.get('exhausted'):raise ValueError('Incomplete explorer snapshot: '+name)
     break
    if next_cursor==cursor:raise ValueError('Explorer cursor did not advance: '+name)
    cursor=next_cursor
    if pages%25==0:print('Snapshot pages',name,pages,'documents',count,flush=True)
  self.state[key]={**self.state.get(key,{}),'transport':'paged-explorer','snapshot':snapshot,'pages':pages,'count':count}
  atomic(self.state_path,self.state)
 def snapshot(self,names):
  manifest={'scope':self.state['scope'],'collections':{}}
  for name in names:
   key='export-'+name;path=self.root/(name+'.jsonl');receipt=self.state.get(key,{})
   if receipt.get('sha256'):
    if not path.exists() or sha(path)!=receipt['sha256']:raise ValueError('Sealed snapshot changed: '+name)
   else:
    if path.exists():path.unlink() # only an unsealed, interrupted download
    if name in getattr(self.args,'paged_explorer_collections','').split(','):
     self.paged_snapshot(key,name,path)
    elif name in getattr(self.args,'explorer_collections','').split(','):
     response=self.run(key,['explorer','browse',name,'--limit','25','--duration','300','--all','--reason','Verified Rational Investment migration snapshot'])
     if response.get('nextCursor') is not None:raise ValueError('Incomplete explorer snapshot: '+name)
     with path.open('w') as output:
      path.chmod(0o600)
      for document in response['items']:
       if not document['deleted']:output.write(json.dumps(document['content'],separators=(',',':'),ensure_ascii=False)+'\n')
    else:
     words=['data','export','--output',str(path),'--timeout','300']
     if receipt.get('jobId'):words+=['--job',receipt['jobId']]
     else:words+=['--collection',name]
     response=self.run(key,words);path.chmod(0o600)
     successful(response['job'])
     if response['digest']!='sha256:'+sha(path):raise ValueError('Export verification failed: '+name)
    receipt={**self.state.get(key,{}),'sha256':sha(path)}
    self.state[key]=receipt;atomic(self.state_path,self.state)
   entry=snapshot_summary(path)
   if entry['sha256']!=receipt['sha256']:raise ValueError('Sealed snapshot changed: '+name)
   manifest['collections'][name]=entry
   atomic(self.root/'manifest.json',manifest)
   print('Verified snapshot',name,entry['count'],'documents',flush=True)
 def import_snapshot(self,snapshot,names):
  root=Path(snapshot).resolve();manifest=json.loads((root/'manifest.json').read_text())
  scope=manifest['scope']
  if scope['project']!=self.state['scope']['project'] or scope['endpoint']!=self.state['scope']['endpoint']:raise ValueError('Snapshot belongs to another cloud project')
  if scope['environment']==self.state['scope']['environment']:raise ValueError('Refusing to import over source environment')
  source={'scope':scope,'manifest':sha(root/'manifest.json')}
  if self.state.get('source',source)!=source:raise ValueError('Import journal belongs to a different snapshot')
  self.state['source']=source;atomic(self.state_path,self.state)
  if getattr(self.args,'existing_snapshot',None):
   baseline_manifest=Path(self.args.existing_snapshot).resolve()/'manifest.json';baseline_hash=sha(baseline_manifest)
   if self.state.get('existingSnapshot',baseline_hash)!=baseline_hash:raise ValueError('Destination baseline changed during import')
   self.state['existingSnapshot']=baseline_hash;atomic(self.state_path,self.state)
  # Head is published separately only after every other collection reconciles.
  if 'portfolio_heads' in names and not self.args.publish_head:raise ValueError('Head import requires --publish-head after verification')
  for name in names:
   path=root/(name+'.jsonl');entry=manifest['collections'][name]
   if sha(path)!=entry['sha256']:raise ValueError('Snapshot changed: '+name)
   rows=documents(path)
   if logical_digest(rows)!=entry['logicalDigest']:raise ValueError('Logical digest mismatch: '+name)
   if getattr(self.args,'existing_snapshot',None):
    baseline=Path(self.args.existing_snapshot).resolve();existing_manifest=json.loads((baseline/'manifest.json').read_text())
    if existing_manifest['scope']!=self.state['scope']:raise ValueError('Existing snapshot is not the destination')
    if name in existing_manifest['collections']:
     existing_path=baseline/(name+'.jsonl');existing_entry=existing_manifest['collections'][name]
     if sha(existing_path)!=existing_entry['sha256']:raise ValueError('Existing snapshot changed: '+name)
     existing=documents(existing_path)
     if any(key not in rows or row!=rows[key] for key,row in existing.items()):raise ValueError('Unexpected destination content: '+name)
     rows={key:row for key,row in rows.items() if key not in existing}
   if not rows:print('Empty snapshot',name,flush=True);continue
   parts=import_parts(rows)
   for index,content in enumerate(parts):
    key=f'import-{name}-{index:05d}';part=self.root/(key+'.jsonl');digest=hashlib.sha256(content).hexdigest()
    receipt=self.state.get(key,{})
    if receipt.get('sha256',digest)!=digest:raise ValueError('Import input changed: '+key)
    if receipt.get('succeeded'):continue
    part.write_bytes(content);part.chmod(0o600)
    words=['data','import','--timeout','300','--wait','--yes']
    if receipt.get('jobId'):words+=['--job',receipt['jobId']]
    else:words+=['--collection',name,'--input',str(part),'--strategy','create_only','--schema-version',str(2 if name=='robinlab_uploads' else 1)]
    self.state.setdefault(key,{})['sha256']=digest;atomic(self.state_path,self.state)
    response=self.run(key,words);job=response.get('job',response)
    successful(job)
    self.state[key]={**self.state[key],'succeeded':True};atomic(self.state_path,self.state)
    print('Imported',name,index+1,'/',len(parts),flush=True)

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('action',choices=['snapshot','import'])
 for name in ['cli','environment','output','collections']:parser.add_argument('--'+name,required=True)
 parser.add_argument('--config',default='rational.config.json');parser.add_argument('--profile',default='robinlab');parser.add_argument('--snapshot');parser.add_argument('--existing-snapshot');parser.add_argument('--publish-head',action='store_true')
 parser.add_argument('--paged-explorer-collections',default='',help='Stream bounded pages from one stable audited explorer snapshot')
 parser.add_argument('--explorer-collections',default='',help='Use one audited, byte-bounded explorer snapshot for these large-document collections')
 args=parser.parse_args();transfer=Transfer(args);names=args.collections.split(',')
 if any(not re.fullmatch('[a-z][a-z0-9_]{0,62}',n) for n in names):raise ValueError('Invalid collection name')
 if args.action=='snapshot':transfer.snapshot(names)
 else:
  if not args.snapshot:raise ValueError('--snapshot required')
  transfer.import_snapshot(args.snapshot,names)
if __name__=='__main__':main()
