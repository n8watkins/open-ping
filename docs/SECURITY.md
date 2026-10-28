# Security and secret storage

OpenPing runs inside your Cloudflare account and uses Cloudflare Worker secrets plus a D1 database.
Encryption at rest protects selected D1 values, but it does not make the entire database opaque.
This document describes what is stored, how it is protected, and what must be backed up separately.

## Worker secrets

The following values can be configured with `wrangler secret put` or in the Cloudflare dashboard and are injected into the Worker at runtime:

- `MASTER_KEY` encrypts sensitive values stored in D1.
- `MASTER_KEY_PREVIOUS` is set only while rotating `MASTER_KEY`: it holds the old key, which OpenPing then uses to read but never to write.
- `SETUP_TOKEN` protects the unauthenticated first-run setup flow and stops working after setup is complete.
  A new value, different from the one setup finished with, can be used once to recover access with a new passkey ([Passkeys](#passkeys)).
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` configure GitHub OAuth.
- `RESEND_API_KEY` authorizes email delivery.
- `ADMIN_GITHUB_LOGIN` and `ADMIN_EMAIL` identify the single allowed administrator.
- `APP_URL` defines the canonical public origin used for links and authentication callbacks.
- `API_TOKEN` is an optional administrator bearer token for the CLI, automation and the `/mcp` endpoint.
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
Ciphertext is stored in the versioned form `v2:<key id>:<base64 nonce>:<base64 ciphertext and tag>`.
The key id is 8 hex characters derived from the key with HMAC-SHA-256 over a fixed label.
It is not secret, it cannot be used to recover the key, and it tells OpenPing which key sealed a value without trying each one.
Settings > Encryption keys shows the id of the current key, so you can tell keys apart without ever displaying one.

Releases before key ids wrote `v1:<base64 nonce>:<base64 ciphertext and tag>`.
Those values stay readable: OpenPing tries `MASTER_KEY` first and then `MASTER_KEY_PREVIOUS`.
Every new write uses the `v2` form and `MASTER_KEY`.
An older release cannot read `v2` values, so do not roll back below the release that introduced them (see [Upgrading](./UPGRADE.md#rolling-back)).
OpenPing does not bind a ciphertext to its row with AES-GCM additional data, because some write paths do not know the row's final identity when they encrypt.

A valid `MASTER_KEY` is required to complete setup on a new installation.
Older installations can still boot without one for compatibility, but writes that use compatibility mode can remain plaintext and the administrator receives a warning.

Never simply replace `MASTER_KEY` on an existing installation.
Follow [Rotating `MASTER_KEY`](#rotating-master_key), which keeps the old key readable until every value has been re-encrypted and verified.
Cloudflare does not expose the current value of a deployed Worker secret, so a rotation needs your own backed-up copy of the current key as well as the new key.
Replacing the key without the old one makes everything sealed under it unreadable, and protected notification deliveries fail closed.
Back up the key separately from D1 and restrict access to every copy.

## D1 storage inventory

### Encrypted values

The protections in this section apply when a valid `MASTER_KEY` is configured.

- The complete monitor `config` document is sealed as one AES-GCM value on create and update.
- Complete monitor configuration includes target URLs and query strings, custom headers, request bodies, authentication credentials, and heartbeat shared secrets.
- Discord, Slack and Microsoft Teams webhook URLs, the Telegram bot token, generic webhook destination URLs, and generic webhook HMAC secrets are encrypted inside notification-channel configuration.
- A Telegram chat id is not a credential and stays plaintext.
- Web Push subscription endpoints, `p256dh` keys, and browser authentication secrets are encrypted.
- A Web Push endpoint also has a SHA-256 digest for indexed lookup without exposing the endpoint.
- An in-app generated VAPID private key is encrypted in the settings table when `MASTER_KEY` is configured.
- Notification outbox payload bodies are encrypted before they are written to D1.
- The dispatcher rejects unreadable ciphertext, invalid JSON, and structurally invalid notification payloads before calling an external provider.

Email channel addresses and other non-secret notification-channel fields are not encrypted unless listed above.
Normal monitor and channel API responses redact modeled secret fields, even though authenticated checks and delivery workers can decrypt them internally.

### One-way hashes

- The random session cookie token is stored only as a SHA-256 session identifier.
- GitHub OAuth state, email magic-link tokens and passkey challenges are stored only as SHA-256 identifiers and are single use.
- The `SETUP_TOKEN` that finished setup, or last recovered access, is stored as a SHA-256 hash (`setup_token_spent_hash`) so it can't be used again.
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
- Passkey public keys (COSE), credential ids, names, signature counters, hostnames and timestamps, and the admin's random WebAuthn user handle (`passkey_user_handle`).
  A public key can only verify signatures; it can't be used to sign in.
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

For immediate hardening after an upgrade, configure `MASTER_KEY` and click **Re-encrypt now** in Settings > Encryption keys (or call `POST /api/admin/rekey`, below).
The pass encrypts every legacy plaintext value in the classes above at once.
That includes an unsealed monitor configuration, a plaintext VAPID private key generated before `MASTER_KEY` was configured, and a Web Push subscription from before migration 0008, which also receives its endpoint digest.
Heartbeat tokens are hashes rather than ciphertext, so rotate any legacy plaintext heartbeat token from the monitor detail screen.

## Rotating `MASTER_KEY`

A rotation replaces the key that protects stored values without downtime and without losing data.
It has three parts: a dual-key window in which both keys can read, a re-encryption pass that moves every value onto the new key, and a check that proves nothing needs the old key any more.

### What is covered

The re-encryption pass and the status report cover every value that `MASTER_KEY` protects:

| Storage class | Where | What |
| --- | --- | --- |
| Encrypted settings | `settings` rows with `encrypted = 1`, plus `vapid_private_key` | The generated VAPID private key |
| Monitor configuration | `monitors.config` | The whole sealed configuration, including legacy field-level values inside it |
| Notification channel secrets | `notification_channels.config` | Discord, Slack and Teams webhook URLs, Telegram bot tokens, generic webhook URLs and HMAC secrets |
| Web Push subscriptions | `push_subscriptions` | Endpoint, `p256dh` and `auth` |
| Notification outbox payloads | `notification_outbox.payload` | Every payload, including delivered and dead history |

Worker secrets such as `VAPID_PRIVATE_KEY` or `API_TOKEN` live outside D1 and are not affected.
Hashed values (sessions, sign-in tokens, heartbeat tokens) do not depend on `MASTER_KEY`.

### The API

Both endpoints are administrator-only: a signed-in session (with the CSRF header on the `POST`) or the `API_TOKEN` bearer.
Neither ever returns a stored value, encrypted or not.

- `GET /api/admin/rekey/status` counts the values in each storage class by key: `current`, `previous`, `legacy` (a `v1` value), `unsealed` (legacy plaintext) and `unreadable`.
  It opens up to 50 `legacy` and `previous` values to prove which key they need, lists unreadable values by storage class, row id and field, and returns `safeToRemovePreviousKey`.
- `POST /api/admin/rekey` with `{"cursor": null}` runs one batch of the re-encryption pass and returns `stats`, the `unreadable` values it found and the next `cursor`.
  Send the returned `cursor` back until `done` is `true`.
  A batch reads at most 25 rows by default (`limit` up to 35) and makes one D1 query per storage class it reaches plus one batched update per changed row.
  That keeps each call well under the Workers Free limit of 50 D1 queries, and the cryptography for 35 rows is a small fraction of the 10 ms CPU limit.

The pass is idempotent and safe to run beside normal traffic.
It rewrites a value only when it is not already a `v2` value under the current key, and every write is a compare-and-swap on the exact stored value, so a concurrent save from the app wins.
A value that no configured key can open is reported and left exactly as it is: the pass never drops or overwrites data it cannot read.
If a call fails, run the pass again; resuming or restarting is harmless.

### Runbook

These steps rotate a production install deployed with `npm run deploy:prod`.
Run `node scripts/prod-config.mjs` first, so the gitignored `.wrangler.prod.jsonc` exists, and pass `-c .wrangler.prod.jsonc` to every Wrangler command.
A template install without `deploy.local.json` can drop the `-c` flag.

1. Deploy a release that includes key rotation, and confirm that Settings > Encryption keys shows a current key id.
2. Back up D1 and keep the file with the current key, because only that key can decrypt it:

   ```bash
   npx wrangler d1 export DB --remote -c .wrangler.prod.jsonc --output openping-before-key-rotation.sql
   ```

3. Find your backed-up copy of the current `MASTER_KEY` and generate the new one:

   ```bash
   openssl rand -base64 32
   ```

   Save the new key in your secret manager next to the old one, clearly labelled, before you set it anywhere.
4. Set `MASTER_KEY_PREVIOUS` to the **old** key first:

   ```bash
   npx wrangler secret put MASTER_KEY_PREVIOUS -c .wrangler.prod.jsonc
   ```

   Settings > Encryption keys should now show the same id for the current and the previous key.
   Setting the previous key first means there is never a moment in which stored values are unreadable.
5. Set `MASTER_KEY` to the **new** key:

   ```bash
   npx wrangler secret put MASTER_KEY -c .wrangler.prod.jsonc
   ```

   The current key id changes, the badge reads "Rotation in progress", and everything keeps working through the previous key.
6. Run the re-encryption pass: click **Re-encrypt now** in Settings > Encryption keys, or loop the API:

   ```bash
   cursor=null
   while :; do
     res=$(curl -s https://status.example.com/api/admin/rekey \
       -H "Authorization: Bearer $OPENPING_TOKEN" -H "Content-Type: application/json" \
       --data "{\"cursor\": $cursor}")
     echo "$res" | jq -c '{stats, unreadable}'
     cursor=$(echo "$res" | jq '.cursor')
     [ "$cursor" = "null" ] && break
   done
   ```

7. Check the status, and continue only when `safeToRemovePreviousKey` is `true` and the summary says it is safe to delete `MASTER_KEY_PREVIOUS`:

   ```bash
   curl -s https://status.example.com/api/admin/rekey/status \
     -H "Authorization: Bearer $OPENPING_TOKEN" | jq '{safeToRemovePreviousKey, dependsOnPreviousKey, unreadable, summary}'
   ```

   If values are still listed as depending on the previous key, run the pass again (something wrote with the old key mid-pass, or the pass was interrupted).
   Unreadable values were already unreadable before the rotation.
   They do not block removing the previous key; fix them as described under [If the old key is lost](#if-the-old-key-is-lost).
8. Delete the previous key:

   ```bash
   npx wrangler secret delete MASTER_KEY_PREVIOUS -c .wrangler.prod.jsonc
   ```

9. Confirm that the status now reads "Every protected value is encrypted with the current key", open a monitor's edit page, and send a test notification to a webhook, Discord, Slack, Teams or Telegram channel.
10. Keep the old key and the pre-rotation D1 export together for at least one full backup cycle (30 days is a reasonable minimum), because the export can only be decrypted with the old key.
    Then destroy both together.

Never set `MASTER_KEY` to the new key before `MASTER_KEY_PREVIOUS` holds the old one.
In that window every protected value fails closed: monitors lose their configuration, notifications to protected channels are not sent, and pending deliveries can be retried until they are marked dead.

### If the old key is lost

Without the old key, the values sealed under it cannot be recovered by anyone, including OpenPing.
Everything else in D1 is unaffected: monitor names, schedules, history, incidents, status pages, categories, email channels and settings stay as they are.

Set a fresh key so that new values are protected again:

1. Back up D1 as in step 2 above, even though some of it is unreadable.
2. Generate a new key, save it in your secret manager, and set it as `MASTER_KEY` without setting `MASTER_KEY_PREVIOUS`.
3. Open Settings > Encryption keys, or `GET /api/admin/rekey/status`, for the list of unreadable values by storage class, row id and field.
4. Fix each storage class that is listed:

   - **Monitor configuration:** the whole configuration of each listed monitor is unreadable, so its checks fail until it is fixed.
     Open the monitor's edit page, enter the URL again along with its headers, body and credentials, and save.
     History, schedule and notification settings are kept.
   - **Notification channel secrets:** in Integrations, edit each listed Discord, Slack, Teams or webhook channel and enter the URL again, or a Telegram channel's bot token.
     Until then its deliveries fail with `channel_secret_unreadable` and nothing is sent.
     Re-enter a webhook's HMAC secret as well, because a blank secret keeps the unreadable one, which the status still lists.
   - **VAPID private key:** Web Push cannot sign messages, and existing browser subscriptions belong to the old key pair.
     Delete the stored key pair, generate a new one under Integrations, and subscribe each device again.
   - **Web Push subscriptions:** the device list fails to load while an unreadable subscription exists, so delete the listed rows directly.
   - **Notification outbox payloads:** a pending delivery fails closed and is never sent, and delivered history is unreadable but harmless.
     Delete the listed rows if you want the status to read clean.

   Delete the rows that cannot be fixed from the app with Wrangler, using the ids from the status report:

   ```bash
   npx wrangler d1 execute open-ping --remote -c .wrangler.prod.jsonc --command \
     "DELETE FROM settings WHERE key IN ('vapid_public_key', 'vapid_private_key');
      DELETE FROM push_subscriptions WHERE id IN ('psub_...');
      DELETE FROM notification_outbox WHERE id IN ('out_...');"
   ```

5. Run **Re-encrypt now** once to seal any legacy plaintext values under the new key, and confirm that the status reports no unreadable values.

## Passkeys

The administrator can sign in with passkeys (WebAuthn) as well as, or instead of, GitHub and email.
Verification is implemented with Web Crypto only, in `src/worker/lib/webauthn.ts` and `src/worker/lib/cbor.ts`, with no third-party WebAuthn library.

- **Relying party.** The RP ID is the hostname of `APP_URL` (or the wizard's `app_url`; before either exists, the request's own host) and the expected origin is that origin exactly.
  A passkey therefore works only on that hostname: one made on `openping.n8builds.dev` does not work on `open-ping.<subdomain>.workers.dev`, and changing `APP_URL` strands every existing passkey (sign in another way, or recover, and add new ones).
  Each passkey records the RP ID it was made for.
- **Challenges** are 32 random bytes, stored in `auth_tokens` only as a SHA-256 id, valid for 5 minutes, and consumed with one `DELETE ... RETURNING`, so each can be answered once; a failed answer spends it too.
  They are also bound to the browser that asked for them with an HttpOnly, Secure, `SameSite=Strict` cookie that must match in constant time.
- **Checks on every ceremony:** client data type, challenge and origin (and not `crossOrigin`); the RP ID hash; user presence **and user verification** (a PIN, biometric or device unlock); ES256 (P-256) or RS256 (2048-bit or larger) keys only.
  Sign-in and recovery POSTs from another `Origin` are refused before any work.
- **Attestation** is requested as `none` and never trusted: a `none` statement must be empty, and any other format's statement is ignored, because OpenPing doesn't restrict which authenticators an admin uses.
- **Sign-in** is usernameless (discoverable credentials); the browser may also offer passkeys in the email field's autofill.
  The returned user handle must be this install's.
  A signature counter must increase whenever either side is non-zero, and the update is a compare-and-swap, so a cloned authenticator or a replayed counter is refused; synced passkeys report 0 and are allowed.
  A successful sign-in creates exactly the same session as GitHub and email (cookie, CSRF secret, 30 days).
- **Rate limits:** sign-in options and verification share 30 a minute per IP and 600 a minute in total; recovery allows 5 a minute per IP and 20 in total.
- **Registration** needs a signed-in browser session with its CSRF token (not the `API_TOKEN`), or, during first-run setup, the `SETUP_TOKEN`.
- **Removal** of a passkey ends every session signed in with it.
  The last passkey can't be removed while it is the only working way in (no GitHub app plus admin login, and no admin email plus `RESEND_API_KEY`).
  "Sign out everywhere" ends every session, whichever way it signed in.

### Recovery

If every passkey is lost, GitHub or email sign-in still work where they are set up.
Otherwise the Cloudflare account is the root of trust:

1. Set a new random `SETUP_TOKEN`: `npx wrangler secret put SETUP_TOKEN`, or the dashboard's Variables and Secrets.
2. Open `/recover` on the install's own address, enter the token, and create a passkey; you are signed in.
3. Remove lost passkeys in Settings > Passkeys.

Recovery accepts only a token whose hash differs from `setup_token_spent_hash`, then stores the new hash, so each token works once and the token that set the install up never does.
On installs finished before passkeys existed nothing is recorded yet: the first passkey registration records the token set at that time, and recovery refuses until a new one is set.
Anyone who can set Worker secrets can already change everything about the install, so this adds no new way in.

Passkeys are not part of the JSON backup export (they are tied to a hostname); a D1 export includes them.

## Outbound alert destinations

Chat-app channels can only send to their provider, checked when a channel is saved and again before every delivery, so a hand-edited row cannot redirect a capability:

- Slack: `https://hooks.slack.com/services/...` or `https://hooks.slack-gov.com/services/...`.
- Microsoft Teams: an https host ending in `.environment.api.powerplatform.com` or `.logic.azure.com`, with `/workflows/` in the path.
- Telegram: always `https://api.telegram.org`, and the bot token must match the BotFather format, so it cannot alter the request path.

Discord, Slack, Teams and generic webhook URLs also pass the same SSRF guard as monitor checks (no private, loopback, link-local or metadata addresses, no embedded credentials).
Provider error text stored in `last_error` has the webhook URL or bot token removed before it is saved.
See [Alert channels](./ALERT_CHANNELS.md) for the URL patterns and the sources they were checked against.

## Backups and restores

The in-app JSON export is designed to omit modeled secrets.
It leaves out notification channels entirely (so no webhook URL, signing secret or bot token), and it removes monitor authentication credentials, custom header values, request bodies, heartbeat shared secrets, heartbeat ingestion tokens, secret-named settings, internal incident errors, and private incident notes.
It still includes target URLs and query strings, monitor assertions, schedules, public history, and other non-secret configuration.
Do not embed credentials in a target URL or assertion value if the JSON export will leave your trusted environment.

A Wrangler D1 export contains encrypted values, one-way hashes, and all plaintext operational data described above.
It does not contain Worker secrets.
Restoring encrypted D1 values requires the key they were sealed with.
For an export taken before a rotation that is the old key: set it as `MASTER_KEY_PREVIOUS` after the restore and run the re-encryption pass.
Hashed heartbeat tokens remain usable only if the calling system still has the original raw token.
If the raw token is unavailable after a restore, rotate it.

Back up these items separately:

1. The D1 database export.
2. `MASTER_KEY` and all other required Worker secrets in a secret manager.
3. External service configuration such as the GitHub OAuth callback, Resend domain, custom domain, and Cloudflare routes.
4. Heartbeat URLs in the systems that call them, or a plan to rotate those tokens after recovery.

See [Backup and restore](./BACKUP.md) for export and import commands.

## The `/mcp` endpoint

The [MCP server](./MCP.md) at `/mcp` is a second way in with the same administrator power as the REST API.
It exists only while `API_TOKEN` is set; otherwise it answers `404`.

- It accepts only `Authorization: Bearer <API_TOKEN>`, checked in constant time by the same function as the REST API, and never a session cookie.
- A request whose `Origin` header names another site is refused with `403`, and no CORS headers are sent, so a web page cannot drive it through a visitor's browser (including by DNS rebinding).
- Unauthenticated requests are rejected before any D1 access.
- Authenticated requests are capped at 120 a minute per install through the `rate_limits` table, and bodies at 256 KB.
- It is stateless: nothing about an MCP client is stored between requests.
- Tool results go to the client's model provider, so they are redacted more strictly than REST responses: modeled secrets (HTTP auth passwords and tokens, heartbeat shared secrets, webhook URLs and secrets, Telegram bot tokens) are blanked as in the API, and custom header values and request bodies are blanked as in a backup export.
- Heartbeat ping tokens are returned only by `create_monitor` and `rotate_heartbeat_token`, matching the API's one-time disclosure.
- Plaintext operational data does reach the model provider: monitor names and target URLs (with query strings), schedules, incident errors and private notes, maintenance notes and status page settings.
- Destructive tools (`delete_monitor`, `delete_maintenance_window`, `rotate_heartbeat_token`) are annotated as destructive and refuse to act without `confirm: true`.

Rotating `API_TOKEN` cuts off the CLI and every MCP client at once.

## Response headers

Every page, the offline page and every API response carry one security policy, defined once in `src/worker/security-headers.ts`.
It is a strict Content-Security-Policy (scripts from this origin and Cloudflare Web Analytics only, requests to this origin, Web Analytics and the canonical install's waitlist endpoint), `X-Frame-Options: DENY` with `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer` and HSTS.
The `/embed` widget is the only framable page; it allows `https://n8builds.dev` and `https://*.n8builds.dev` ([WIDGET.md](./WIDGET.md)).
`assets.run_worker_first` in `wrangler.jsonc` sends every request except the hashed `/assets/*` bundles through the Worker, so no page can be served straight from static assets without the policy.
`public/_headers` only covers those bundles, and `src/static-headers.test.ts` checks that it agrees with the Worker.

## Operational recommendations

- Use independent randomly generated values for `MASTER_KEY`, `SETUP_TOKEN`, and `API_TOKEN`.
- Keep `.dev.vars` out of version control and never copy production secrets into test fixtures or issue reports.
- Restrict `.dev.vars` permissions and treat local `dist` output as sensitive when it contains a copied development-secret file.
- Apply every D1 migration before deploying new application code.
- Restrict Cloudflare account and D1 access with least privilege and multifactor authentication.
- Rotate a heartbeat token immediately if its URL is logged, shared, or otherwise exposed.
- Revoke all administrator sessions after suspected account or session compromise.
- Review Worker logs and notification payloads before sharing them because they can contain operational metadata.
