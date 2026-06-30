/**
 * Pure, framework-free helpers powering the free OpenPing tools.
 *
 * Everything here is side-effect-free and unit-tested (see lib.test.ts) except
 * `dohLookup`, which performs a network request (its JSON parsing is split out
 * into the testable `parseDohJson`). luxon is used for all cron date/time math.
 */
import { DateTime } from "luxon";

/* ================================================================== *
 * Uptime / downtime math
 * ================================================================== */

export interface UptimePeriod {
  key: "day" | "week" | "month" | "year";
  label: string;
  seconds: number;
}

/**
 * Reference period lengths. Following the common SLA convention a "month" is 30
 * days and a "year" is 365 days, so the numbers line up with published uptime
 * tables (e.g. 99.9% ≈ 43m 12s/month).
 */
export const UPTIME_PERIODS: UptimePeriod[] = [
  { key: "day", label: "Per day", seconds: 24 * 60 * 60 },
  { key: "week", label: "Per week", seconds: 7 * 24 * 60 * 60 },
  { key: "month", label: "Per month (30d)", seconds: 30 * 24 * 60 * 60 },
  { key: "year", label: "Per year (365d)", seconds: 365 * 24 * 60 * 60 },
];

export interface AllowedDowntime extends UptimePeriod {
  /** Allowed downtime for the period, in seconds. */
  downtimeSeconds: number;
}

/** Allowed downtime per period for a given uptime percentage (0–100). */
export function allowedDowntime(uptimePct: number): AllowedDowntime[] {
  const frac = (100 - uptimePct) / 100;
  return UPTIME_PERIODS.map((p) => ({
    ...p,
    downtimeSeconds: frac * p.seconds,
  }));
}

/** Reverse mode: the uptime % that a given downtime over a period implies. */
export function uptimeFromDowntime(
  downtimeSeconds: number,
  periodSeconds: number,
): number {
  if (periodSeconds <= 0) return 0;
  const clamped = Math.min(Math.max(downtimeSeconds, 0), periodSeconds);
  return (1 - clamped / periodSeconds) * 100;
}

