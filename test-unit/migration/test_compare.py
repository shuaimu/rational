import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('compare', Path(__file__).parents[2] / 'scripts/compare-investment-snapshots.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class CompareTests(unittest.TestCase):
 def setUp(self):
  self.temp = tempfile.TemporaryDirectory()
  self.addCleanup(self.temp.cleanup)
  self.root = Path(self.temp.name)
 def snapshot(self, name, rows):
  root=self.root/name;root.mkdir()
  path=root/'portfolio_commands.jsonl'
  path.write_text(''.join(json.dumps(row)+'\n' for row in rows))
  m.transfer.atomic(root/'manifest.json',{'collections':{'portfolio_commands':{'sha256':m.transfer.sha(path),'logicalDigest':m.transfer.logical_digest({row['id']:row for row in rows}),'count':len(rows)}}})
  return root
 def test_order_and_format_do_not_change_logical_parity(self):
  a=self.snapshot('a',[{'id':'one','value':1},{'id':'two','value':2}])
  b=self.snapshot('b',[{'value':2,'id':'two'},{'value':1,'id':'one'}])
  m.compare(a,b,['portfolio_commands'])
 def test_equal_counts_with_different_content_are_rejected(self):
  a=self.snapshot('a',[{'id':'one','value':1}]);b=self.snapshot('b',[{'id':'one','value':2}])
  with self.assertRaisesRegex(ValueError,'Logical records differ'):m.compare(a,b,['portfolio_commands'])
 def test_unsealed_input_cannot_claim_parity(self):
  a=self.snapshot('a',[{'id':'one'}]);b=self.snapshot('b',[{'id':'one'}])
  (b/'portfolio_commands.jsonl').write_text('{"id":"changed"}\n')
  with self.assertRaisesRegex(ValueError,'Unsealed'):m.compare(a,b,['portfolio_commands'])

if __name__=='__main__':unittest.main()
