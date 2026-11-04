/**
 * Error reporting to Sentry, off unless the SENTRY_DSN var is set. The public
 * template leaves it empty, so a self-hosted install reports nothing unless its
 * owner adds a DSN of their own (deploy.local.json "vars").
 *
 * - The Worker: `withSentry` (src/worker/index.ts) and app.onError.
 * - The browser: the app shell carries the DSN in a meta tag
 *   (withErrorReportingMeta), and src/client/lib/error-reporting.ts sends its
 *   reports to /api/monitoring on this origin, which forwards them here
 *   (sentryTunnel). The CSP stays connect-src 'self', whatever the DSN's host.
 *
 * Privacy: no user, request body, cookies, headers or query string is sent,
 * and messages have emails and long tokens masked (scrubEvent).
 */
import type { CloudflareOptions, ErrorEvent } from "@sentry/cloudflare";
import type { Context } from "hono";

export const SENTRY_META = "openping-sentry-dsn";
export const SENTRY_TUNNEL_PATH = "/api/monitoring";

/** Masks emails and anything that looks like a key or token. */
export function safeMessage(message: string): string {
  return message
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, "[email]")
    .replace(/[A-Za-z0-9_\-.+/=]{24,}/g, "[redacted]")
    .slice(0, 300);
}

export function scrubEvent<T extends Pick<ErrorEvent, "user" | "request" | "message" | "exception">>(event: T): T {
  delete event.user;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    if (event.request.url) event.request.url = event.request.url.split(/[?#]/)[0] ?? "";
  }
  if (event.message) event.message = safeMessage(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = safeMessage(exception.value);
  }
  return event;
}

export function sentryOptions(env: { SENTRY_DSN?: string }): CloudflareOptions {
  const dsn = env.SENTRY_DSN || undefined;
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: "production",
    // Collect nothing about the visitor or the request beyond the path.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      httpBodies: [],
      stackFrameVariables: false,
      databaseQueryData: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
    },
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  };
}

/** Adds the DSN meta tag to the app shell's <head>, when a DSN is set. */
export function withErrorReportingMeta(html: string, dsn: string | undefined): string {
  if (!dsn) return html;
  const escaped = dsn.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return html.replace("</head>", `<meta name="${SENTRY_META}" content="${escaped}" /></head>`);
}

/** Where the configured DSN's events go, or null without a valid DSN. */
export function envelopeEndpoint(dsn: string | undefined): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+|\/+$/g, "");
    if (url.protocol !== "https:" || !/^\d+$/.test(projectId)) return null;
    return `https://${url.host}/api/${projectId}/envelope/`;
  } catch {
    return null;
  }
}

/**
 * POST /api/monitoring: forwards a browser's Sentry envelope, but only one
 * addressed to this install's own DSN, so the route can't relay anything else.
 */
export async function sentryTunnel(c: Context<{ Bindings: { SENTRY_DSN?: string } }>): Promise<Response> {
  const dsn = c.env.SENTRY_DSN || undefined;
  const endpoint = envelopeEndpoint(dsn);
  if (!endpoint) return c.json({ error: "not_found" }, 404);
  const envelope = await c.req.text();
  let header: { dsn?: unknown };
  try {
    header = JSON.parse(envelope.slice(0, envelope.indexOf("\n")));
  } catch {
    return c.json({ error: "bad_envelope" }, 400);
  }
  if (header.dsn !== dsn) return c.json({ error: "wrong_dsn" }, 400);
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope" },
    body: envelope,
  });
  return new Response(null, { status: upstream.ok ? 200 : 502 });
}
