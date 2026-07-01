import { connect } from "cloudflare:sockets";
import type { TcpConfig } from "../../shared/schemas";
import type { ProbeResult } from "./types";
import { assertSafeHost } from "../lib/ssrf";

/**
 * TCP-port check executor. Opens a raw socket to `host:port` via the Workers
 * `cloudflare:sockets` API and reports whether the connection is accepted.
 *
 * SSRF/abuse handling: BEFORE connecting we run `assertSafeHost` on the raw host
 * so loopback/`.local`/metadata/private targets are rejected with a permanent
 * `blocked_host` (never dialed, never retried). The runtime independently blocks
 * Cloudflare-internal/private/localhost destinations and outbound port 25 as
 * defense-in-depth; port 25 is additionally rejected at the zod layer.
 */

export async function runTcpCheck(config: TcpConfig): Promise<ProbeResult> {
  const hostCheck = assertSafeHost(config.host);
  if (!hostCheck.ok) {
    return {
      ok: false,
      durationMs: 0,
      error: "blocked_host",
      errorMessage: `Target rejected by SSRF guard: ${hostCheck.reason}`,
    };
  }

  const startedAt = Date.now();
  let socket: ReturnType<typeof connect> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    socket = connect({ hostname: config.host, port: config.port });

    // Race the connection's `opened` promise against a wall-clock timeout so a
    // silently-dropped SYN (filtered port) can't hang the check indefinitely.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("tcp_timeout"));
      }, config.timeoutMs);
    });

    await Promise.race([socket.opened, timeout]);
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (timedOut) {
      return {
        ok: false,
        durationMs,
        error: "tcp_timeout",
        errorMessage: `Connection to ${config.host}:${config.port} exceeded ${config.timeoutMs}ms`,
      };
    }
    return {
      ok: false,
      durationMs,
      error: "tcp_refused",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
    // Always release the socket, even if it never opened.
    if (socket) await socket.close().catch(() => {});
  }
}
