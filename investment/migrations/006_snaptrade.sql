-- SnapTrade connection state.
--
-- The SnapTrade "user" (a single record for this self-hosted app). The
-- user_secret is returned exactly once at registration and is required as a
-- query param on every user-scoped call thereafter, so it must persist.
CREATE TABLE IF NOT EXISTS snaptrade_users (
    id INTEGER PRIMARY KEY,
    snaptrade_user_id TEXT NOT NULL UNIQUE,
    user_secret TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Maps a SnapTrade-connected brokerage account to a RobinLab account so that
-- pulled activities land under the right account code. last_synced_date is the
-- per-account incremental-pull watermark (re-pulling overlap is safe; dedup
-- handles it).
CREATE TABLE IF NOT EXISTS snaptrade_accounts (
    snaptrade_account_id TEXT PRIMARY KEY,
    snaptrade_user_id TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts(id),
    brokerage_authorization TEXT,
    institution_name TEXT,
    account_number TEXT,
    account_name TEXT,
    last_synced_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
