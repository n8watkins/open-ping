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
