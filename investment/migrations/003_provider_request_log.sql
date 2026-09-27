-- Outbound market data provider request log for daily usage/error metrics
CREATE TABLE IF NOT EXISTS provider_request_log (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    success INTEGER NOT NULL,
    status_code INTEGER,
    error TEXT,
    requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provider_request_log_requested_at
    ON provider_request_log(requested_at);

CREATE INDEX IF NOT EXISTS idx_provider_request_log_provider_requested_at
    ON provider_request_log(provider, requested_at);
