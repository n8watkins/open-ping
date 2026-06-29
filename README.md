# OpenPing

Open-source, self-hosted **uptime monitoring and public status pages** that run
entirely inside your own Cloudflare account — no central service, no operational
database to manage, no monitoring subscription.

Its defining feature is **schedule-aware monitoring**: applications are checked
(and optionally kept awake) only during the hours that matter. Outside those
hours they show as `Scheduled off` rather than `Down`, and the inactive period
does not reduce uptime.

> Status: **early development.** See [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the
> V1 roadmap and live progress.

## What it does (V1 target)

- HTTP/API monitoring with keyword & JSON assertions
- Heartbeat / cron-job monitoring
- Timezone-aware operating schedules with warm-up handling
- Incidents with automatic recovery, flapping protection, MTBF/MTTR
- Compact historical uptime (samples → intervals → hourly → daily → monthly)
- Mobile Web Push (installable Android PWA), email via Resend, Discord, signed webhooks
- GitHub OAuth + email magic-link auth (single administrator)
- A polished, configurable public status page
- Data import/export and transparent Cloudflare usage estimates

## Tech stack

- **Frontend:** React + TypeScript + Vite + Tailwind CSS v4 (PWA)
- **Backend:** Cloudflare Worker (Hono router, Zod), scheduled handler every 12 min
- **Storage:** Cloudflare D1 + Worker secrets
- **External:** GitHub OAuth · Resend · Web Push · Discord

## Local development

```bash
npm install
npm run dev        # vite + workerd dev server at http://localhost:5173
```

Useful scripts:

```bash
npm run typecheck  # tsc project references
npm run build      # production build (client + worker)
npm run test       # vitest
```

## Deploy (outline — see docs once Phase 6 lands)

1. `npm run db:create` and copy the `database_id` into `wrangler.jsonc`.
2. `npm run db:migrate` to apply migrations to your D1 database.
3. Set Worker secrets (`SESSION_SECRET`, `MASTER_KEY`, GitHub OAuth, Resend, …).
4. `npm run deploy`.
5. Open the app and complete the first-run setup wizard.

## Documentation

- [Install](./docs/INSTALL.md) — from clone to a deployed install (plus a local-dev quickstart)
- [Upgrade](./docs/UPGRADE.md) — pull, migrate, redeploy
- [Backup & restore](./docs/BACKUP.md) — JSON export/import and full D1 dumps
- [Custom domain](./docs/CUSTOM_DOMAIN.md) — put OpenPing on your own hostname
- [Free tier](./docs/FREE_TIER.md) — how usage maps to Cloudflare's free plan
- [Troubleshooting](./docs/TROUBLESHOOTING.md) — common issues and fixes
- [Contributing](./CONTRIBUTING.md) — dev setup and PR guidelines

## License

[MIT](./LICENSE)
