# Landing page and sign-in: the plan

Written 2026-10-28.
This plan answers six questions about how the landing page explains the two ways to get OpenPing, what "signing in" means, which login methods to offer, and what to build when.
It fits the stages and gates in [the Hosted plan](./HOSTED_PLAN.md) and does not change them.
Competitor facts were checked on 2026-10-28 unless a source says otherwise.

## The short version

- Say "one OpenPing, two ways to run it" above the fold, with two buttons: "Deploy free to your Cloudflare" and "Join the Hosted waitlist".
- Stop putting "Sign in" in the main nav of the marketing site; nobody visiting it can sign in yet.
- Make every sign-in screen say whose OpenPing it is, so nobody confuses an install's admin login with an account on our service.
- Self-host: keep GitHub and email links, add passkeys as the default, and never add Google.
- Hosted: launch with email (link plus a 6-digit code), GitHub and Google; add passkeys after launch; no passwords, no SAML.
- Do not compete on probe networks, sub-minute checks, SMS, on-call or big free tiers.

## What I looked at

- Code: `src/client/pages/Landing.tsx`, `src/client/components/landing/SignInModal.tsx`, `src/client/pages/Login.tsx`, `src/worker/routes/auth.ts`, `src/worker/routes/magic.ts`, `src/client/App.tsx`.
- Docs: `docs/HOSTED_PLAN.md`, `docs/HANDOFF.md`, `docs/INSTALL.md`, `README.md`.
- The live site, https://openping.n8builds.dev, in Chrome at 1440 by 900 and 390 by 844.
  Screenshots were taken of the hero, the pricing section, the sign-in modal, the `/login` error state and `/install` at both sizes.
  The page has no horizontal overflow on phones (document width 390 at a 390 viewport).
- Competitor pricing pages, home pages and sign-up pages, the sign-up pages in a real browser so client-rendered buttons were visible.

## 1. Explaining the two paths

### Who each path is for

| | Run it in your own Cloudflare | OpenPing Hosted |
|---|---|---|
| Who | Developers who already have, or don't mind, a Cloudflare account and a terminal | Freelancers, agencies and small businesses who want monitoring, not a project |
| What they value | Free, owning the data, reading the code | Nothing to set up, someone else keeps it running |
| What scares them | Being locked into a vendor, a bill that grows | Wrangler, secrets, D1, OAuth apps |
| What they need to hear | "Free, MIT, your account, about 20 minutes" | "$24 a year, sign in and add your sites, cancel any time, take your data with you" |

The two paths are not rivals.
The free path is the product's credibility (open code, nothing hidden) and the Hosted path is how the project pays for itself.
The page should make both feel like first-class choices, not "the real product, plus a donation box".

### Making the choice obvious in seconds

A visitor should be able to answer "which one is for me?" from the hero alone, without scrolling.
The test: show the hero to five people for five seconds, and ask which button they would press and what it costs.
All five should get both prices right.

Today the hero only offers one path ("Deploy your own"), which goes to the GitHub README, while the Pricing section, about two-thirds of the way down, offers the second path and links the free path to `/install` instead.
A non-developer who lands on the hero sees "Worker", "D1 database" and a GitHub icon, and leaves before learning that a hosted option exists.

### Does the tagline still fit?

"Uptime monitoring on your own Cloudflare" is true and sharp today, because the only shipping product runs in the visitor's account.
Keep it as the headline while Hosted is a waitlist.
Once Hosted takes paying customers it stops being true for half the offer, because a Hosted customer's OpenPing runs on our Cloudflare, not theirs.
At that point:

- Lead with what both paths share and nobody else does well: schedule-aware monitoring that does not count off-hours as downtime.
- Keep "on your own Cloudflare" as the name of the free path, where it remains literally true and is still the strongest line for developers.
- Keep it as the GitHub repository description and in the README, where the audience is developers.

### Copy: now (Hosted is a waitlist)

**Eyebrow pill:** Open source, MIT licensed

**Headline (h1):** Uptime monitoring on your own Cloudflare

**Subhead:** Checks, status pages and alerts for your sites and APIs, with schedules that know when an app is meant to be asleep. Run it free in your own Cloudflare account. A hosted version is coming.

**Buttons:**

- Primary: `Deploy free to your Cloudflare` (to `/install`, not the README)
- Secondary: `Join the Hosted waitlist` (to `#pricing`, focusing the email field)
- Text link under them: `See a live status page` and `Try the free tools`, no sign-up needed.

**Under the buttons, one line of small print:** Free forever in your account. Hosted will be $24 a year; not open yet.

### Copy: after Hosted launches (stage 7)

**Headline:** Uptime monitoring that knows your hours

**Subhead:** Checks, status pages and alerts that only count the hours an app is meant to be up. Run it free on your own Cloudflare, or let us host it for $24 a year.

**Buttons:**

- Primary: `Start a 14-day trial` (to Hosted sign-up; no card)
- Secondary: `Deploy free to your Cloudflare` (to `/install`)

Which path is primary flips at launch because the Hosted visitor is the one who needs the least persuading to start, and the developer will find the free path anyway.
If the trial is dropped (the Hosted plan makes it conditional), the primary label becomes `Get Hosted, $24 a year`.

### Nav

Now:

```
[OpenPing]  How it works  Features  Pricing  FAQ      [GitHub *1]  [Deploy free]
```

- Move "Pricing" to the third slot; it is the question people come with.
- Drop "Sign in" from the nav (see question 2); put "Owner sign-in" in the footer.
- Keep Ko-fi out of the top bar: a tip jar next to a $24 product muddies "is this a business?".
  It fits in the footer and on the GitHub README.
