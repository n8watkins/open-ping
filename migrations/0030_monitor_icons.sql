-- 0030: Each HTTP monitor's site icon (favicon), fetched by the Worker.
-- lib/favicon.ts reads it from the monitored site (the page's <link rel=icon>,
-- else /favicon.ico) when the monitor is first listed, when its address changes
-- and at most once a week after, and keeps the small image here (at most 16 KB,
-- a PNG, ICO, GIF, JPEG or WebP) so the browser never asks a third party.
--   origin     the monitor's origin the icon was fetched for; a different one is stale
--   icon       the image, or NULL when the site has none we can use
--   fetched_at when it was last tried (a miss is not retried for a week either)
CREATE TABLE monitor_icons (
  monitor_id   TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  origin       TEXT NOT NULL,
  icon         BLOB,
  content_type TEXT,
  fetched_at   INTEGER NOT NULL
);
