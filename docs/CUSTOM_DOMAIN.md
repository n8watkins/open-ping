# Using a custom domain

By default your install is reachable at a `*.workers.dev` URL. Putting it on
your own domain (e.g. `https://status.example.com`) makes for a nicer public
status page and stable OAuth/push URLs.

The domain must be on a zone in the **same Cloudflare account** as the Worker.

## 1. Attach the domain to the Worker

In the Cloudflare dashboard:

1. Go to **Workers & Pages → your `open-ping` worker → Settings → Domains &
   Routes**.
2. **Add → Custom Domain**, and enter your hostname (e.g.
   `status.example.com`). Cloudflare provisions the DNS record and a TLS
   certificate for you.

> Prefer config-as-code? You can instead declare a custom domain or route in
> `wrangler.jsonc` (a `routes` entry with `custom_domain: true`, or a zone
> route) and it'll be applied on `npm run deploy`. The dashboard approach is the
> simplest for a single status site.

Wait until the domain shows as active and serves your app over HTTPS before
continuing.

## 2. Point `APP_URL` at the new domain

`APP_URL` is the public base URL OpenPing uses for OAuth callbacks, magic-link
emails, and push. Update it to the custom domain:

```bash
npx wrangler secret put APP_URL
# enter: https://status.example.com
npm run deploy
```

Use `https://` and **no trailing slash**.

## 3. Update the GitHub OAuth app

The OAuth callback must match the new `APP_URL`. In **GitHub → Settings →
Developer settings → OAuth Apps → your app**:

- **Homepage URL:** `https://status.example.com`
- **Authorization callback URL:** `https://status.example.com/auth/github/callback`

(The `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` don't change - only the URLs.)

## 4. Verify

- Open `https://status.example.com` and confirm the app loads over HTTPS.
- Sign in with GitHub - if you get "invalid callback" or a redirect-URI error,
  the callback URL in step 3 doesn't exactly match `APP_URL` + `/auth/github/
  callback`.
- If you use Web Push, re-subscribe from your device so the subscription is tied
  to the new origin.

## Notes

- You can keep the old `*.workers.dev` URL working alongside the custom domain,
  but sign-in and links will use whatever `APP_URL` is set to, so keep that
  pointed at the canonical public URL.
- See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) if OAuth says "not
  authorized" or the callback is rejected after switching domains.
