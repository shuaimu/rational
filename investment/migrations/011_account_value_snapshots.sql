-- Point-in-time account value snapshots, captured on each sync. These let the
-- trailing-12-month money-weighted return (XIRR) use a REAL starting book value
-- once a snapshot ~12 months old exists, instead of reconstructing it from the
-- ledger + historical prices. Both figures are stored:
--   computed_value : RobinLab's own equity (positions @ market + cash ledger, Value B)
--   broker_value   : broker-reported net liquidation (Value A), null if unlinked
CREATE TABLE IF NOT EXISTS account_value_snapshots (
    account_id     INTEGER NOT NULL,
    as_of_date     TEXT    NOT NULL,
    computed_value REAL    NOT NULL,
    broker_value   REAL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_account_value_snapshots_date
    ON account_value_snapshots(as_of_date);
