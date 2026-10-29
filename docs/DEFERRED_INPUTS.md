# Deferred operator inputs

This is the owner's to-do list: things that need a person, a decision, a device or an account, not code.
It intentionally contains no secret values.
When you finish an item, tick it here (or tell the agent, who will).
Last reviewed: 2026-10-28.

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

### 6. Later: what OpenPing Hosted needs before wave 3 testing

None of these is needed yet; wave 2 runs entirely on fakes.
The agent will walk you through each one when wave 3 starts, and will never ask you to paste a secret into chat.
Details are in [platform/README.md](../platform/README.md) and [HOSTED_BUILD_PLAN.md](./HOSTED_BUILD_PLAN.md#12-owner-actions-and-costs).

- [ ] Buy the Hosted domain (about $10 to $15 a year).
- [ ] Turn on Workers Paid ($5 a month) and Workers for Platforms in Cloudflare.
- [ ] Create a Cloudflare API token for your one account with only "Workers Scripts: Edit" and "D1: Edit".
- [ ] Generate `PLATFORM_KEY` (`openssl rand -base64 32`), set it as a platform secret, and save it in your password manager: without it no customer backup can be restored.
- [ ] Generate the sign-in hand-off key pair (the agent gives you the command): the private half becomes a platform secret, the public half a plain setting.
- [ ] Create an R2 bucket named `openping-tenant-bundles` for release copies.
- [ ] Verify the Hosted domain in Resend for sign-in and alert emails.
- [ ] Create a GitHub OAuth app for Hosted sign-in, with callback `https://app.<domain>/auth/github/callback`.
- [ ] Before launch: finish the Stripe account (wave 3 billing).

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

## Not needed

- **Discord alerts.** Email alerts work, so Discord is not set up and not required.
  If you ever want a Discord channel too, create a channel webhook and add it on the Integrations page.

## The agent handles these

- Checking during weekday hours (08:00 to 17:00 Los Angeles) that Echo, GeminiGPT and Scout return to "operational".
- Dependency upkeep (release-kit 2.0.1, the renamed Cloudflare test package).
