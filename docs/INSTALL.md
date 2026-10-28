# Deploy your own OpenPing

Welcome! This guide takes you from a fresh clone to a live, working OpenPing
install on **your own Cloudflare account** - no prior context required. Every
step is copy-pasteable.

OpenPing is intentionally tiny to operate: a single Cloudflare Worker (a Hono
router plus a scheduled handler that runs every 12 minutes), one D1 database, and
the built React SPA served as static assets. There is **no external database and
no central service** - everything lives in your account, and you control it.

If you get stuck at any point, jump to
[Troubleshooting the common gotchas](#troubleshooting-the-common-gotchas) at the
bottom, or the full [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

There are two ways to install it:

- **[The Deploy to Cloudflare button](#the-quick-way-deploy-to-cloudflare)**: about 5 minutes in the browser, no terminal needed.
- **[By hand](#1-prerequisites)**: clone → register a GitHub sign-in app → set a few secrets → deploy → finish the in-app setup wizard.
  Budget about 15 minutes the first time.

---

## The quick way: Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/n8watkins/open-ping)

The button copies OpenPing into a new repository in your GitHub (or GitLab) account and deploys it to your Cloudflare account with [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).
The D1 database is created for you, and the deploy script creates its tables.
Every later push to that repository's main branch deploys again, and applies any new migrations first.

The deploy form asks for:

- **The Worker and repository names.** The Worker name becomes your address, `https://<worker-name>.<your-subdomain>.workers.dev`.
- **The database (`DB`).** Let it create a new one; any name works.
- **`MASTER_KEY` and `SETUP_TOKEN`**, the two required secrets.
  Generate each with `openssl rand -base64 32`, or with the generator on [the install page](https://openping.n8builds.dev/install#generate), which makes them in your browser and sends them nowhere.
  **Save both in your password manager before you deploy**: Cloudflare never shows a secret again, `SETUP_TOKEN` unlocks the setup page, and `MASTER_KEY` is the only key to your encrypted data ([Backup & restore](./BACKUP.md)).
- **`WORKERS_PLAN`, `WAITLIST_ENABLED` and `HOME_PAGE`.** Keep the defaults (`free`, `false`, `status`), or set `WORKERS_PLAN` to `paid` on Workers Paid.

When the build finishes:

1. Open your new address.
   It shows the setup page: enter your `SETUP_TOKEN`, confirm the address, pick your timezone and enter your GitHub username (or an email address).
2. Create a GitHub OAuth app for sign-in, as in [step 3](#3-create-a-github-oauth-app-sign-in), with your new address.
3. Add its Client ID and Client Secret to the Worker: in the Cloudflare dashboard, open **Workers & Pages**, your Worker, **Settings**, **Variables and Secrets**, then **Add**, choose type **Secret**, and save `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
   Any optional secret from [step 5](#5-set-your-worker-secrets), such as `RESEND_API_KEY` for email, is added the same way.
4. Sign in and add your monitors ([step 8](#8-first-run-complete-setup-then-add-monitors)).

Good to know:

- **Upgrading.** The new repository is a copy, not a fork, so it doesn't follow this one by itself.
  To upgrade, pull this repository's `main` into your copy and push; Workers Builds migrates and deploys ([Upgrading](./UPGRADE.md)).
- **A missing secret.** If you skipped `MASTER_KEY` or `SETUP_TOKEN`, the setup page says which one is missing and how to add it in the dashboard.
- **Changing vars.** `WORKERS_PLAN`, `WAITLIST_ENABLED` and `HOME_PAGE` live in your copy's `wrangler.jsonc`; change them there and push, because each deploy resets vars to that file.
- **Limits.** The button needs a public repository on github.com or gitlab.com, and deploys Workers only ([Cloudflare's docs](https://developers.cloudflare.com/workers/platform/deploy-buttons/)).

---

## 1. Prerequisites

- **Node 20 or newer** - check with `node --version`. (Enforced by
  `package.json`'s `engines` field.)
- **git** - to clone the repo.
- **A Cloudflare account** - the **free plan is enough** for a small install.
  See [`FREE_TIER.md`](./FREE_TIER.md) for how usage maps to the free tier.
- **Wrangler**, Cloudflare's CLI - it ships as a dev dependency, so the
  `npm run` scripts use the local copy automatically. You can also call it
  directly with `npx wrangler …`, or install it globally with `npm i -g wrangler`.

Optional, but recommended for a real install:

- **A GitHub account** - to create the OAuth app used for sign-in (step 3).
- **A [Resend](https://resend.com) account** - for transactional email and
  email magic-link sign-in (a free tier is available).

> **First Wrangler command logs you in.** The first time you run a `wrangler`
> command it opens a browser to authorize against your Cloudflare account. You
> can also run it explicitly: `npx wrangler login`.

---

## 2. Clone and install

```bash
git clone https://github.com/<owner>/open-ping.git
cd open-ping
npm install
```

> **On npm 12?** Run `npm install --allow-git=root` instead: the release tooling
> (a development dependency) is installed from GitHub, which npm 12 asks you to allow.

---

## 3. Create a GitHub OAuth app (sign-in)

OpenPing has a **single administrator**, and GitHub OAuth is the primary way to
sign in. (Email magic links are an alternative/backup - see the note below.)

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
   (<https://github.com/settings/developers>).
2. **Application name:** anything you like (e.g. "OpenPing").
3. **Homepage URL:** your public app origin, supplied through the `APP_URL` Worker secret or the setup wizard
   (for example `https://status.example.com`, or your `*.workers.dev` URL).
4. **Authorization callback URL:**
   `https://<your-domain>/auth/github/callback`
   - for example `https://status.example.com/auth/github/callback`.
   OpenPing requests only the `read:user` scope.
5. Click **Register application**, then note the **Client ID** and use
   **Generate a new client secret** to get the **Client Secret**. Copy both -
   you'll set them as secrets in step 5.

> **Don't know your URL yet?** If you're going to deploy to a `*.workers.dev`
> URL and don't know it, you can deploy once (step 6) to learn it, then come
> back and fill in the Homepage/callback URLs and `APP_URL`. If you plan to use a
> custom domain, set everything to that domain from the start - see
> [`CUSTOM_DOMAIN.md`](./CUSTOM_DOMAIN.md).

### Admin identity: `ADMIN_GITHUB_LOGIN` vs `ADMIN_EMAIL`

OpenPing gates the single admin with an allowlist.
You must configure **at least one** identity before setup can finish, either as a Worker secret here or on the Administrator step of the setup wizard:

- **`ADMIN_GITHUB_LOGIN`** - your GitHub **login (username)**, e.g. `octocat`
  (not your display name or email). Pairs with the GitHub OAuth app above.
- **`ADMIN_EMAIL`** - your email address. Enables **email magic-link** sign-in
  as an alternative or backup. This path also requires `RESEND_API_KEY` (step 5)
  so OpenPing can actually send the link.

A common, robust setup is to configure **both**: GitHub for everyday sign-in, and email magic link as a fallback in case you ever cannot use GitHub.
Worker-secret values take precedence over identities saved by the wizard, which makes them useful for configuration-as-code.

---

## 4. Generate your `MASTER_KEY`

`MASTER_KEY` is a base64-encoded **32-byte AES-GCM key** that enables
**encryption-at-rest** for sensitive values stored in D1 (monitor auth
credentials, channel secrets, VAPID keys, etc.). Generate one with:

```bash
openssl rand -base64 32
```

Copy the output - you'll set it as the `MASTER_KEY` secret in the next step.

> **What if I skip it?** OpenPing can boot for diagnostics, but the first-run wizard will not complete without a valid key.
> Existing installations created before this requirement display an administrator warning and may store new credentials in plaintext until `MASTER_KEY` is configured.
> **Back it up somewhere safe** - it is the only thing that can decrypt protected values in a full D1 dump (see [`BACKUP.md`](./BACKUP.md)).
> To change it later, follow [Rotating `MASTER_KEY`](./SECURITY.md#rotating-master_key); simply replacing it makes previously encrypted values unreadable.

---

## 5. Set your Worker secrets

Secrets are stored encrypted by Cloudflare and injected into the Worker at
runtime - they live **outside** `wrangler.jsonc` and are never committed. Set
each one with:

```bash
npx wrangler secret put <NAME>
```

You'll be prompted to paste the value. Here's every secret OpenPing recognizes:

| Secret | Required? | What it is / how to obtain it |
| --- | --- | --- |
| `MASTER_KEY` | **Yes** | Base64 32-byte AES-GCM key for encryption-at-rest. Generate with `openssl rand -base64 32` (step 4). |
| `MASTER_KEY_PREVIOUS` | Only while rotating | The old `MASTER_KEY` during a [key rotation](./SECURITY.md#rotating-master_key); read-only, and deleted once Settings > Encryption keys says it is no longer needed. |
| `SETUP_TOKEN` | **Yes** | One-time credential that protects the first-run wizard before you can sign in. Generate with `openssl rand -base64 32`. |
| `APP_URL` | Recommended override | Public origin of this install, e.g. `https://status.example.com`; used for OAuth callbacks, magic links, and Web Push; must use `https://` with no path, query, fragment, credentials, or trailing slash; can instead be saved in the setup wizard. |
| `ADMIN_GITHUB_LOGIN` | Optional override | Your GitHub login/username, which can instead be saved in the setup wizard; at least one GitHub or email administrator must exist before setup can finish. |
| `ADMIN_EMAIL` | Optional override | Your email for magic-link sign-in, which can instead be saved in the setup wizard; at least one GitHub or email administrator must exist before setup can finish. |
| `GITHUB_CLIENT_ID` | For GitHub sign-in | Client ID from the OAuth app (step 3). |
| `GITHUB_CLIENT_SECRET` | For GitHub sign-in | Client secret from the OAuth app (step 3). |
| `RESEND_API_KEY` | For email / magic links | API key from [Resend](https://resend.com). Required for email notifications and email magic-link sign-in. |
| `API_TOKEN` | Optional | Admin token for the CLI / automation. When set, `Authorization: Bearer <API_TOKEN>` is treated as full admin. Generate with `openssl rand -base64 32`. See [`CLI.md`](./CLI.md). |
| `VAPID_PUBLIC_KEY` | Optional | Web Push public key. You can instead generate VAPID keys in-app under **Integrations**. |
| `VAPID_PRIVATE_KEY` | Optional | Web Push private key. |
| `VAPID_SUBJECT` | Optional | Web Push subject - a `mailto:` address or URL. |

**The minimum Worker secrets for first-run setup:** a valid `MASTER_KEY` and a high-entropy `SETUP_TOKEN`.
The wizard can save `APP_URL` and the administrator identity in D1.
GitHub sign-in additionally requires `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, while email sign-in requires `RESEND_API_KEY`.

For example:

```bash
npx wrangler secret put MASTER_KEY            # paste the openssl output
npx wrangler secret put SETUP_TOKEN           # paste another random value
npx wrangler secret put APP_URL               # e.g. https://status.example.com
npx wrangler secret put ADMIN_GITHUB_LOGIN    # your github username
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
# optional but recommended:
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put RESEND_API_KEY
```

> **Two rules to remember:** (1) `MASTER_KEY` must decode to exactly 32 bytes, and setup will fail closed without it.
> (2) `SETUP_TOKEN` protects an incomplete public installation from being claimed by its first visitor.
> Ordinary `wrangler secret put` updates the deployed Worker's secret directly, so it does not require a follow-up deploy.
> The separate `wrangler versions secret put` workflow creates an undeployed version and does require an explicit versions deployment.

---

## 6. Deploy

```bash
npm run deploy             # build, create the database if needed, migrate, deploy
```

`npm run deploy` runs `scripts/deploy.mjs`, which:

1. builds the SPA and the Worker (`vite build`),
2. applies any pending migrations in `migrations/` to the remote D1 database (`wrangler d1 migrations apply DB --remote`),
3. and publishes the Worker, then prints your deployed URL (something like `https://open-ping.<your-subdomain>.workers.dev`).

There is no database to create by hand.
`wrangler.jsonc` names the database `open-ping` but carries no `database_id`, because an id belongs to one Cloudflare account.
On the first deploy, Wrangler's [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) creates the database (or binds an existing one with that name), so the script deploys first and migrates straight after; from then on it migrates before it deploys.
Wrangler then writes the new id into your `wrangler.jsonc`; keeping or discarding that change both work, because later deploys and `wrangler d1` commands find the database by name.
Migrations are additive and tracked by Wrangler, so only unapplied ones run, and Wrangler asks you to confirm before applying them.
To run them on their own, use `npm run db:migrate`.

The Cron Trigger that runs the checker **every 12 minutes** (`*/12 * * * *`,
defined in `wrangler.jsonc`) is enabled automatically on deploy - you don't need
to configure anything for monitoring to start.

> If you deployed first to learn your `*.workers.dev` URL, enter that origin in the setup wizard or set `APP_URL` with `wrangler secret put`.
> Update the GitHub OAuth Homepage and callback URLs from step 3 to match it.

### Keep your own ids out of git

To pin your database id, or keep your own var values, without editing `wrangler.jsonc` (so `git pull` never conflicts), put them in a gitignored `deploy.local.json`; `npx wrangler d1 list` shows the id:

```json
{
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "vars": { "WORKERS_PLAN": "free" }
}
```

`vars` is optional and may override only vars that `wrangler.jsonc` already defines (`WORKERS_PLAN`, `WAITLIST_ENABLED`, `HOME_PAGE`), so a typo fails loudly.
Then use the `:prod` scripts in place of the plain ones:

```bash
npm run db:migrate:prod    # instead of npm run db:migrate
npm run deploy:prod        # instead of npm run deploy
```

Each one first runs `scripts/prod-config.mjs`, which merges `deploy.local.json` into `wrangler.jsonc` and writes the gitignored `.wrangler.prod.jsonc`.
Because that file is regenerated on every run, new settings in `wrangler.jsonc` reach your deploy automatically.
Don't edit `.wrangler.prod.jsonc` by hand.
While `deploy.local.json` exists, plain `npm run deploy` refuses to run, so a deploy can't silently drop your values.

### What visitors see at `/`

Your install is yours alone, so a signed-out visitor who opens its address sees your own default status page, not OpenPing's marketing page.
If the status page is turned off, `/` shows a short "This OpenPing has no public status page" screen with a small owner sign-in link.
You, signed in, always get the dashboard at `/`, and `/login` always works.

The `HOME_PAGE` var in `wrangler.jsonc` sets this:

| Value | Signed-out visitors at `/` see |
|---|---|
| `"status"` (the default) | This install's default status page |
| `"landing"` | OpenPing's marketing page, with its click counts in Settings |

Leave it at `"status"`.
Only the canonical install, openping.n8builds.dev, sets `"landing"`, in its `deploy.local.json`.
The `ratelimits` entry named `EVENT_LIMITER` in `wrangler.jsonc` caps that page's click counter and does nothing on a `"status"` install; its `namespace_id` only has to be an integer no other Worker in your account uses for a rate limiter.

---

## 7. (Optional) Add a custom domain

A custom domain (e.g. `https://status.example.com`) gives you a nicer public
status page and stable OAuth/push URLs. Full instructions are in
[`CUSTOM_DOMAIN.md`](./CUSTOM_DOMAIN.md); the short version:

1. Attach the domain to the Worker in the Cloudflare dashboard
   (**Workers & Pages → your worker → Settings → Domains & Routes → Add custom
   domain**). The domain must be on a zone in the **same Cloudflare account**.
2. Point `APP_URL` at it:
   ```bash
   npx wrangler secret put APP_URL    # enter https://status.example.com
   ```
3. Update the GitHub OAuth app's **Homepage URL** and **Authorization callback
   URL** to the new domain (`https://status.example.com/auth/github/callback`).
   The client id/secret don't change - only the URLs.

---

## 8. First run: complete setup, then add monitors

Open the deployed public URL in a browser.

While setup is incomplete, the **first-run wizard** can be opened before signing in, but it requires the `SETUP_TOKEN` you configured in step 5.
This prevents an anonymous visitor from claiming a newly deployed instance before you reach it.
The wizard saves:

- confirming your public app URL,
- choosing a **timezone** (required - schedules and reports use it),
- and configuring at least one admin identity if it was not supplied as a Worker secret.

The wizard configures only the prerequisites needed to secure and identify the installation.
After setup, sign in to create monitors from **Monitoring** and configure delivery channels under **Integrations & API**.

When you finish, **setup locks** and the setup token stops working.
Further changes require signing in as the admin.
Sign in with **GitHub** or an **email magic link**, then:

- **Configure notification channels** under **Integrations** (email via Resend,
  Web Push, Slack, Microsoft Teams, Discord, Telegram, signed webhooks) and send
  a test event from each; [Alert channels](./ALERT_CHANNELS.md) has the setup steps.
- **Add your monitors** - OpenPing supports five check types (HTTP/API,
  heartbeat/cron, DNS record, TCP port, and domain-expiry), each with an
  operating schedule if you want schedule-aware monitoring. See
  [`MONITOR_TYPES.md`](./MONITOR_TYPES.md) for every type, its config, and its
  limits.

> **Prefer automation?** Once you've set an `API_TOKEN` secret, you can manage
> monitors entirely from a terminal with the admin CLI (`scripts/op.mjs`) - see
> [`CLI.md`](./CLI.md). Handy for scripting, bulk setup, or CI. The same token
> connects Claude Code or another MCP client to `/mcp` - see [`MCP.md`](./MCP.md).

---

## 9. Verify it's working

A quick checklist to confirm a healthy install:

- **Health endpoint** - `GET /api/health` should return JSON with `ok: true`
  and `db: true`:
  ```bash
  curl https://status.example.com/api/health
  # {"ok":true,"name":"OpenPing","version":"0.1.0","time":"…","db":true}
  ```
  (`db: true` confirms the D1 binding is wired up.)
- **Cron is firing** - after ~12 minutes, the **Diagnostics** view in the app
  (and the `scheduler_runs` table) should show recent scheduled runs. You can
  also see the Cron Trigger in the Cloudflare dashboard under **Workers → your
  worker → Triggers → Cron Triggers**.
- **A test notification** - add a monitor and a channel, then use the channel's
  **test** action under **Integrations**; watch it arrive (and watch live logs
  with `npx wrangler tail` if it doesn't).

That's it - your install is live. 🎉

---

## Troubleshooting the common gotchas

A few things trip up almost everyone on a first deploy. See
[`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for the full list; the greatest
hits:

- **"Database not found" / `no such table` on deploy or in the app.** The migrations didn't run: run `npm run db:migrate`, or check the deploy log.
  If you set a `database_id` yourself, check it points at the right database (`npx wrangler d1 list`).
- **GitHub sign-in fails with a state / callback / "redirect URI" error.** The
  OAuth app's **Authorization callback URL** must be **exactly**
  `<configured-app-origin>/auth/github/callback`. A mismatch between the configured app origin and the
  registered callback (e.g. after switching to a custom domain) breaks the
  OAuth state check. Re-check both, then redeploy.
- **"Not authorized" after a successful GitHub login.** The administrator GitHub login saved in the wizard or overridden by `ADMIN_GITHUB_LOGIN` must match your GitHub **login/username** exactly, not your display name or email.
- **Setup reports that `MASTER_KEY` is required, or the dashboard warns that encryption is disabled.**
  Configure a valid base64-encoded 32-byte `MASTER_KEY` secret (step 4).
- **Magic-link / notification emails don't arrive.** Make sure `RESEND_API_KEY`
  is set and your Resend **sending domain/sender is verified**. For quick
  testing without verifying a domain, Resend lets you send from
  `onboarding@resend.dev` **to your own account email** - useful to confirm the
  pipeline before you set up a real sender.
- **Changed a secret but nothing changed.** Confirm you used `wrangler secret put`, which updates the deployed Worker directly, and not `wrangler versions secret put`, which creates an undeployed version.
- **Setup reports `app_url_required`.** Enter the public origin in the wizard or set `APP_URL`; it must be an HTTPS origin with no path, query, fragment, or embedded credentials.

---

## Local development quickstart

You don't need to deploy to develop or try OpenPing locally.

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in values
npm run db:migrate:local         # local D1 schema
npm run dev                      # http://localhost:5173
```

- `.dev.vars` uses the **same names** as the production secrets above and is gitignored.
  At minimum set a valid `MASTER_KEY` and `SETUP_TOKEN`.
  You may preconfigure an admin identity and `APP_URL=http://localhost:5173`, or enter them in the local setup wizard.
  See [`.dev.vars.example`](../.dev.vars.example).
- For GitHub OAuth locally, set the OAuth app's callback to
  `http://localhost:5173/auth/github/callback`.
- `npm run test` runs both the fast Node unit suite and the workerd/D1 route integration suite.
- Other handy scripts are `npm run typecheck`, `npm run test:unit`, `npm run test:integration`, and `npm run build`.

---

## Next steps

- [CLI](./CLI.md) - manage your instance from a terminal/automation
- [Upgrading](./UPGRADE.md) - pull, migrate, redeploy
- [Backup & restore](./BACKUP.md) - JSON export/import and full D1 dumps
- [Custom domain](./CUSTOM_DOMAIN.md) - put OpenPing on your own hostname
- [Free-tier budget](./FREE_TIER.md) - how usage maps to Cloudflare's free plan
- [Troubleshooting](./TROUBLESHOOTING.md) - common issues and fixes
