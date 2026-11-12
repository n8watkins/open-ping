import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import { assertSafeUrl } from "./ssrf";
import { checkerUserAgent, DEFAULT_CHECKER_USER_AGENT } from "./user-agent";

/**
 * Site icons for HTTP monitors (the Monitors list and a monitor's page).
 *
 * The Worker reads each icon from the monitored site itself (the page's
 * <link rel=icon>, else /favicon.ico) and keeps the small image in D1, so the
 * browser only ever asks OpenPing for it: no third party sees what you
 * monitor, and nothing is mixed content.
 *
 * Strict by design: the monitor's own host only (the page, after its
 * redirects, and the icon on that same host), the checker's SSRF guard on
 * every hop, a short timeout over the whole exchange, 256 KB of page and 16 KB
 * of icon at most, and only PNG, ICO, GIF, JPEG and WebP, recognised by their
 * bytes. SVG is left out: it can carry script, and the stored bytes are served
 * from OpenPing's own origin.
 *
 * Cost: one page request and at most a few icon requests per monitor, when the
 * monitor is first opened or listed, when its address changes, and once a week after.
 */

export const ICON_MAX_BYTES = 16 * 1024;
const PAGE_MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
/** How many candidate icons one refresh tries before giving up. */
const MAX_CANDIDATES = 4;
/** A fetched (or failed) icon is not fetched again for this long. */
export const ICON_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** How many monitors' icons one request refreshes in the background. */
const REFRESH_BATCH = 4;

export interface IconImage {
  bytes: Uint8Array;
  contentType: string;
}

/** The image type these bytes are, by their magic numbers; null for anything we don't serve. */
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...vals: number[]) => vals.every((v, k) => b[i + k] === v);
  if (b.length < 12) return null;
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = m[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** How far a declared size is from 32px (smaller is better); unknown sizes sit in the middle. */
function sizeRank(sizes: string | undefined): number {
  if (!sizes) return 20;
  const first = /(\d+)x\d+/i.exec(sizes);
  return first ? Math.abs(Number(first[1]) - 32) : 20;
}

/**
 * The icons a page declares, best first: <link rel=icon> by closeness to 32px,
 * then apple-touch-icon, then /favicon.ico. Relative links resolve against
 * `pageUrl`; data: links and SVGs are skipped.
 */
export function iconCandidates(html: string, pageUrl: URL): URL[] {
  const found: { url: URL; rank: number }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(m[0]);
    const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const touch = rels.includes("apple-touch-icon") || rels.includes("apple-touch-icon-precomposed");
    if (!rels.includes("icon") && !touch) continue;
    const href = attrs.get("href")?.trim();
    if (!href || href.startsWith("data:")) continue;
    if ((attrs.get("type") ?? "").toLowerCase().includes("svg")) continue;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (url.pathname.toLowerCase().endsWith(".svg")) continue;
    found.push({ url, rank: (touch ? 1000 : 0) + sizeRank(attrs.get("sizes")) });
  }
  found.sort((a, b) => a.rank - b.rank);
  const all = [...found.map((f) => f.url), new URL("/favicon.ico", pageUrl)];
  const seen = new Set<string>();
  return all.filter((u) => !seen.has(u.href) && seen.add(u.href));
}

/** Read at most `max` bytes of a body; `over` says whether there was more. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; over: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), over: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        over = true;
        chunks.push(value.subarray(0, value.length - (total - max)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  return { bytes, over };
}

interface Got {
  url: URL;
  bytes: Uint8Array;
  over: boolean;
}

/**
 * GET one URL with no headers of ours beyond a User-Agent (never the monitor's
 * credentials), following up to three redirects, each re-checked by the SSRF
 * guard and, when `hosts` is given, held to those hosts. Null on any failure.
 */
async function guardedGet(
  start: URL,
  max: number,
  signal: AbortSignal,
  hosts: ReadonlySet<string> | null,
  fetchFn: typeof fetch,
  userAgent: string,
): Promise<Got | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!assertSafeUrl(url.href).ok) return null;
    if (hosts && !hosts.has(url.hostname)) return null;
    const res = await fetchFn(url.href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { "user-agent": userAgent, accept: "*/*" },
    });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) return null;
      try {
        url = new URL(location, url);
      } catch {
        return null;
      }
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return { url, ...(await readCapped(res, max)) };
  }
  return null;
}

