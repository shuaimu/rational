-- The broker's reported net-liquidation balance per linked account (authoritative
-- account value), captured on each sync. Used as a cross-check against RobinLab's
-- computed equity, which can't price options or fully track margin.
ALTER TABLE snaptrade_accounts ADD COLUMN balance REAL;
ALTER TABLE snaptrade_accounts ADD COLUMN balance_date TEXT;
