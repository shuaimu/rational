-- Cached stock-split events per ticker (source: Yahoo Finance). multiplier is
-- numerator/denominator (a 2:1 forward split = 2.0; a 1:10 reverse = 0.1).
CREATE TABLE IF NOT EXISTS ticker_splits (
    symbol TEXT NOT NULL,
    split_date DATE NOT NULL,
    multiplier REAL NOT NULL,
    PRIMARY KEY (symbol, split_date)
);

-- When each symbol's splits were last fetched (so symbols with no splits aren't
-- re-fetched every sync, and known splits refresh periodically).
CREATE TABLE IF NOT EXISTS split_fetch (
    symbol TEXT PRIMARY KEY,
    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
