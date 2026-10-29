import type { MonitorState } from "../../shared/states";
import type { MonitorType } from "./types";
import { formatMs } from "./format";

/** Monitors whose Degraded means "renew soon", not a slow or failing service. */
const EXPIRY_NOUN: Partial<Record<MonitorType, { one: string; many: string }>> = {
  cert: { one: "certificate", many: "certificates" },
  domain: { one: "domain", many: "domains" },
};

/** The one line under a monitor in the dashboard's Needs attention list. */
export function attentionDetail(m: {
  type: MonitorType;
  state: MonitorState;
  lastDurationMs: number | null;
  lastStatusCode: number | null;
}): string {
  const expiry = EXPIRY_NOUN[m.type];
  if (expiry) {
    const noun = expiry.one.charAt(0).toUpperCase() + expiry.one.slice(1);
    return m.state === "degraded" ? `${noun} expires soon` : `${noun} expired or couldn't be read`;
  }
  if (m.state === "degraded" && m.lastDurationMs != null) return `Responding in ${formatMs(m.lastDurationMs)}`;
  if (m.state === "suspended") return "Suspended by the host";
  if (m.lastStatusCode != null) return `Last response ${m.lastStatusCode}`;
  return "Not responding";
}

/**
 * The headline for degraded monitors: "2 monitors are slow or degraded", or,
 * when every one of them is only near expiry, "1 certificate expires soon".
 */
export function degradedTitle(degraded: { type: MonitorType }[], total: number): string {
  const expiring = degraded.filter((m) => EXPIRY_NOUN[m.type]);
  if (total > 0 && expiring.length === total) {
    const types = new Set(expiring.map((m) => m.type));
    const n = expiring.length;
    const noun =
      types.size === 1
        ? EXPIRY_NOUN[[...types][0]!]![n === 1 ? "one" : "many"]
        : n === 1
          ? "renewal"
          : "renewals";
    if (noun.startsWith("renewal")) return `${n} ${noun} due soon`;
    return `${n} ${noun} ${n === 1 ? "expires" : "expire"} soon`;
  }
  return `${total} monitor${total === 1 ? " is" : "s are"} slow or degraded`;
}
