# Installing OpenPing

OpenPing runs entirely inside **your own Cloudflare account**: a single Worker
(Hono router + a scheduled handler), one D1 database, and the built SPA served
as static assets. There is no external database or central service to manage.

This guide takes you from a clone to a deployed, working install.

## Prerequisites

- **Node 20+** (`node --version`).
- A **Cloudflare account**. The free plan is enough for a small install — see
  [`FREE_TIER.md`](./FREE_TIER.md).
- **Wrangler**, Cloudflare's CLI. It ships as a dev dependency, so the `npm run`
  scripts use the local copy automatically. You can also install it globally
  (`npm i -g wrangler`) or call it with `npx wrangler …`.
- A **GitHub account** (for the OAuth sign-in app) and optionally a
  [**Resend**](https://resend.com) account (for email + magic-link sign-in).

The first time you run a `wrangler` command it will open a browser to log in to
Cloudflare (`npx wrangler login`).

## 1. Clone and install

```bash
git clone https://github.com/<owner>/open-ping.git
cd open-ping
npm install
```

## 2. Create the D1 database

```bash
npm run db:create
```

This runs `wrangler d1 create open-ping` and prints a block like:

```
[[d1_databases]]
binding = "DB"
database_name = "open-ping"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` value into `wrangler.jsonc`, replacing the placeholder
`REPLACE_WITH_YOUR_D1_DATABASE_ID`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "open-ping",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "migrations_dir": "migrations"
  }
]
```

## 3. Apply migrations

Create the schema in your remote D1 database:

```bash
npm run db:migrate         # wrangler d1 migrations apply open-ping --remote
```

For local development against a local D1 file instead, use:

```bash
npm run db:migrate:local   # wrangler d1 migrations apply open-ping --local
```

Migrations live in `migrations/` and are tracked by Wrangler, so re-running is
safe — only unapplied migrations run.

## 4. Create a GitHub OAuth app

GitHub OAuth is the primary sign-in method.

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Homepage URL:** your public app URL (the `APP_URL` you'll set below, e.g.
   `https://open-ping.<your-subdomain>.workers.dev` or your custom domain).
3. **Authorization callback URL:** `${APP_URL}/auth/github/callback`
   — for example `https://status.example.com/auth/github/callback`.
   (OpenPing requests only the `read:user` scope.)
4. Note the **Client ID** and generate a **Client Secret**.

> Don't know your `workers.dev` URL yet? You can deploy once (step 6) to learn
> it, then come back and set `APP_URL` and the OAuth app accordingly. For a
> custom domain, see [`CUSTOM_DOMAIN.md`](./CUSTOM_DOMAIN.md).

## 5. Set Worker secrets

Secrets are stored encrypted by Cloudflare and injected into the Worker at
runtime (they are **not** in `wrangler.jsonc`). Set each with:

```bash
npx wrangler secret put <NAME>
```

| Secret | Required? | What it is |
| --- | --- | --- |
| `MASTER_KEY` | **Yes** | Base64 32-byte AES-GCM key used to encrypt sensitive config at rest. Generate with `openssl rand -base64 32`. |
| `SESSION_SECRET` | **Yes** | Random string used to sign session + CSRF tokens. Generate with `openssl rand -base64 32`. |
| `APP_URL` | **Yes** | Public base URL of this install, e.g. `https://status.example.com`. Used for OAuth callbacks, magic links, and push. |
| `GITHUB_CLIENT_ID` | For GitHub sign-in | From the OAuth app in step 4. |
| `GITHUB_CLIENT_SECRET` | For GitHub sign-in | From the OAuth app in step 4. |
| `ADMIN_GITHUB_LOGIN` | At least one admin | Your GitHub login (username). Allowlist for the single administrator. |
| `ADMIN_EMAIL` | At least one admin | Your email. Allowlist for email/magic-link sign-in. |
| `RESEND_API_KEY` | For email | [Resend](https://resend.com) API key for transactional email and magic links. |
| `VAPID_PUBLIC_KEY` | Optional | Web Push public key. You can instead generate VAPID keys in-app under **Integrations**. |
| `VAPID_PRIVATE_KEY` | Optional | Web Push private key. |
| `VAPID_SUBJECT` | Optional | Web Push `mailto:` or URL subject. |

> **You must configure at least one admin identity** (`ADMIN_GITHUB_LOGIN` or
> `ADMIN_EMAIL`) — the setup wizard refuses to complete without one. To use
> GitHub sign-in you need both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
> To use email/magic-link sign-in you need `RESEND_API_KEY` plus `ADMIN_EMAIL`.

Generate the two random keys quickly:

```bash
openssl rand -base64 32   # use the output for MASTER_KEY
openssl rand -base64 32   # use the output for SESSION_SECRET
```

## 6. Deploy

```bash
npm run deploy             # vite build && wrangler deploy
```

Wrangler prints your deployed URL (something like
`https://open-ping.<subdomain>.workers.dev`). If you hadn't set `APP_URL` /
the OAuth app yet, set them now (steps 4–5) so the value matches this URL, then
deploy again.

A Cron Trigger runs the scheduled checker **every 12 minutes** (`*/12 * * * *`,
defined in `wrangler.jsonc`); it's enabled automatically on deploy.

## 7. Complete the first-run setup wizard

Open your `APP_URL` in a browser. While setup is incomplete, the wizard is
reachable without signing in (by necessity — it bootstraps the install). It
walks you through:

- confirming your public app URL,
- choosing a timezone (required — schedules and reports use it),
- confirming the admin identity, and
- optional integrations (email, push, etc.).

When you finish, setup locks: further changes require signing in as the admin.
Sign in (GitHub or email magic link) and start adding monitors.

That's it — your install is live.

---

## Local development quickstart

You don't need to deploy to develop or try OpenPing locally.

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in values
npm run db:migrate:local         # local D1 schema
npm run dev                      # http://localhost:5173
```

- `.dev.vars` uses the **same names** as the production secrets above and is
  gitignored. At minimum set `MASTER_KEY`, `SESSION_SECRET`, one admin identity,
  and `APP_URL=http://localhost:5173`. See
  [`.dev.vars.example`](../.dev.vars.example).
- For GitHub OAuth locally, set the OAuth app's callback to
  `http://localhost:5173/auth/github/callback`.
- Other handy scripts: `npm run typecheck`, `npm run test`, `npm run build`.

## Next steps

- [Upgrading](./UPGRADE.md)
- [Backup & restore](./BACKUP.md)
- [Custom domain](./CUSTOM_DOMAIN.md)
- [Free-tier budget](./FREE_TIER.md)
- [Troubleshooting](./TROUBLESHOOTING.md)
