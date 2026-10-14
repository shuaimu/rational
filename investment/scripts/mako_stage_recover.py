#!/usr/bin/env python3
"""Finish a sealed import using fresh reconciliation after terminal job failures.

Never publishes a head. All writes are create-only, and every recovery compares
exported document bodies with the sealed package before selecting missing rows.
"""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from mako_cloud import Cloud, COLLECTIONS, QUALIFICATION, atomic, documents, import_files
import mako_migrate as migration


def missing_rows(expected, actual, collection):
    extra = set(actual) - set(expected) - QUALIFICATION.get(collection, set())
    if extra or any(actual[k] != expected[k] for k in actual.keys() & expected.keys()):
        raise ValueError('destination collision: ' + collection)
    for key in actual.keys() & QUALIFICATION.get(collection, set()):
        body = actual[key]
        if set(body) != {'id', 'payload'} or key.split('_', 1)[1] != hashlib.sha256(body['payload'].encode()).hexdigest():
            raise ValueError('qualification orphan content changed')
    return [v for k, v in expected.items() if k not in actual]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--cli', required=True, type=Path)
    parser.add_argument('--profile', default='robinlab')
    parser.add_argument('--login-email')
    parser.add_argument('--allow-cloud-writes', action='store_true')
    args = parser.parse_args()
    if not args.allow_cloud_writes:
        raise ValueError('requires --allow-cloud-writes')
    cloud = Cloud(args.directory.resolve(), args.cli.resolve(), args.profile)
    secret_path = None
    last_login = 0
    if args.login_email:
        password = getpass.getpass('Existing MakoDB developer password: ')
        fd, name = tempfile.mkstemp(prefix='.login-', dir=cloud.directory)
        secret_path = Path(name)
        with os.fdopen(fd, 'w') as stream:
            stream.write(password)
        del password

    def refresh_login():
        nonlocal last_login
        if secret_path and time.monotonic() - last_login > 600:
            result = subprocess.run(cloud.base + ['auth', 'login', '--email', args.login_email,
                '--password-file', str(secret_path), '--endpoint', cloud.env['endpoint'],
                '--profile', args.profile], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode:
                raise ValueError('developer session renewal failed')
            last_login = time.monotonic()

    def inspect(key):
        refresh_login()
        result = cloud.run(key, ['data', 'jobs', 'get', cloud.jobs[key]['jobId']])
        return result

    def export(collection):
        # Retry only after a prior export is terminal. Keep its job/artifact
        # receipts; never reuse a failed snapshot or overlap active exports.
        for attempt in range(3):
            phase = 'recovery-review-' + str(time.time_ns())
            key = phase + '-' + collection
            while True:
                refresh_login()
                try:
                    return cloud.export(collection, phase)
                except ValueError:
                    if key not in cloud.jobs:
                        raise
                    result = inspect(key)
                    if result['state'] in ['failed', 'cancelled', 'expired']:
                        break
                    if result['state'] == 'succeeded':
                        # A completed job may outlive the CLI wait, but a
                        # repeated download/checksum failure must propagate.
                        return cloud.export(collection, phase)
                    if result['state'] not in ['queued', 'running']:
                        raise
                    time.sleep(5)
            time.sleep(5 * (attempt + 1))
        raise ValueError('repeated export failures: ' + collection)

    def finish(key, part, collection):
        refresh_login()
        if key not in cloud.jobs:
            dry = cloud.run(key, ['data', 'import', '--input', str(part), '--collection', collection,
                '--strategy', 'create_only', '--schema-version', '1', '--dry-run-only'])
        else:
            dry = inspect(key)
            if dry['state'] == 'dry_run':
                dry = cloud.run(key, ['data', 'import', '--job', dry['jobId'],
                    '--input', str(part), '--schema-version', '1', '--dry-run-only'])
        if dry['state'] == 'awaiting_confirmation':
            if dry['progress']['failed'] or dry['errors']:
                raise ValueError('dry run rejected: ' + collection)
            try:
                cloud.run(key, ['data', 'import', '--job', dry['jobId'], '--yes', '--wait', '--timeout', '55'])
            except ValueError:
                # A client timeout does not cancel the job or authorize replay.
                pass
        while True:
            result = inspect(key)
            if result['state'] in ['succeeded', 'failed', 'cancelled', 'expired']:
                return result
            if result['state'] not in ['queued', 'running', 'cancelling']:
                raise ValueError('unexpected job state: ' + result['state'])
            time.sleep(5)

    try:
        refresh_login()
        # Unconfirmed jobs cannot write. Preserve their IDs so finish() resumes
        # the same upload/confirmation after an interrupted local command.
        for key in list(cloud.jobs):
            if key.startswith(('import-', 'recovery-')):
                result = inspect(key)
                if result['state'] not in ['succeeded', 'failed', 'cancelled', 'expired',
                    'dry_run', 'awaiting_confirmation']:
                    raise ValueError('prior job may still write: ' + key)
        if export('portfolio_heads'):
            raise ValueError('recovery staging requires no published head')
        for collection in COLLECTIONS:
            expected = documents(cloud.directory / (collection + '.jsonl'))
            failures = 0
            consecutive_failures = 0
            while True:
                refresh_login()
                actual = export(collection)
                missing = missing_rows(expected, actual, collection)
                print(f'{collection}: {len(expected)-len(missing)}/{len(expected)} verified', flush=True)
                if not missing:
                    break
                interrupted = False
                for start in range(0, len(missing), 512):
                    content = ''.join(json.dumps(row, ensure_ascii=False, separators=(',', ':'))+'\n' for row in missing[start:start+512]).encode()
                    digest = hashlib.sha256(content).hexdigest()
                    path = cloud.export_dir / f'recovery-{collection}-{digest}.jsonl'
                    if path.exists():
                        migration.private(path)
                        if path.read_bytes() != content:
                            raise ValueError('recovery artifact changed')
                    else:
                        with open(path, 'xb', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
                            stream.write(content); stream.flush(); os.fsync(stream.fileno())
                    for part in import_files(path):
                        key = 'recovery-' + collection + '-' + migration.sha(part)
                        # Failed attempts retain their receipts; a fresh reviewed
                        # export must choose a new attempt even if no row landed.
                        attempt = 0
                        while cloud.jobs.get(key, {}).get('state') in ['failed', 'cancelled', 'expired']:
                            attempt += 1
                            key = 'recovery-' + collection + '-' + migration.sha(part) + '-' + str(attempt)
                        result = finish(key, part, collection)
                        if result['state'] != 'succeeded' or result['progress']['failed']:
                            consecutive_failures += 1
                            failures = 0 if result['progress']['committed'] else failures + 1
                            print(collection + ': terminal job reviewed next; attempt retained', flush=True)
                            if failures >= 3:
                                raise ValueError('repeated import failures: ' + collection)
                            delay = min(300, 30 * 2**min(consecutive_failures - 1, 4))
                            print(f'{collection}: cooling down {delay}s before fresh reconciliation', flush=True)
                            # Never pause a subprocess or let its command timeout
                            # expire during a cooldown. No CLI command is active.
                            while delay:
                                pause = min(60, delay)
                                time.sleep(pause)
                                delay -= pause
                            refresh_login()
                            interrupted = True
                            break
                        failures = consecutive_failures = 0
                        count = len(part.read_bytes().splitlines())
                        atomic(cloud.directory / 'recovery-progress.json', {'collection': collection,
                            'verifiedBefore': len(expected)-len(missing), 'stagedThrough': start+count,
                            'expected': len(expected), 'lastJob': result['jobId']})
                        print(f'{collection}: imported {start+count}/{len(missing)} missing rows', flush=True)
                    if interrupted:
                        break
                if interrupted:
                    continue
                # Full collection export is the authoritative completion check.
        refresh_login()
        if not cloud.preflight('verified-staging')['complete']:
            raise ValueError('staging remains incomplete')
        print('All staged collections verified. Head remains unpublished.', flush=True)
    finally:
        if secret_path:
            secret_path.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Recovery stopped: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), flush=True)
        raise SystemExit(1)
