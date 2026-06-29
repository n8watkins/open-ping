# Backup & restore

OpenPing gives you two complementary ways to back up your install:

1. **In-app export/import** — a portable, secret-free JSON backup of your
   configuration and public history. Best for migrating, sharing, or restoring
   monitors.
2. **Full D1 dump** — a complete database snapshot via Wrangler. Best for a
   true disaster-recovery copy of everything.

## 1. In-app export (recommended)

Export from the UI (**Settings/Integrations → Export**) or directly via the API:

```bash
curl -L https://status.example.com/api/data/export \
  -H "Cookie: <your authenticated session cookie>" \
  -o openping-backup.json
```

The export is a single JSON file (`openping-backup.json`, `version: 1`)
containing your **monitors**, **maintenance windows**, **public incident
history**, and **non-secret settings**.

### Exports never contain secrets

This is by design. The exporter redacts everything sensitive:

- HTTP monitor **auth** credentials are stripped (basic passwords blanked,
  bearer tokens dropped; the non-secret username is kept).
- Request **header values** are blanked (names preserved), and request
  **bodies** are dropped.
- Heartbeat **secrets** and the per-monitor **ingestion/heartbeat token** are
  removed.
- Settings are filtered to non-secret keys (anything VAPID-, `key`- or
  `secret`-named is excluded), and incidents expose only public-safe columns
  (no internal error text or private notes).

Because secrets aren't in the backup, you'll re-enter monitor credentials and
re-set Worker secrets after a restore.

## Restore / import

Import is **validation-first and preview-able**, and defaults to **not**
overwriting anything.

Endpoint: `POST /api/data/import` (requires an authenticated admin session;
CSRF is enforced like other mutations). Body shape:

```jsonc
{
  "data": { /* the exported backup object */ },
  "options": {
    "dryRun": true,        // preview only — reports counts + name collisions
    "skipExisting": true   // default true — skip monitors whose name exists
  }
}
```

How it behaves:

- The backup envelope and **every monitor** are validated up front. If anything
  is invalid you get `400 invalid_import` with a list of specific errors, and
  nothing is written.
- With `dryRun: true` you get a **preview**: counts of monitors / maintenance /
  incidents and a list of `duplicateMonitors` (names that already exist).
- On a real import, monitors whose **name already exists are skipped by default**
  (`skipExisting` defaults to true), so a restore can't silently overwrite live
  config. Set `skipExisting: false` only if you intend to add duplicates.
- **Secrets are never imported** (they aren't in the backup), and **settings are
  intentionally not imported** in v1 — re-apply settings/secrets manually.

Tip: always run a `dryRun` first to see what will change.

## 2. Full database dump (disaster recovery)

For a complete snapshot — including secrets stored encrypted in D1, sessions,
samples, and summaries — use Wrangler's D1 export:

```bash
# Dump the remote database to SQL
npx wrangler d1 export open-ping --remote --output openping-d1-backup.sql
```

This produces a SQL file you can keep as an offline backup or use to recreate
the database. Note that encrypted values in this dump can only be decrypted with
the original `MASTER_KEY`, so back that key up separately and securely — without
it, encrypted config is unrecoverable.

## What to back up, and how often

| Item | Tool | Notes |
| --- | --- | --- |
| Monitors, maintenance, public incidents | In-app export | Portable, secret-free; safe to store anywhere |
| Full database | `wrangler d1 export` | Complete snapshot incl. encrypted blobs |
| `MASTER_KEY` (and other secrets) | Your secret manager | Required to decrypt a full D1 dump; never in exports |

A good rhythm: take a JSON export **before every upgrade** (see
[`UPGRADE.md`](./UPGRADE.md)) and whenever you make significant config changes,
plus an occasional full D1 dump for peace of mind.
