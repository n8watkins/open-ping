# Troubleshooting

Common issues with a self-hosted OpenPing install and how to diagnose them.
When in doubt, watch live Worker logs:

```bash
npx wrangler tail
```

The **Diagnostics** view in the app (and the `scheduler_runs` table) records the
result of each scheduled run, which is the fastest way to see what the checker
is actually doing.

## Checks aren't running

OpenPing checks monitors from a **Cron Trigger that fires every 12 minutes**
(`*/12 * * * *` in `wrangler.jsonc`). If nothing is being checked:

- Confirm the Worker deployed successfully (`npm run deploy`) and the cron
  trigger shows up in the Cloudflare dashboard under **Workers → your worker →
  Triggers → Cron Triggers**.
- Check **Diagnostics** / `scheduler_runs` for recent runs and errors. No rows
  at all usually means the trigger isn't firing or the deploy didn't include it.
- Make sure the monitor is **enabled and not paused**, and that - for
  schedule-aware monitors - the current time is within its operating schedule.
  Outside scheduled hours a monitor shows `Scheduled off`, which is expected,
  not a failure.
- Remember the cadence: with a 12-minute cron, a monitor is checked at most once
  every 12 minutes. New monitors won't have data until the next run.

## Notifications aren't being delivered

- Open **Integrations** and look at each channel's **health** (last success /
  last failure / last error are tracked per channel).
- Delivery goes through an **outbox** (`notification_outbox`) with retries.
  A row stuck in `pending`/`failed` carries a `last_error` explaining why;
  `dead` means it exhausted retries.
- **Email:** verify `RESEND_API_KEY` is set and your Resend sending
  domain/sender is verified.
- **Discord/webhook:** re-check the URL; use the channel's test action to send a
  test event and watch `wrangler tail`.
- Confirm the event type you expect is enabled for that channel (channels have
  per-event preferences).

## Web Push notifications don't arrive

- Push needs **VAPID keys**. Either generate them in-app under **Integrations**,
  or set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` as Worker
  secrets. Without them, push can't be sent.
- The browser/device must have **granted notification permission** and the PWA
  must be subscribed (a `push_subscriptions` row exists).
- **Real-device caveat:** background Web Push is unreliable in some
  environments - notably iOS requires the PWA to be **installed to the home
  screen**, and desktop/emulator behavior can differ from a real phone. Test on
  the actual device you care about.
- Subscriptions that repeatedly fail are auto-disabled (`disabled` flag /
  `failures` count); re-subscribe from the device to refresh the endpoint.

## "Not authorized" after GitHub sign-in

OpenPing has a **single administrator** gated by an allowlist. If GitHub login
succeeds but you're rejected:

- Confirm the administrator GitHub login saved in setup exactly matches your GitHub **login (username)**, not your display name or email.
  A configured `ADMIN_GITHUB_LOGIN` Worker secret overrides the wizard value.
- Confirm `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` belong to an OAuth app
  whose **callback URL** is `<configured-app-origin>/auth/github/callback`.
- Update a Worker-secret override with `npx wrangler secret put ADMIN_GITHUB_LOGIN`.
  Ordinary `wrangler secret put` updates the deployed Worker directly and does not need a follow-up deploy.

For email/magic-link sign-in, use the administrator email saved in setup or the `ADMIN_EMAIL` Worker-secret override, plus a working `RESEND_API_KEY`.

## Database errors / "no such table"

These almost always mean **migrations haven't been applied** to the database
you're using:

- Remote: `npm run db:migrate`
- Local dev: `npm run db:migrate:local`

Also confirm the `database_id` in `wrangler.jsonc` matches the database you
created with `npm run db:create` - pointing at the wrong (empty) database
produces the same symptoms.

## A monitor reports `blocked_url`

This is **expected, not a bug**. OpenPing's outbound checker has an **SSRF
guard** that refuses to fetch targets that are loopback, `.local`, `.internal`,
`.lan`, `.home`, cloud
metadata endpoints (e.g. `169.254.169.254`, `metadata.google.internal`),
private/reserved IP ranges, non-`http(s)` schemes, or URLs with embedded
credentials. The error message includes the reason (e.g. `loopback_host`,
`private_hostname`, `metadata_host`, `private_ipv4`). Point the monitor at a **publicly reachable**
URL. (These targets fail permanently and are not retried, by design.)

## Setup wizard won't complete

The first-run wizard requires:

- A high-entropy `SETUP_TOKEN` Worker secret for access before an administrator can sign in.
- A valid base64-encoded 32-byte `MASTER_KEY` Worker secret, otherwise you will see `master_key_required`.
- **At least one admin identity** supplied through the wizard or a Worker-secret override (`ADMIN_GITHUB_LOGIN` or `ADMIN_EMAIL`), otherwise you will see `no_admin_configured`.
- A valid public app origin supplied through the wizard or `APP_URL`, otherwise you will see `app_url_required`.
- A **timezone** chosen - otherwise `timezone_required`.

The wizard configures installation prerequisites only.
Configure channels and create monitors after setup finishes and you sign in.

Once setup is complete it **locks**: the setup API returns `setup_locked` for unauthenticated requests, the setup token is no longer accepted, and further changes require signing in as the admin.
This is intentional.

## Local dev won't start or behaves oddly

- Ensure `.dev.vars` exists (copy from `.dev.vars.example`) with at least a valid `MASTER_KEY` and `SETUP_TOKEN`.
- Preconfigure an admin identity and `APP_URL=http://localhost:5173`, or enter both in the local setup wizard.
- Run `npm run db:migrate:local` so the local D1 database has the schema.
- Set the GitHub OAuth callback to `http://localhost:5173/auth/github/callback`
  for local sign-in.

## Still stuck?

- `npx wrangler tail` for live logs.
- Check the **Diagnostics** view / `scheduler_runs` for the last run's error.
- Open an issue with the failing behavior, your Node/Wrangler versions, and any
  relevant log lines.
