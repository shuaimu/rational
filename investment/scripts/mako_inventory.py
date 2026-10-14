#!/usr/bin/env python3
"""Read-only migration snapshots and reconciliation; never imports or cuts over."""
import argparse
from contextlib import closing
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
TABLES = json.loads((ROOT / "mako/table-map.json").read_text())
INTEGER = {"id", "account_id", "ticker_id", "status_code"}
NUMBER = {"quantity", "price", "cost", "fees", "strike_price", "multiplier",
          "computed_value", "broker_value", "latest_price", "balance"}
BOOLEAN = {"success", "is_market_close"}
TIMESTAMP = {"created_at", "updated_at", "fetched_at", "requested_at", "applied_at"}
SAFE_INTEGER = 2**53 - 1


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def normalize(field, value):
    if value is None:
        return None
    if field in INTEGER:
        # Do not let int() truncate fractional IDs or accept booleans.
        if isinstance(value, bool) or str(value).strip() != str(int(value)):
            raise ValueError("non-integer identifier")
        value = int(value)
        if abs(value) > SAFE_INTEGER:
            raise ValueError("identifier exceeds JavaScript safe integer range")
    elif field in NUMBER:
        value = float(value)
        if not math.isfinite(value):
            raise ValueError("non-finite numeric value")
        if value.is_integer():
            value = int(value)
    elif field in BOOLEAN:
        if value not in (True, False, 0, 1, "0", "1"):
            raise ValueError("invalid boolean")
        value = value in (True, 1, "1")
    elif field in TIMESTAMP:
        value = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt.timezone.utc)
        value = value.astimezone(dt.timezone.utc).isoformat(timespec="microseconds")
    return value


def normalize_table(name, rows, columns):
    spec = TABLES[name]
    expected = set(spec["columns"])
    missing = sorted(expected - set(columns))
    extra = sorted(set(columns) - expected - set(spec.get("redacted", [])) - {"deleted"})
    # Transport replication bookkeeping is absent from these SQLite tables.
    if name in ("accounts", "tickers"):
        extra = [field for field in extra if field != "updated_at"]
    clean, keys, duplicate_keys, deleted = [], set(), 0, 0
    for row in rows:
        tombstone = row.get("deleted", False)
        if tombstone not in (True, False, 0, 1):
            raise ValueError("invalid tombstone")
        if tombstone:
            deleted += 1
            continue
        doc = {field: normalize(field, row[field]) for field in spec["columns"] if field in row}
        key = canonical([doc.get(field) for field in spec["key"]])
        if key in keys:
            duplicate_keys += 1
        keys.add(key)
        clean.append(doc)
    clean.sort(key=canonical)
    return {"rows": clean, "count": len(clean), "sha256": digest(clean),
            "missingColumns": missing, "unknownColumns": extra,
            "duplicateKeys": duplicate_keys, "tombstones": deleted,
            "redactedColumns": spec.get("redacted", [])}


def reference_errors(tables):
    def rows(name):
        return tables.get(name, {}).get("rows", [])
    accounts = {row["id"] for row in rows("accounts")}
    tickers = {row["id"] for row in rows("tickers")}
    issues = {}
    for name, field, valid in (("transactions", "account_id", accounts),
                               ("transactions", "ticker_id", tickers),
                               ("account_value_snapshots", "account_id", accounts),
                               ("snaptrade_accounts", "account_id", accounts)):
        count = sum(row.get(field) is not None and row[field] not in valid for row in rows(name))
        if count:
            issues[f"{name}.{field}"] = count
    for name, spec in TABLES.items():
        for fields in spec.get("unique", []):
            values = [canonical([r.get(f) for f in fields]) for r in rows(name)]
            count = len(values) - len(set(values))
            if count:
                issues[f"{name}.unique.{','.join(fields)}"] = count
    return issues


def sqlite_snapshot(path):
    path = path.resolve(strict=True)
    tables = {}
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        present = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        for name, spec in TABLES.items():
            if name not in present:
                tables[name] = {"unavailable": True}
                continue
            columns = [r[1] for r in db.execute(f'PRAGMA table_info("{name}")')]
            # Select only explicit non-secret columns; no SELECT * for credentials.
            selected = [f for f in spec["columns"] if f in columns]
            selection = ",".join(f'"{f}"' for f in selected)
            rows = (dict(r) for r in db.execute(f'SELECT {selection} FROM "{name}"'))
            tables[name] = normalize_table(name, rows, columns)
        db.rollback()
    return {"format": 1, "source": "sqlite", "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "tableMapSha256": digest(TABLES), "tables": tables,
            "unknownTables": sorted(present - set(TABLES)), "referenceErrors": reference_errors(tables),
            "credentialsIncluded": False}


