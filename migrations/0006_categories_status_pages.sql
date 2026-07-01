-- 0006: Monitor categories + multiple per-category public status pages.
-- SQLite/D1. Timestamps are integer epoch milliseconds (matches existing schema).

-- ---------------------------------------------------------------------------
-- Categories: named, ordered buckets a monitor can belong to (one primary
-- category). `slug` is URL-safe and unique (drives /status/:slug page selection).
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- A monitor's primary category. Nullable; SET NULL on delete so a monitor
-- survives its category being removed (the app also cleans this up explicitly,
-- mirroring deleteMonitor, so it works whether or not D1 enforces FKs).
ALTER TABLE monitors ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
CREATE INDEX idx_monitors_category ON monitors(category_id);

-- ---------------------------------------------------------------------------
-- Status pages: each row is one published public page with its own slug,
-- branding, kill switch, ordering, and monitor selection.
--   include_mode 'all'        -> every public.visible monitor (legacy page)
--   include_mode 'categories' -> public.visible AND category_id IN category_ids
--   include_mode 'monitors'   -> public.visible AND id IN monitor_ids
-- category_ids / monitor_ids are JSON TEXT arrays (consistent with
-- maintenance_windows.monitor_ids).
-- ---------------------------------------------------------------------------
CREATE TABLE status_pages (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  enabled      INTEGER NOT NULL DEFAULT 0,
  is_default   INTEGER NOT NULL DEFAULT 0,
  include_mode TEXT NOT NULL DEFAULT 'all',
  category_ids TEXT,
  monitor_ids  TEXT,
  theme        TEXT,
  accent       TEXT,
  logo         TEXT,
  homepage     TEXT,
  footer       TEXT,
  attribution  INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- At most one default page (the one served at /status with no slug).
CREATE UNIQUE INDEX idx_status_pages_default ON status_pages(is_default) WHERE is_default = 1;

-- Backstop the include_mode enum (mirrors the 0005 trigger pattern), so a stray
-- value can't slip past the app-layer resolver.
CREATE TRIGGER status_pages_mode_valid_insert
BEFORE INSERT ON status_pages
FOR EACH ROW WHEN NEW.include_mode NOT IN ('all', 'categories', 'monitors')
BEGIN
  SELECT RAISE(ABORT, 'invalid status_pages.include_mode');
END;
CREATE TRIGGER status_pages_mode_valid_update
BEFORE UPDATE OF include_mode ON status_pages
FOR EACH ROW WHEN NEW.include_mode NOT IN ('all', 'categories', 'monitors')
BEGIN
  SELECT RAISE(ABORT, 'invalid status_pages.include_mode');
END;

-- ---------------------------------------------------------------------------
-- Back-compat seed: materialize the existing single page (configured via
-- settings status_page_* keys) as the default status_pages row, so existing
-- installs keep their exact /status page with zero operator action. NULL
-- settings fall through to COALESCE defaults matching routes/public.ts today.
-- ---------------------------------------------------------------------------
INSERT INTO status_pages (
  id, slug, name, description, enabled, is_default, include_mode,
  theme, accent, logo, homepage, footer, attribution, sort_order,
  created_at, updated_at
)
SELECT
  'sp_default',
  'default',
  COALESCE((SELECT value FROM settings WHERE key='status_page_name'), 'OpenPing'),
  (SELECT value FROM settings WHERE key='status_page_description'),
  CASE WHEN (SELECT value FROM settings WHERE key='status_page_enabled')='true' THEN 1 ELSE 0 END,
  1,
  'all',
  COALESCE((SELECT value FROM settings WHERE key='status_page_theme'), 'dark'),
  COALESCE((SELECT value FROM settings WHERE key='status_page_accent'), '#6d8bff'),
  (SELECT value FROM settings WHERE key='status_page_logo'),
  (SELECT value FROM settings WHERE key='status_page_homepage'),
  (SELECT value FROM settings WHERE key='status_page_footer'),
  CASE WHEN (SELECT value FROM settings WHERE key='status_page_attribution')='false' THEN 0 ELSE 1 END,
  0,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000;
