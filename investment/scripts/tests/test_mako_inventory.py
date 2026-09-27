import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "mako_inventory.py"
spec = importlib.util.spec_from_file_location("inventory", MODULE)
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def empty_snapshot():
    tables = {name: inventory.normalize_table(name, [], spec["columns"])
              for name, spec in inventory.TABLES.items()}
    return {"format": 1, "source": "sqlite", "tables": tables, "referenceErrors": {},
            "unknownTables": [], "credentialsIncluded": False,
            "tableMapSha256": inventory.digest(inventory.TABLES)}


class InventoryTests(unittest.TestCase):
    def test_missing_database_does_not_create_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "absent.db"
            with self.assertRaises(FileNotFoundError):
                inventory.sqlite_snapshot(path)
            self.assertFalse(path.exists())

    def test_sqlite_snapshot_is_read_only_and_excludes_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.db"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE snaptrade_users (id INTEGER, snaptrade_user_id TEXT, user_secret TEXT, created_at TEXT)")
                db.execute("INSERT INTO snaptrade_users VALUES (1, 'fixture', 'DO_NOT_EXPORT', '2026-01-01 00:00:00')")
            before = path.read_bytes()
            result = inventory.sqlite_snapshot(path)
            self.assertEqual(path.read_bytes(), before)
            self.assertNotIn("DO_NOT_EXPORT", json.dumps(result))
            self.assertEqual(result["tables"]["snaptrade_users"]["count"], 1)
            self.assertTrue(inventory.snapshot_issues(result))

    def test_transport_representations_compare_without_rounding(self):
        self.assertEqual(inventory.normalize("fetched_at", "2026-01-01 00:00:00"),
                         inventory.normalize("fetched_at", "2025-12-31T19:00:00-05:00"))
        self.assertEqual(inventory.normalize("id", "42"), 42)
        self.assertEqual(inventory.normalize("success", 1), True)
        self.assertEqual(inventory.normalize("cost", "1.000000001"), 1.000000001)

    def test_invalid_values_are_rejected(self):
        for field, value in [("id", 2**53), ("id", 1.5), ("id", True), ("cost", float("nan")),
                             ("quantity", float("inf")), ("success", "false")]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                inventory.normalize(field, value)

    def test_identical_snapshot_is_not_cutover_approval(self):
        result = inventory.compare(empty_snapshot(), empty_snapshot())
        self.assertTrue(result["equivalent"])
        self.assertFalse(result["cutoverReady"])

    def test_missing_cloud_table_is_not_empty(self):
        cloud = inventory.destination_snapshot({"format": 1, "source": "mako", "tables": {}})
        self.assertFalse(inventory.compare(empty_snapshot(), cloud)["equivalent"])

    def test_unknown_columns_and_duplicate_keys_block_equivalence(self):
        left = empty_snapshot()
        spec = inventory.TABLES["accounts"]
        row = {"id": 1, "code": "fixture", "name": None, "account_type": None}
        left["tables"]["accounts"] = inventory.normalize_table("accounts", [row, row], spec["columns"] + ["new_field"])
        result = inventory.compare(left, copy.deepcopy(left))
        self.assertFalse(result["equivalent"])
        self.assertEqual(result["leftIssues"]["accounts"]["duplicateKeys"], 1)
        self.assertEqual(result["leftIssues"]["accounts"]["unknownColumns"], ["new_field"])

    def test_cloud_only_and_changed_rows_are_reported_without_values(self):
        left, right = empty_snapshot(), empty_snapshot()
        a = {"id": 1, "code": "PRIVATE_OLD", "name": None, "account_type": None}
        b = {**a, "code": "PRIVATE_NEW"}
        left["tables"]["accounts"] = inventory.normalize_table("accounts", [a], list(a))
        right["tables"]["accounts"] = inventory.normalize_table("accounts", [b, {**b, "id": 2}], list(b))
        result = inventory.compare(left, right)
        self.assertFalse(result["equivalent"])
        self.assertEqual(result["tables"]["accounts"]["rightOnlyKeys"], ["[2]"])
        self.assertEqual(result["tables"]["accounts"]["changedFields"], {"code": 1})
        self.assertNotIn("PRIVATE_", json.dumps(result))

    def test_tombstones_are_not_live_rows(self):
        spec = inventory.TABLES["accounts"]
        result = inventory.normalize_table("accounts", [{"id": 1, "deleted": True}], spec["columns"] + ["deleted"])
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["tombstones"], 1)

    def test_equal_trade_occurrences_keep_distinct_primary_keys(self):
        spec = inventory.TABLES["transactions"]
        row = {field: None for field in spec["columns"]}
        row.update(id=1, account_id=1, ticker_id=1, quantity=1, cost=12.34)
        result = inventory.normalize_table("transactions", [row, {**row, "id": 2}], spec["columns"])
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["duplicateKeys"], 0)

    def test_orphans_are_counted(self):
        snapshot = empty_snapshot()
        snapshot["tables"]["transactions"]["rows"] = [{"id": 1, "account_id": 8, "ticker_id": 9}]
        errors = inventory.reference_errors(snapshot["tables"])
        self.assertEqual(errors, {"transactions.account_id": 1, "transactions.ticker_id": 1})

    def test_tampered_snapshot_hash_blocks_equivalence(self):
        left = empty_snapshot()
        left["tables"]["accounts"]["sha256"] = "stale"
        self.assertFalse(inventory.compare(left, left)["equivalent"])

    def test_output_is_private_and_cannot_overwrite_or_follow_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            inventory.write_private(path, {"fixture": True})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                inventory.write_private(path, {})
            link = Path(directory) / "link.json"
            link.symlink_to(path)
            with self.assertRaises(FileExistsError):
                inventory.write_private(link, {})


if __name__ == "__main__":
    unittest.main()
