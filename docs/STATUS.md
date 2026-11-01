# Project status

Where OpenPing stands, and what the owner has left to do.
The step-by-step owner checklists live in [DEFERRED_INPUTS.md](./DEFERRED_INPUTS.md); this page is the overview and the order to tackle them in.
Last updated: 2026-11-01.

## Overview

### Self-hosted OpenPing (free, in your own Cloudflare): done and running

- v0.20.0 is live at https://openping.n8builds.dev, with migrations through 0028 applied.
- No failed scheduler runs, no open incidents and an empty alert outbox as of 2026-11-01.
- D1 use is about 6,000 rows read and 1,000 written a day, down from 2.69 million reads a day before the leaner writes; the Free plan allows 5 million and 100,000.
- The three monitors (GeminiGPT, Echo and Scout) check on weekdays from 08:00 to 17:00 Los Angeles time.
- Features: HTTP, heartbeat (cron job), TCP, DNS, domain and SSL certificate checks, status pages, a second-region check before alerting, email and push alerts, the MCP server ([MCP.md](./MCP.md)) and the CLI ([CLI.md](./CLI.md)).
- The waitlist form links the privacy notice (#80); this reaches the live site with the next release.

### OpenPing Hosted (paid, run by you): built, not switched on

- Pricing (decision D13 in [hosted/DECISIONS.md](./hosted/DECISIONS.md)): $24 a year for 20 monitors at 12 minutes and 2 status pages.
- Add-ons: 1-minute checks on 5 monitors for $24 a year, +25 monitor packs for $24 a year (up to 4), +5 fast packs for $36 a year (up to 3).
- Trial: 30 days, 5 monitors, no card.
- Margins: about 73 to 85% on the base plan and 65 to 77% with fast checks ([HOSTED_PLAN.md](./HOSTED_PLAN.md)).
- Built and reviewed: sign-up and provisioning, Stripe billing (test mode, against fakes), trials, cancellation, export-first deletion, canary releases, service monitoring, and the admin console locked to your passkeys.
- Two ways to start: starter mode at about $5 a month with `name.openping.n8builds.dev` addresses (break-even about 3 customers), or the full Workers for Platforms setup at about $30 a month (break-even about 16 customers).
- Waiting on: the owner setup in section 6, then the staging drills ([hosted/LAUNCH_DRILLS.md](./hosted/LAUNCH_DRILLS.md)) and a 7-day soak.

### Legal: drafted

- The Terms of Service and the Privacy Policy are served at /terms and /privacy, with data deleted 60 days after checks stop (decision D12).
- Both still have `[TO FILL]` blanks (legal name, postal address, retention periods, mailbox provider, EU and UK, minimum age, analytics) and need a review.

### Android app: built, not yet tried on a phone

- Sign-in through the phone's browser and push alerts are built; CI builds a debug APK on every change ([ANDROID.md](./ANDROID.md)).
- The latest APK is at `Downloads\openping-android\app-debug.apk`.
- It works with Hosted and with any self-hosted install.
- Later: a notification relay so self-hosted installs get push without their own Firebase project ([MOBILE_PLAN.md](./MOBILE_PLAN.md)).

## Owner to-do list, in order

1. [ ] Install the debug APK on your phone and try signing in (section 8, first item).
       If sign-in fails, note which browser opened.
2. [ ] Fill in the `[TO FILL]` blanks in the Privacy Policy and Terms, and review them (section 7).
3. [ ] When you want Hosted live, work through section 6, starting with its decisions: the address, starter mode or the full setup, and whether Hosted gets its own Cloudflare account.
4. [ ] Optional, any time: own-domain alert email, Web Push, a real outage drill, and the Deploy to Cloudflare click test (sections 2 to 5).
5. [ ] Later: Google Play and Firebase for the app (section 8).

Done:

- [x] Saved the new `MASTER_KEY` in your password manager (2026-10-28).
- [x] Deleted `openping-MASTER_KEY.txt` from Downloads (2026-11-01).

## Agent follow-ups (no owner input needed)

- [ ] Cut a release and deploy, so the waitlist privacy link (#80) reaches the live site.
- [ ] Dependabot #51 and #52: update the dev-only `minimatch` to 11.0.1 or later in `package-lock.json` and `apps/android/package-lock.json` (moderate, a denial of service in build tooling, not in the live Worker).
- [ ] Refresh [HANDOFF.md](./HANDOFF.md): its "Current state" section still describes v0.7.0.
- [ ] Android, from [MOBILE_PLAN.md](./MOBILE_PLAN.md): the home-screen status widget and biometric unlock.
- [ ] Later: the notification relay for self-hosted installs ([MOBILE_PLAN.md](./MOBILE_PLAN.md#later-a-notification-relay-for-self-hosted-installs)).
- [ ] After the owner's section 6 setup: the Hosted staging drills, load test and restore drill ([hosted/LAUNCH_DRILLS.md](./hosted/LAUNCH_DRILLS.md)), then the 7-day soak.
- [ ] After the owner fills the legal blanks: point the waitlist's privacy link at the Hosted domain's /privacy (`PRIVACY_NOTICE_URL` in `WaitlistForm.tsx`).
