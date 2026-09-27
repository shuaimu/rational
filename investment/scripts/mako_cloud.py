#!/usr/bin/env python3
"""Resumable official-CLI bulk migration. Publishes only after an exact staged export."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import mako_migrate as migration

COLLECTIONS = ['portfolio_public', 'portfolio_private', 'portfolio_commands', 'historical_prices', 'latest_prices', 'provider_requests', 'split_fetch']
# Exact immutable synthetic records left by the documented qualification.
QUALIFICATION = {
    'portfolio_public': {'p_77a04a996fcfb15bf4ccfcd72651632db59769e9960d1d70c4a49e2f15cc6d6b', 'm_e69d4f59ae5aa086981b03da5a70000a6f6bafd1f94f4c90c411c3b456f93c81'},
    'portfolio_private': {'m_3b1998b794ebd622e9cfc6c5e545e6bcde50304a93363cde53f5c8d27d5475f8'},
}


def documents(path):
    rows = {}
    with path.open() as stream:
        for line in stream:
            # MakoDB represents an empty export as a single newline.
            if not line.strip():
                continue
            value = json.loads(line)
            key = value['id']
            if key in rows:
                raise ValueError('duplicate destination primary key')
            rows[key] = value
    return rows



# Leave room for the internal command envelope on older MakoDB deployments.
IMPORT_REQUEST_BUDGET = 200_000


def import_files(path):
    lines = path.read_bytes().splitlines(keepends=True)
    if not lines:
        return []
    # Small-record collections can use one large artifact: the worker sends at
    # most 32 records per RPC. Split only files whose batches could exceed it.
    if max(map(len, lines)) * min(32, len(lines)) <= IMPORT_REQUEST_BUDGET:
        return [path]
    chunks, current, size = [], [], 0
    for line in lines:
        if len(line) > IMPORT_REQUEST_BUDGET:
            raise ValueError('individual import record exceeds the request budget')
        if current and size + len(line) > IMPORT_REQUEST_BUDGET:
            chunks.append(b''.join(current)); current, size = [], 0
        current.append(line); size += len(line)
    if current:
        chunks.append(b''.join(current))
    files = []
    for index, content in enumerate(chunks):
        output = path.with_name(path.stem + '-part-%04d.jsonl' % index)
        if output.exists():
            migration.private(output)
            if output.read_bytes() != content:
                raise ValueError('resumable import part checksum changed')
        else:
            with open(output, 'xb', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
                stream.write(content)
                stream.flush(); os.fsync(stream.fileno())
        files.append(output)
    return files


def seal(directory):
    migration.verify_files(directory)
    files = COLLECTIONS + ['head']
    hashes = {name + ('.json' if name == 'head' else '.jsonl'): migration.sha(directory / (name + ('.json' if name == 'head' else '.jsonl'))) for name in files}
    migration.write(directory / 'package.json', {'format': 1, 'sourceManifestSha256': migration.sha(directory / 'manifest.json'), 'files': hashes})
    print('Immutable migration package sealed.')


def validate(directory):
    migration.verify_files(directory)
    package = json.loads((directory / 'package.json').read_text())
    if package['sourceManifestSha256'] != migration.sha(directory / 'manifest.json'):
        raise ValueError('source manifest changed')
    for name, expected in package['files'].items():
        path = directory / name
        if path.parent != directory:
            raise ValueError('invalid package path')
        migration.private(path)
        if migration.sha(path) != expected:
            raise ValueError('sealed package changed')
    return package


def atomic(path, value):
    temporary = path.with_suffix('.tmp')
    if temporary.exists():
        migration.private(temporary)
        temporary.unlink()
    migration.write(temporary, value)
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


class Cloud:
    def __init__(self, directory, cli, profile):
        self.directory = directory
        self.package = validate(directory)
        self.env = json.loads((migration.ROOT / 'mako/environment.json').read_text())
        self.base = ['node', str(cli)]
        self.flags = ['--profile', profile, '--endpoint', self.env['endpoint'], '--project', self.env['projectId'], '--env', self.env['environmentId'], '--json']
        self.journal = directory / 'bulk-jobs.json'
        self.jobs = json.loads(self.journal.read_text()) if self.journal.exists() else {}
        self.export_dir = directory / 'cloud-exports'
        self.export_dir.mkdir(mode=0o700, exist_ok=True)
        migration.private(self.export_dir)

    def run(self, key, args):
        # Preserve the job ID as soon as the CLI prints it, including on timeout.
        attempt = len(list(self.export_dir.glob('command-*.log')))
        log = self.export_dir / ('command-%04d.log' % attempt)
        with open(log, 'x', opener=lambda p, f: os.open(p, f, 0o600)) as stderr:
            process = subprocess.Popen(self.base + args + self.flags, stdout=subprocess.PIPE, stderr=stderr, text=True)
            try: stdout, _ = process.communicate(timeout=65)
            except subprocess.TimeoutExpired:
                process.terminate(); stdout, _ = process.communicate(timeout=10)
                code = -1
            else: code = process.returncode
        job_ids = re.findall(r'\bdjob_[A-Za-z0-9_-]+', log.read_text())
        if job_ids:
            self.jobs[key] = {'jobId': job_ids[0]}
            atomic(self.journal, self.jobs)
        if code != 0:
            raise ValueError('cloud command did not complete; saved job can be resumed (' + key + ')')
        result = json.loads(stdout)
        job = result.get('job', result)
        if 'jobId' in job:
            self.jobs[key] = {'jobId': job['jobId'], 'state': job['state']}
            atomic(self.journal, self.jobs)
        return result

    def export(self, collection, phase):
        key = phase + '-' + collection
        output = self.export_dir / (key + '.jsonl')
        marker = output.with_suffix('.receipt.json')
        if marker.exists():
            receipt = json.loads(marker.read_text())
            if migration.sha(output) != receipt['sha256']:
                raise ValueError('downloaded artifact checksum changed')
            return documents(output)
        args = ['data', 'export', '--output', str(output), '--timeout', '55']
        if key in self.jobs: args += ['--job', self.jobs[key]['jobId']]
        else: args += ['--collection', collection]
        if output.exists():
            # Only this phase's unfinished download; CLI uses exclusive output.
            migration.private(output); output.unlink()
        result = self.run(key, args)
        os.chmod(output, 0o600)
        if result['job']['state'] != 'succeeded' or result['digest'] != 'sha256:' + migration.sha(output):
            raise ValueError('export digest or job status failed')
        migration.write(marker, {'sha256': migration.sha(output), 'jobId': result['job']['jobId']})
        return documents(output)

    def preflight(self, phase):
        head = self.export('portfolio_heads', phase)
        expected_head = json.loads((self.directory / 'head.json').read_text())
        if head and head != {'portfolio': expected_head}:
            raise ValueError('destination has a different live portfolio head')
        result = {'format': 1, 'packageSha256': migration.sha(self.directory / 'package.json'), 'headAlreadyPublished': bool(head), 'collections': {}}
        for collection in COLLECTIONS:
            expected = documents(self.directory / (collection + '.jsonl'))
            actual = self.export(collection, phase)
            extra = set(actual) - set(expected) - QUALIFICATION.get(collection, set())
            if extra or any(actual[key] != expected[key] for key in set(actual) & set(expected)):
                raise ValueError('destination collision: ' + collection)
            # Qualification exceptions are content-addressed, and payloads are verified.
            for key in set(actual) & QUALIFICATION.get(collection, set()):
                body = actual[key]
                if set(body) != {'id', 'payload'} or key.split('_', 1)[1] != hashlib.sha256(body['payload'].encode()).hexdigest():
                    raise ValueError('qualification orphan content changed')
            missing = [value for key, value in expected.items() if key not in actual]
            result['collections'][collection] = {'expected': len(expected), 'present': len(expected) - len(missing), 'missing': len(missing)}
            if phase == 'preflight':
                path = self.export_dir / ('missing-' + collection + '.jsonl')
                content = ''.join(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n' for value in missing).encode()
                if path.exists():
                    migration.private(path)
                    if path.read_bytes() != content:
                        raise ValueError('preflight import file changed: ' + collection)
                else:
                    with open(path, 'xb', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
                        stream.write(content)
                result['collections'][collection]['missingSha256'] = hashlib.sha256(content).hexdigest()
            print(collection + ': ' + str(len(expected) - len(missing)) + '/' + str(len(expected)) + ' matching documents', flush=True)
        result['complete'] = all(item['missing'] == 0 for item in result['collections'].values())
        atomic(self.directory / (phase + '.json'), result)
        return result

    def stage(self):
        report = json.loads((self.directory / 'preflight.json').read_text())
        if report['packageSha256'] != migration.sha(self.directory / 'package.json'):
            raise ValueError('preflight is for another package')
        for collection in COLLECTIONS:
            if report['collections'][collection]['missing'] == 0: continue
            path = self.export_dir / ('missing-' + collection + '.jsonl')
            if migration.sha(path) != report['collections'][collection].get('missingSha256'):
                raise ValueError('preflight import file checksum missing or changed; rerun preflight')
            for index, part in enumerate(import_files(path)):
                key = 'import-' + collection + ('-part-%04d' % index if part != path else '')
                if self.jobs.get(key, {}).get('state') == 'succeeded': continue
                args = ['data', 'import', '--input', str(part), '--schema-version', '1', '--dry-run-only']
                if key in self.jobs: args += ['--job', self.jobs[key]['jobId']]
                else: args += ['--collection', collection, '--strategy', 'create_only']
                dry = self.run(key, args)
                if dry['progress']['failed'] or (dry['state'] == 'awaiting_confirmation' and dry['errors']):
                    raise ValueError('bulk dry run failed: ' + collection)
                done = self.run(key, ['data', 'import', '--job', dry['jobId'], '--yes', '--wait', '--timeout', '55'])
                if done['state'] != 'succeeded' or done['progress']['failed']:
                    raise ValueError('bulk import incomplete: ' + collection)
                print('Imported ' + collection + ' part ' + str(index + 1), flush=True)



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['seal', 'preflight', 'stage', 'verify'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--cli', type=Path)
    parser.add_argument('--profile', default='robinlab')
    parser.add_argument('--allow-cloud-writes', action='store_true')
    args = parser.parse_args(); directory = args.directory.resolve()
    if args.phase == 'seal': seal(directory); return
    if not args.cli: raise ValueError('--cli is required')
    cloud = Cloud(directory, args.cli.resolve(), args.profile)
    if args.phase == 'stage':
        if not args.allow_cloud_writes: raise ValueError('stage requires --allow-cloud-writes')
        cloud.stage()
    else:
        report = cloud.preflight('preflight' if args.phase == 'preflight' else 'verified-staging')
        if args.phase == 'verify' and not report['complete']: raise ValueError('staged data is incomplete')

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Migration stopped: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
