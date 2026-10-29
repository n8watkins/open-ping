# OpenPing

Open-source **uptime monitoring and public status pages** that run entirely
inside your own Cloudflare account - no central service, no operational database
to manage, no monitoring subscription.
Prefer not to run it yourself? OpenPing Hosted ($24 a year) is coming; join the
waitlist on [openping.n8builds.dev](https://openping.n8builds.dev/#pricing).

Its defining feature is **schedule-aware monitoring**: applications are checked
(and optionally kept awake) only during the hours that matter. Outside those
hours they show as `Scheduled off` rather than `Down`, and the inactive period
does not reduce uptime.

> Status: **V1 shipped and running live at
> [openping.n8builds.dev](https://openping.n8builds.dev).** It has since grown
> beyond core uptime checks - monitor categories and multiple public status
> pages, six monitor types, a free `/tools` suite, an embeddable widget/badge,
> and a marketing landing page (all listed below). Hardened by multiple review
> passes plus a live-deploy verification round that fixed several real production
> bugs (see [`CODE_REVIEW.md`](./CODE_REVIEW.md)); the test suite, `tsc -b`, and
> `vite build` are clean. See [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the build
> history.

## What it does

- HTTP/API monitoring with keyword & JSON assertions
- Heartbeat / cron-job monitoring
- DNS record monitoring (A/AAAA/CNAME/MX/TXT) with optional value assertions
- TCP port monitoring (connection-accepted checks)
- Domain-expiry monitoring (RDAP) with an early-warning window
- SSL certificate expiry monitoring, with an alert at 30, 14 and 7 days (configurable)
- Timezone-aware operating schedules with warm-up handling
- Distinct **Suspended** status for hosts that signal suspension (e.g. Render free-tier)
- Incidents with automatic recovery, flapping protection, MTBF/MTTR
- Failures confirmed by a second check before anyone is alerted, and new monitors checked the moment you add them
- Compact historical uptime (samples → intervals → hourly → daily → monthly)
- Alerts to Slack, Microsoft Teams, Discord and Telegram, email via Resend, signed webhooks and mobile Web Push (installable Android PWA), with a test button for each ([docs/ALERT_CHANNELS.md](./docs/ALERT_CHANNELS.md))
- Passkey sign-in for the single administrator, with optional GitHub OAuth and email magic links
- Monitor **categories** and **multiple public status pages** (a default page at `/status`, per-category pages at `/status/:slug`), each polished and configurable
- An **embeddable status widget** (`<iframe>`) plus an **SVG status badge** for READMEs and dashboards
- A free **`/tools` suite** (uptime & subnet calculators, cron tester, DNS/MX lookup, and an **"Is it down?" checker**)
- Your own **status page at `/`** for signed-out visitors (`HOME_PAGE`, [Install, "What visitors see at `/`"](./docs/INSTALL.md#what-visitors-see-at-)); the canonical install shows OpenPing's marketing page there instead
- Admin **CLI** (`scripts/op.mjs`) + opt-in Bearer API-token auth for scripting/automation
- A built-in **MCP server** at `/mcp`, so Claude Code or any MCP client can check status and manage monitors ([docs/MCP.md](./docs/MCP.md))
- Data import/export and transparent Cloudflare usage estimates

## Tech stack

- **Frontend:** React + TypeScript + Vite + Tailwind CSS v4 (PWA)
- **Backend:** Cloudflare Worker (Hono router, Zod), scheduled handler every 12 min
- **Storage:** Cloudflare D1 + Worker secrets
- **External:** GitHub OAuth · Resend · Web Push · Slack · Microsoft Teams · Discord · Telegram

## Local development

```bash
npm install
npm run dev        # vite + workerd dev server at http://localhost:5173
```

Useful scripts:

```bash
npm run typecheck  # tsc project references
npm run build      # production build (client + worker)
npm run test       # Node unit tests plus workerd/D1 route integration tests
```

## Deploy your own

OpenPing runs entirely in **your own Cloudflare account**.
The quickest way is the button: it copies this repository into your GitHub account, creates the database, applies the migrations and deploys, asking only for the two required secrets.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/n8watkins/open-ping)

Then open your new address, unlock the setup page with your `SETUP_TOKEN`, and create a passkey to sign in ([the button's steps](./docs/INSTALL.md#the-quick-way-deploy-to-cloudflare)).

By hand, the outline is:

1. Clone, `npm install`, and `npx wrangler login`.
2. Generate a `MASTER_KEY` (GitHub OAuth and email magic-link sign-in are optional extras).
3. Set Worker secrets (`MASTER_KEY`, `SETUP_TOKEN`, optionally `APP_URL`, GitHub OAuth, an admin identity and Resend).
4. `npm run deploy`: it builds, creates the D1 database on the first run, applies the migrations and deploys.
5. Open the app, unlock the first-run wizard with `SETUP_TOKEN`, create your passkey, finish setup, and add monitors.

**Follow the full, copy-pasteable walkthrough in
[docs/INSTALL.md](./docs/INSTALL.md)** - it covers passkeys, the optional GitHub OAuth app, every
secret, custom domains, and a verify-it's-working checklist.

## Documentation

- [Install](./docs/INSTALL.md) - from clone to a deployed install (plus a local-dev quickstart)
- [Hosted plan](./docs/HOSTED_PLAN.md) - the staged plan for OpenPing Hosted and its waitlist
- [Monitor types](./docs/MONITOR_TYPES.md) - every check type, its config, and what the runtime can't do
- [Alert channels](./docs/ALERT_CHANNELS.md) - set up Slack, Teams, Telegram, Discord, email and webhook alerts
- [Status pages](./docs/STATUS_PAGES.md) - categories and multiple per-category public status pages
- [Status widget & badge](./docs/WIDGET.md) - embed the live status widget or an SVG badge on another site
- [Free tools](./docs/TOOLS.md) - the public `/tools` suite and the "Is it down?" API
- [CLI](./docs/CLI.md) - manage an instance from a terminal/automation via an API token
- [MCP server](./docs/MCP.md) - connect Claude Code or another MCP client to your install
- [Upgrade](./docs/UPGRADE.md) - pull, migrate, redeploy
- [Backup & restore](./docs/BACKUP.md) - JSON export/import and full D1 dumps
- [Security & secret storage](./docs/SECURITY.md) - encryption, hashing, plaintext metadata, legacy upgrades, and backup boundaries
- [Custom domain](./docs/CUSTOM_DOMAIN.md) - put OpenPing on your own hostname
- [Free tier](./docs/FREE_TIER.md) - how usage maps to Cloudflare's free plan
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - common issues and fixes
- [Deferred operator inputs](./docs/DEFERRED_INPUTS.md) - production checks and migrations waiting on an operator decision or device
- [Contributing](./CONTRIBUTING.md) - dev setup and PR guidelines

## License

[MIT](./LICENSE)
