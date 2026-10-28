/**
 * Importing the Hosted waitlist into the platform, so it becomes the launch
 * list (build plan, D5).
 *
 * The list lives on the canonical self-hosted install (openping.n8builds.dev)
 * in its `waitlist` table (OpenPing migration 0010). Its owner downloads it
 * from Settings > Reports ("Download CSV", GET /api/waitlist/export.csv:
 * `email,joined_at` with ISO times) and uploads the file here. The platform
 * never calls the install: no credentials for it live on the platform, and
 * the import is a deliberate act by the owner, repeatable at any time.
 *
 * Also accepted, for a hand-made list: the JSON of GET /api/waitlist
 * (`{ entries: [{ email, created_at }] }`), a JSON array of such objects or
 * of plain addresses, or a CSV with only an email column.
 */

import { normalizeEmail } from "../accounts";

/** Bigger than any plausible waitlist export; refused before parsing. */
export const WAITLIST_MAX_BYTES = 1_000_000;
/** Entries in one import. A longer list is split into several files. */
export const WAITLIST_MAX_ENTRIES = 5_000;
/** Bound parameters per statement are capped at 100 by D1: 2 per row. */
const ROWS_PER_STATEMENT = 50;
/** Statements per batch. */
const STATEMENTS_PER_BATCH = 20;

export interface WaitlistEntry {
  email: string;
  joinedAt: number | null;
}

export interface ParsedWaitlist {
  entries: WaitlistEntry[];
  /** Lines (1-based) or JSON items that held no usable address, with what they held, cut short. */
  invalid: { where: string; text: string }[];
  /** Addresses that appeared more than once in the file. */
  duplicates: number;
}

export type WaitlistParseResult = { ok: true; list: ParsedWaitlist } | { ok: false; message: string };

/** One CSV line into fields: commas, double quotes and "" inside quotes (RFC 4180, the export's csvField). */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** An ISO time, or epoch milliseconds as a number or digits; null when it is neither or implausible. */
export function parseJoinedAt(value: unknown): number | null {
  let ms: number;
  if (typeof value === "number") ms = value;
  else if (typeof value === "string" && /^\d{10,16}$/.test(value.trim())) ms = Number(value.trim());
  else if (typeof value === "string" && value.trim()) ms = Date.parse(value.trim());
  else return null;
  // From the year 2020 to a day from now: anything else is a typo or a unit mistake.
  return Number.isSafeInteger(ms) && ms >= 1_577_836_800_000 && ms <= Date.now() + 86_400_000 ? ms : null;
}

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

function collect(items: { where: string; raw: string; email: unknown; joinedAt: unknown }[]): ParsedWaitlist {
  const byEmail = new Map<string, WaitlistEntry>();
  const invalid: ParsedWaitlist["invalid"] = [];
  let duplicates = 0;
  for (const item of items) {
    const email = normalizeEmail(item.email);
    if (!email) {
      invalid.push({ where: item.where, text: short(item.raw) });
      continue;
    }
    const joinedAt = parseJoinedAt(item.joinedAt);
    const seen = byEmail.get(email);
    if (seen) {
      duplicates++;
      // The earliest join wins: that is when they really joined.
      if (joinedAt !== null && (seen.joinedAt === null || joinedAt < seen.joinedAt)) seen.joinedAt = joinedAt;
      continue;
    }
    byEmail.set(email, { email, joinedAt });
  }
  return { entries: [...byEmail.values()], invalid, duplicates };
}

function parseJson(text: string): WaitlistParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "That file looks like JSON but doesn't parse. Upload the CSV from Settings > Reports instead." };
  }
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? (value as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(list)) return { ok: false, message: "That JSON has no list of entries. Expected an array, or an object with an entries array." };
  const items = list.map((item: unknown, i) => {
    const where = `item ${i + 1}`;
    if (typeof item === "string") return { where, raw: item, email: item, joinedAt: null };
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return { where, raw: JSON.stringify(item) ?? "", email: o.email, joinedAt: o.created_at ?? o.joined_at ?? o.joinedAt ?? null };
  });
  return { ok: true, list: collect(items) };
}

