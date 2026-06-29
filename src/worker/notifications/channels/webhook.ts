/**
 * Generic signed-webhook sender (PRD §12). Pure delivery: serializes a payload
 * and POSTs it, optionally signing the body with an HMAC-SHA256 secret. No DB
 * access, no outbox/retry logic. Runs in the Cloudflare Workers runtime — only
 * global `fetch` and Web Crypto (`crypto.subtle`) are used; no Node APIs.
 */

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** HMAC-SHA256 of `body` keyed by `secret`, returned as lowercase hex. */
export async function signPayload(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export async function sendWebhook(
  url: string,
  secret: string | undefined,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): Promise<SendResult> {
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (secret) {
    // Sign `${timestamp}.${body}` so the timestamp is covered by the signature
    // and can't be rewritten for a replay. Receivers reconstruct the same string.
    const timestamp = String(Date.now());
    headers["X-OpenPing-Timestamp"] = timestamp;
    headers["X-OpenPing-Signature"] =
      `sha256=${await signPayload(secret, `${timestamp}.${body}`)}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body });
  } catch {
    return { ok: false, error: "network_error" };
  }

  if (res.ok) {
    return { ok: true, status: res.status };
  }

  let detail = "";
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    detail = "";
  }
  return {
    ok: false,
    status: res.status,
    error: detail ? `webhook_error: ${detail}` : "webhook_error",
  };
}
