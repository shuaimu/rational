#!/usr/bin/env python3
"""Compare sealed logical snapshots without printing financial values."""
import argparse, importlib.util, json
from pathlib import Path
spec=importlib.util.spec_from_file_location('transfer',Path(__file__).with_name('investment-transfer.py'))
transfer=importlib.util.module_from_spec(spec);spec.loader.exec_module(transfer)
def rows_equal(left,right):
 # Preserve the former parsed-row comparison (including 1 == 1.0) without
 # retaining payloads. Usually the canonical digests already match.
 ranges={};offset=0
 with right.open('rb') as destination:
  for line in destination:
   if line.strip():ranges[json.loads(line)['id']]=(offset,len(line))
   offset+=len(line)
  with left.open('rb') as source:
   for line in source:
    if not line.strip():continue
    row=json.loads(line);location=ranges.pop(row['id'],None)
    if location is None:return False
    destination.seek(location[0])
    if row!=json.loads(destination.read(location[1])):return False
 return not ranges
def compare(source,destination,names):
 manifests=[json.loads((root/'manifest.json').read_text()) for root in [source,destination]]
 for name in names:
  data=[]
  for root,manifest in zip([source,destination],manifests):
   entry=manifest['collections'][name];path=root/(name+'.jsonl')
   actual=transfer.snapshot_summary(path)
   if actual['sha256']!=entry['sha256']:raise ValueError('Unsealed snapshot: '+name)
   if actual['count']!=entry['count'] or actual['logicalDigest']!=entry['logicalDigest']:raise ValueError('Snapshot manifest mismatch: '+name)
   data.append((actual['count'],actual['logicalDigest']))
  if data[0]!=data[1] and not rows_equal(source/(name+'.jsonl'),destination/(name+'.jsonl')):raise ValueError('Logical records differ: '+name)
  print('Exact logical parity',name)
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source',type=Path);parser.add_argument('destination',type=Path);parser.add_argument('--collections',required=True);args=parser.parse_args();compare(args.source,args.destination,args.collections.split(','))