- Leave a visible gap between the n8builds mark and "How it works": at 1440 px the two run together ("n8buildsHow it works").
- On phones, the one header button should be the primary call to action (`Deploy free`), not "Sign in".

After launch:

```
[OpenPing]  How it works  Features  Pricing  Self-host  FAQ     Log in   [Start trial]
```

"Log in" then means a Hosted account and goes to the Hosted app's own address (see question 2).

### Pricing section

Keep the two cards, and add the comparison table under them.
The current heading, "Run it yourself for free, or let me run it", is good: it is honest that a single person runs Hosted.
Keep the first person, and add a line under the cards that says who "me" is: "Hosted is run by Nathan Watkins (n8builds), the person who writes OpenPing."
People buying a $24 product from a solo developer want to know there is a person, and they will forgive small scale if it is stated up front.

**Free card**

- Label: In your own Cloudflare account
- Price: Free
- Points: Every feature, MIT licensed / Your data never leaves your account / Fits Cloudflare's free plan for about 8 monitors at once; Workers Paid for more / About 20 minutes, step by step
- Button: `Deploy free to your Cloudflare`

**Hosted card (now)**

- Label: OpenPing Hosted, with a badge `Not open yet` (plainer than "Coming soon", which reads like a launch date is close)
- Price: $24 a year
- Points: as today.
- Form: email field and `Join the waitlist`.
- Small print: "No date yet. I'll email you once when it opens, with early pricing. No newsletter, never shared."
- Link: "Where Hosted is up to" to `docs/HOSTED_PLAN.md` on GitHub.
  Showing the staged plan with its gates is the most honest way to say "this may not happen", and it doubles as proof of seriousness.

Do not show the waitlist count until it passes the stage 1 gate (about 20); a small number reads as "nobody wants this".

**Hosted card (after launch)**

- Badge: none, or `New`.
- Button: `Start a 14-day trial`, then "No card needed. Cancel any time. Export everything, or move it to your own Cloudflare."

### Comparison table: Self-host vs Hosted

Put this directly under the two pricing cards, and use the same table in `/install` and the FAQ.

