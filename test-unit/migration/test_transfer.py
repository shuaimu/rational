import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('transfer', Path(__file__).parents[2] / 'scripts/investment-transfer.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class TransferTests(unittest.TestCase):
 def setUp(self):
  self.temp = tempfile.TemporaryDirectory()
  self.addCleanup(self.temp.cleanup)
  self.root = Path(self.temp.name)
  self.config = self.root / 'config.json'
  self.config.write_text(json.dumps({'projectId':'p','endpoint':'https://example.invalid'}))
  self.args = SimpleNamespace(output=str(self.root/'target'), config=str(self.config), environment='destination', profile='fixture', cli='fixture', publish_head=False)
 def snapshot(self, rows):
  root = self.root/'source';root.mkdir(exist_ok=True)
  path = root/'portfolio_heads.jsonl'
  path.write_text(''.join(json.dumps(v)+'\n' for v in rows.values()))
  m.atomic(root/'manifest.json', {'scope':{'environment':'source','project':'p','endpoint':'https://example.invalid'}, 'collections':{'portfolio_heads':{'sha256':m.sha(path),'logicalDigest':m.logical_digest(rows),'count':len(rows)}}})
  return root
 def test_large_captures_are_isolated_and_small_rows_batched(self):
  rows = {str(i):{'id':str(i),'payload':'a'*350000} for i in range(3)}
  parts=m.import_parts(rows)
  self.assertEqual(len(parts),3)
  self.assertTrue(all(len(p.splitlines())==1 for p in parts))
  self.assertEqual(len(m.import_parts({str(i):{'id':str(i)} for i in range(300)})),1)
  with self.assertRaises(ValueError):m.import_parts({'big':{'id':'big','payload':'a'*1048576}})
 def test_failed_records_are_not_success(self):
  with self.assertRaises(ValueError):m.successful({'state':'succeeded','progress':{'failed':1}})
 def test_timeout_retains_job_for_resume(self):
  transfer=m.Transfer(self.args)
  def interrupted(*args, **kwargs):
   kwargs['stderr'].write('Created job djob_fixture01\n');kwargs['stderr'].flush()
   raise subprocess.TimeoutExpired('fixture',65)
  with patch.object(m.subprocess,'run',interrupted):
   with self.assertRaises(RuntimeError):transfer.run('import-test',[])
  self.assertEqual(m.Transfer(self.args).state['import-test']['jobId'],'djob_fixture01')
 def test_head_requires_explicit_publication_and_sealed_input(self):
  root=self.snapshot({'portfolio':{'id':'portfolio'}});transfer=m.Transfer(self.args)
  with self.assertRaisesRegex(ValueError,'publish-head'):transfer.import_snapshot(root,['portfolio_heads'])
  self.args.publish_head=True
  (root/'portfolio_heads.jsonl').write_text('{"id":"changed"}\n')
  with self.assertRaisesRegex(ValueError,'Snapshot changed'):transfer.import_snapshot(root,['portfolio_heads'])
 def test_successful_parts_resume_without_duplicate_submission(self):
  root=self.snapshot({'portfolio':{'id':'portfolio'}});self.args.publish_head=True
  transfer=m.Transfer(self.args)
  with patch.object(transfer,'run',return_value={'job':{'state':'succeeded','progress':{'failed':0}}}) as run:
   transfer.import_snapshot(root,['portfolio_heads']);transfer.import_snapshot(root,['portfolio_heads'])
   self.assertEqual(run.call_count,1)
  with self.assertRaisesRegex(ValueError,'different snapshot'):
   manifest=json.loads((root/'manifest.json').read_text());manifest['extra']='changed';m.atomic(root/'manifest.json',manifest)
   transfer.import_snapshot(root,['portfolio_heads'])
 def test_journal_refuses_environment_rebinding(self):
  m.Transfer(self.args);self.args.environment='other'
  with self.assertRaisesRegex(ValueError,'another environment'):m.Transfer(self.args)
 def test_verified_partial_destination_is_skipped_without_recreating_rows(self):
  root=self.snapshot({'portfolio':{'id':'portfolio'}});self.args.publish_head=True
  baseline=self.root/'baseline';baseline.mkdir()
  (baseline/'portfolio_heads.jsonl').write_bytes((root/'portfolio_heads.jsonl').read_bytes())
  manifest=json.loads((root/'manifest.json').read_text());manifest['scope']['environment']='destination';m.atomic(baseline/'manifest.json',manifest)
  self.args.existing_snapshot=str(baseline);transfer=m.Transfer(self.args)
  with patch.object(transfer,'run') as run:
   transfer.import_snapshot(root,['portfolio_heads']);run.assert_not_called()
  manifest['extra']='changed';m.atomic(baseline/'manifest.json',manifest)
  with self.assertRaisesRegex(ValueError,'baseline changed'):transfer.import_snapshot(root,['portfolio_heads'])
 def test_partial_destination_collision_is_not_overwritten(self):
  root=self.snapshot({'portfolio':{'id':'portfolio'}});self.args.publish_head=True
  baseline=self.root/'baseline';baseline.mkdir();p=baseline/'portfolio_heads.jsonl';p.write_text('{"id":"unrelated"}\n')
  m.atomic(baseline/'manifest.json',{'scope':{'environment':'destination','project':'p','endpoint':'https://example.invalid'},'collections':{'portfolio_heads':{'sha256':m.sha(p)}}})
  self.args.existing_snapshot=str(baseline)
  with self.assertRaisesRegex(ValueError,'Unexpected destination'):m.Transfer(self.args).import_snapshot(root,['portfolio_heads'])
 def test_duplicate_ids_rejected(self):
  path=self.root/'duplicate.jsonl';path.write_text('{"id":"one"}\n{"id":"one"}\n')
  with self.assertRaises(ValueError):m.documents(path)
 def test_explorer_snapshot_requires_complete_pagination_and_excludes_tombstones(self):
  self.args.explorer_collections='robinlab_inputs'
  transfer=m.Transfer(self.args)
  live={'id':'capture','payload':'x'*300000}
  with patch.object(transfer,'run',return_value={'items':[{'deleted':False,'content':live}], 'nextCursor':'more'}):
   with self.assertRaisesRegex(ValueError,'Incomplete explorer'):transfer.snapshot(['robinlab_inputs'])
  self.assertNotIn('sha256',transfer.state.get('export-robinlab_inputs',{}))
  with patch.object(transfer,'run',return_value={'items':[{'deleted':False,'content':live},{'deleted':True,'content':{'id':'deleted'}}], 'nextCursor':None}):
   transfer.snapshot(['robinlab_inputs'])
  self.assertEqual(m.documents(transfer.root/'robinlab_inputs.jsonl'),{'capture':live})
  self.assertEqual((transfer.root/'robinlab_inputs.jsonl').stat().st_mode & 0o777,0o600)

if __name__=='__main__':unittest.main()