/** Human-readable downtime: "0.86 sec", "43 min 12 sec", "8 hr 45 min", "3 days 6 hr". */
export function formatDowntimeDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0 sec";
  if (totalSeconds < 60) {
    return `${parseFloat(totalSeconds.toFixed(2))} sec`;
  }
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days > 1 ? "s" : ""}`);
  if (hours) parts.push(`${hours} hr`);
  if (minutes) parts.push(`${minutes} min`);
  // Only bother with seconds at sub-day resolution to keep the string tidy.
  if (seconds && !days) parts.push(`${seconds} sec`);
  return parts.join(" ") || "0 sec";
}

/* ================================================================== *
 * IPv4 subnet math
 * ================================================================== */

export interface SubnetResult {
  cidr: string;
  prefix: number;
  networkAddress: string;
  broadcastAddress: string;
  netmask: string;
  wildcardMask: string;
  firstHost: string;
  lastHost: string;
  hostRange: string;
  totalHosts: number;
  usableHosts: number;
}

function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    throw new Error("An IPv4 address needs four octets, e.g. 192.168.1.0");
  }
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw new Error(`"${part || "(empty)"}" is not a valid octet (use 0–255)`);
    }
    const n = Number(part);
    if (n > 255) throw new Error(`Octet "${part}" is out of range (0–255)`);
    result = result * 256 + n;
  }
  return result >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Parse an IPv4 CIDR block (e.g. "192.168.1.0/24") into its derived values. */
export function parseCidr(input: string): SubnetResult {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a CIDR block, e.g. 192.168.1.0/24");

  const slash = trimmed.split("/");
  if (slash.length !== 2) {
    throw new Error('Use CIDR notation with a prefix, e.g. "192.168.1.0/24"');
  }
  const ipStr = slash[0]!;
  const prefixStr = slash[1]!;
  if (!/^\d+$/.test(prefixStr)) {
    throw new Error("The prefix after “/” must be a number from 0 to 32");
  }
  const prefix = Number(prefixStr);
  if (prefix > 32) throw new Error("The prefix must be between 0 and 32");

  const ipInt = ipToInt(ipStr);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const wildcard = (~mask) >>> 0;
  const broadcast = (network | wildcard) >>> 0;
  const totalHosts = 2 ** (32 - prefix);

  let firstHost: number;
  let lastHost: number;
  let usableHosts: number;
  if (prefix >= 31) {
    // /31 (RFC 3021 point-to-point) and /32 (single host) have no network/
    // broadcast reservation to subtract.
    firstHost = network;
    lastHost = broadcast;
    usableHosts = totalHosts;
  } else {
    firstHost = (network + 1) >>> 0;
    lastHost = (broadcast - 1) >>> 0;
    usableHosts = totalHosts - 2;
  }

  return {
    cidr: `${intToIp(network)}/${prefix}`,
    prefix,
    networkAddress: intToIp(network),
    broadcastAddress: intToIp(broadcast),
    netmask: intToIp(mask),
    wildcardMask: intToIp(wildcard),
    firstHost: intToIp(firstHost),
    lastHost: intToIp(lastHost),
    hostRange:
      firstHost === lastHost
        ? intToIp(firstHost)
        : `${intToIp(firstHost)} – ${intToIp(lastHost)}`,
    totalHosts,
    usableHosts,
  };
}

/* ================================================================== *
 * Cron parser (standard 5-field) + next-run computation
 * ================================================================== */

const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW_LABELS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** True when the day-of-month field is not "*". */
  domRestricted: boolean;
  /** True when the day-of-week field is not "*". */
  dowRestricted: boolean;
}

function nameOrNum(
  token: string,
  names: string[] | undefined,
  min: number,
  max: number,
  nameBase: number,
): number {
  let n: number;
  if (names && /^[a-z]+$/i.test(token)) {
    const idx = names.indexOf(token.toLowerCase());
    if (idx === -1) throw new Error(`unknown name "${token}"`);
    n = idx + nameBase;
  } else {
    if (!/^\d+$/.test(token)) throw new Error(`"${token || "(empty)"}" is not a valid value`);
    n = Number(token);
  }
  if (n < min || n > max) throw new Error(`value ${n} is out of range (${min}–${max})`);
  return n;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: string[],
  nameBase = 0,
): number[] {
  const result = new Set<number>();
  for (const seg of raw.split(",")) {
    if (seg === "") throw new Error("empty value in list");
    const slashParts = seg.split("/");
    if (slashParts.length > 2) throw new Error(`too many "/" in "${seg}"`);
    const rangeStr = slashParts[0]!;
    const stepStr = slashParts[1];

    let step = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr)) throw new Error(`step "/${stepStr}" must be a positive number`);
      step = Number(stepStr);
      if (step === 0) throw new Error("step cannot be zero");
    }

    let lo: number;
    let hi: number;
    if (rangeStr === "*") {
      lo = min;
      hi = max;
    } else if (rangeStr.includes("-")) {
      const rp = rangeStr.split("-");
      if (rp.length !== 2) throw new Error(`invalid range "${rangeStr}"`);
      lo = nameOrNum(rp[0]!, names, min, max, nameBase);
      hi = nameOrNum(rp[1]!, names, min, max, nameBase);
      if (lo > hi) throw new Error(`range "${rangeStr}" is backwards`);
    } else {
      lo = nameOrNum(rangeStr, names, min, max, nameBase);
      // "5/15" means "from 5 to the maximum, every 15".
      hi = stepStr !== undefined ? max : lo;
    }

    for (let v = lo; v <= hi; v += step) result.add(v);
  }
  return [...result].sort((a, b) => a - b);
}

function parseFieldNamed(
  fieldName: string,
  raw: string,
  min: number,
  max: number,
  names?: string[],
  nameBase = 0,
): number[] {
  try {
    return parseField(raw, min, max, names, nameBase);
  } catch (err) {
    throw new Error(`${fieldName} field ("${raw}"): ${(err as Error).message}`);
  }
}

/** Parse a 5-field cron expression. Throws an Error with a friendly message. */
export function parseCron(expr: string): CronFields {
  const trimmed = expr.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("Enter a cron expression, e.g. */5 * * * *");

  const fields = trimmed.split(" ");
  if (fields.length !== 5) {
    throw new Error(
      `A standard cron expression has 5 fields (got ${fields.length}). ` +
        "Format: minute hour day-of-month month day-of-week",
    );
  }
  const [minRaw, hourRaw, domRaw, monRaw, dowRaw] = fields as [
    string, string, string, string, string,
  ];

  const minute = parseFieldNamed("Minute", minRaw, 0, 59);
  const hour = parseFieldNamed("Hour", hourRaw, 0, 23);
  const dom = parseFieldNamed("Day-of-month", domRaw, 1, 31);
  const month = parseFieldNamed("Month", monRaw, 1, 12, MONTH_NAMES, 1);
  // Day-of-week allows 0–7 where both 0 and 7 mean Sunday; normalise 7 → 0.
  const dowRaw0to7 = parseFieldNamed("Day-of-week", dowRaw, 0, 7, DOW_NAMES, 0);
  const dow = [...new Set(dowRaw0to7.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: domRaw !== "*",
    dowRestricted: dowRaw !== "*",
  };
}

function dayMatches(f: CronFields, day: number, cronDow: number): boolean {
  const domOk = f.dom.includes(day);
  const dowOk = f.dow.includes(cronDow);
  // Vixie-cron semantics: when BOTH day fields are restricted, a match on
  // either one counts; otherwise only the restricted field applies.
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

/**
 * Compute the next `count` run times for a cron expression, in the given IANA
 * timezone, strictly after `from`. Uses coarse skipping (jump whole months/
 * days/hours that can't match) so even yearly schedules resolve quickly.
 */
export function nextCronRuns(
  expr: string,
  count: number,
  zone: string,
  from: DateTime = DateTime.now(),
): DateTime[] {
  const f = parseCron(expr);
  const out: DateTime[] = [];

  let dt = from.setZone(zone).set({ second: 0, millisecond: 0 }).plus({ minutes: 1 });
  let guard = 0;
  const MAX_ITERATIONS = 500_000;

  while (out.length < count && guard < MAX_ITERATIONS) {
    guard++;
    if (!dt.isValid) {
      dt = dt.plus({ minutes: 1 });
      continue;
    }
    if (!f.month.includes(dt.month)) {
      dt = dt.plus({ months: 1 }).set({ day: 1, hour: 0, minute: 0 });
      continue;
    }
    // luxon weekday is 1 (Mon) – 7 (Sun); cron uses 0 (Sun) – 6 (Sat).
    const cronDow = dt.weekday % 7;
    if (!dayMatches(f, dt.day, cronDow)) {
      dt = dt.plus({ days: 1 }).set({ hour: 0, minute: 0 });
      continue;
    }
    if (!f.hour.includes(dt.hour)) {
      dt = dt.plus({ hours: 1 }).set({ minute: 0 });
      continue;
    }
    if (!f.minute.includes(dt.minute)) {
      dt = dt.plus({ minutes: 1 });
      continue;
    }
    out.push(dt);
    dt = dt.plus({ minutes: 1 });
  }
  return out;
}

/* ---- Plain-English cron description ---- */

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** If values are an arithmetic series 0, n, 2n… covering the range, return n. */
function detectStepFromZero(values: number[], max: number): number | null {
  if (values.length < 3 || values[0] !== 0) return null;
  const step = values[1]! - values[0]!;
  if (step <= 1) return null;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! - values[i - 1]! !== step) return null;
  }
  if (values[values.length - 1]! + step <= max) return null;
  return step;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function describeTime(f: CronFields): string {
  const minuteAll = f.minute.length === 60;
  const hourAll = f.hour.length === 24;

  if (minuteAll && hourAll) return "Every minute";

  if (hourAll) {
    const step = detectStepFromZero(f.minute, 59);
    if (step) return `Every ${step} minutes`;
    const mins = joinList(f.minute.map((m) => pad2(m)));
    return `At minute ${mins} of every hour`;
  }

  if (minuteAll) {
    const step = detectStepFromZero(f.hour, 23);
    if (step) return `Every minute, every ${step} hours`;
    const hrs = joinList(f.hour.map((h) => `${pad2(h)}:00–${pad2(h)}:59`));
    return `Every minute during ${hrs}`;
  }

  // Specific minute(s) and hour(s): list explicit clock times when small.
  if (f.minute.length * f.hour.length <= 12) {
    const times: string[] = [];
    for (const h of f.hour) {
      for (const m of f.minute) times.push(`${pad2(h)}:${pad2(m)}`);
    }
    return `At ${joinList(times)}`;
  }
  return `At minute ${joinList(f.minute.map(pad2))} past hour ${joinList(f.hour.map(String))}`;
}

function describeDays(f: CronFields): string {
  const clauses: string[] = [];

  if (f.dowRestricted && f.dow.length < 7) {
    clauses.push(`on ${joinList(f.dow.map((d) => DOW_LABELS[d]!))}`);
  }
  if (f.domRestricted && f.dom.length < 31) {
    const ord = joinList(f.dom.map((d) => `day ${d}`));
    clauses.push(`on ${ord} of the month`);
  }

  let dayClause = "";
  if (clauses.length === 2) {
    // OR semantics when both are restricted.
    dayClause = ` ${clauses.join(" or ")}`;
  } else if (clauses.length === 1) {
    dayClause = ` ${clauses[0]}`;
  }

  let monthClause = "";
  if (f.month.length < 12) {
    monthClause = ` in ${joinList(f.month.map((m) => MONTH_LABELS[m - 1]!))}`;
  }

  return dayClause + monthClause;
}

/** A plain-English description of a cron expression. Throws on invalid input. */
export function describeCron(expr: string): string {
  const f = parseCron(expr);
  return `${describeTime(f)}${describeDays(f)}.`;
}

/* ================================================================== *
 * DNS-over-HTTPS (Google JSON API)
 * ================================================================== */

/** Record type → numeric code (the types the tools expose). */
export const DNS_TYPE_CODES: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
};

const CODE_TO_TYPE: Record<number, string> = Object.fromEntries(
  Object.entries(DNS_TYPE_CODES).map(([k, v]) => [v, k]),
);

/** Map a numeric RR type code to its mnemonic (falls back to the number). */
export function rrTypeName(code: number): string {
  return CODE_TO_TYPE[code] ?? String(code);
}

const DOH_STATUS: Record<number, string> = {
  0: "NOERROR",
  1: "FORMERR (malformed query)",
  2: "SERVFAIL (server failure)",
  3: "NXDOMAIN (no such domain)",
  4: "NOTIMP (not implemented)",
  5: "REFUSED",
};

export function dohStatusText(code: number): string {
  return DOH_STATUS[code] ?? `Status ${code}`;
}

export interface DohAnswer {
  name: string;
  type: string;
  ttl: number;
  data: string;
}

export interface DohResult {
  status: number;
  statusText: string;
  answers: DohAnswer[];
  comment?: string;
}

/** Parse a Google DNS-over-HTTPS JSON payload into a normalised result. */
export function parseDohJson(json: unknown): DohResult {
  const obj = (json ?? {}) as Record<string, unknown>;
  const status = typeof obj.Status === "number" ? obj.Status : -1;
  const rawAnswers = Array.isArray(obj.Answer) ? obj.Answer : [];
  const answers: DohAnswer[] = rawAnswers.map((a) => {
    const r = (a ?? {}) as Record<string, unknown>;
    return {
      name: String(r.name ?? ""),
      type: rrTypeName(Number(r.type)),
      ttl: Number(r.TTL ?? 0),
      data: String(r.data ?? ""),
    };
  });
  const comment = typeof obj.Comment === "string" ? obj.Comment : undefined;
  return { status, statusText: dohStatusText(status), answers, comment };
}

/**
 * Query DNS-over-HTTPS via Google's CORS-enabled JSON endpoint. Resolves with a
 * normalised {@link DohResult}; rejects (throws) only on network/HTTP failure.
 */
export async function dohLookup(name: string, type: string): Promise<DohResult> {
  const host = name.trim();
  if (!host) throw new Error("Enter a hostname to look up");
  const url = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${encodeURIComponent(type)}`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DNS query failed (HTTP ${res.status})`);
  return parseDohJson(await res.json());
}

/** Split an MX record's data ("10 mail.example.com.") into priority + host. */
export function parseMxData(data: string): { priority: number; exchange: string } {
  const tokens = data.trim().split(/\s+/);
  const priority = Number(tokens[0]);
  const exchange = tokens.slice(1).join(" ").replace(/\.$/, "");
  return {
    priority: Number.isFinite(priority) ? priority : 0,
    exchange: exchange || data.trim(),
  };
}
