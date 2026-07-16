# Security and secret storage

OpenPing runs inside your Cloudflare account and uses Cloudflare Worker secrets plus a D1 database.
Encryption at rest protects selected D1 values, but it does not make the entire database opaque.
This document describes what is stored, how it is protected, and what must be backed up separately.

## Worker secrets

The following values can be configured with `wrangler secret put` or in the Cloudflare dashboard and are injected into the Worker at runtime:

- `MASTER_KEY` encrypts sensitive values stored in D1.
- `SETUP_TOKEN` protects the unauthenticated first-run setup flow and stops working after setup is complete.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` configure GitHub OAuth.
- `RESEND_API_KEY` authorizes email delivery.
- `ADMIN_GITHUB_LOGIN` and `ADMIN_EMAIL` identify the single allowed administrator.
- `APP_URL` defines the canonical public origin used for links and authentication callbacks.
- `API_TOKEN` is an optional administrator bearer token for the CLI and automation.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` optionally provide the Web Push identity.

Worker secrets are not written to D1 and are not included in a D1 export or OpenPing JSON export.
Keep a separate backup of every Worker secret that is required to restore the installation.
Although some values such as `APP_URL` are not confidential, they use the same Worker binding mechanism.
The setup wizard can instead write `APP_URL`, `ADMIN_GITHUB_LOGIN`, and `ADMIN_EMAIL` to plaintext D1 settings, with a Worker binding taking precedence when both exist.

Local development secrets live in the gitignored `.dev.vars` file.
The Cloudflare Vite production build can copy that file into the gitignored `dist/open_ping/.dev.vars` output for local Worker tooling.
The `postbuild` script restricts that generated copy to owner-only permissions.
Do not archive, publish, or share `dist`, and remove old build output when it is no longer needed.
Wrangler deploys configured Worker secrets separately rather than using local development values as the production secret store.

## `MASTER_KEY` and AES-GCM

`MASTER_KEY` must be a base64-encoded 32-byte key.
OpenPing uses it as an AES-256-GCM key with a fresh random 12-byte nonce for every encrypted value.
Ciphertext is stored in the versioned form `v1:<base64 nonce>:<base64 ciphertext and tag>`.

A valid `MASTER_KEY` is required to complete setup on a new installation.
Older installations can still boot without one for compatibility, but writes that use compatibility mode can remain plaintext and the administrator receives a warning.

Do not replace `MASTER_KEY` on an existing installation without first migrating every encrypted record.
OpenPing does not currently provide an automated key-rotation or re-encryption command.
Cloudflare does not expose the current value of a deployed Worker secret, so a safe migration requires the operator's backed-up current key as well as the new key.
Changing the key in place makes values encrypted with the previous key unreadable and causes protected notification deliveries to fail closed.
Back up the original key separately from D1 and restrict access to both copies.

## D1 storage inventory

### Encrypted values

The protections in this section apply when a valid `MASTER_KEY` is configured.

- The complete monitor `config` document is sealed as one AES-GCM value on create and update.
- Complete monitor configuration includes target URLs and query strings, custom headers, request bodies, authentication credentials, and heartbeat shared secrets.
- Discord webhook URLs, generic webhook destination URLs, and generic webhook HMAC secrets are encrypted inside notification-channel configuration.
- Web Push subscription endpoints, `p256dh` keys, and browser authentication secrets are encrypted.
- A Web Push endpoint also has a SHA-256 digest for indexed lookup without exposing the endpoint.
- An in-app generated VAPID private key is encrypted in the settings table when `MASTER_KEY` is configured.
- Notification outbox payload bodies are encrypted before they are written to D1.

Email channel addresses and other non-secret notification-channel fields are not encrypted unless listed above.
Normal monitor and channel API responses redact modeled secret fields, even though authenticated checks and delivery workers can decrypt them internally.

### One-way hashes

- The random session cookie token is stored only as a SHA-256 session identifier.
- GitHub OAuth state and email magic-link tokens are stored only as SHA-256 identifiers and are single use.
- New heartbeat ingestion tokens are stored only as SHA-256 hashes.
- A heartbeat token is returned in plaintext once when the monitor is created or the token is rotated.
- Normal monitor API responses do not reveal a heartbeat ingestion token.

Hashes are not encryption and cannot be reversed during restore.
If the original heartbeat URL is lost, rotate the monitor token and update the sending system.

### Plaintext operational data

D1 necessarily retains operational and account metadata in plaintext, including:

