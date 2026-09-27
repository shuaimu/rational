-- Latest known symbol price snapshot (used when today's quote is unavailable)
CREATE TABLE IF NOT EXISTS latest_price_cache (
    symbol TEXT PRIMARY KEY,
    latest_price_date DATE NOT NULL,
    latest_price REAL NOT NULL,
    source TEXT NOT NULL,
    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_latest_price_cache_date
    ON latest_price_cache(latest_price_date);

-- Backfill latest snapshot from historical cache. Safe to run repeatedly.
INSERT INTO latest_price_cache (symbol, latest_price_date, latest_price, source, fetched_at)
SELECT pc.symbol, pc.price_date, pc.price, pc.source, pc.fetched_at
FROM price_cache pc
JOIN (
    SELECT symbol, MAX(price_date) AS max_price_date
    FROM price_cache
    GROUP BY symbol
) latest
  ON latest.symbol = pc.symbol
 AND latest.max_price_date = pc.price_date
ON CONFLICT(symbol) DO UPDATE SET
    latest_price_date = CASE
        WHEN excluded.latest_price_date >= latest_price_cache.latest_price_date
            THEN excluded.latest_price_date
        ELSE latest_price_cache.latest_price_date
    END,
    latest_price = CASE
        WHEN excluded.latest_price_date >= latest_price_cache.latest_price_date
            THEN excluded.latest_price
        ELSE latest_price_cache.latest_price
    END,
    source = CASE
        WHEN excluded.latest_price_date >= latest_price_cache.latest_price_date
            THEN excluded.source
        ELSE latest_price_cache.source
    END,
    fetched_at = CASE
        WHEN excluded.latest_price_date >= latest_price_cache.latest_price_date
            THEN excluded.fetched_at
        ELSE latest_price_cache.fetched_at
    END;
