#!/usr/bin/env python3
"""Compare sealed logical snapshots without printing financial values."""
import argparse, importlib.util, json
from pathlib import Path
spec=importlib.util.spec_from_file_location('transfer',Path(__file__).with_name('investment-transfer.py'))
transfer=importlib.util.module_from_spec(spec);spec.loader.exec_module(transfer)
def compare(source,destination,names):
 manifests=[json.loads((root/'manifest.json').read_text()) for root in [source,destination]]
 for name in names:
  data=[]
  for root,manifest in zip([source,destination],manifests):
   entry=manifest['collections'][name];path=root/(name+'.jsonl')
   if transfer.sha(path)!=entry['sha256']:raise ValueError('Unsealed snapshot: '+name)
   rows=transfer.documents(path)
   if len(rows)!=entry['count'] or transfer.logical_digest(rows)!=entry['logicalDigest']:raise ValueError('Snapshot manifest mismatch: '+name)
   data.append(rows)
  if data[0]!=data[1]:raise ValueError('Logical records differ: '+name)
  print('Exact logical parity',name)
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source',type=Path);parser.add_argument('destination',type=Path);parser.add_argument('--collections',required=True);args=parser.parse_args();compare(args.source,args.destination,args.collections.split(','))