- Monitor names, types, schedules, assertions, notification preferences, public settings, and current state.
- Check samples, response status and timing, error summaries, incidents, incident notes, maintenance windows, and scheduler diagnostics.
- Categories, status-page configuration, non-secret application settings, and usage counters.
- Notification-channel names, non-secret configuration, delivery health, and last-error text.
- Notification outbox routing targets, event types, retry state, and errors.
- Session administrator identity, CSRF secret, expiry, last-seen time, IP address, and user agent.
- Authentication-token metadata such as a magic-link email address, even though the bearer token itself is hashed.
- Rate-limit keys and counters, which can include client IP addresses.
- Push device labels, user agents, platform names, timestamps, and delivery health.

Treat D1 exports as sensitive records even when encrypted fields remain sealed.
Notification routing targets and operational errors can contain URLs, email addresses, or other deployment-specific information.

## Legacy record upgrades

Migrations `0008_push_subscription_secrets.sql` and `0009_heartbeat_token_hash.sql` add the lookup columns needed by the newer storage model, but SQL migrations cannot transform secrets without application context.
Compatibility upgrades therefore happen as records are used:

- An older unsealed monitor configuration is sealed the next time the monitor is updated.
- An older Web Push subscription is hashed and encrypted when the browser registers the same subscription again.
- An older plaintext heartbeat token is replaced by its hash after a successful heartbeat or an administrator token rotation.
- An older notification-channel capability URL or secret is encrypted the next time that channel is read or updated with `MASTER_KEY` configured.
- An older plaintext notification outbox payload is encrypted when the dispatcher claims it for delivery.

Plaintext VAPID private keys generated before `MASTER_KEY` was configured are not automatically re-encrypted.
OpenPing does not currently provide an automated migration for a legacy plaintext VAPID private key.
For immediate hardening after an upgrade, read each notification channel through the authenticated API, re-save monitors, re-register push devices, and rotate heartbeat tokens.
Verify that `MASTER_KEY` is configured before performing those actions.

## Key rotation readiness

A safe online `MASTER_KEY` rotation needs a dual-key read window, an idempotent re-encryption pass over every protected storage location, and a verification pass that proves no ciphertext still depends on the previous key.
OpenPing deliberately does not offer a command that swaps the key first or performs an unverifiable partial rewrite.
Until dual-key rotation support is implemented, preserve these recovery prerequisites:

1. Retain the current `MASTER_KEY` in a secret manager that is independent of Cloudflare and D1.
2. Take and retain a second D1 backup immediately before maintenance.
3. Keep the deployed `MASTER_KEY` unchanged while auditing or preparing migration tooling.
4. Do not remove the old key backup until every encrypted storage class has been re-encrypted and independently verified.
5. If the current key is unavailable, restore it from the secret manager rather than replacing it in Cloudflare.

Protected storage classes currently include monitor configuration, notification-channel capabilities, notification outbox payloads, Web Push subscription secrets, and generated VAPID private keys.
Production rotation remains blocked until the operator supplies the backed-up current key and approves a maintenance window with a verified D1 backup.
Track those prerequisites in [Deferred operator inputs](./DEFERRED_INPUTS.md#master_key-rotation).

## Backups and restores

The in-app JSON export is designed to omit modeled secrets.
It removes monitor authentication credentials, custom header values, request bodies, heartbeat shared secrets, heartbeat ingestion tokens, secret-named settings, internal incident errors, and private incident notes.
It still includes target URLs and query strings, monitor assertions, schedules, public history, and other non-secret configuration.
Do not embed credentials in a target URL or assertion value if the JSON export will leave your trusted environment.

A Wrangler D1 export contains encrypted values, one-way hashes, and all plaintext operational data described above.
It does not contain Worker secrets.
Restoring encrypted D1 values requires the same `MASTER_KEY`, while hashed heartbeat tokens remain usable only if the calling system still has the original raw token.
If the raw token is unavailable after a restore, rotate it.

Back up these items separately:

1. The D1 database export.
2. `MASTER_KEY` and all other required Worker secrets in a secret manager.
3. External service configuration such as the GitHub OAuth callback, Resend domain, custom domain, and Cloudflare routes.
4. Heartbeat URLs in the systems that call them, or a plan to rotate those tokens after recovery.

See [Backup and restore](./BACKUP.md) for export and import commands.

## Operational recommendations

- Use independent randomly generated values for `MASTER_KEY`, `SETUP_TOKEN`, and `API_TOKEN`.
- Keep `.dev.vars` out of version control and never copy production secrets into test fixtures or issue reports.
- Restrict `.dev.vars` permissions and treat local `dist` output as sensitive when it contains a copied development-secret file.
- Apply every D1 migration before deploying new application code.
- Restrict Cloudflare account and D1 access with least privilege and multifactor authentication.
- Rotate a heartbeat token immediately if its URL is logged, shared, or otherwise exposed.
- Revoke all administrator sessions after suspected account or session compromise.
- Review Worker logs and notification payloads before sharing them because they can contain operational metadata.
