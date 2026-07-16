# Backup & restore

OpenPing provides two complementary backup methods.

1. **API export/import** produces a portable JSON backup with credentials removed.
2. **Full D1 dump** captures the complete database for disaster recovery.

## 1. API export

OpenPing does not currently expose export or import controls in the web interface.
Use the authenticated API endpoints directly.

The simplest automation path is an [`API_TOKEN`](./CLI.md):

```bash
curl -L https://status.example.com/api/data/export \
  -H "Authorization: Bearer $OPENPING_TOKEN" \
  -o openping-backup.json
```

An authenticated browser session cookie also works for this read-only endpoint.

The export is a single JSON file named `openping-backup.json` with `version: 1`.
It contains monitors, maintenance windows, public-safe incident history, and non-secret settings.

### Exports remove credentials

The exporter applies these protections:

- HTTP authentication credentials are removed, although a basic-auth username is retained.
- Request header names are retained while their values are blanked.
- Request bodies are removed.
- Heartbeat shared secrets and ingestion tokens are removed.
- Secret-looking settings are excluded.
- Internal incident errors and private notes are excluded.

An export contains no usable credentials, but it can still contain operationally sensitive metadata such as monitor URLs, names, schedules, usernames, incident history, and public messages.
Store it with access controls appropriate for that information.

You must re-enter monitor credentials and restore Worker secrets separately.

> **Category and status-page limitation:** Category records and status-page definitions are not exported.
> Portable exports clear each monitor's category assignment to avoid dangling references in another installation.
> Recreate categories and status pages, then reassign restored monitors.

## Restore / import

Import is validation-first, supports a dry run, and does not overwrite same-named monitors by default.

Send `POST /api/data/import` with Bearer authentication.
The following dry run uses `jq` to wrap the exported document in the import request envelope:

```bash
jq -n --slurpfile backup openping-backup.json \
  '{data: $backup[0], options: {dryRun: true, skipExisting: true}}' |
  curl https://status.example.com/api/data/import \
    -H "Authorization: Bearer $OPENPING_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @-
```

Set `dryRun` to `false` only after reviewing the preview.
A cookie-authenticated request is also supported, but mutations made with a session cookie must include the session's CSRF token.

Import behaves as follows:

- The backup envelope and every monitor are validated before any writes occur.
- Invalid input returns `400 invalid_import` with specific errors.
- `dryRun: true` returns counts and same-name monitor collisions without writing data.
- `skipExisting` defaults to `true`, so a same-named monitor is left unchanged and reused when restoring relationships.
- Setting `skipExisting: false` creates another monitor with that name.
- Monitor credentials and settings are not imported.
- Incident monitor references are remapped to restored or reused monitors.
- Monitor-scoped maintenance references are remapped to restored or reused monitors.
- A monitor-scoped maintenance window is skipped when none of its target monitors survive the import.
- The response reports imported and skipped maintenance counts.

### Capture restored heartbeat tokens

Every newly imported heartbeat monitor receives a new ingestion token.
The import response returns these credentials once in `heartbeatMonitors`:

```json
{
  "heartbeatMonitors": [
    {
      "id": "mon_example",
      "name": "Nightly backup",
      "heartbeatToken": "one-time-token"
    }
  ]
}
```

Construct each new URL as `https://status.example.com/hb/<heartbeatToken>` and update the corresponding job immediately.
OpenPing stores only a hash after creation, so it cannot display the token again.
If you lose it, open the monitor detail screen and rotate the heartbeat URL.

Always perform a dry run first, then securely capture the real import response before closing the terminal or automation job.

## 2. Full database dump

Use Wrangler for a complete D1 snapshot:

```bash
npx wrangler d1 export open-ping --remote --output openping-d1-backup.sql
```

A full dump includes sessions, samples, summaries, encrypted values, and compatibility rows that may still be plaintext after an older upgrade.
Treat the SQL file as highly sensitive even when `MASTER_KEY` is configured.

The authoritative list of values protected by `MASTER_KEY` is maintained in [Security and secret storage](./SECURITY.md#d1-storage-inventory).
The original `MASTER_KEY` is required to decrypt protected values after a restore, so back it up separately in a secret manager.
Cloudflare Worker secrets such as `MASTER_KEY`, `SETUP_TOKEN`, OAuth credentials, `RESEND_API_KEY`, and `API_TOKEN` live outside D1 and are never included in either backup format.

Heartbeat ingestion tokens are stored as SHA-256 hashes.
A D1 dump preserves those hashes, so existing heartbeat URLs continue to work when the database is restored intact, but the raw token cannot be recovered from the dump.
Keep the active heartbeat URL in the calling job's secret store, or rotate it after recovery.

## What to back up

| Item | Tool | Notes |
| --- | --- | --- |
| Portable configuration and public-safe history | `GET /api/data/export` | Credentials removed, but operational metadata remains sensitive |
| Complete database | `wrangler d1 export` | Sensitive snapshot containing encrypted and possibly legacy plaintext rows |
| `MASTER_KEY` and other Worker secrets | Your secret manager | Required separately because Worker secrets are outside D1 |
| Active heartbeat URLs | The calling job's secret manager | Raw tokens cannot be recovered from their D1 hashes |

Take an API export before every upgrade and after significant configuration changes.
Take periodic full D1 dumps according to your recovery requirements.
See [Upgrading OpenPing](./UPGRADE.md) for the upgrade sequence.