function parseCsv(text: string): WaitlistParseResult {
  const lines = text.split(/\r\n|\n|\r/);
  let emailColumn = 0;
  let joinedColumn: number | null = 1;
  let start = 0;
  const header = csvFields(lines[0] ?? "").map((f) => f.toLowerCase());
  if (header.includes("email")) {
    emailColumn = header.indexOf("email");
    const joined = header.findIndex((f) => f === "joined_at" || f === "created_at" || f === "joined");
    joinedColumn = joined >= 0 ? joined : null;
    start = 1;
  }
  const items: { where: string; raw: string; email: unknown; joinedAt: unknown }[] = [];
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const fields = csvFields(raw);
    items.push({ where: `line ${i + 1}`, raw, email: fields[emailColumn], joinedAt: joinedColumn === null ? null : fields[joinedColumn] });
  }
  return { ok: true, list: collect(items) };
}

/** Reads an export (CSV or JSON). Refuses an empty or oversized one with a message for the page. */
export function parseWaitlistExport(text: string): WaitlistParseResult {
  if (new TextEncoder().encode(text).length > WAITLIST_MAX_BYTES) {
    return { ok: false, message: `That file is over ${WAITLIST_MAX_BYTES / 1_000_000} MB. Split it into smaller files and import each.` };
  }
  const body = text.replace(/^\uFEFF/, "").trim();
  if (!body) return { ok: false, message: "That file is empty. Download the CSV from Settings > Reports on the canonical install." };
  const result = body.startsWith("[") || body.startsWith("{") ? parseJson(body) : parseCsv(body);
  if (result.ok && result.list.entries.length > WAITLIST_MAX_ENTRIES) {
    return { ok: false, message: `That file has ${result.list.entries.length} addresses; one import takes up to ${WAITLIST_MAX_ENTRIES}. Split it and import each part.` };
  }
  if (result.ok && result.list.entries.length === 0) {
    return { ok: false, message: "No email addresses were found in that file." };
  }
  return result;
}

/**
 * Adds the entries that aren't on the platform's list yet. An address that is
 * already there keeps its row, except that an earlier join time from the
 * file replaces a later or missing one, so importing the same export twice
 * changes nothing. Answers how many were new.
 */
export async function importWaitlist(db: D1Database, entries: WaitlistEntry[], now: number): Promise<{ added: number; existing: number }> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < entries.length; i += ROWS_PER_STATEMENT) {
    const chunk = entries.slice(i, i + ROWS_PER_STATEMENT);
    const values = chunk.map(() => `(?, ?, ${Math.trunc(now)})`).join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO waitlist_entries (email, joined_at, imported_at) VALUES ${values}
           ON CONFLICT(email) DO UPDATE SET joined_at = excluded.joined_at
           WHERE excluded.joined_at IS NOT NULL AND (waitlist_entries.joined_at IS NULL OR excluded.joined_at < waitlist_entries.joined_at)`,
        )
        .bind(...chunk.flatMap((e) => [e.email, e.joinedAt])),
    );
  }
  const before = await waitlistCount(db);
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
  }
  const added = (await waitlistCount(db)) - before;
  return { added, existing: entries.length - added };
}

async function waitlistCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM waitlist_entries").first<{ n: number }>())?.n ?? 0;
}

export interface WaitlistSummary {
  total: number;
  withAccount: number;
  lastImportAt: number | null;
  latest: { email: string; joinedAt: number | null; importedAt: number; hasAccount: boolean }[];
}

export async function waitlistSummary(db: D1Database, limit = 50): Promise<WaitlistSummary> {
  const [totals, latest] = await db.batch<unknown>([
    db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(a.id IS NOT NULL), 0) AS with_account, MAX(w.imported_at) AS last_import
       FROM waitlist_entries w LEFT JOIN accounts a ON a.email = w.email`,
    ),
    db
      .prepare(
        `SELECT w.email, w.joined_at, w.imported_at, a.id IS NOT NULL AS has_account
         FROM waitlist_entries w LEFT JOIN accounts a ON a.email = w.email
         ORDER BY COALESCE(w.joined_at, w.imported_at) DESC, w.email LIMIT ?`,
      )
      .bind(limit),
  ]);
  const t = totals!.results[0] as { total: number; with_account: number; last_import: number | null } | undefined;
  return {
    total: t?.total ?? 0,
    withAccount: t?.with_account ?? 0,
    lastImportAt: t?.last_import ?? null,
    latest: (latest!.results as { email: string; joined_at: number | null; imported_at: number; has_account: number }[]).map((r) => ({
      email: r.email,
      joinedAt: r.joined_at,
      importedAt: r.imported_at,
      hasAccount: r.has_account === 1,
    })),
  };
}
