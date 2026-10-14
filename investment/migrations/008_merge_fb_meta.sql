-- Merge the renamed Facebook ticker into Meta (FB -> META, June 2022) so all
-- history lives under one ticker. No-op on a fresh DB (no FB ticker) — new
-- imports already fold FB onto META via the mapper's canonical_ticker.
UPDATE transactions
SET ticker_id = (SELECT id FROM tickers WHERE symbol = 'META')
WHERE ticker_id IN (SELECT id FROM tickers WHERE symbol = 'FB')
  AND (SELECT id FROM tickers WHERE symbol = 'META') IS NOT NULL;

-- Drop the now-unreferenced FB ticker.
DELETE FROM tickers
WHERE symbol = 'FB'
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ticker_id = tickers.id);
