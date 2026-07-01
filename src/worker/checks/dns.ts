import type { DnsConfig } from "../../shared/schemas";
import type { ProbeResult } from "./types";
import { assertSafeUrl } from "../lib/ssrf";

/**
 * DNS record check executor. Resolves a record over Cloudflare's public DNS-over-
 * HTTPS JSON API and (optionally) asserts the resolved value(s) equal/contain an
 * expected string. Runs in the Workers runtime — only global `fetch`,
 * `AbortController` and the `URL` global are used.
 *
 * The resolver host is a FIXED constant (never user input), so this cannot be an
 * SSRF vector; we still run `assertSafeUrl` on the constructed URL as belt-and-
 * suspenders, mirroring the HTTP executor.
 */

const RESOLVER = "https://cloudflare-dns.com/dns-query";

/** DoH JSON numeric record types for the record kinds we support. */
const TYPE_NUM: Record<DnsConfig["recordType"], number> = {
  A: 1,
  AAAA: 28,
  CNAME: 5,
  MX: 15,
  TXT: 16,
};

interface DnsAnswer {
  name: string;
  type: number;
  data: string;
}
interface DnsJson {
  Status: number;
  Answer?: DnsAnswer[];
}

/** Normalize a record's `data` for comparison (per record kind). */
function normalizeRecord(data: string, recordType: DnsConfig["recordType"]): string {
  let v = data.trim();
  // DoH wraps TXT payloads in double quotes.
  if (recordType === "TXT") v = v.replace(/^"/, "").replace(/"$/, "");
  // CNAME/MX targets carry the FQDN root dot; drop it for stable comparison.
  if (recordType === "CNAME" || recordType === "MX") v = v.replace(/\.$/, "");
  return v;
}

export async function runDnsCheck(config: DnsConfig): Promise<ProbeResult> {
  const url = `${RESOLVER}?name=${encodeURIComponent(config.hostname)}&type=${config.recordType}`;

  // Belt-and-suspenders: the resolver is a fixed public host, but re-validate.
  const safe = assertSafeUrl(url);
  if (!safe.ok) {
    return {
      ok: false,
      durationMs: 0,
      error: "blocked_url",
      errorMessage: `Resolver URL rejected by SSRF guard: ${safe.reason}`,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;

    if (!res.ok) {
      return {
        ok: false,
        durationMs,
        error: "dns_error",
        errorMessage: `Resolver returned HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as DnsJson;

    // Status != 0 → NXDOMAIN / SERVFAIL / etc. (the name does not resolve).
    if (json.Status !== 0) {
      return {
        ok: false,
        durationMs,
        error: "dns_nxdomain",
        errorMessage: `Resolver status ${json.Status} for ${config.hostname}`,
        meta: { status: json.Status },
      };
    }

    // Keep only answers of the requested record type (an A query may also carry
    // the CNAME chain that led there — we assert against the requested kind).
    const answers = (json.Answer ?? []).filter(
      (a) => a.type === TYPE_NUM[config.recordType],
    );
    if (answers.length === 0) {
      return {
        ok: false,
        durationMs,
        error: "dns_no_records",
        errorMessage: `No ${config.recordType} records for ${config.hostname}`,
        meta: { records: [] },
      };
    }

    const records = answers.map((a) => normalizeRecord(a.data, config.recordType));

    if (config.expected) {
      const target = config.expected.value.trim();
      const matched = records.some((r) =>
        config.expected!.mode === "equals" ? r === target : r.includes(target),
      );
      if (!matched) {
        return {
          ok: false,
          durationMs,
          error: "dns_mismatch",
          errorMessage: `No ${config.recordType} record ${config.expected.mode} "${target}"`,
          meta: { records },
        };
      }
    }

    return { ok: true, durationMs, meta: { records } };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      return {
        ok: false,
        durationMs,
        error: "dns_timeout",
        errorMessage: `DNS query exceeded ${config.timeoutMs}ms timeout`,
      };
    }
    return {
      ok: false,
      durationMs,
      error: "dns_error",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
