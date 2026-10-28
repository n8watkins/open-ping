/**
 * Shared delivery plumbing for the HTTP alert providers. Pure: no DB access and
 * no retry loop; a failed send is retried by the durable outbox with backoff.
 */

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
  /**
   * The provider asked us to wait this long before trying again (a 429's
   * `Retry-After` header or Telegram's `retry_after`). The outbox never retries
   * sooner than this.
   */
  retryAfterMs?: number;
  /**
   * Not an attempt at all: the sender itself (OpenPing Hosted's mail, over its
   * daily cap) says it can't send before this time (epoch ms). The outbox
   * waits until then and keeps every attempt it had (db/outbox.ts markDeferred).
   */
  deferUntil?: number;
}

/** Per-request bound so one hung provider can't stall the sequential outbox drain. */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * Parse a `Retry-After` header: delay-seconds (Slack, Teams, Discord) or an
 * HTTP date. Returns milliseconds, or undefined when absent or unusable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Math.ceil(Number(trimmed) * 1000);
    return ms > 0 ? ms : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const ms = at - now;
  return ms > 0 ? ms : undefined;
}

/** Read at most `max` characters of an error body, never throwing. */
export async function readErrorDetail(res: Response, max = 200): Promise<string> {
  try {
    return (await res.text()).slice(0, max).trim();
  } catch {
    return "";
  }
}

/**
 * POST a JSON body and map the response to a {@link SendResult}. `label`
 * prefixes the error (`slack_error: no_service`). A network failure or timeout
 * becomes a retryable `network_error`; the URL is never echoed into an error,
 * because for these providers the URL is the credential.
 */
export async function postJson(url: string, body: unknown, label: string): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "network_error" };
  }
  if (res.ok) return { ok: true, status: res.status };

  // The URL is the credential: never store it, even if the provider echoed it.
  // Redact before truncating, so a cut can't leave part of the URL behind.
  const detail = redactSecret(await readErrorDetail(res, 8192), url, "[webhook URL]").slice(0, 200).trim();
  const result: SendResult = {
    ok: false,
    status: res.status,
    error: detail ? `${label}: ${detail}` : label,
  };
  const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  if (res.status === 429 && !detail) result.error = `${label}: rate_limited`;
  return result;
}

/** Replace every occurrence of `secret` in `text` (a no-op for an empty secret). */
export function redactSecret(text: string, secret: string, replacement: string): string {
  return secret ? text.split(secret).join(replacement) : text;
}

/** Truncate to `max` characters, marking any elision with an ellipsis. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
