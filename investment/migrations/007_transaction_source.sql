-- Provenance of each transaction: 'manual' (hand-entered / roll actions),
-- 'excel' (spreadsheet upload), or 'snaptrade' (broker auto-import).
ALTER TABLE transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

-- Backfill rows previously imported from SnapTrade: linked accounts, on/after
-- the go-forward cutoff. No-op on a fresh database (no linked accounts yet).
UPDATE transactions
SET source = 'snaptrade'
WHERE account_id IN (
        SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL
    )
  AND date >= '2026-06-17';
