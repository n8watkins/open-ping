# Upgrading OpenPing

An OpenPing upgrade consists of pulling code, applying pending database migrations, and deploying the Worker and SPA.
You control when each self-hosted installation is upgraded.

## Before you start

Take a backup even though migrations are designed to be additive.
See [Backup & restore](./BACKUP.md).

- Use `GET /api/data/export` for a portable, credential-free JSON backup.
- Optionally create a full D1 dump with `npx wrangler d1 export open-ping --remote --output backup.sql`.
- Preserve `MASTER_KEY`, other Worker secrets, and active heartbeat URLs separately because they are not recoverable from the portable export.

## Steps

```bash
git pull                 # get the latest code
npm install              # install updated dependencies
npm run db:migrate       # apply pending migrations to remote D1
npm run deploy           # build and deploy the Worker and SPA
```

The commands have these effects:

- `git pull` updates the working copy, so commit or stash local changes first.
- `npm install` installs dependency versions from the updated lockfile.
- `npm run db:migrate` runs `wrangler d1 migrations apply open-ping --remote` and applies only pending migrations.
- `npm run db:migrate:local` performs the equivalent operation for the local development database.
- `npm run deploy` runs `vite build && wrangler deploy` and reapplies the Cron Trigger from `wrangler.jsonc`.

## Security migrations in `0008` and `0009`

Migrations `0008_push_subscription_secrets.sql` and `0009_heartbeat_token_hash.sql` add lookup hashes that allow capability credentials to be protected without breaking existing installations.
The SQL migrations cannot encrypt or hash an unknown plaintext credential by themselves, so existing rows upgrade lazily.
See [Security and secret storage](./SECURITY.md#legacy-record-upgrades) for the authoritative inventory of protected storage and every lazy-upgrade trigger, including notification-channel capabilities and outbox payloads.

- New and updated monitor configurations are sealed as one AES-GCM document when `MASTER_KEY` is configured.
- A legacy monitor configuration remains readable and is sealed the next time that monitor is edited and saved.
- New Web Push subscriptions are encrypted when `MASTER_KEY` is configured.
- A legacy push subscription is encrypted the next time that browser or device registers the same endpoint.
- A legacy plaintext heartbeat ingestion token is replaced by its SHA-256 hash the next time the existing URL is used.
- Rotating a heartbeat URL immediately stores only the new token hash and invalidates the previous URL.

After upgrading an older installation, edit and save monitors that contain sensitive URLs, headers, query parameters, bodies, or credentials.
Re-enable push on each active device so its endpoint and key material are rewritten in encrypted form.
Use each existing heartbeat URL once or rotate it from the monitor detail screen.

Existing installations can continue to read legacy plaintext rows for compatibility.
Until each row is rewritten, a full D1 dump may contain those plaintext values.

## After upgrading

- Confirm that sign-in succeeds and the monitor list loads.
- Check **Integrations** for channel and push-device health warnings.
- Confirm that monitors containing secrets were saved after `MASTER_KEY` was configured.
- Send a test notification to each important channel and push device.
- Confirm that heartbeat jobs still receive `200` responses.
- If checks do not resume, see [Troubleshooting: Checks aren't running](./TROUBLESHOOTING.md#checks-arent-running).

## Worker secrets and configuration

Database migrations and deployments do not copy or rotate Cloudflare Worker secrets.
They also do not replace the `database_id` in `wrangler.jsonc`.

If a release introduces a new secret, it is documented in [`.dev.vars.example`](../.dev.vars.example) and the `Env` interface in `src/worker/types.ts`.
Set it with `npx wrangler secret put <NAME>` for the target Worker.
Back up `MASTER_KEY` before changing it because previously encrypted values cannot be decrypted with a replacement key.

## Rolling back

Redeploy a previous commit if an application rollback is needed:

```bash
git checkout <previous-tag-or-commit>
npm install
npm run deploy
```

Migrations are additive, so older code generally tolerates a newer schema.
Do not assume that a rollback reverses data transformations or restores secrets.
Use the backup procedure when data restoration is required.
