-- 0007: Generic fixed-window rate-limit counters.
-- SQLite/D1. Timestamps are integer epoch milliseconds (matches existing schema).
--
-- One row per (scope, window) bucket: `key` is the caller-built composite
-- (e.g. "iid:ip:1.2.3.4:29123456"), `window_start` is the epoch-ms start of the
-- fixed window, and `count` is the number of hits recorded in that window.
-- Callers upsert-increment `count` and compare it to their cap; each new window
-- produces a fresh key, so counters reset automatically. Expired rows are
-- reaped opportunistically (see src/worker/db/rate-limit.ts).
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- Supports the range delete used to reap expired windows.
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
