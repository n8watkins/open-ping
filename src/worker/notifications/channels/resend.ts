import type { Env } from "../../types";

/**
 * Resend email sender (PRD §12). Pure delivery: takes an already-rendered
 * message and POSTs it to the Resend API. No DB access, no outbox/retry logic.
 * Runs in the Cloudflare Workers runtime — only global `fetch` is used.
 */

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** A fully-rendered email ready to hand to Resend. */
export interface ResendMessage {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendResendEmail(
  env: Env,
  msg: ResendMessage,
): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: "resend_not_configured" };
  }

  let res: Response;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
  } catch {
    return { ok: false, error: "network_error" };
  }

  if (res.ok) {
    return { ok: true, status: res.status };
  }

  // Capture a short, safe error string from the response body.
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    detail = "";
  }
  return {
    ok: false,
    status: res.status,
    error: detail ? `resend_error: ${detail}` : "resend_error",
  };
}
