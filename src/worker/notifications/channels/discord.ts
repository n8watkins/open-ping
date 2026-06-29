/**
 * Discord webhook sender (PRD §12). Pure delivery: POSTs a message (optionally
 * with embeds) to a Discord webhook URL. No DB access, no outbox/retry logic.
 * Runs in the Cloudflare Workers runtime — only global `fetch` is used.
 */

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
  footer?: { text: string };
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
}

/** Embed accent color for a monitor state (used by callers building embeds). */
export function stateColor(state: string): number {
  switch (state) {
    case "up":
      return 0x2fbf6e; // green
    case "degraded":
      return 0xf5a524; // amber
    case "down":
      return 0xef4757; // red
    default:
      return 0x64748b; // gray
  }
}

export async function sendDiscordMessage(
  webhookUrl: string,
  body: DiscordMessage,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Bound the request so one hung endpoint can't stall the sequential outbox
      // drain. An abort throws and is mapped to a retryable network_error below.
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { ok: false, error: "network_error" };
  }

  // Discord returns 204 No Content on success; res.ok covers 2xx.
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
    error: detail ? `discord_error: ${detail}` : "discord_error",
  };
}
