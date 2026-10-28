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

## Not needed

- **Discord alerts.** Email alerts work, so Discord is not set up and not required.
  If you ever want a Discord channel too, create a channel webhook and add it on the Integrations page.

## The agent handles these

- Checking during weekday hours (08:00 to 17:00 Los Angeles) that Echo, GeminiGPT and Scout return to "operational".
- Dependency upkeep (release-kit 2.0.1, the renamed Cloudflare test package).
