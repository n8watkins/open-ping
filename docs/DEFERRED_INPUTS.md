# Deferred operator inputs

This is the owner's to-do list: things that need a person, a decision, a device or an account, not code.
It intentionally contains no secret values.
When you finish an item, tick it here (or tell the agent, who will).
Last reviewed: 2026-10-29.

## To do

### 1. Save the new `MASTER_KEY` in your password manager

- [x] A fresh `MASTER_KEY` was set on 2026-10-28 (key id `641eb0c9`), because no copy of the original existed.
  The only values the old key protected were the Web Push signing key (no devices were subscribed) and four copies of already-sent alerts; they were deleted, and the three monitors' settings were re-encrypted under the new key.
- [x] Saved in your password manager (2026-10-28).
- [ ] Delete `openping-MASTER_KEY.txt` from your Windows Downloads folder.

Why: Cloudflare never shows a secret again after it is set, so your password manager holds the only readable copy.
You need it to restore a database backup onto a new install, or if the Worker's secret is ever lost; without it, the encrypted values in a backup can't be read.
Do not paste the key into an issue, pull request, chat or repository file.
See [Rotating `MASTER_KEY`](./SECURITY.md#rotating-master_key) and [Backup and restore](./BACKUP.md).

### 2. Optional: send alert emails from your own domain

- [ ] In Resend, add and verify `n8builds.dev` (Resend shows the DNS records to add in Cloudflare).
- [ ] Tell the agent, which will change the email channel's sender from `onboarding@resend.dev` to an address such as `alerts@n8builds.dev`.

Why: Resend's test sender only delivers to the Resend account's own address.
That works today because the alerts go to you, but it would fail for anyone else and looks less trustworthy.

### 3. Optional: phone notifications (Web Push)

- [ ] On your phone or desktop browser, open https://openping.n8builds.dev, sign in and turn on notifications in Settings.
- [ ] Tell the agent, which will send a test push and check that tapping it opens the right page.

### 4. Optional: a real outage drill

- [ ] Pick a time when an app can be briefly broken (for example a test endpoint that returns an error), and tell the agent.

The drill checks, with a real failure: detection, the incident, the down and recovery emails, uptime accounting and what the public page shows.

### 5. Click the Deploy to Cloudflare button once

- [ ] Open https://github.com/n8watkins/open-ping (after this change is merged) and click **Deploy to Cloudflare** in the README.
- [ ] In the form, keep the suggested names (or add `-test` to the Worker, repository and database names), and paste a `MASTER_KEY` and `SETUP_TOKEN` made with `openssl rand -base64 32`.
  Note what the form shows: does it list exactly those two secrets plus the three vars, with the descriptions from `package.json`, and a D1 database to create?
- [ ] Watch the build log (Workers & Pages, the new Worker, Deployments, or the build link the form shows).
  It should run `npm ci`, `npm run build`, then `npm run deploy`, and print either migrations applied before the deploy or "The D1 database does not exist yet", then the deploy, then the migrations.
- [ ] Open the new `*.workers.dev` address: the setup page should ask for the setup token, and the welcome step should show "Encryption at rest configured".
  Finish setup with your GitHub username; you don't need to sign in, so you can skip the GitHub OAuth app.
- [ ] Check the new repository in your GitHub account: did the button change `wrangler.jsonc` (a `database_id`, a new `name`), and does it carry this repository's history or start fresh?
- [ ] Tell the agent what you saw, especially anything that failed or differed, and whether the new repository is public or private.
- [ ] Delete the test install: in the Cloudflare dashboard, delete the new Worker (Workers & Pages) and its D1 database (Storage & Databases, D1), then delete the new GitHub repository.

Why: everything the button runs was checked locally on 2026-10-28 (a clean clone, `npm ci` with npm 11, the build, `wrangler deploy --dry-run`, and the deploy script's order with and without an existing database), but only a real click shows what the deploy form asks and what it writes into the new repository.
The test creates a separate Worker and D1 database in your account, so it can't touch openping.n8builds.dev, and both can be deleted afterwards.
Cloudflare's docs (Deploy buttons page, updated 2026-10-12) say the button provisions D1 and runs the `deploy` script; they don't say how it treats a config without a `database_id`, which is the main thing this click confirms.

### 6. Later: what OpenPing Hosted needs before it can run for real

The code for Hosted is built and tested against stand-ins; nothing below is needed until you decide to start staging.
The full commands are in [platform/README.md, "Owner setup"](../platform/README.md#owner-setup-not-done-yet); this is the short version, in order.
"You" means only you can do it (an account, a payment, a decision); "together" means the agent runs the commands with you and you keep the secrets: it never asks you to paste a secret into chat.

**Accounts and money (you):**

- [ ] Turn on Workers Paid ($5 a month) and Workers for Platforms ($25 a month) in Cloudflare.
  The free plan can't run Hosted: it has no Workers for Platforms, allows only 10 D1 databases (one per customer), and shares its daily request and database limits with your own install.
- [ ] Choose the Hosted address: buy a domain (about $10 to $15 a year, recommended, decision D2), or start on `openping.n8builds.dev` subdomains (see "Starting cheaper" below).
- [ ] Finish the Stripe account and switch on test mode.
- [ ] In Resend, verify the Hosted domain (or `mail.<domain>`) for sending.
- [ ] Create a GitHub OAuth app with the callback `https://app.<domain>/auth/github/callback`.
- [ ] Create a Cloudflare API token for this one account with only "Workers Scripts: Edit" and "D1: Edit".

**Cloudflare resources (together):** the dispatch namespace, the platform database and its migrations, the two queues (`openping-provision`, `openping-schedule`), the two R2 buckets (`openping-tenant-bundles` and the private `openping-tenant-exports`, with a 40-day expiry rule on `exports/`), and the routes for `app.<domain>` and `*.<domain>`.

**Keys and secrets (together, each copy saved in your password manager):**

- [ ] `PLATFORM_KEY` (`openssl rand -base64 32`): without it no customer backup can be restored.
- [ ] The sign-in hand-off key pair: the private half a secret, the public half a setting.
- [ ] `CF_API_TOKEN`, `RESEND_API_KEY` (sending access only), `GITHUB_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

**Stripe products (you, in the Stripe dashboard, test mode first):** yearly USD prices for the plan ($24), 1-minute checks ($24), a monitor pack ($24 per pack) and a fast monitor pack ($36 per pack); Stripe Tax; the Customer Portal limited to card, invoices and cancel; failed payments set to "cancel the subscription" (decision D11); the webhook with the events listed in platform/README.md step 11.

**Your admin console (you):** sign up on your own Hosted, add a passkey, then the agent sets `PLATFORM_OWNERS` to your account and pins that passkey in `PLATFORM_OWNER_PASSKEYS`.

**Watching Hosted (together):** the five monitors and the `hosted` status page on openping.n8builds.dev, three free UptimeRobot monitors as an outside check, and a WAF rate limit on `/__health` ([OBSERVABILITY.md](./hosted/OBSERVABILITY.md)).

**Then the agent runs:** the first tenant release, a staging soak with 5 test customers for 7 days, a load test, a restore drill and a security review, and only then `SIGN_UPS=open` and the landing page's `HOSTED_SIGNUP_URL`.

**Starting cheaper (not built, your call):**

- A subdomain instead of a new domain: customers at `<name>.openping.n8builds.dev` and the platform at `app.openping.n8builds.dev`.
  Cloudflare's free certificate covers only one level of subdomain, but a Workers Custom Domain gets its own certificate at no cost, up to 100 per zone, so the platform would add one per customer (a small change to provisioning).
  Past about 100 customers it needs a $10 a month certificate add-on or the move to a real domain, which changes every customer's address.
- Workers Paid only ($5 a month) instead of adding Workers for Platforms ($25): each customer as an ordinary Worker (up to 500 on Workers Paid).
  This needs a different, signed way for the platform to call each customer (about 1 to 2 days of work and a security review), and moving to Workers for Platforms later.
  It lowers break-even from about 15 to 20 customers to about 3.

### 7. Before launch: review the Terms of Service and the Privacy Policy

The drafts are [docs/legal/TERMS.md](./legal/TERMS.md) and [docs/legal/PRIVACY.md](./legal/PRIVACY.md) (PR #74), served by the platform at `/terms` and `/privacy`.
They are drafts, not legal advice; have a lawyer review them if revenue justifies it (decision D9).
Every placeholder is marked `[TO FILL: ...]` in the Markdown and shows highlighted on the page.

Fill in:

- [ ] The provider's legal name: your own name or a company's (Terms intro and section 1, Privacy intro and section 15).
- [ ] A postal address for the provider (the same places).
- [ ] The minimum age to hold an account; 18 is proposed (Terms section 3, Privacy section 11).
- [ ] The governing law and the courts for disputes (Terms section 21).
- [ ] How long tax law makes you keep billing records, for example 7 years (Privacy section 4).
- [ ] How long support email is kept, for example 2 years after the last message (Privacy section 4).
- [ ] The mailbox provider that receives support@n8builds.dev, which is a sub-processor (Privacy section 5).
- [ ] Whether Hosted is offered to people in the EU and the UK, and if so whether an EU or UK representative is needed (Privacy section 7).
- [ ] Whether Cloudflare Web Analytics is on for openping.n8builds.dev: keep that line in Privacy section 13, or delete it.

Decide:

- [ ] **Refund policy.** Proposed: a full refund of any payment, first year or renewal, if asked within 30 days; after that no refund, but the service runs to the end of the paid year; a pro-rata refund if we end a plan with the customer not at fault (Terms section 7).
  EU and UK consumers may also have a 14-day right to withdraw from an online purchase; the terms keep any such right.
- [ ] **Renewal reminder.** Terms section 5 promises an email before each yearly renewal, and nothing sends one yet.
  In the Stripe dashboard, turn on the emails about upcoming renewals (Billing settings, subscriptions and emails), or ask the agent to build one.
  Some US states, California among them, require a notice before a yearly automatic renewal.
- [ ] **Notice periods** the drafts promise: 30 days before a renewal at a new price, 30 days before a change to the terms that matters (with a refund of the unused year to a customer who cancels because of it), and 60 days if Hosted is ever shut down.
- [ ] **Liability cap:** what the customer paid in the 12 months before the claim (Terms section 18).
- [ ] **How acceptance is shown.** Today a line under the sign-up buttons says "By continuing, you agree to the Terms of Service and the Privacy Policy", and the account records the version and the time.
  A checkbox to tick is stronger evidence of agreement, at the cost of one more tap; say if you want one.
- [ ] **When support may sign in to a customer's OpenPing:** the drafts say only to help with something the customer asked about, or, when there is no other way, to stop abuse or fix a fault (Terms section 12).
- [ ] **Data processing agreements (DPAs)** with Cloudflare, Stripe and Resend: Privacy section 8 relies on them for data leaving the EU and the UK.
  Cloudflare's and Stripe's are part of their standard terms; check that each is accepted in its dashboard, and accept Resend's.

Then tell the agent, which will fill the text, change the "Last updated" date (new accounts then accept the new version), and tick this item.
### 8. Later: the Android app in Google Play

The app is built and CI makes a debug APK you can install now ([ANDROID.md](./ANDROID.md#ci-and-installing-a-build-on-your-phone)).
These are for the store and for notifications; the agent walks you through each one and never needs a key in chat.

- [ ] Try the debug APK on your phone: add openping.n8builds.dev, sign in, switch to a second install and back, open a link to another site, and turn on airplane mode for the offline screen.
- [ ] Create a Google Play developer account ($25 once) and verify your identity.
  A new personal account must run a closed test with at least 12 testers for 14 days before the first public release.
- [ ] Create a Firebase project, add the Android app `dev.n8builds.openping`, and put its four values in the repository's Actions variables (`FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_API_KEY`, `FIREBASE_SENDER_ID`).
- [ ] Generate a Firebase service account key and set it on openping.n8builds.dev as the `FCM_SERVICE_ACCOUNT` secret; keep the file in your password manager and delete the download.
- [ ] Make the upload key (`keytool`, in ANDROID.md, "Signing") and save the file and its passwords in your password manager.
- [ ] Store listing: descriptions, a feature graphic, phone screenshots, category Tools, a contact email, and the privacy policy link (the draft in section 7, with a short section on the app added).
- [ ] Optional: after the first upload, set `ANDROID_APP_LINKS` to the app signing certificate's SHA-256 so passkeys also work inside the app.

Why: Google charges the developer account once; FCM is free.
Until the Firebase steps are done the app works fully except notifications, which come by email, chat or webhook as today.

## Not needed

- **Discord alerts.** Email alerts work, so Discord is not set up and not required.
  If you ever want a Discord channel too, create a channel webhook and add it on the Integrations page.

## The agent handles these

- Checking during weekday hours (08:00 to 17:00 Los Angeles) that Echo, GeminiGPT and Scout return to "operational".
- Dependency upkeep (release-kit 2.0.1, the renamed Cloudflare test package).
