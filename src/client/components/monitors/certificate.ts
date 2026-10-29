/**
 * The wire shape of an SSL certificate monitor's last read (worker
 * checks/cert.ts CertificateDetail) and the words the monitor page uses.
 */

export type CantCheckReason = "cloudflare" | "tls13_only" | "refused";

export interface CertificateDetail {
  host: string;
  port: number;
  checkedAt: number;
  certificate?: {
    subject: string | null;
    issuer: string | null;
    validFrom: number;
    validTo: number;
    daysUntil: number;
    sans: string[];
    sanCount: number;
    serial: string;
    chainLength: number;
    coversHost: boolean;
  };
  cantCheck?: { reason: CantCheckReason; message: string; detail: string };
  lookupError?: { code: string; message?: string; at: number };
}

/** Why the latest read failed, in words. */
export function certLookupFailure(code: string): string {
  switch (code) {
    case "cert_timeout":
      return "timed out";
    case "cert_connect_failed":
      return "couldn't connect";
    case "cert_closed":
      return "the server closed the connection";
    case "cert_unreadable":
      return "unreadable answer";
    default:
      return "read error";
  }
}

/** "42 days left", "1 day left", "Expires today", "Expired 3 days ago". */
export function daysLeftLabel(daysUntil: number, expired: boolean): string {
  if (expired) {
    const ago = Math.max(0, -daysUntil - 1);
    return ago === 0 ? "Expired" : `Expired ${ago} ${ago === 1 ? "day" : "days"} ago`;
  }
  if (daysUntil <= 0) return "Expires today";
  return `${daysUntil} ${daysUntil === 1 ? "day" : "days"} left`;
}
