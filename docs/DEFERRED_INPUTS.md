# Deferred operator inputs

This is the owner's to-do list: things that need a person, a decision, a device or an account, not code.
It intentionally contains no secret values.
When you finish an item, tick it here (or tell the agent, who will).
Last reviewed: 2026-10-28.

## To do

### 1. Back up the `MASTER_KEY` (decide soon)

- [ ] Look in your password manager for the production `MASTER_KEY` from the original setup (around 2026-06-29).
- [ ] If you find it, keep it there and tick this item.
- [ ] If you can't, tell the agent "set a fresh MASTER_KEY". It will generate one, set it on the Worker and show it once so you can save it in your password manager.

Why: `MASTER_KEY` encrypts sensitive data in D1, and Cloudflare never shows a secret again after it is set.
On 2026-10-28 no copy existed on the development machine; both local `.dev.vars` keys are development keys and decrypt none of the production data.
Today very little depends on it: the Web Push signing key (no devices subscribed) and copies of alerts that were already sent.
Monitor settings get encrypted the next time each monitor is saved, so a fresh key is cheapest now, before that happens.
Do not paste the key into an issue, pull request, chat or repository file.
Once this release is deployed, either path is supported: rotate online with the old key ([Rotating `MASTER_KEY`](./SECURITY.md#rotating-master_key)), or start fresh without it ([If the old key is lost](./SECURITY.md#if-the-old-key-is-lost)), and Settings > Encryption keys lists exactly what each path leaves unreadable.
See also [Backup and restore](./BACKUP.md).

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

## Not needed

- **Discord alerts.** Email alerts work, so Discord is not set up and not required.
  If you ever want a Discord channel too, create a channel webhook and add it on the Integrations page.

## The agent handles these

- Checking during weekday hours (08:00 to 17:00 Los Angeles) that Echo, GeminiGPT and Scout return to "operational".
- Dependency upkeep (release-kit 2.0.1, the renamed Cloudflare test package).
