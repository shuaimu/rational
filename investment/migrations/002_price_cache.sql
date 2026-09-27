-- Daily symbol price cache to avoid repeated external API calls
CREATE TABLE IF NOT EXISTS price_cache (
    symbol TEXT NOT NULL,
    price_date DATE NOT NULL,
    price REAL NOT NULL,
    source TEXT NOT NULL,
    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, price_date)
);

CREATE INDEX IF NOT EXISTS idx_price_cache_date ON price_cache(price_date);