def destination_snapshot(raw):
    if raw.get("format") != 1 or raw.get("source") != "mako":
        raise ValueError("unsupported MakoDB export")
    tables = {}
    for name, spec in TABLES.items():
        if spec.get("sourceOnly"):
            continue
        item = raw.get("tables", {}).get(name)
        if not item or item.get("unavailable"):
            tables[name] = {"unavailable": True}
        else:
            tables[name] = normalize_table(name, item["rows"], item["columns"])
    return {"format": 1, "source": "mako", "tables": tables,
            "tableMapSha256": digest(TABLES), "unknownTables": raw.get("unknownTables", []),
            "referenceErrors": reference_errors(tables), "credentialsIncluded": False}


def snapshot_issues(snapshot):
    issues = {}
    for name, spec in TABLES.items():
        if spec.get("sourceOnly"):
            continue
        item = snapshot.get("tables", {}).get(name, {"unavailable": True})
        flags = {k: item[k] for k in ("unavailable", "missingColumns", "unknownColumns", "duplicateKeys") if item.get(k)}
        if "rows" in item and (item.get("sha256") != digest(item["rows"]) or item.get("count") != len(item["rows"])):
            flags["integrity"] = "snapshot rows do not match recorded count/hash"
        if flags:
            issues[name] = flags
    if snapshot.get("unknownTables"):
        issues["unknownTables"] = snapshot["unknownTables"]
    if snapshot.get("referenceErrors"):
        issues["references"] = snapshot["referenceErrors"]
    if snapshot.get("tableMapSha256") != digest(TABLES):
        issues["tableMap"] = "snapshot uses a different field map"
    if snapshot.get("credentialsIncluded") is not False:
        issues["credentials"] = "snapshot does not declare credential exclusion"
    return issues


def compare(left, right):
    result = {"format": 1, "leftIssues": snapshot_issues(left), "rightIssues": snapshot_issues(right), "tables": {}}
    for name, spec in TABLES.items():
        if spec.get("sourceOnly"):
            continue
        a, b = left["tables"].get(name, {}), right["tables"].get(name, {})
        if "rows" not in a or "rows" not in b:
            result["tables"][name] = {"unavailable": True}
            continue
        def keyed(item):
            return {canonical([r.get(f) for f in spec["key"]]): r for r in item["rows"]}
        aa, bb = keyed(a), keyed(b)
        changed_fields = {}
        changed = []
        for key in aa.keys() & bb.keys():
            if aa[key] != bb[key]:
                changed.append(key)
                for field in set(aa[key]) | set(bb[key]):
                    if aa[key].get(field) != bb[key].get(field) or (field in aa[key]) != (field in bb[key]):
                        changed_fields[field] = changed_fields.get(field, 0) + 1
        # Reports name primary keys and changed columns, never row values or secrets.
        result["tables"][name] = {"leftCount": a["count"], "rightCount": b["count"],
            "leftSha256": a["sha256"], "rightSha256": b["sha256"],
            "leftOnlyKeys": sorted(aa.keys() - bb.keys()), "rightOnlyKeys": sorted(bb.keys() - aa.keys()),
            "changedKeys": sorted(changed), "changedFields": changed_fields}
    result["equivalent"] = not (result["leftIssues"] or result["rightIssues"]) and all(
        not t.get("unavailable") and t["leftSha256"] == t["rightSha256"] for t in result["tables"].values())
    result["cutoverReady"] = False  # Reconciliation is only one readiness check.
    return result


def write_private(path, payload):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Exclusive creation refuses existing files and symlinks; secrets never inherit a permissive mode.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as out:
            out.write(canonical(payload) + "\n")
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--sqlite", type=Path, required=True)
    snapshot.add_argument("--out", type=Path, required=True)
    diff = sub.add_parser("compare")
    diff.add_argument("--sqlite-snapshot", type=Path, required=True)
    diff.add_argument("--destination-export", type=Path, required=True)
    diff.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "snapshot":
            value = sqlite_snapshot(args.sqlite)
        else:
            left = json.loads(args.sqlite_snapshot.read_text())
            if left.get("format") != 1 or left.get("source") != "sqlite":
                raise ValueError("unsupported SQLite snapshot")
            value = compare(left, destination_snapshot(json.loads(args.destination_export.read_text())))
        write_private(args.out, value)
        print(f"Wrote protected {args.command} artifact; no database writes performed.")
        if args.command == "compare":
            print("Datasets equivalent:", value["equivalent"], "(not a cutover approval)")
            return 0 if value["equivalent"] else 2
        return 0
    except (ValueError, OSError, sqlite3.Error, KeyError, TypeError, OverflowError) as error:
        # Values in database/parse errors can contain private data; keep them out of logs.
        print(f"Migration inventory failed ({type(error).__name__}); inspect inputs locally.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
