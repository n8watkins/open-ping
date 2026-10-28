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
/** Statements per batch (an even number: they come in pairs). */
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

export interface CsvRecord {
  /** The 1-based line the record starts on. */
  line: number;
  /** The record as it appeared, quotes and all. */
  raw: string;
  fields: string[];
}

/**
 * A whole CSV text into records (RFC 4180, as the export's csvField writes
 * it): commas, double quotes, "" inside quotes, and line breaks inside quotes
 * kept in the field. An unclosed quote runs to the end of the text.
 */
export function csvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let start = 0;
  const end = (i: number) => {
    fields.push(field);
    records.push({ line: startLine, raw: text.slice(start, i), fields: fields.map((f) => f.trim()) });
    fields = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      end(i);
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      startLine = line;
      start = i + 1;
    } else field += ch;
  }
  if (start < text.length) end(text.length);
  return records;
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
  const records = csvRecords(text).filter((rec) => rec.raw.trim());
  let emailColumn = 0;
  let joinedColumn: number | null = 1;
  let first = 0;
  const header = (records[0]?.fields ?? []).map((f) => f.toLowerCase());
  if (header.includes("email")) {
    emailColumn = header.indexOf("email");
    const joined = header.findIndex((f) => f === "joined_at" || f === "created_at" || f === "joined");
    joinedColumn = joined >= 0 ? joined : null;
    first = 1;
  }
  const items = records.slice(first).map((rec) => ({
    where: `line ${rec.line}`,
    raw: rec.raw,
    email: rec.fields[emailColumn],
    joinedAt: joinedColumn === null ? null : rec.fields[joinedColumn],
  }));
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
 * changes nothing. `added` comes from the inserts themselves, so it stays
 * right even when two imports run at once.
 */
export async function importWaitlist(db: D1Database, entries: WaitlistEntry[], now: number): Promise<{ added: number; existing: number }> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < entries.length; i += ROWS_PER_STATEMENT) {
    const chunk = entries.slice(i, i + ROWS_PER_STATEMENT);
    const values = chunk.map(() => `(?, ?, ${Math.trunc(now)})`).join(", ");
    const binds = chunk.flatMap((e) => [e.email, e.joinedAt]);
    // In pairs: the insert (whose changes are the new rows), then the earlier join times for the rest.
    statements.push(
      db.prepare(`INSERT INTO waitlist_entries (email, joined_at, imported_at) VALUES ${values} ON CONFLICT(email) DO NOTHING`).bind(...binds),
      db
        .prepare(
          `INSERT INTO waitlist_entries (email, joined_at, imported_at) VALUES ${values}
           ON CONFLICT(email) DO UPDATE SET joined_at = excluded.joined_at
           WHERE excluded.joined_at IS NOT NULL AND (waitlist_entries.joined_at IS NULL OR excluded.joined_at < waitlist_entries.joined_at)`,
        )
        .bind(...binds),
    );
  }
  let added = 0;
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    const results = await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
    results.forEach((result, j) => {
      if ((i + j) % 2 === 0) added += result.meta.changes ?? 0;
    });
  }
  return { added, existing: entries.length - added };
}

/**
 * Reads a request body, refusing it (null) as soon as it passes `maxBytes`,
 * so an oversized upload is never held in memory whole.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
