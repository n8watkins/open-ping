# Embeddable status widget

OpenPing ships a compact, auto-refreshing **status widget** you can drop onto any
external site with a single `<iframe>`. It shows the overall banner
("All systems operational" / "Some systems degraded" / "Major outage", etc.)
plus a per-service list with status pills.

The widget renders **only** the already-public, redacted data served by
`GET /api/public/status` — the exact same payload the public status page uses. It
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

That's it — the card polls for fresh data every ~60s on its own.

---

## Options

All options are query-string parameters on the `/embed` URL.

| Param   | Values            | Default | Description                                              |
| ------- | ----------------- | ------- | -------------------------------------------------------- |
| `theme` | `dark` \| `light` | `dark`  | Color scheme. The card background is transparent so it blends into the host page; only the inner cards are tinted by the theme. |

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

Every OpenPing response is locked down with `X-Frame-Options` and a
`Content-Security-Policy` of `frame-ancestors 'none'`, so the admin panel, login,
API and the main `/status` page **cannot** be framed. The `/embed` route is the
single exception: its framing headers are relaxed so the widget can be embedded
cross-origin.

By default `/embed` allows embedding from **`https://*.n8builds.dev`**
subdomains. To embed from a different host, edit the allow-list in
[`src/worker/index.ts`](../src/worker/index.ts):

```ts
// src/worker/index.ts
const ALLOWED_FRAME_ANCESTORS = "https://*.n8builds.dev";
```

Add origins space-separated, for example:

```ts
const ALLOWED_FRAME_ANCESTORS = "https://*.n8builds.dev https://example.com";
```

then redeploy (`npm run deploy`). This is scoped to `/embed` only — all other
routes keep `X-Frame-Options` and `frame-ancestors 'none'`.

> Note: this only changes framing for `/embed`. The override drops
> `X-Frame-Options` and rewrites just the `frame-ancestors` directive of the CSP;
> every other CSP directive (`script-src 'self'`, etc.) is preserved.

---

## Bonus: SVG status badge

For a tiny shields.io-style badge (great for READMEs / dashboards), use a plain
`<img>` — no framing changes needed, since images aren't subject to
`frame-ancestors`:

```html
<img src="https://openping.n8builds.dev/api/public/badge.svg" alt="Service status" />
```

Markdown:

```md
![Service status](https://openping.n8builds.dev/api/public/badge.svg)
```

The badge shows only the aggregate status (`operational`, `degraded`,
`partial outage`, `major outage`, `maintenance`, `no services`) and respects the
status-page kill switch. Optional `?label=uptime` overrides the left-hand label.