| | In your own Cloudflare | OpenPing Hosted |
|---|---|---|
| Price | Free (Cloudflare's free plan; Workers Paid is $5 a month if you outgrow it) | $24 a year; 1-minute checks $12 a year more |
| Set-up | About 20 minutes: a Cloudflare account, a terminal and a few commands | About a minute: sign in and add a site |
| Monitors | No cap of its own; about 8 at once on Cloudflare's free plan, up to 200 per run on Workers Paid | 20 |
| Check interval | Every 12 minutes by default; you can change it | Every 12 minutes, or 1 minute with the add-on |
| Status pages | As many as you like | 2 |
| Second-region confirmation | Once stage 2 ships, yes | Yes |
| Where your data lives | Your D1 database, in your Cloudflare account | An isolated database for you alone, in our Cloudflare account |
| Who can see it | Only you | You; and me, only to keep the service running or when you ask for help |
| Updates | You pull and redeploy | Automatic |
| If something breaks | GitHub issues | Email support |
| Leaving | It's already yours | Export everything, or move to your own Cloudflare in one import |
| Sign-in | Passkey, GitHub or email link, for you as the only admin | Email, Google or GitHub |

### Showing honestly that Hosted is a waitlist

- Never use "Start", "Sign up" or "Get started" for Hosted until stage 7; use "Join the waitlist".
- Never show a launch date.
- Say "planned" in the FAQ ("Is there a hosted version? Planned, not open yet. Join the waitlist to hear once when it opens.").
- Keep the free path as the one complete thing the page offers today; the Hosted card is clearly secondary in weight (secondary button style) until launch.
- Make the waitlist confirmation say what happens next: "You're on the list. One email when Hosted opens, nothing else."

### Section order

Now:

1. Nav
2. Hero with both paths and the small-print prices
3. Product shot (the dashboard)
4. Schedule-aware monitoring (the differentiator; it is fourth today, behind the trust strip and How it works)
5. How it works (your Cloudflare account diagram)
6. Two ways to run it: the pricing cards plus the Self-host vs Hosted table
7. Features, status pages, alerts (merge the three into one section with tabs or a grid; three sections in a row is a long scroll on phones)
8. Honest limits (what Cloudflare's free plan covers)
9. OpenPing vs the hosted tools (the existing comparison)
10. Quick start (the terminal block)
11. Free tools
12. FAQ, with "Who can sign in?" and "Is there a hosted version?"
13. Final call to action with both buttons
14. Footer, with "Owner sign-in", Ko-fi and "More from n8builds"

After launch, move "Two ways to run it" to position 4, right after the product shot, and move "How it works" into the self-host half of the page.

## 2. What "signing in" means, and how to say it

### Three different sign-ins share one word

| | Self-hosted admin sign-in | The owner's sign-in on openping.n8builds.dev | A future Hosted account |
|---|---|---|---|
| Whose app | The person who deployed it | Nathan's own install, which also serves the marketing page | Ours, a service we run for the customer |
| Who can sign in | One person: `ADMIN_GITHUB_LOGIN` or `ADMIN_EMAIL` | One person: Nathan | Anyone who signs up |
| Who stores the identity | The install's own D1 | The install's own D1 | Our platform database |
| Who can see the monitors | Only that admin; we never see them | Only Nathan | The customer, and us to operate the service |
| Address | Their `*.workers.dev` or their domain | openping.n8builds.dev | A separate address (for example app.openping.n8builds.dev) |

The confusion today is real and specific:

- The marketing page has "Sign in" in the nav on desktop and as the only header button on phones.
  A visitor who just read "Deploy your own" reasonably thinks "Sign in" is how they start.
- The modal says "OpenPing is single-administrator. Only the configured identity can sign in."
  This is accurate jargon, and it does not say whose OpenPing this is.
- The modal footer says "Runs in your own Cloudflare account." On openping.n8builds.dev that is false from the visitor's side: it runs in Nathan's.
- A visitor who tries GitHub gets "That account isn't the configured administrator." with no next step.
- Every install shows the OpenPing marketing page to signed-out visitors at `/` (`src/client/App.tsx`), so a self-hoster's customers who open the root of their status domain see "Deploy your own", a waitlist and a "Sign in" button for somebody else's admin.

### Recommendations

**Separate the addresses.**
When Hosted ships, the Hosted app lives on its own address (the Hosted plan already says to decide one at stage 4).
Recommend `app.openping.n8builds.dev`.
openping.n8builds.dev stays the marketing site plus Nathan's install.
"Log in" in the marketing nav then only ever means a Hosted account, and the owner reaches his own admin from the footer link or `/login`.

**Before Hosted: no customer sign-in anywhere on the marketing site.**
Move the button to the footer as "Owner sign-in", and keep `/login` working.

**Give each install a choice of what guests see at `/`.**
Add a setting (and an env var for the canonical install) with three values: the marketing page (today's behavior, and the default only on the canonical install), the install's default status page, or a minimal "This is <install name>'s OpenPing. Status page / Admin sign-in" page.
Default new installs to the status page.
This reverses part of stage 1, which deliberately put the waitlist on every install's landing page; the reach that loses is small, and a "Powered by OpenPing" link on status pages keeps the referral without confusing anyone's own visitors.
The owner should decide this one explicitly.

**Sign-in modal and `/login` wording, self-hosted installs (including Nathan's):**

```
            [logo]  <Install name, or "OpenPing">
        Sign in to this OpenPing
  This OpenPing is run by its owner in their own
  Cloudflare account. Only its administrator can
  sign in. The OpenPing project never sees its data.

  [ Sign in with a passkey ]
  [ Continue with GitHub   ]
  ------------- or -------------
  [ you@example.com        ]
  [ Email me a sign-in link ]

  Not the admin? You can't make an account here.
  Get your own OpenPing ->        See the status page ->
```

On the canonical install, the two links at the bottom are "Deploy free to your Cloudflare" and "Join the Hosted waitlist".
On other installs, the links are "See the status page" and a small "Get your own OpenPing" to openping.n8builds.dev.

**Error for a non-admin**, replacing "That account isn't the configured administrator.":

> That GitHub account isn't this OpenPing's administrator, so it can't sign in here.
> If you wanted your own OpenPing, [deploy it free](/install) or [join the Hosted waitlist](/#pricing).

**Hosted sign-in, after launch** (on `app.openping.n8builds.dev`):

```
          [logo] OpenPing Hosted
       Log in to your OpenPing Hosted account
  [ Continue with Google ]
  [ Continue with GitHub ]
  ------------- or -------------
  [ you@company.com      ]
  [ Continue with email  ]

  Run OpenPing in your own Cloudflare instead?
  Your install has its own sign-in at its own address.
```

The last line catches self-hosters who land here looking for their own install.

### What a Hosted account stores, and how to say it

Put this on the pricing card's "what's stored" link, in the privacy policy (stage 6), and in a FAQ answer.

- **Your account:** your email, your sign-in identities (a Google or GitHub id), your plan and your Stripe customer id.
  Card details stay with Stripe.
- **Your OpenPing:** monitors, schedules, results, incidents, status pages and alert channels, in a database used only by your OpenPing (one Workers for Platforms Worker and one D1 database per customer).
- **Who can see it:** you.
  I can technically read it because I run the service; I only look when you ask for help or to fix the service, and the privacy policy says so.
- **Leaving:** Settings has "Export everything" (the same JSON the self-hosted import reads) and a "Move to your own Cloudflare" guide that is: deploy, then import that file.
  After you cancel, checks stop and your data is kept for 30 days, then deleted (already in stage 4's acceptance).

Do not claim "we can't see your data" for Hosted.
The isolation is between customers, not between the customer and the operator, and saying otherwise would undercut the trust the self-host path earns.

**FAQ, "Who can sign in?" (replace today's answer):**

> In your own Cloudflare account, only you: OpenPing has one administrator, who signs in with a passkey, GitHub or an email link, and the OpenPing project never sees that install.
> OpenPing Hosted, when it opens, will have normal accounts with email, Google or GitHub sign-in, kept separate from any install you run yourself.

## 3. Login methods

### What competitors offer (sign-up pages checked in Chrome, 2026-10-28)

| Product | Google | GitHub | Microsoft | Email and password | Email link or code | SSO |
|---|---|---|---|---|---|---|
| [UptimeRobot](https://dashboard.uptimerobot.com/sign-up) | Yes | Yes | No | Yes ("Use email") | No | No |
| [Better Stack](https://betterstack.com/users/sign-up) | No | No | No | Yes, at sign-in | Yes, the only sign-up option | Yes |
| [Instatus](https://dashboard.instatus.com/signup) | Yes | No | No | Email first, then continue | Email first | Yes (SAML on Business) |
| [Checkly](https://app.checklyhq.com/signup) | Yes | Yes | No | Email first | Email first | Enterprise |
| [Cronitor](https://cronitor.io/sign-up) | Yes | Yes | No | Yes (name, email, password) | No | SAML add-on |
| [StatusCake](https://app.statuscake.com/Signup.php) | Yes | No | Yes | Yes | No | No |
| [HetrixTools](https://hetrixtools.com/register/) | No | No | No | Yes (4 fields) | No | No |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) (self-hosted) | No | No | No | Local user and password | No | No (TOTP 2FA) |
| [UptimeFlare](https://github.com/lyc8503/UptimeFlare) (self-hosted on Cloudflare) | No | No | No | No | No | Optional password on the status page only |

The pattern: hosted products aimed at developers offer Google and GitHub; the ones aimed at teams add SSO; nobody serious ships Google alone; self-hosted tools keep it local.
Google is on 5 of the 7 hosted products checked, GitHub on 3.

### Self-host: keep GitHub and email links, add passkeys, never Google

- **Audience:** one admin, almost always a developer with a GitHub account.
  Conversion does not apply: they have already deployed before they ever see the sign-in page.
- **Setup burden is the real cost.**
  Each OAuth provider is another console, another app, a redirect URI to get exactly right and two more secrets.
  Google is the worst of the three: a Google Cloud project, an OAuth consent screen, a client, test users or publishing the app, and a privacy policy URL on the consent screen.
  The GitHub OAuth app is already step 4 of `docs/INSTALL.md` and the most common place a first deploy goes wrong (state, callback URL, `APP_URL`).
- **Security:** an allowlist of one identity is already strong.
  Every extra provider is one more way in to watch, and the account that gets in has full control.
- **Maintenance:** every provider is code, tests and docs forever, for a feature one person per install uses a few times a month.

**Recommendation: add passkeys (WebAuthn) as the default self-host sign-in, and make GitHub and email optional.**
A passkey needs no third-party account and no extra secret: the admin registers one in the setup wizard, already protected by `SETUP_TOKEN`.
That can take the GitHub OAuth app out of the required install steps, which is the single biggest cut to the self-host time to first monitor.
Recovery stays rooted in Cloudflare, which the admin controls anyway: setting a new `SETUP_TOKEN` with Wrangler unlocks "register a new passkey" once.
Keep GitHub and email links as optional extras for people who want a second way in, and say so in `/install`: "Passkey is enough. Add GitHub or email if you want a backup."
Passkeys are supported by every current browser and by iCloud Keychain, Google Password Manager, Windows Hello, 1Password and Bitwarden.

### Hosted: email first, then GitHub and Google before launch

- **Audience:** at $24 a year with "nothing to set up", Hosted is aimed at freelancers, agencies and small businesses, many of whom live in Google Workspace and do not have a GitHub account.
- **Conversion:** a social button removes the "go check your inbox" step, which is where email-only sign-ups drop.
  Google is the one most non-developers have; GitHub is the one OpenPing's current audience has.
- **Trust:** a "Continue with Google" button on a one-person product reads as more legitimate, not less, as long as the consent screen only asks for name and email.
- **Burden:** on Hosted it is ours alone and paid once, not once per install.
- **Security:**
  - Link identities to an account by verified email only.
    Google returns `email_verified`; for GitHub, read `/user/emails` and use only a primary, verified address.
    Never link or create an account from an unverified email, which is the classic takeover path.
  - When a new provider's verified email matches an existing account, sign the person in and show "Google is now linked to this account" with an "Unlink" button, and email them about it.
  - Email links expire in 15 minutes and work once (as today); add a 6-digit code in the same email, so a phone user whose mail app opens the link in a different browser can still finish.
  - Rate limits per IP and globally, as today, plus a per-address cap on sends.
- **Maintenance:** three methods, one code path (an identity table keyed by provider and subject).
  Never add passwords: they bring resets, breach checks and credential stuffing, for no gain over email codes.
- **Not worth it for Hosted:** Microsoft (StatusCake has it; revisit only if agencies on Microsoft 365 ask), Apple (only matters for a native iOS app), SAML or SCIM SSO (enterprise, and the wrong market at $24).

### Passkeys: worth it?

- **Self-host: yes, and early.**
  It is the one method that removes setup steps instead of adding them, and it is phishing-resistant for an account that controls monitoring and alerts.
- **Hosted: yes, after launch.**
  Offer "Add a passkey" in account settings once people have accounts, then offer passkey sign-in on the login page for those who have one.
  Do not make it the only sign-up method; for new users, passkey-first sign-up still confuses more people than it helps.

### Rollout order

1. Now, self-host: the wording changes in question 2 (no code risk).
2. Self-host, before or alongside stage 2: passkeys in the setup wizard and sign-in, GitHub becomes optional in `/install`.
3. Stage 4, Hosted: email link plus 6-digit code (the generalized magic-link code the Hosted plan already calls for), and GitHub.
4. Stage 6 or 7, before Hosted launches: Google.
5. After launch: passkeys for Hosted accounts.

## 4. Sign-in and onboarding UX

### The current flow: what's good

- The modal is well built: a real dialog, labelled, Escape and backdrop close it, focus is trapped and restored, scroll is locked, and the entrance animation respects reduced motion.
- GitHub is the visually primary button, which matches the audience.
- The email confirmation is generic ("If that address is allowed, a sign-in link has been sent."), so it doesn't reveal the admin's address.
- OAuth errors are specific and some offer "Try again" right in the message.
- At 390 px the modal fits with comfortable margins, and the page has no horizontal scroll.
- The `/install` guide is a clear numbered page (Get the code, Sign in to Cloudflare, Create the database, Set up the tables, Add the two required secrets, Deploy, Create a GitHub sign-in app, Finish setup in the browser, Sign in and add your sites).

### The current flow: what's off

1. **Sign-in is offered to people who can't use it.**
   It is in the desktop nav, and on phones it is the only header button besides the menu, so the first tappable thing on a phone is the one thing a visitor can never do.
2. **The modal doesn't say whose OpenPing this is**, and its footer ("Runs in your own Cloudflare account.") is wrong for a visitor on openping.n8builds.dev.
3. **The non-admin error is a dead end.** "That account isn't the configured administrator." with no link to deploy or the waitlist, and `/login` has no link back to the home page.
4. **The email path is under-explained.** "Email magic link" is a noun, not an action; there is no "or" divider between GitHub and email, so the email field reads as part of the GitHub button; and the confirmation doesn't say to check spam, that the link lasts 15 minutes or to open it on the same device.
5. **A disabled GitHub button is shown** on `/login` when GitHub isn't configured, with a tooltip only a mouse user can see.
   Hide providers that aren't configured.
6. **The hero's main button goes to the GitHub README**, while Pricing goes to `/install`.
   `/install` is the better page; send every "deploy" button there.
7. **Pixel issues:** at 1440 px "n8builds" runs straight into "How it works" in the nav; the four hero checks wrap to an orphan "Off-hours aware" on a line of its own; the waitlist button is dimmed until an email is typed, which reads as broken at a glance (keep it enabled and validate on submit).
8. **Self-host time to first monitor is about 20 minutes and nine steps**, including two consoles (Cloudflare and GitHub), two generated secrets and an OAuth app.
   The steps are well written; there are just a lot of them.

### Competitors, step by step

I did not create accounts; first screens were checked in Chrome, and later steps come from each product's own pages.

| | UptimeRobot | Checkly | Better Stack | OpenPing self-host today | OpenPing Hosted target |
|---|---|---|---|---|---|
| Promise on the home page | "Start monitoring in 30 seconds" | "Start for free" | "The most reliable uptime monitoring" | "Deploy your own" | "Start a 14-day trial" |
| First screen asks for | The website to monitor, then Google, GitHub or email | Email, or Google or GitHub | Email only | A terminal | Google, GitHub or email |
| Fields before the first monitor | 1 (the URL) plus a sign-in | 1 (email) or 0 with social | 1 (email) | About 6 secrets and IDs | 1 (the URL) |
| Social buttons | Google and GitHub side by side, under the URL field | Google and GitHub stacked under the email field | None | GitHub only | Google and GitHub stacked, above email |
| Inbox round trip | Only with email | Only with email | Always | Only with email | Only with email; a code works too |
| Time to first monitor | Under a minute | A few minutes | A couple of minutes | About 20 minutes | Under a minute |

The best idea in the table is UptimeRobot's: ask for the URL first, before the account.
It makes the first field the thing the visitor came to do, and the account becomes the second, small step.

### Target flow: self-host

```
Landing                     /install                      Cloudflare
+-----------------------+   +------------------------+    +-------------------------+
| Uptime monitoring on  |   | Run OpenPing in your   |    | Deploy OpenPing         |
| your own Cloudflare   |-->| own Cloudflare account |--->| repo name  [open-ping]  |
| [Deploy free to your  |   | [Deploy to Cloudflare] |    | D1 database [created]   |
|  Cloudflare]          |   |  or do it by hand v    |    | MASTER_KEY  [generate]  |
| [Join Hosted waitlist]|   |                        |    | [Deploy]                |
+-----------------------+   +------------------------+    +-------------------------+
                                                                      |
     your-openping.workers.dev/setup                                  v
+------------------------------+   +------------------------------+   +-------------------+
| 1. Paste your setup token    |-->| 2. Create your passkey       |-->| 3. What should    |
|    (shown in the deploy log) |   |    [Create passkey]          |   |    OpenPing watch?|
|                              |   |    Add GitHub or email later |   | [https://...    ] |
+------------------------------+   +------------------------------+   | Hours [Always v]  |
                                                                      | [Start watching]  |
                                                                      +-------------------+
                                                                                |
                                                                                v
                                                                  Dashboard: first check
                                                                  runs right away, result
                                                                  shown, "Add another" and
                                                                  "Publish a status page"
```

- **Deploy to Cloudflare button:** Cloudflare's deploy buttons copy the repository into the user's GitHub, create the D1 database from the Wrangler config, run the repository's `deploy` script and build with Workers Builds ([Cloudflare docs](https://developers.cloudflare.com/workers/platform/deploy-buttons/), checked 2026-10-28).
  Migrations run if the `deploy` script applies them.
  The docs don't say that users are prompted for secret values, so the first spike is to find out whether `MASTER_KEY` and `SETUP_TOKEN` can be generated during the deploy or entered on that page; if not, the setup wizard has to accept them another way.
  Keep the manual steps on `/install` under "Prefer to do it by hand?".
- **First check now:** call the existing manual test (`POST /api/monitors/:id/test`) when the first monitor is created, so the dashboard shows a real result instead of waiting up to 12 minutes for the cron.
- **Empty state:** the dashboard with no monitors shows one URL field and "Start watching", not an empty table.
- **Errors:** the wizard keeps today's messages and adds the fix ("Setup token didn't match. It's the SETUP_TOKEN secret you set in Cloudflare. Reset it with `npx wrangler secret put SETUP_TOKEN`.").

### Target flow: Hosted

```
Landing pricing card              app.openping.n8builds.dev/start
+--------------------------+      +-----------------------------------+
| OpenPing Hosted          |      | What should OpenPing watch?       |
| $24 a year               |----->| [https://example.com            ] |
| [Start a 14-day trial]   |      | [Continue]                        |
| No card. Cancel any time |      +-----------------------------------+
+--------------------------+                       |
                                                   v
        +-----------------------------------+      +-----------------------------------+
        | Create your account to save it    |      | Check your email                  |
        | [ Continue with Google ]          |      | We sent a link and a code to      |
        | [ Continue with GitHub ]          |----->| you@company.com.                  |
        | ------------ or ------------      |      | Code [ _ _ _ _ _ _ ]              |
        | [ you@company.com ]               |      | Link lasts 15 minutes.            |
        | [ Continue with email ]           |      | Not there? Check spam, or resend. |
        | Terms - Privacy                   |      +-----------------------------------+
        +-----------------------------------+                       |
                                   (social sign-in skips this step) v
                                    +------------------------------------------------+
                                    | example.com is up - 212 ms - checked just now  |
                                    | Only check it during set hours? [Set hours]    |
                                    | Where should alerts go? [your email, on]       |
                                    | Next: add another site, or publish a status    |
                                    | page.                                          |
                                    +------------------------------------------------+
```

- Two screens from the pricing card to a real result for social sign-in, three for email.
- The account is provisioned (stage 4) while the person reads the sign-in screen, so the check result is ready when they arrive.
- Schedule-aware monitoring is offered in the first result, because it is the reason to pick OpenPing over UptimeRobot's free plan.
- **Mobile:** every button full width and at least 44 px tall, the code field uses `inputmode="numeric"` and `autocomplete="one-time-code"`, the email field uses `autocomplete="email"`, and nothing needs a hover.
- **Errors:** say what happened and the next step, in the place it happened; never a bare "Sign-in failed".
  For example, "That link was already used. We've sent a new one." or "This Google account's email isn't verified, so we can't use it to sign in. Use email instead."

## 5. OpenPing vs the competitors

Prices are the lowest paid plan billed yearly, as stated on each pricing page on 2026-10-28.

| Product | Entry paid price | Free tier | Self-host | Data ownership | Schedule-aware (off-hours not counted) | Status pages | Login options |
|---|---|---|---|---|---|---|---|
| **OpenPing** | Hosted planned: $24 a year | All of it, in your own Cloudflare | Yes, on Cloudflare Workers and D1, MIT | Yours (self-host); exportable (Hosted) | Yes, the core feature | Many (self-host), 2 (Hosted) | GitHub, email link (passkeys planned) |
| [UptimeRobot](https://uptimerobot.com/pricing/) | Solo, $12 a month ($144 a year) | 50 monitors, 5-minute checks, 1 basic status page, "for hobby and non-profit projects" | No | Theirs | Maintenance windows only | 1 free, 3 on Solo | Google, GitHub, email |
| [Better Stack](https://betterstack.com/pricing) | Extra monitors from $21 a month; responders $29 a month | 10 monitors and heartbeats, 1 status page | No | Theirs | Maintenance windows only | 1 free, $12 a month each after | Email link, password, SSO |
| [StatusCake](https://www.statuscake.com/pricing/) | Superior, $20.41 a month yearly | 10 monitors, 5-minute checks | No | Theirs | Maintenance windows only | Yes | Google, Microsoft, email |
| [HetrixTools](https://hetrixtools.com/pricing/uptime-monitor/) | Professional, $99.95 a year | 15 monitors, 1-minute checks; log in every 90 days | No | Theirs | Maintenance windows only | All plans | Email and password |
| [Instatus](https://instatus.com/pricing) | Pro, from $20 a month | 15 monitors, 2-minute checks | No | Theirs | Maintenance windows only | The core product | Google, email, SSO |
| Pingdom | About $10 a month yearly for 10 checks ([third-party estimates](https://costbench.com/software/observability/pingdom); Pingdom's [own page](https://www.pingdom.com/pricing/) didn't show a price to my fetch) | None, trial only | No | Theirs | Maintenance windows only | Yes | Not checked |
| [Cronitor](https://cronitor.io/pricing) | $2 a month per monitor plus $5 a month per user | 5 monitors, 1 status page | No | Theirs | Not checked | 1 free | Google, GitHub, email and password |
| [Checkly](https://www.checklyhq.com/pricing/) | Starter, $24 a month yearly | 10 uptime monitors, 2-minute checks, capped check runs | No | Theirs | Not checked | Yes | Google, GitHub, email |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | None (93k GitHub stars) | All of it | Yes, Docker on your own server | Yours | Maintenance windows only | Yes | Local user and password, TOTP |
| [UptimeFlare](https://github.com/lyc8503/UptimeFlare) | None | All of it | Yes, Cloudflare Workers and D1, Apache-2.0 | Yours | No | Yes | None (optional status-page password) |
| [Upptime](https://github.com/upptime/upptime) | None | All of it | Yes, GitHub Actions and Pages | Yours, in a git repo | No | Yes (GitHub Pages) | GitHub (it's your repo) |

"Maintenance windows only" means the product can pause checks or mark a planned window, but has no notion of an app's normal operating hours that are excluded from uptime every day.
Where I couldn't confirm a feature from the product's own page, the table says "Not checked".

### How the open-core neighbors talk about self-host vs hosted

- [Plausible](https://plausible.io/self-hosted-web-analytics) shows a side-by-side table (infrastructure, releases, features, support, cost) and is blunt that self-hosting is "a real commitment".
  Its Community Edition lacks some paid features; OpenPing should not copy that part, because "every feature, free" is OpenPing's strongest line.
- [PostHog](https://posthog.com/docs/self-host) recommends its cloud for almost everyone and offers self-hosting with no support or guarantees.
  That works for a company that wants cloud revenue above all; OpenPing's free path is its identity, so it should be presented as a full equal.
- UptimeFlare is the closest product to OpenPing's free path: free, on Cloudflare Workers and D1, 1-minute checks from many locations, and no hosted version.
  OpenPing's honest differences are schedule-aware monitoring, a real admin app with alerts and multiple status pages, and (soon) a hosted option.
  UptimeFlare's March 2026 advisory (CVE-2026-29779, configuration and credentials exposed) is a reminder to keep OpenPing's sealed-config story visible on `/install`, not to attack anyone.

### Where OpenPing should not compete

- **Free hosted tiers.** UptimeRobot gives 50 free monitors; a solo-run service cannot win a free-tier race and the Hosted plan rightly has none.
  OpenPing's free tier is the self-host path.
- **Check frequency and probe networks.** 30-second and 15-second checks from dozens of regions are Better Stack's, UptimeRobot's and Checkly's game.
- **Incident management and on-call** (rotations, phone calls, escalation): Better Stack, Instatus.
- **Synthetic browser and API testing** (Playwright, monitoring as code): Checkly.
- **Status pages as the product** (subscribers, white-label, SSO-gated pages): Instatus, Better Stack.
- **Enterprise:** SOC 2, SAML, audit logs and invoices.

OpenPing wins where the others are weakest: apps that are meant to sleep (business-hours tools, demo apps on free hosting, staging), developers who want to own their monitoring outright, and people who want a status page and alerts for $24 a year instead of $144 or more.
The landing page should name that audience plainly.

## 6. The staged action plan

Effort: S is under half a day, M is one to two days, L is three days or more.
Metrics need the existing Cloudflare Web Analytics plus a few named click events; adding those events is item 1.0.

### Now, during stage 1 (Hosted is a waitlist)

| # | Change | Effort | Metric that shows it worked | Status |
|---|---|---|---|---|
| 1.0 | Count clicks on each hero and pricing button, and visits to `/install` | S | Baseline exists within a week | Done |
| 1.1 | Hero: both paths, small-print prices, primary button to `/install` (copy in question 1) | S | Share of visitors who click a hero button; share of `/install` visits from the hero | Done |
| 1.2 | Nav: Pricing third, "Sign in" out of the nav into the footer as "Owner sign-in", Ko-fi to the footer, primary "Deploy free" on phones | S | Sign-in modal opens by non-admins drop to near zero; hero-to-`/install` clicks on phones rise | Done |
| 1.3 | Pricing: "Not open yet" badge, honest small print, "Where Hosted is up to" link, the Self-host vs Hosted table, who runs it | S | Waitlist sign-ups per 100 visitors to `#pricing` | Done |
| 1.4 | Section order (question 1), merge features, status pages and alerts | M | Scroll depth to Pricing on phones | Done |
| 1.5 | Sign-in modal and `/login` wording, the "Not the admin?" links, non-admin error with next steps, hide unconfigured providers, back link on `/login` | S | Fewer `not_authorized` errors per week, which can be counted from the redirect | Done |
| 1.6 | Email path polish: "Email me a sign-in link", an "or" divider, confirmation that says 15 minutes, same device, check spam | S | Fewer repeat link requests per sign-in | Done |
| 1.7 | Pixel fixes: nav gap after n8builds, hero checks wrap, waitlist button enabled until submit | S | Screenshots at 1440 and 390 look right | Done |
| 1.8 | FAQ: rewrite "Who can sign in?", add "Is there a hosted version?" | S | Fewer sign-in questions in GitHub issues or email | Done |
| 1.9 | Decide what guests see at `/` on other installs (owner decision), then build the setting | M | Waitlist sign-ups from non-canonical installs vs canonical, before and after | Done |

Notes on how stage 1 was built (branch `feat/landing-two-paths`):

- 1.0: Cloudflare Web Analytics has no custom events ([its FAQ](https://developers.cloudflare.com/web-analytics/faq/), checked 2026-10-28), so clicks go to a first-party counter, `POST /api/events`.
  It takes a fixed list of event names, keeps daily totals only (migration 0012, `page_events`), sets no cookies, stores nothing about the visitor, and rate limits with the Workers Rate Limiting binding instead of a database write.
  Settings shows 7- and 30-day totals beside the waitlist.
- 1.4: checks, status pages and alerts are one section with tabs; the trust strip under the hero is gone, since the hero and How it works say the same things.
- 1.5: the GitHub callback counts non-admin sign-ins as `signin_not_admin`, so the metric is in the same table.
- 1.9: decided by the owner (other installs show their own status page); built as the `HOME_PAGE` var.
  The default, `"status"`, shows the install's default status page at `/`, or a short "no public status page" screen with an owner sign-in link when it's off; only openping.n8builds.dev sets `"landing"`.
  Status pages' "Powered by OpenPing" now links to openping.n8builds.dev, which keeps the referral.

These all fit inside stage 1: they make the waitlist test fairer, because a visitor who never finds the Hosted card can't join it.
Ship 1.0 first so the stage 1 gate (about 20 sign-ups in 8 weeks) is measured against a known number of pricing views.

### Alongside stage 2 (independent of the gate; helps the free path either way)

| # | Change | Effort | Metric |
|---|---|---|---|
| 2.1 | Passkeys for the self-host admin: register in the setup wizard, sign in with one, recovery through a new `SETUP_TOKEN` | M | Share of new installs that finish setup with a passkey only |
| 2.2 | GitHub OAuth optional in `/install` and the wizard | S | Median time from `/install` visit to first monitor (ask in the wizard, or time the steps by hand) |
| 2.3 | Spike: Deploy to Cloudflare button, including how secrets and migrations work with it | M | Yes or no on whether a fresh account deploys with one button |
| 2.4 | If 2.3 works: the button on `/install` and the hero, the manual steps kept below | M | `/install` visits that end in a deployed install (GitHub repository copies per week as a proxy) |
| 2.5 | First check right away on the first monitor, and a one-field empty state | S | Share of new installs with a monitor in their first session |

### Stage 4: Hosted sign-up and sign-in

| # | Change | Effort | Metric |
|---|---|---|---|
| 4.1 | Hosted app on its own address (app.openping.n8builds.dev) | S | No Hosted customer ever lands on the owner's `/login` |
| 4.2 | URL-first start page, then sign-in | M | Share of start-page visitors who reach a first result |
| 4.3 | Email link plus 6-digit code; per-address send cap | M | Email sign-ins completed vs started; median minutes between request and completion |
| 4.4 | GitHub sign-in for Hosted, with verified-email linking | S | Share of sign-ups by method |
| 4.5 | Identity model: one account, many identities, link by verified email only, notify on link | M | Zero accounts created from unverified emails (a test, and a weekly query) |
| 4.6 | Hosted sign-in wording, and the "self-hosters sign in at your own install" line | S | Support emails about "which login?" |

### Stage 6: before launch

| # | Change | Effort | Metric |
|---|---|---|---|
| 6.1 | Google sign-in (consent screen with name and email only, privacy policy URL from stage 6) | S | Share of sign-ups via Google; overall sign-up completion before and after |
| 6.2 | "What we store" page, Export everything, "Move to your own Cloudflare" guide | M | An export imports cleanly into a fresh self-host install (a test) |
| 6.3 | Account settings: linked identities, unlink, delete account | M | Delete requests handled without support |

### Stage 7: launch

| # | Change | Effort | Metric |
|---|---|---|---|
| 7.1 | New hero headline and subhead, "Start a 14-day trial" primary, "Deploy free" secondary | S | Trial starts per 100 visitors; `/install` visits should not fall by more than a third |
| 7.2 | Nav gets "Log in" (to the Hosted app) and "Start trial" | S | Log-in clicks that land on the Hosted app, not `/login` |
| 7.3 | "Two ways to run it" moves up to position 4 | S | Scroll depth to pricing |
| 7.4 | Pricing card switches from waitlist to trial; waitlist email sent once | S | Waitlist-to-trial conversion |
| 7.5 | Update the tagline across README, social cards and the page title | S | Consistent everywhere (a search of the repo) |

### After launch

| # | Change | Effort | Metric |
|---|---|---|---|
| 8.1 | Passkeys for Hosted accounts (add in settings, then sign in) | M | Share of active accounts with a passkey |
| 8.2 | Microsoft sign-in, only if agencies ask | S | Requests for it |
| 8.3 | Compare trial-to-paid by sign-up method; drop a method that brings no paying customers | S | Trial-to-paid by method |

## Open decisions for the owner

All four were decided on 2026-10-28:

1. Other installs show their own status page to guests, not the marketing page (item 1.9, the `HOME_PAGE` var).
2. The Hosted address is `app.openping.n8builds.dev`.
3. The first-person voice for Hosted stays, with Nathan Watkins (n8builds) named next to it.
4. Ko-fi moves off the top bar to the footer.

## Sources

All checked on 2026-10-28.

- UptimeRobot: [pricing](https://uptimerobot.com/pricing/), [home page](https://uptimerobot.com/), [sign-up](https://dashboard.uptimerobot.com/sign-up)
- Better Stack: [pricing](https://betterstack.com/pricing), [uptime page](https://betterstack.com/uptime), [sign-up](https://betterstack.com/users/sign-up), [sign-in](https://betterstack.com/users/sign-in)
- StatusCake: [pricing](https://www.statuscake.com/pricing/), [sign-up](https://app.statuscake.com/Signup.php)
- HetrixTools: [pricing](https://hetrixtools.com/pricing/uptime-monitor/), [register](https://hetrixtools.com/register/)
- Instatus: [pricing](https://instatus.com/pricing), [sign-up](https://dashboard.instatus.com/signup)
- Pingdom: [pricing](https://www.pingdom.com/pricing/), [CostBench estimate](https://costbench.com/software/observability/pingdom), [Hyperping on Pingdom pricing](https://hyperping.com/blog/pingdom-pricing)
- Cronitor: [pricing](https://cronitor.io/pricing), [sign-up](https://cronitor.io/sign-up)
- Checkly: [pricing](https://www.checklyhq.com/pricing/), [sign-up](https://app.checklyhq.com/signup)
- Uptime Kuma: [repository](https://github.com/louislam/uptime-kuma)
- UptimeFlare: [repository](https://github.com/lyc8503/UptimeFlare)
- Upptime: [repository](https://github.com/upptime/upptime)
- Plausible: [self-hosted vs Cloud](https://plausible.io/self-hosted-web-analytics)
- PostHog: [self-host docs](https://posthog.com/docs/self-host)
- Cloudflare: [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
