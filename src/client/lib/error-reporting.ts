// Browser error reporting to Sentry, off unless the install sets SENTRY_DSN:
// the Worker then puts the DSN in the app shell's <meta name="openping-sentry-dsn">
// (src/worker/lib/error-reporting.ts). Reports go to /api/monitoring on this
// origin, which forwards them, so the CSP keeps connect-src 'self'.
//
// The SDK is a separate chunk loaded on the first error, so a session that
// never fails never downloads it. Privacy: no user, request data or query
// string, no console breadcrumbs, and emails and tokens masked.
import type { Breadcrumb, ErrorEvent } from "@sentry/browser";

type SentryModule = typeof import("@sentry/browser");
let sdk: Promise<SentryModule | null> | null = null;

function configuredDsn(): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLMetaElement>('meta[name="openping-sentry-dsn"]')?.content || null;
}

export function safeMessage(message: string): string {
  return message
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, "[email]")
    .replace(/[A-Za-z0-9_\-.+/=]{24,}/g, "[redacted]")
    .slice(0, 300);
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/)[0] ?? "";
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    if (event.request.url) event.request.url = withoutQuery(event.request.url);
  }
  if (event.message) event.message = safeMessage(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = safeMessage(exception.value);
  }
  return event;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") return null;
  const data = breadcrumb.data;
  if (data) {
    for (const key of ["url", "from", "to"] as const) {
      if (typeof data[key] === "string") data[key] = withoutQuery(data[key]);
    }
  }
  return breadcrumb;
}

function load(dsn: string): Promise<SentryModule | null> {
  sdk ??= import("@sentry/browser")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        tunnel: "/api/monitoring",
        release: __OP_VERSION__,
        environment: "production",
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
        // The window listeners below already report uncaught errors.
        integrations: (defaults) => defaults.filter((integration) => integration.name !== "GlobalHandlers"),
        ignoreErrors: ["ResizeObserver loop", "AbortError", "Load failed", "Failed to fetch", "NetworkError"],
        denyUrls: [/^(chrome|moz|safari)-extension:\/\//, /^chrome:\/\//],
        beforeSend: scrubEvent,
        beforeBreadcrumb: scrubBreadcrumb,
      });
      return Sentry;
    })
    .catch(() => null); // Offline or blocked: the app works the same without it.
  return sdk;
}

/** Reports an error to Sentry; a no-op on an install without a DSN. */
export function reportError(error: unknown): void {
  const dsn = configuredDsn();
  if (!dsn) return;
  void load(dsn).then((Sentry) => Sentry?.captureException(error));
}

/** Reports uncaught errors and unhandled promise rejections. */
export function installErrorReporting(): void {
  if (!configuredDsn()) return;
  window.addEventListener("error", (event) => reportError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
}
