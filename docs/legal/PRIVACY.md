# Privacy Policy

Last updated: 2026-10-28

This policy explains what personal data OpenPing Hosted collects, why, where it goes, and how long we keep it.
It also covers the OpenPing website at openping.n8builds.dev (section 13).
OpenPing Hosted is run by [TO FILL: the provider's legal name], [TO FILL: postal address] ("we", "us"), who decides how this data is used.
Questions go to support@n8builds.dev.

## 1. The short version

- We collect what we need to run your account and your OpenPing, take payment, send email and keep the service safe.
- We do not sell personal data, show ads, or use tracking cookies.
- Your monitoring data lives in your OpenPing's own database, separate from every other customer's, and we look at it only when you ask us to help.
- When your checks stop, your OpenPing's data is deleted after 30 days, and its last export 30 days after that: 60 days in all.
- You can export your data, correct it, or ask us to delete it, by writing to support@n8builds.dev.

## 2. What we collect and why

**Your account.**
Your email address, when you created the account, and when you accepted these terms and which version.
We use it to sign you in, to send you account emails, and to tell you about your plan.

**How you sign in.**
For email sign-in, a one-time code and link, which we store only as scrambled hashes, never as the code itself.
For passkeys, each passkey's public key, its id, the name you gave it, and when it was added and last used; a public key cannot be used to sign in as you.
For GitHub sign-in, your GitHub user id and username; we read your verified primary email address from GitHub to match or create your account, and we ask GitHub for nothing else.

**Sessions.**
When you sign in, your browser gets a session cookie.
We store only a hash of it, with the sign-in method, and when it started, expires and was last used.

**Security and abuse prevention.**
To stop people guessing codes or making mass sign-ups, we count requests per email address and per IP address (for IPv6, per /64 block) for short periods.
These counters hold the address and a number, nothing else.

**The account history (audit log).**
We keep a record of important events on your account: sign-ins and the method used, a new or removed passkey, an export, each time your encryption key was shown, plan changes, a support sign-in and its reason, and a suspension and its reason.
It includes the email addresses that confirmed or declined email from your OpenPing, and, when you change your account's email address, the old and the new address.
It never holds passwords, codes, keys or card details, and it does not record your IP address.

**Billing.**
Stripe handles payment and keeps your card, billing address and any tax id.
We keep your Stripe customer id, your subscription's id, plan, status, renewal date and payment state, and a record of each billing event Stripe sends us.

**Email.**
We send email through Resend: sign-in codes, account emails (welcome, trial ending, payment failed, paused, deletion warning, a new passkey, your key being shown) and your OpenPing's alerts and reports.
For your OpenPing's email, we keep the list of addresses it may send to, whether each one confirmed or declined, and the token of each one's unsubscribe link, and a count of emails sent each day.
We do not track whether you open emails or click links.

**Your OpenPing's numbers.**
Your OpenPing tells us how many monitors, status pages and alert channels it has, and how each scheduled run went (how many checks, how many failed, how long it took).
We use these numbers to run the service, enforce plan limits and spot problems; they hold no monitoring details.

**Support.**
When you write to support, we keep the emails, so we can help you and see what was said before.

**Logs.**
Like most web services, our servers write logs when they handle requests, which can include the IP address, the address requested, the browser's user agent, and the error if something failed.
Fields that hold secrets are written as "[redacted]".

## 3. Your OpenPing's data

Everything you put in your OpenPing (monitors, check results, incidents, status pages, alert channels and settings) is stored in your OpenPing's own database, separate from every other customer's.
Secrets you give it, such as alert channel tokens and webhook addresses, are encrypted with your OpenPing's own key.
We keep a copy of that key, itself encrypted with a key only the platform holds, so we can restore your data from a backup and so you can move to your own Cloudflare account; you can see your key on your account page after a fresh sign-in, and we email you each time it is shown.
Your OpenPing also keeps, for each of its own sign-in sessions, the IP address and browser user agent, as a security record, until the session ends.
We look inside your OpenPing only when you ask us for help, or, when there is no other way, to stop abuse or fix a fault; each time is recorded with the reason and shown to you on your account page and in your OpenPing's settings.
Public status pages show what you choose to make public.
Alert channels you set up (for example Slack, Discord, a webhook or push notifications) send your alerts to those services, under their own privacy terms.
For push notifications, your browser's push service (from Google, Apple, Mozilla or Microsoft, depending on the browser) delivers them, encrypted.

## 4. How long we keep it

- **Email sign-in codes and links:** 15 minutes, or until used.
- **Passkey and GitHub sign-in steps in progress:** 5 minutes, or until finished.
- **Sessions on the account site:** 30 days, or until you sign out.
- **Sessions in your OpenPing:** 30 days, or until you sign out; a support sign-in lasts at most an hour.
- **Rate-limit counters:** deleted within 2 days.
- **Server logs:** 7 days, kept by Cloudflare.
- **Daily email counts:** 35 days.
- **Billing event records from Stripe:** 90 days.
- **Your OpenPing's run numbers:** the latest run, and daily totals for 90 days.
- **An export you make from your account page:** 7 days.
- **Your OpenPing's data after checks stop** (a cancelled plan, an unpaid renewal, or a trial that ended): kept 30 days so you can come back or export it, then deleted.
- **The last export made before that deletion:** kept 30 more days, then deleted with its copy of your key.
  So 60 days after your checks stop, your OpenPing's data is gone from our systems.
- **The list of addresses that confirmed email from your OpenPing:** until your OpenPing is deleted.
- **The account history (audit log):** 2 years; its security part (when your account was made and which terms it accepted, each change of its email address, each support sign-in, each time your key was shown, and each sign-in method added or removed) is kept while your account exists, and then until it is 2 years old.
- **Your account, sign-in methods and subscription record:** while your account exists; deleting your OpenPing does not delete your account, so you can come back.
  You can delete your account yourself (section 10).
- **Payment records:** Stripe keeps invoices and payments, and we keep our billing records, for as long as tax and accounting law requires, which is [TO FILL: retention period required by the provider's tax law, for example 7 years].
- **Support emails:** [TO FILL: retention period for support email, for example 2 years after the last message].
- **Backups:** Cloudflare keeps 30 days of point-in-time history of each database while it exists, and can restore a deleted database for 7 days after it is deleted; after that it is gone.

## 5. Who else handles your data

We use these companies to run OpenPing Hosted.
Each one handles your data only to provide its service to us.

- **Cloudflare** runs everything: our servers, every customer's OpenPing and its database, file storage for exports, queues, logs, and email forwarding for support@n8builds.dev.
- **Stripe** takes payments, calculates tax, keeps invoices and runs the billing portal.
- **Resend** sends every email: sign-in codes, account emails and your OpenPing's alerts.
- **GitHub**, only if you choose to sign in with GitHub, confirms who you are.
- **[TO FILL: the mailbox provider that receives support@n8builds.dev, for example Google Workspace]** stores the support emails we receive and send.

We share personal data with others only when the law requires it, to protect people from harm or fraud, or if OpenPing Hosted is transferred to a new owner, who would have to keep these promises.

## 6. Cookies and local storage

We use only the cookies needed to sign you in and keep it secure; there are no analytics or advertising cookies.

On the account site (`app.<our domain>`):

- `__Host-op_platform`: keeps you signed in, for 30 days.
- `__Host-op_ceremony`: holds a passkey or GitHub sign-in while it happens, for 5 minutes.

In your OpenPing (`yourname.<our domain>`):

- `op_session`: keeps you signed in to your OpenPing, for 30 days (an hour for a support sign-in).
- `op_passkey`: holds a passkey sign-in or registration while it happens, for 5 minutes.
- `op_signed_out`: for 2 minutes after you sign out, so you can sign out of the account site too.

Your OpenPing also saves a few display choices in your browser's local storage, such as the time range you last picked, whether you dismissed a tip, and whether you installed the app; they never leave your browser.
Visitors to your public status pages get no cookies.
When you pay, Stripe's checkout and billing pages set Stripe's own cookies, which Stripe uses to prevent fraud.

## 7. Legal bases (for people in the EU, the UK and similar places)

[TO FILL: confirm whether OpenPing Hosted is offered to people in the EU and the UK; if so, keep this section and appoint an EU or UK representative if the law requires one.]

- **To provide the service you signed up for (contract):** your account, sign-in, sessions, your OpenPing and its data, billing, and account and alert emails.
- **For our legitimate interests in keeping the service secure and working:** rate limits, logs, the account history, abuse prevention and support.
- **To meet legal obligations:** keeping payment and tax records.
- **With your consent:** the waitlist on openping.n8builds.dev, which you can leave at any time.

## 8. Where your data is stored

Cloudflare runs on a global network, and stores your databases in the region it chooses, which may be outside your country.
Stripe and Resend are based in the United States.
When data leaves the EU or the UK, we rely on our providers' data processing agreements, which include the European Commission's standard contractual clauses (and the UK addendum) or another legal transfer mechanism.

## 9. Security

Each customer's OpenPing is separate, with its own database and its own encryption key.
Sign-in codes, links and sessions are stored only as hashes, secrets in your OpenPing are encrypted, and our staff sign-ins to the admin side need a passkey.
No system is perfectly secure; if a breach affects your personal data, we will tell you without undue delay and as the law requires.

## 10. Your rights

You can, at any time:

- **See and export your data:** your account page shows your account, sign-in methods, support sign-ins and plan, and lets you download a full export of your OpenPing; for a copy of everything else we hold about you, write to support@n8builds.dev.
- **Correct it:** change your OpenPing's data yourself, and your account's email address on your account page (we send the new address a code first, and tell the old one).
- **Delete it:** on your account page, choose "Delete my account" (we ask you to sign in again first, and to type your email), or write to support@n8builds.dev from your account's email and we will do it for you.
  Your plan is cancelled and your OpenPing's checks stop at once, and you are signed out everywhere.
  We then export your OpenPing once more and delete it, usually within the hour, and then delete your sign-in methods, sessions and email address; we email you when it starts and when it is done.
  That last export is kept 30 days, so we can bring your OpenPing back if you write in time, and is then deleted.
  We keep the payment records the law requires, and the account history for its 2 years (section 4), with the email addresses in it removed.
- **Object or restrict:** ask us to stop a use of your data based on our legitimate interests.
- **Complain:** to your local data protection authority, though we would like the chance to help first.

We answer requests within 30 days, and we may ask you to confirm it is you, usually by writing from your account's email.

## 11. Children

OpenPing Hosted is for adults running websites and services, and is not meant for children.
You must be at least [TO FILL: minimum age, proposed 18] to have an account.
If you think a child has given us personal data, write to support@n8builds.dev and we will delete it.

## 12. People who are not our customers

If a customer's OpenPing wants to email you, we first send you one email asking if you want it; we keep your address and your answer so we never ask again.
Every email it sends you after that has an unsubscribe link, and your mail app's own unsubscribe button works too; either stops that OpenPing's email to you for good, and we tell its owner you stopped it.
You can also write to support@n8builds.dev and we will stop them.
If you visit a customer's public status page, we do not set cookies, and only our server logs (section 2) record the visit.

## 13. The OpenPing website (openping.n8builds.dev)

The OpenPing website is the project's own copy of OpenPing, run by us in our own Cloudflare account.

- **The waitlist:** if you join, we keep your email address and when you joined, send you one confirmation email through Resend, and email you when OpenPing Hosted opens; to stop abuse, sign-ups are counted per IP address for a few minutes; we keep it until you ask to be removed (reply to any email from us, or write to support@n8builds.dev) or we close the waitlist.
- **Click counts:** the page counts a few clicks, such as "Start a free trial", as daily totals only; no cookies are set, and nothing about you is stored; your IP address is used only for a moment, in Cloudflare's memory, to limit how often one visitor is counted.
- **Page views:** [TO FILL: confirm whether Cloudflare Web Analytics is on for openping.n8builds.dev; if it is, keep this line] Cloudflare Web Analytics counts page views without cookies and without tracking you across sites.
- **The "Is it down?" tool:** the address you enter is checked once, and is not stored; to stop abuse we count requests per IP address and per site checked, for a few minutes.
- **Logs:** Cloudflare keeps the website's server logs for up to 7 days.

## 14. Changes to this policy

The date at the top shows when this policy last changed.
For a change that matters to you, we will email you before it takes effect.

## 15. Contact

[TO FILL: the provider's legal name], [TO FILL: postal address].
Email: support@n8builds.dev.
