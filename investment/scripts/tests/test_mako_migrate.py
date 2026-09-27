import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import mako_migrate as migration
import mako_cloud as cloud
import mako_stage_recover as recovery
from mako_stage_recover import missing_rows


def fixture(path):
    with sqlite3.connect(path) as db:
        for name,spec in migration.inventory.TABLES.items():
            columns=spec['columns']+spec.get('redacted',[])
            declaration=[]
            for field in columns:
                kind='INTEGER' if field in migration.inventory.INTEGER or field in migration.inventory.BOOLEAN else 'REAL' if field in migration.inventory.NUMBER else 'TEXT'
                declaration.append('"'+field+'" '+kind)
            db.execute('CREATE TABLE "'+name+'" ('+','.join(declaration)+')')
        db.execute("INSERT INTO accounts VALUES (1,'A',NULL,NULL)")
        db.execute("INSERT INTO tickers VALUES (1,'TEST',NULL)")
        db.execute("INSERT INTO snaptrade_users VALUES (1,'fixture','2025-01-01','private_fixture_secret')")
        db.execute("INSERT INTO transactions(id,account_id,ticker_id,transaction_type,quantity,price,cost,date,status) VALUES (1,1,1,'Buy',1,12.345,12.345,'2025-01-02','open')")


class MigrationTests(unittest.TestCase):
    def test_recovery_resumes_unconfirmed_job_but_refuses_active_writer(self):
        from unittest.mock import patch
        for initial in ['dry_run', 'awaiting_confirmation', 'queued', 'running', 'cancelling']:
            with self.subTest(state=initial), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                content = b'{"id":"one","price":12}\n'
                (root / 'historical_prices.jsonl').write_bytes(content)
                key = 'recovery-historical_prices-' + hashlib.sha256(content).hexdigest()
                instance = cloud.Cloud.__new__(cloud.Cloud)
                instance.directory = instance.export_dir = root
                instance.jobs = {key: {'jobId': 'djob_saved', 'state': initial}}
                calls, exports = [], []
                state = initial

                def run(job_key, args):
                    nonlocal state
                    self.assertEqual(job_key, key)
                    calls.append(args)
                    if args[:2] == ['data', 'import']:
                        self.assertIn('--job', args)
                        self.assertIn('djob_saved', args)
                        if '--dry-run-only' in args:
                            self.assertEqual(state, 'dry_run')
                            self.assertEqual(Path(args[args.index('--input') + 1]).read_bytes(), content)
                            state = 'awaiting_confirmation'
                        else:
                            self.assertEqual(state, 'awaiting_confirmation')
                            self.assertIn('--yes', args)
                            state = 'succeeded'
                    instance.jobs[key]['state'] = state
                    return {'jobId': 'djob_saved', 'state': state,
                            'progress': {'failed': 0, 'committed': int(state == 'succeeded')}, 'errors': []}

                def export(collection, phase):
                    exports.append(collection)
                    return {'one': {'id': 'one', 'price': 12}} if collection == 'historical_prices' and state == 'succeeded' else {}

                instance.run, instance.export = run, export
                instance.preflight = lambda phase: {'complete': state == 'succeeded'}
                argv = ['recovery', str(root), '--cli', str(root / 'cli'), '--allow-cloud-writes']
                with patch.object(recovery, 'Cloud', return_value=instance), patch.object(recovery, 'COLLECTIONS', ['historical_prices']), patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()):
                    if initial in ['queued', 'running', 'cancelling']:
                        with self.assertRaisesRegex(ValueError, 'prior job may still write'):
                            recovery.main()
                        self.assertEqual(exports, [])
                        self.assertEqual(len(calls), 1)
                    else:
                        recovery.main()
                        self.assertEqual(state, 'succeeded')
                        self.assertEqual(sum('--yes' in args for args in calls), 1)
                        self.assertEqual(exports[-1], 'historical_prices')

    def test_partial_import_recovery_excludes_only_exact_committed_rows(self):
        expected = {'a': {'id': 'a', 'price': 1}, 'b': {'id': 'b', 'price': 2}}
        self.assertEqual(missing_rows(expected, {'a': expected['a']}, 'historical_prices'), [expected['b']])
        self.assertEqual(missing_rows(expected, expected, 'historical_prices'), [])
        with self.assertRaises(ValueError):
            missing_rows(expected, {'a': {'id': 'a', 'price': 99}}, 'historical_prices')
        with self.assertRaises(ValueError):
            missing_rows(expected, {'foreign': {'id': 'foreign'}}, 'historical_prices')
        orphan = next(iter(cloud.QUALIFICATION['portfolio_public']))
        with self.assertRaises(ValueError):
            missing_rows({}, {orphan: {'id': orphan, 'payload': 'changed'}}, 'portfolio_public')

    def test_consistent_backup_separate_credentials_and_checksum_tampering(self):
        with tempfile.TemporaryDirectory() as temp,contextlib.redirect_stdout(io.StringIO()):
            root=Path(temp);source=root/'source.sqlite';fixture(source);before=source.read_bytes();out=root/'migration'
            migration.snapshot(source,out)
            self.assertEqual(source.read_bytes(),before)
            self.assertNotIn('private_fixture_secret',(out/'inventory.json').read_text())
            self.assertNotIn('private_fixture_secret',(out/'source.json').read_text())
            self.assertIn('private_fixture_secret',(out/'credentials.json').read_text())
            self.assertEqual((out/'credentials.json').stat().st_mode&0o777,0o600)
            migration.verify_files(out)
            with self.assertRaises(FileExistsError): migration.snapshot(source,out)
            with (out/'source.json').open('a') as stream: stream.write(' ')
            with self.assertRaises(ValueError): migration.verify_files(out)

    def test_rollback_replays_accepted_mutation_into_new_copy(self):
        with tempfile.TemporaryDirectory() as temp,contextlib.redirect_stdout(io.StringIO()):
            root=Path(temp);source=root/'source.sqlite';fixture(source);out=root/'migration';migration.snapshot(source,out)
            tables={}
            with sqlite3.connect(source) as db:
                db.row_factory=sqlite3.Row
                for name,spec in migration.inventory.TABLES.items():
                    if spec.get('sourceOnly'):continue
                    columns=spec['columns']+spec.get('redacted',[])
                    tables[name]={'columns':columns,'rows':[dict(r) for r in db.execute('SELECT * FROM "'+name+'"')]}
            row=dict(tables['transactions']['rows'][0]);row.update(id=2,quantity=2,cost=24.69)
            tables['transactions']['rows'].append(row)
            exported=root/'cloud.json';migration.write(exported,{'format':1,'source':'mako','version':2,'tables':tables,'nextIds':{'account':2,'ticker':2,'transaction':3,'brokerage_user':2}})
            restored=root/'rollback.sqlite';migration.rollback(out,exported,restored)
            with sqlite3.connect(restored) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM transactions').fetchone()[0],2)
                self.assertEqual(db.execute('SELECT user_secret FROM snaptrade_users').fetchone()[0],'private_fixture_secret')
            with sqlite3.connect(source) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM transactions').fetchone()[0],1)
            with self.assertRaises(FileExistsError): migration.rollback(out,exported,restored)

    def test_resume_accepts_dependency_retry_warnings_and_rejects_changed_input(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / 'missing-portfolio_public.jsonl'
            path.write_text('{"id":"one","payload":"x"}\n')
            migration.write(root / 'package.json', {'fixture': True})
            migration.write(root / 'preflight.json', {
                'packageSha256': migration.sha(root / 'package.json'),
                'collections': {'portfolio_public': {'missing': 1, 'missingSha256': migration.sha(path)}},
            })
            instance = cloud.Cloud.__new__(cloud.Cloud)
            instance.directory = instance.export_dir = root
            instance.jobs = {'import-portfolio_public': {'jobId': 'djob_fixture', 'state': 'running'}}
            calls = []
            def run(key, args):
                calls.append(args)
                return {'jobId': 'djob_fixture', 'state': 'running' if len(calls) == 1 else 'succeeded',
                        'progress': {'failed': 0}, 'errors': ['worker_dependency_retry_scheduled']}
            instance.run = run
            with patch.object(cloud, 'COLLECTIONS', ['portfolio_public']), contextlib.redirect_stdout(io.StringIO()):
                instance.stage()
                self.assertEqual(len(calls), 2)
                self.assertIn('djob_fixture', calls[0])
                self.assertIn('--wait', calls[1])
                path.write_text('{"id":"unexpected"}\n')
                with self.assertRaises(ValueError): instance.stage()
                self.assertEqual(len(calls), 2)

    def test_large_import_parts_are_bounded_repeatable_and_tamper_evident(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'rows.jsonl'
            content = ''.join(json.dumps({'id': str(i), 'payload': 'x' * 30000}) + '\n' for i in range(20))
            path.write_text(content)
            parts = cloud.import_files(path)
            self.assertGreater(len(parts), 1)
            self.assertEqual(b''.join(p.read_bytes() for p in parts), content.encode())
            self.assertTrue(all(p.stat().st_size <= cloud.IMPORT_REQUEST_BUDGET for p in parts))
            self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in parts))
            self.assertEqual(cloud.import_files(path), parts)
            parts[0].write_text('changed')
            with self.assertRaises(ValueError): cloud.import_files(path)
            path.write_text(''.join(json.dumps({'id': str(i)}) + '\n' for i in range(10000)))
            self.assertEqual(cloud.import_files(path), [path])

    def test_empty_cloud_export_and_blank_lines(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'rows.jsonl'
            path.write_text('\n')
            self.assertEqual(cloud.documents(path), {})
            path.write_text('\n{"id":"one","payload":"x"}\n\n')
            self.assertEqual(cloud.documents(path), {'one': {'id': 'one', 'payload': 'x'}})

    def test_destination_duplicates_and_modified_qualification_content_are_not_ignored(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'rows.jsonl';path.write_text('{"id":"same"}\n{"id":"same"}\n')
            with self.assertRaises(ValueError):cloud.documents(path)
        for values in cloud.QUALIFICATION.values():
            self.assertTrue(all(len(value)==66 for value in values))

if __name__=='__main__':unittest.main()