/** The site's icon, or null when it has none we may serve. Never throws. */
export async function fetchFavicon(
  pageUrl: string,
  fetchFn: typeof fetch = fetch,
  userAgent: string = DEFAULT_CHECKER_USER_AGENT,
): Promise<IconImage | null> {
  let start: URL;
  try {
    start = new URL(pageUrl);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // The page may redirect (to www, or to a login), so its own host is where it ends up.
    const page = await guardedGet(start, PAGE_MAX_BYTES, controller.signal, null, fetchFn, userAgent).catch(() => null);
    const finalUrl = page?.url ?? start;
    const own = new Set([start.hostname, finalUrl.hostname]);
    const html = page ? new TextDecoder().decode(page.bytes) : "";
    for (const candidate of iconCandidates(html, finalUrl).slice(0, MAX_CANDIDATES)) {
      if (!own.has(candidate.hostname)) continue;
      const got = await guardedGet(candidate, ICON_MAX_BYTES, controller.signal, own, fetchFn, userAgent).catch(() => null);
      if (!got || got.over) continue;
      const contentType = sniffImage(got.bytes);
      if (contentType) return { bytes: got.bytes, contentType };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Storage and refresh ---------------------------------------------------

export interface IconRow {
  origin: string;
  fetchedAt: number;
  hasIcon: boolean;
}

/** The origin an HTTP monitor's icon belongs to; null for other types or a bad URL. */
export function iconOrigin(monitor: Pick<MonitorRecord, "type" | "config">): string | null {
  if (monitor.type !== "http") return null;
  try {
    const url = new URL((monitor.config as { url?: string }).url ?? "");
    return assertSafeUrl(url.href).ok ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Every monitor's icon state, for the lists. Empty (never throws) when the
 * table isn't there yet, as on an install a moment before its migration.
 */
export async function listIconRows(env: Env): Promise<Map<string, IconRow>> {
  try {
    const res = await env.DB.prepare(
      "SELECT monitor_id, origin, fetched_at, icon IS NOT NULL AS has_icon FROM monitor_icons",
    ).all<{ monitor_id: string; origin: string; fetched_at: number; has_icon: number }>();
    return new Map(
      (res.results ?? []).map((r) => [r.monitor_id, { origin: r.origin, fetchedAt: r.fetched_at, hasIcon: !!r.has_icon }]),
    );
  } catch {
    return new Map();
  }
}

export async function getIconRow(env: Env, id: string): Promise<IconRow | undefined> {
  try {
    const r = await env.DB.prepare(
      "SELECT origin, fetched_at, icon IS NOT NULL AS has_icon FROM monitor_icons WHERE monitor_id = ?",
    )
      .bind(id)
      .first<{ origin: string; fetched_at: number; has_icon: number }>();
    return r ? { origin: r.origin, fetchedAt: r.fetched_at, hasIcon: !!r.has_icon } : undefined;
  } catch {
    return undefined;
  }
}

/** The stored icon's bytes, for GET /api/monitors/:id/icon. */
export async function getIcon(env: Env, id: string): Promise<{ icon: ArrayBuffer; contentType: string } | null> {
  const r = await env.DB.prepare("SELECT icon, content_type FROM monitor_icons WHERE monitor_id = ? AND icon IS NOT NULL")
    .bind(id)
    .first<{ icon: ArrayBuffer | number[]; content_type: string | null }>();
  // D1 hands a BLOB back as an array of byte values (or an ArrayBuffer, by runtime).
  return r ? { icon: r.icon instanceof ArrayBuffer ? r.icon : (Uint8Array.from(r.icon).buffer as ArrayBuffer), contentType: r.content_type ?? "image/png" } : null;
}

/** When this monitor's stored icon was fetched (the cache-buster for its image URL), or null for none. */
export function iconAtFor(m: Pick<MonitorRecord, "type" | "config">, row: IconRow | undefined): number | null {
  return row?.hasIcon && row.origin === iconOrigin(m) ? row.fetchedAt : null;
}

/** Whether this monitor's icon should be fetched now: never tried, its address moved, or a week old. */
export function iconIsStale(monitor: Pick<MonitorRecord, "type" | "config">, row: IconRow | undefined, now: number): boolean {
  const origin = iconOrigin(monitor);
  if (!origin) return false;
  return !row || row.origin !== origin || now - row.fetchedAt >= ICON_REFRESH_MS;
}

/** Fetch and store one monitor's icon. The attempt is recorded first, so a slow or failing site is not retried for a week. */
export async function refreshMonitorIcon(
  env: Env,
  monitor: Pick<MonitorRecord, "id" | "type" | "config">,
  now: number = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const origin = iconOrigin(monitor);
  if (!origin) return;
  try {
    await env.DB.prepare(
      `INSERT INTO monitor_icons (monitor_id, origin, icon, content_type, fetched_at) VALUES (?1, ?2, NULL, NULL, ?3)
       ON CONFLICT(monitor_id) DO UPDATE SET
         fetched_at = excluded.fetched_at,
         icon = CASE WHEN monitor_icons.origin = excluded.origin THEN monitor_icons.icon ELSE NULL END,
         content_type = CASE WHEN monitor_icons.origin = excluded.origin THEN monitor_icons.content_type ELSE NULL END,
         origin = excluded.origin`,
    )
      .bind(monitor.id, origin, now)
      .run();
    const image = await fetchFavicon((monitor.config as { url: string }).url, fetchFn, checkerUserAgent(env));
    if (!image) return;
    await env.DB.prepare("UPDATE monitor_icons SET icon = ?1, content_type = ?2 WHERE monitor_id = ?3 AND origin = ?4")
      .bind(image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength), image.contentType, monitor.id, origin)
      .run();
  } catch (e) {
    // The monitor was deleted meanwhile, or the table isn't migrated yet: nothing to keep.
    console.warn("[favicon] could not store an icon", e instanceof Error ? e.message : e);
  }
}

/**
 * Refresh the stale icons among `monitors`, a few at a time, after the response
 * (`waitUntil`). Costs nothing when none is stale, which is almost always.
 */
export function refreshStaleIcons(
  env: Env,
  monitors: readonly MonitorRecord[],
  rows: ReadonlyMap<string, IconRow>,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  now: number = Date.now(),
): void {
  if (!waitUntil) return;
  const due = monitors.filter((m) => iconIsStale(m, rows.get(m.id), now)).slice(0, REFRESH_BATCH);
  if (due.length > 0) waitUntil(Promise.all(due.map((m) => refreshMonitorIcon(env, m, now))));
}
