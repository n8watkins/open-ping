export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

interface ApiOptions extends Omit<RequestInit, "body"> {
  /** JSON-serializable body. */
  json?: unknown;
  /** CSRF token to echo on mutations. */
  csrf?: string;
}

/** Thin JSON fetch wrapper: same-origin credentials, JSON in/out, typed errors. */
export async function api<T = unknown>(
  path: string,
  opts: ApiOptions = {},
): Promise<T> {
  const { json, csrf, headers, ...rest } = opts;
  const h = new Headers(headers);
  if (json !== undefined) h.set("Content-Type", "application/json");
  if (csrf) h.set("x-csrf-token", csrf);

  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: h,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // Non-JSON body (e.g. an HTML 5xx/502/503 page): surface the HTTP status
      // instead of throwing a raw SyntaxError that loses it. `statusText` is
      // empty over HTTP/2 (Cloudflare) and the raw body must never become the
      // user-facing message, so build it from the status code; the body is kept
      // as `data` for debugging only.
      throw new ApiError(res.status, `HTTP ${res.status}`, text);
    }
  }
  if (!res.ok) {
    // Prefer a server-provided `error` field; otherwise fall back to the status
    // code (never `statusText`, which is empty over HTTP/2).
    const serverError =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : "";
    throw new ApiError(res.status, serverError || `HTTP ${res.status}`, data);
  }
  return data as T;
}

/**
 * Return `url` only when it parses as a safe http(s) URL; otherwise null.
 *
 * `rel="noreferrer"`/`target="_blank"` do NOT stop a `javascript:` (or other
 * scheme) value from executing when placed in an `href`/`src`, so admin- and
 * user-supplied URLs must be filtered before they reach the DOM. Callers render
 * plain text (or omit `src`) when this returns null.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return /^https?:$/.test(protocol) ? url : null;
  } catch {
    return null;
  }
}
