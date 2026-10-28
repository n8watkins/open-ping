# Embeddable status widget

OpenPing ships a compact, auto-refreshing **status widget** you can drop onto any
external site with a single `<iframe>`. It shows the overall banner
("All systems operational" / "Some systems degraded" / "Major outage", etc.)
plus a per-service list with status pills.

The widget renders **only** the already-public, redacted data served by
`GET /api/public/status` - the exact same payload the public status page uses. It
never exposes monitor URLs, request bodies, auth/credentials, headers, heartbeat
tokens, or internal error messages, and it honours the **status page enabled**
kill switch (when the status page is off, the widget shows
"Status page not enabled").

---

## Quick start

Add this to the host page (replace the host if you self-host under a different
domain):

```html
<iframe
  src="https://openping.n8builds.dev/embed?theme=dark"
  title="Service status"
  width="100%"
  height="320"
  style="border:0;max-width:480px;color-scheme:normal"
  loading="lazy"
></iframe>
```

That's it - the card polls for fresh data every ~60s on its own.

---

## Options

All options are query-string parameters on the `/embed` URL.

| Param   | Values            | Default | Description                                              |
| ------- | ----------------- | ------- | -------------------------------------------------------- |
| `theme` | `dark` \| `light` | `dark`  | Color scheme. The card background is transparent so it blends into the host page; only the inner cards are tinted by the theme. |
| `slug`  | a status-page slug | default page | Scopes the widget to a specific per-category status page. Omit it (the default) to show the default page. The slug is the same one that appears in that page's public URL `/status/<slug>` (see [`STATUS_PAGES.md`](./STATUS_PAGES.md)). The "View status" link at the bottom of the widget deep-links to the matching public page. An unknown slug renders "Status unavailable." |

For example, to embed a widget scoped to the status page with slug `api`:

```html
<iframe
  src="https://openping.n8builds.dev/embed?theme=dark&slug=api"
  title="API status"
  width="100%"
  height="320"
  style="border:0;max-width:480px;color-scheme:normal"
  loading="lazy"
></iframe>
```

### Sizing

The `<iframe>` is sized by the **host** via the `width`/`height` attributes
(it can't auto-grow across origins by default). Recommended:

- `width: 100%` with a `max-width` of `~480px` (the widget caps its own content
  width at `max-w-md`).
- `height`: roughly `120px` for the banner + ~`40px` per listed service. Start at
  `320` and adjust.

#### Optional auto-resize

The widget broadcasts its content height to the parent window on every update:

```js
window.addEventListener("message", (e) => {
  // Optionally check e.origin === "https://openping.n8builds.dev"
  if (e.data?.type === "openping:resize" && typeof e.data.height === "number") {
    document.querySelector("iframe[title='Service status']").style.height =
      e.data.height + "px";
  }
});
```

Hosts that don't add this listener simply use the fixed `height` they set on the
`<iframe>`.

---

## Allowing your domain (framing / `frame-ancestors`)

Every OpenPing page and API response is locked down with `X-Frame-Options: DENY` and a `Content-Security-Policy` of `frame-ancestors 'none'`, so the admin panel, login, API and the main `/status` page **cannot** be framed.
The `/embed` route (and paths under it) is the single exception: it drops `X-Frame-Options` so the widget can be embedded cross-origin.

By default `/embed` can be embedded from **`https://n8builds.dev`** and its subdomains (**`https://*.n8builds.dev`**).
A `*.` wildcard in a CSP source matches subdomains only, which is why the bare domain is listed separately.
To embed from a different host, add its origin to the allow-list in [`src/worker/security-headers.ts`](../src/worker/security-headers.ts):

```ts
// src/worker/security-headers.ts
export const WIDGET_FRAME_ANCESTORS = ["https://n8builds.dev", "https://*.n8builds.dev"] as const;
```

For example:

```ts
export const WIDGET_FRAME_ANCESTORS = ["https://n8builds.dev", "https://*.n8builds.dev", "https://example.com"] as const;
```

Then update the matching test in `src/static-headers.test.ts` and redeploy (`npm run deploy`).
This is scoped to `/embed` only; all other routes keep `X-Frame-Options` and `frame-ancestors 'none'`.

> Note: only framing changes for `/embed`.
> Its CSP is the same policy as every other page with just the `frame-ancestors` directive swapped, so `script-src 'self'` and the rest still apply.

---

## Off-hours

Outside a monitor's operating schedule, the widget shows that service as **Scheduled off since Fri 4:48 PM** (the time it went off, in the visitor's timezone), never as operational.
When every service on the page is off, the banner reads **All services are scheduled off** with the time of the last check.
With only some services off, the banner stays **All systems operational**, because off-hours never count as an outage.
See [Off-hours in the status pages guide](./STATUS_PAGES.md#off-hours-scheduled-off) for the full rules.

---

## Bonus: SVG status badge

For a tiny shields.io-style badge (great for READMEs / dashboards), use a plain
`<img>` - no framing changes needed, since images aren't subject to
`frame-ancestors`:

```html
<img src="https://openping.n8builds.dev/api/public/badge.svg" alt="Service status" />
```

Markdown:

```md
![Service status](https://openping.n8builds.dev/api/public/badge.svg)
```

The badge shows only the aggregate status (`operational`, `degraded`,
`partial outage`, `major outage`, `maintenance`, `off hours`, `no services`) and
respects the status-page kill switch.
It reads `off hours` when every service on the page is outside its operating schedule, and `no services` when the page has no public services.

Two optional query parameters:

- `?label=uptime` overrides the left-hand label (defaults to `status`).
- `?slug=<slug>` scopes the badge to a specific per-category status page, exactly
  like the widget's `slug` param above. Omit it for the default page. A disabled
  page, or a slug that matches no page, renders a neutral `unknown` badge rather
  than breaking the `<img>`.

```md
![API status](https://openping.n8builds.dev/api/public/badge.svg?slug=api&label=API)
```
