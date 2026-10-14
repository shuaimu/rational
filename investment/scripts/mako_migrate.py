#!/usr/bin/env python3
"""Protected, reproducible migration artifacts; cloud writes require a separate publish step."""
import argparse
from contextlib import closing
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import mako_inventory as inventory

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ['accounts', 'tickers', 'transactions', 'ticker_splits', 'account_value_snapshots']
PRIVATE = ['snaptrade_accounts', 'snaptrade_users']
CACHE = {'price_cache': 'historical_prices', 'latest_price_cache': 'latest_prices', 'provider_request_log': 'provider_requests', 'split_fetch': 'split_fetch'}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, value):
    with open(path, 'x', encoding='utf8', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def private(path):
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError('migration artifact must be private and not a symlink')


def snapshot(source, output):
    source = source.resolve(strict=True)
    output.mkdir(mode=0o700)
    private(output)
    backup = output / 'source.sqlite'
    fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as live, closing(sqlite3.connect(backup)) as frozen:
        live.backup(frozen)
        if frozen.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('SQLite integrity check failed')
    report = inventory.sqlite_snapshot(backup)
    if inventory.snapshot_issues(report):
        raise ValueError('source inventory has integrity issues; inspect the read-only inventory')
    write(output / 'inventory.json', report)
    tables = {name: item['rows'] for name, item in report['tables'].items() if not inventory.TABLES[name].get('sourceOnly')}
    credentials = {}
    with closing(sqlite3.connect(backup.as_uri() + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        for name in PRIVATE:
            fields = inventory.TABLES[name].get('redacted', [])
            keys = inventory.TABLES[name]['key']
            credentials[name] = [dict(row) for row in db.execute('SELECT ' + ','.join('"' + f + '"' for f in keys + fields) + ' FROM "' + name + '"')]
        counters = {}
        for field, name in [('account', 'accounts'), ('ticker', 'tickers'), ('transaction', 'transactions'), ('brokerage_user', 'snaptrade_users')]:
            maximum = max([row['id'] for row in tables[name]] + [0])
            seq = db.execute('SELECT seq FROM sqlite_sequence WHERE name=?', (name,)).fetchone() if db.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone() else None
            maximum = max(maximum, seq[0] if seq else 0)
            counters[field] = maximum + 1 if maximum < inventory.SAFE_INTEGER else None
    # Credentials never enter the ordinary reconciliation inventory.
    write(output / 'credentials.json', credentials)
    write(output / 'source.json', {'public': {name: tables[name] for name in PUBLIC}, 'private': {name: tables[name] for name in PRIVATE}, 'nextIds': counters, 'asOf': dt.date.today().isoformat()})
    for name, collection in CACHE.items():
        with open(output / (collection + '.jsonl'), 'x', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
            for original in tables[name]:
                row = dict(original)
                if name == 'provider_request_log':
                    # Raw provider errors can contain signed URLs/API keys.
                    row['error'] = None
                key = [row[field] for field in inventory.TABLES[name]['key']]
                identity = 'r_' + hashlib.sha256(json.dumps(key, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
                stream.write(json.dumps({'id': identity, 'row': row}, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
    manifest = {'format': 1, 'sourcePath': str(source), 'destination': json.loads((ROOT / 'mako/environment.json').read_text()), 'files': {p.name: sha(p) for p in sorted(output.iterdir()) if p.is_file()}, 'counts': {name: len(rows) for name, rows in tables.items()}, 'credentialsIncludedInInventory': False}
    write(output / 'manifest.json', manifest)
    print(json.dumps({'snapshot': str(output), 'counts': manifest['counts'], 'sourceSha256': manifest['files']['source.sqlite']}))


def verify_files(directory):
    private(directory)
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest['destination'] != json.loads((ROOT / 'mako/environment.json').read_text()):
        raise ValueError('destination metadata changed')
    for name, expected in manifest['files'].items():
        path = directory / name
        if path.parent != directory or path.is_symlink():
            raise ValueError('unsafe artifact path')
        private(path)
        if sha(path) != expected:
            raise ValueError('migration artifact checksum changed: ' + name)
    return manifest


def rollback(directory, cloud_export, output):
    """Rebuild a new legacy DB from a verified, private cloud export; never replaces a live DB."""
    verify_files(directory)
    private(cloud_export)
    raw = json.loads(cloud_export.read_text())
    if raw.get('format') != 1 or raw.get('source') != 'mako':
        raise ValueError('invalid cloud export')
    fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    with closing(sqlite3.connect((directory / 'source.sqlite').as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(output)) as target:
        source.backup(target)
        target.execute('PRAGMA foreign_keys=OFF')
        with target:
            for name, spec in inventory.TABLES.items():
                if spec.get('sourceOnly'):
                    continue
                item = raw['tables'][name]
                columns = item['columns']
                if set(columns) != set(spec['columns'] + spec.get('redacted', [])):
                    raise ValueError('rollback columns mismatch: ' + name)
                target.execute('DELETE FROM "' + name + '"')
                statement = 'INSERT INTO "' + name + '" (' + ','.join('"' + c + '"' for c in columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')'
                target.executemany(statement, [[row[c] for c in columns] for row in item['rows']])
            for field, name in [('account', 'accounts'), ('ticker', 'tickers'), ('transaction', 'transactions'), ('brokerage_user', 'snaptrade_users')]:
                value = raw['nextIds'][field]
                sequence = inventory.SAFE_INTEGER if value is None else value - 1
                if target.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone():
                    target.execute('DELETE FROM sqlite_sequence WHERE name=?', (name,))
                    target.execute('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)', (name, sequence))
            if target.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('rollback foreign keys failed')
        if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('rollback SQLite integrity failed')
    restored = inventory.sqlite_snapshot(output)
    result = inventory.compare(restored, inventory.destination_snapshot(raw))
    if not result['equivalent']:
        raise ValueError('rollback reconciliation failed')
    write(output.with_suffix('.verification.json'), {'equivalent': True, 'cloudVersion': raw['version'], 'sqliteSha256': sha(output)})
    print('Rollback copy verified; live database unchanged.')


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    snap = sub.add_parser('snapshot'); snap.add_argument('--sqlite', type=Path, required=True); snap.add_argument('--out', type=Path, required=True)
    check = sub.add_parser('verify-files'); check.add_argument('directory', type=Path)
    restore = sub.add_parser('rollback'); restore.add_argument('directory', type=Path); restore.add_argument('--cloud-export', type=Path, required=True); restore.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'snapshot': snapshot(args.sqlite, args.out.resolve())
    elif args.command == 'verify-files': verify_files(args.directory.resolve()); print('Artifact checksums verified.')
    else: rollback(args.directory.resolve(), args.cloud_export.resolve(), args.out.resolve())

if __name__ == '__main__':
    try: main()
    except Exception as error:
        # SQLite/JSON parse errors can include source data. Never dump a traceback.
        print('Migration stopped: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
