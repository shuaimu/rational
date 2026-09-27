-- Distinguish final market-close bars from intraday/current quotes.
ALTER TABLE price_cache
ADD COLUMN is_market_close INTEGER NOT NULL DEFAULT 0;

-- Any cached date before today is treated as final close data.
UPDATE price_cache
SET is_market_close = 1
WHERE price_date < DATE('now');
