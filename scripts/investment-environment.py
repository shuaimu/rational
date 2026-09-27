#!/usr/bin/env python3
"""Additive investment metadata provisioning from a protected source inventory.

No financial documents, credentials, or existing household resources are changed.
"""
import argparse, json, os, subprocess
from pathlib import Path

COLLECTIONS = ('cache_status','historical_prices','latest_prices','portfolio_commands',
 'portfolio_heads','portfolio_private','portfolio_public','provider_requests',
 'robinlab_coordination','robinlab_counters','robinlab_inputs','robinlab_jobs',
 'robinlab_lanes','robinlab_uploads','split_fetch')

def provision(args):
 config=json.loads(Path(args.config).read_text())
 inventory=Path(args.inventory).resolve()
 journal=inventory/'destination-provisioning.json'
 receipts=json.loads(journal.read_text()) if journal.exists() else {}
 def record(key,value):
  receipts[key]=value
  tmp=journal.with_suffix('.tmp');tmp.write_text(json.dumps(receipts,indent=2)+'\n');tmp.chmod(0o600);tmp.replace(journal)
 def call(*words):
  result=subprocess.run(['node',args.cli,*words,'--project',config['projectId'],'--env',config['environmentId'],
   '--endpoint',config['endpoint'],'--profile',args.profile,'--json'],capture_output=True,text=True)
  if result.returncode:raise RuntimeError(result.stderr[:700])
  return json.loads(result.stdout)
 def file(name,value):
  p=inventory/name;p.write_text(json.dumps(value)+'\n');p.chmod(0o600);return '@'+str(p)
 source={c['id']:c for c in json.loads((inventory/'source-collections.json').read_text())}
 baseline={c['id']:c for c in json.loads((inventory/'destination-collections.json').read_text())}
 if set(COLLECTIONS)&set(baseline):raise ValueError('Baseline collection collision: refusing to change an existing resource')
 existing={c['id']:c for c in call('collections','list')}
 for name in COLLECTIONS:
  definition=source[name]
  if name in existing:
   actual=existing[name]
   if any(actual[k]!=definition[k] for k in ['jsonSchema','primaryKey','schemaVersion']):raise ValueError('Schema collision: '+name)
  else:
   record(name+'.schema',call('collections','create',name,'--schema',file(name+'.schema.json',definition['jsonSchema']),
    '--primary-key',json.dumps(definition['primaryKey']),'--schema-version',str(definition['schemaVersion'])))
  policy=json.loads((inventory/('source-'+name+'-policies.json')).read_text())['policy']
  rules=json.loads(json.dumps(policy['rules']).replace(args.source_owner,args.owner))
  active=call('policies','get',name)
  if (active.get('policy') or {}).get('rules')!=rules or not active.get('policy'):
   if active.get('policy') and active['policy'].get('state')=='active':raise ValueError('Policy collision: '+name)
   version=1
   record(name+'.policy-draft',call('policies','draft',name,'--input',file(name+'.policy.json',{'version':version,'rules':rules})))
   check=call('policies','validate',name,str(version))
   if not check.get('valid'):raise ValueError('Policy invalid: '+name)
   record(name+'.policy',call('policies','activate',name,str(version),'--yes'))
  current={i['name']:i for i in call('indexes','list',name)}
  for index in json.loads((inventory/('source-'+name+'-indexes.json')).read_text()):
   if index['name'] in current:
    found=current[index['name']]
    if any(found[k]!=index[k] for k in ['kind','fields']) or found['state'] not in ['active','building']:raise ValueError('Index collision: '+name)
    continue
   words=['indexes','create',name,'--name',index['name'],'--version',str(index['version'])]
   if index['kind']=='unique':words+=['--unique']
   for field in index['fields']:words+=['--field',field['path']+':'+field['direction']]
   record(name+'.index.'+index['name'],call(*words))
  print('Provisioned',name,flush=True)
 for original in baseline.values():
  actual=next(c for c in call('collections','list') if c['id']==original['id'])
  if actual!=original:raise ValueError('Existing Rational schema changed: '+original['id'])
 print('All investment metadata provisioned; existing Rational schemas unchanged.')

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 for flag in ['cli','inventory','source-owner','owner']:parser.add_argument('--'+flag,required=True)
 parser.add_argument('--config',default='rational.config.json');parser.add_argument('--profile',default='robinlab')
 provision(parser.parse_args())
