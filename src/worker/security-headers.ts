/**
 * The one place OpenPing's response security policy is defined.
 *
 * The Worker applies it to every response it returns (src/worker/index.ts).
 * wrangler.jsonc `assets.run_worker_first` sends every request except the
 * hashed /assets/* bundles through the Worker, so no page is ever served
 * straight from static assets with a different (or missing) policy.
 * public/_headers only adds headers to those bundles (and, harmlessly, to what
 * the Worker fetches from the assets binding, which it then overrides), and
 * src/static-headers.test.ts checks every value there matches the ones below.
 */

/**
 * Extensionless paths of HTML files in public/ (html_handling serves
 * /offline.html at /offline). The Worker hands these to the assets binding as
 * requested instead of answering with the SPA entry; src/static-headers.test.ts
 * checks every such file is listed.
 */
export const STATIC_HTML_PAGES = ["/offline"] as const;

/** Cloudflare Web Analytics beacon script, when it's turned on for the zone. */
export const CF_ANALYTICS_SCRIPT = "https://static.cloudflareinsights.com";
/** Where a manually embedded Web Analytics beacon reports. */
export const CF_ANALYTICS_REPORT = "https://cloudflareinsights.com";
/**
 * The canonical install. Every install's landing page posts the OpenPing Hosted
 * waitlist form here (src/client/components/landing/WaitlistForm.tsx).
 */
export const CANONICAL_ORIGIN = "https://openping.n8builds.dev";

/** The embeddable status widget: the one surface meant to be framed. */
export const WIDGET_PATH = "/embed";

/**
 * Who may frame the /embed widget.
 * To embed from another host, add its origin here (docs/WIDGET.md).
 */
export const WIDGET_FRAME_ANCESTORS = ["https://*.n8builds.dev"] as const;

export function isWidgetPath(path: string): boolean {
  return path === WIDGET_PATH || path.startsWith(`${WIDGET_PATH}/`);
}

export type CspDirectives = {
  defaultSrc: string[];
  baseUri: string[];
  frameAncestors: string[];
  objectSrc: string[];
  scriptSrc: string[];
  styleSrc: string[];
  imgSrc: string[];
  fontSrc: string[];
  connectSrc: string[];
  workerSrc: string[];
};

/**
 * The Content-Security-Policy for every page except /embed. It suits the
 * Vite/React/Tailwind build: external hashed scripts, inline style attributes,
 * same-origin XHR, and external or data: images for the status-page logo.
 */
export function cspDirectives({ viteDev = false }: { viteDev?: boolean } = {}): CspDirectives {
  return {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    // Vite injects an inline React Fast Refresh preamble into transformed HTML
    // during local development. Production builds contain no inline script.
    // Cloudflare Web Analytics, when it's turned on for the zone: Cloudflare
    // injects its beacon, which reports to this origin (automatic injection) or
    // to cloudflareinsights.com (manual embed).
    // developers.cloudflare.com/web-analytics/faq/
    scriptSrc: viteDev
      ? ["'self'", "'unsafe-inline'", CF_ANALYTICS_SCRIPT]
      : ["'self'", CF_ANALYTICS_SCRIPT],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    fontSrc: ["'self'", "data:"],
    connectSrc: ["'self'", CF_ANALYTICS_REPORT, CANONICAL_ORIGIN],
    workerSrc: ["'self'"],
  };
}

/** The /embed policy: the same directives, framable by WIDGET_FRAME_ANCESTORS. */
export function widgetCspDirectives(options: { viteDev?: boolean } = {}): CspDirectives {
  return { ...cspDirectives(options), frameAncestors: [...WIDGET_FRAME_ANCESTORS] };
}

/** Serialise directives the way the header is sent (`frame-ancestors 'none'; ...`). */
export function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} ${values.join(" ")}`)
    .join("; ");
}

/** Headers every response carries, besides the CSP and the framing ones. */
export const BASE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
} as const;
