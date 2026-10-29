# OpenPing Hosted: decision record

The decisions behind the Hosted build, from [the build plan, section 4](../HOSTED_BUILD_PLAN.md#4-decisions-with-recommendations).
Each one is the owner's call.
"Recommended, pending owner" means the build assumes the recommendation until the owner decides otherwise; the code keeps every such choice in one place so it is cheap to change.

| # | Decision | Status |
| --- | --- | --- |
| D2 | Hosted address | Recommended, pending owner (domain not bought yet) |
| D3 | Customer sign-in | Recommended, pending owner |
| D4 | Who holds each customer's `MASTER_KEY` | Recommended, pending owner |
| O4 | Support address | Decided 2026-10-28: support@n8builds.dev |
| D12 | How long a deleted tenant's export is kept, and who may see its `MASTER_KEY` | Decided 2026-10-29 |

## D2: the Hosted address

**Status:** recommended, pending owner.
The domain is not bought yet (owner action O2, needed before staging in wave 3).

**Recommendation:** buy a short dedicated domain (about $10 to $15 a year) and serve `app.<domain>` (sign-up, sign-in, account, billing) and `<slug>.<domain>` (each customer's OpenPing).
Keep `app.openping.n8builds.dev` as a redirect to `app.<domain>`.

**Why:**

- Universal SSL covers the apex and one level of subdomain, so `<slug>.<domain>` gets a free wildcard certificate.
  The alternative, `<slug>.app.openping.n8builds.dev`, is two levels deep and needs Advanced Certificate Manager at $10 a month.
- Customer cookies never share a parent domain with the owner's portfolio sites under n8builds.dev.
- It is the stage 5 rename done early, before any customer has an address to keep.

**How the code keeps it open:** the platform reads the domain from one var, `HOSTED_DOMAIN` in `platform/wrangler.jsonc`, which holds a placeholder (`openping-hosted.invalid`) until the domain exists.
Nothing else names the domain.

**Owner input needed:** the domain name, bought and added to Cloudflare.

## D3: customer sign-in

**Status:** recommended, pending owner.

**Recommendation:** one platform account per customer, signed in with an email link that also shows a 6-digit code, a passkey, or GitHub.
The customer's OpenPing trusts a short-lived signed hand-off from the platform instead of having a sign-up of its own.
Google sign-in comes after launch.

**Why:**

- One account across devices and billing, and no second sign-up inside each OpenPing.
- The existing magic-link and passkey code in OpenPing is reused on the platform.
- The hand-off is a single-use, 60-second, Ed25519-signed token, so the tenant needs only a public key, never a shared secret ([the contract, section 7](./CONTRACT.md#7-the-sign-in-hand-off)).

**How the code keeps it open:** the account schema stores sign-in methods as rows in `account_identities` with `kind` one of `email`, `github`, `passkey`, so adding Google later is a new `kind`, not a new table.

## D4: who holds each customer's `MASTER_KEY`

**Status:** recommended, pending owner.

**Recommendation:** the platform generates each tenant's `MASTER_KEY`, sets it as the user Worker's secret, and keeps a copy encrypted with `PLATFORM_KEY` in the `escrowed_keys` table.

**Why:**

- Restoring a customer's backup, and rotating their key, both need the key, and Cloudflare never shows a secret again after it is set.
- The escrowed copy is useless without `PLATFORM_KEY`, which exists only as a platform secret and in the owner's password manager.
- The platform database holds no monitoring data, so a leak of it alone exposes no customer's credentials.

**How the code keeps it open:** `escrowed_keys` keeps one row per tenant and key id, so a rotation adds a row and retires the old one instead of overwriting it.

**Owner input needed:** generate `PLATFORM_KEY` with the agent and save it in the password manager (owner action O6, before staging).

## O4: the support address

**Status:** decided 2026-10-28.
Support is **support@n8builds.dev**, forwarded with Cloudflare Email Routing.
It appears in the emails (D2), the terms (D3), and the platform's own pages, such as the suspended page.

## D10: push alerts on trial plans

**Status:** decided 2026-10-28.
Trial customers can turn on push alerts on their devices, even though the trial plan's alert channels are email only.
Push devices aren't channels, so plan limits don't count them, and the owner chose to keep it that way: push costs the platform nothing per send and helps a trial feel complete.

## D11: after the last failed payment retry

**Status:** decided 2026-10-28.
When Stripe's last automatic retry of a renewal fails, Stripe cancels the subscription (Billing settings, "Manage failed payments": cancel the subscription), rather than marking it unpaid.
The tenant is then suspended by billing, its checks stop, and the 30-day data retention and deletion of decision D8 apply.
A customer who comes back subscribes again from their account page.

## D12: a deleted tenant's export, and the customer's key

**Status:** decided 2026-10-29: the owner accepted both the 30 extra days (data fully gone 60 days after checks stop, stated in the privacy policy) and customers seeing their own key as described.

**Recommendation:** before a tenant is deleted (decision D8), the platform exports its database to the private `openping-tenant-exports` bucket and keeps that export 30 more days, so the customer can still download it from their account page, and the owner can restore it.
A customer's own export, from the account page, is kept 7 days.
Each export keeps the escrowed copy of the `MASTER_KEY` its encrypted values are sealed with (still encrypted with `PLATFORM_KEY`, in `export_keys`), so a deletion export stays readable after the tenant and its escrowed key are gone; the key and the export's files are deleted together when the export expires.
The customer may see an export's key on the account page, after a sign-in from the last 15 minutes (a passkey sign-in, when the account has a passkey); it is never emailed or put in a download, the account is emailed each time it is shown, and it is in the audit log.

**Why:**

- A deletion that loses data by mistake can't be undone; an export first, kept a while, can.
- Moving to a self-hosted OpenPing needs the key: without it the encrypted credentials in the database can't be read (docs/BACKUP.md).
- The key is the customer's own, for their own data; the steps tell them to rotate it once they have moved.

**How the code keeps it open:** the keep times are `EXPORT_KEEP_MS` in `platform/src/lifecycle/exports.ts`, and the key page is one route in `platform/src/lifecycle/account-export.ts`.

**Owner input needed:** the retention, for the privacy policy (D9): with this, a deleted customer's data is gone 60 days after their checks stopped.

## D13: launch pricing

**Status:** decided 2026-10-29.

- OpenPing Hosted is $24 a year: 20 monitors checked every 12 minutes, 2 status pages, every alert channel, second-region confirmation.
- The fast checks add-on is $24 a year more ($48 in total): 1-minute checks on up to 5 of the 20 monitors; the rest stay at 12 minutes.
- The trial is 30 days with 5 monitors at 12-minute checks, no card.
- Yearly billing only.

**Why:** the measured cost per customer (docs/HOSTED_PLAN.md, "Cost per customer, measured" and the margins table): every plan clears a profit even for a customer using everything the plan allows, and the prices are still well under every paid competitor (docs/LANDING_AND_LOGIN_PLAN.md).
**What changes in code:** a `fastMonitors` plan limit (5) and the contract change for it, the add-on price in billing, and the trial length (14 days to 30 days) in the platform, the landing page's trial copy and the lifecycle emails.
