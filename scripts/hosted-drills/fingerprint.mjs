// What the restore drill compares before and after (docs/hosted/LAUNCH_DRILLS.md):
// a fingerprint of a tenant's database made of
//
//   - every table's row count;
//   - a SHA-256 of every row of the key tables, in primary key order;
//   - a SHA-256 of every encrypted value in them, decrypted with the tenant's
//     MASTER_KEY: monitor configs, encrypted settings, channel credentials.
//
// Two fingerprints are equal only if the restored database holds the same
// rows and the escrowed key still opens every sealed value, which is what a
// restore must prove. Plaintexts are hashed in memory and never kept.
//
// Pure: the SQL it asks for and the arithmetic on the answers, so
// restore.test.mjs runs it against real SQLite.

import { sqlValue } from "./sql.mjs";
import { decryptValue, parseCiphertext } from "./keys.mjs";

/**
 * The tables whose every row is compared: the customer's configuration and
 * history. Volatile operational tables (sessions, rate limits, locks, the
 * outbox, samples and summaries) are compared by count only.
 */
export const KEY_TABLES = [
  "d1_migrations",
  "monitors",
  "monitor_state",
  "incidents",
  "incident_updates",
  "maintenance_windows",
  "notification_channels",
  "settings",
  "categories",
  "status_pages",
  "passkeys",
  "api_tokens",
  "push_subscriptions",
];

/** The tables a tenant keeps after a scheduled run without changing: compared after the restored tenant runs again. */
export const STABLE_TABLES = ["d1_migrations", "monitors", "notification_channels", "settings", "categories", "status_pages", "passkeys", "api_tokens"];

/** Every table of the database except SQLite's and D1's own. */
export const TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_kv' ORDER BY name";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (name) => {
  if (!NAME.test(name)) throw new Error(`unexpected table name ${JSON.stringify(name)}`);
  return `"${name}"`;
};

/** One statement per table: its count. */
export function countsSql(tables) {
  return tables.map((t) => `SELECT ${sqlValue(t)} AS name, COUNT(*) AS n FROM ${ident(t)}`).join("; ");
}

/** One `PRAGMA table_info` per table (D1 allows the statement form), for their primary keys. */
export function tableInfoSql(tables) {
  return tables.map((t) => `PRAGMA table_info(${ident(t)})`).join("; ");
}

/** A table's primary key columns, in key order, from its `PRAGMA table_info` rows. */
export function primaryKeyOf(infoRows) {
  return infoRows
    .filter((c) => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((c) => c.name);
}

/** A page of a table's rows in primary key order (rowid when it has none). */
export function rowsSql(table, primaryKey, { limit, offset }) {
  const order = primaryKey.length ? primaryKey.map(ident).join(", ") : "rowid";
  return `SELECT * FROM ${ident(table)} ORDER BY ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
}

/** Every sealed value inside a cell: the cell itself, or ciphertexts inside its JSON. */
export function ciphertextsIn(value, found = []) {
  if (typeof value === "string") {
    if (parseCiphertext(value)) found.push(value);
    else if (/^\s*[[{]/.test(value)) {
      try {
        ciphertextsIn(JSON.parse(value), found);
      } catch {
        // Not JSON: plain text.
      }
    }
  } else if (Array.isArray(value)) for (const v of value) ciphertextsIn(v, found);
  else if (value && typeof value === "object") for (const v of Object.values(value)) ciphertextsIn(v, found);
  return found;
}

/** A canonical form of a row: its columns sorted by name. */
export function canonicalRow(row) {
  return JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));
}

/**
 * The fingerprint of one key table from its rows in key order. Each
 * ciphertext is decrypted with `masterKey` and hashed; one that doesn't open
 * is counted as such, and fails the drill.
 */
export async function tableFingerprint(rows, { masterKey, sha256Hex }) {
  const rowHashes = [];
  const plainHashes = [];
  const kids = new Set();
  let undecryptable = 0;
  for (const row of rows) {
    rowHashes.push(await sha256Hex(canonicalRow(row)));
    for (const ct of ciphertextsIn(Object.values(row))) {
      const parsed = parseCiphertext(ct);
      if (parsed?.version === "v2") kids.add(parsed.kid);
      try {
        plainHashes.push(await sha256Hex(await decryptValue(masterKey, ct)));
      } catch {
        undecryptable++;
      }
    }
  }
  return {
    rows: rows.length,
    rowsSha256: await sha256Hex(rowHashes.join("\n")),
    encrypted: plainHashes.length + undecryptable,
    decrypted: plainHashes.length,
    undecryptable,
    decryptedSha256: await sha256Hex(plainHashes.join("\n")),
    kids: [...kids].sort(),
  };
}

/** What differs between two fingerprints, as sentences; [] when they match. */
export function compareFingerprints(before, after, { tables = null } = {}) {
  const problems = [];
  const counts = (fp) => fp.counts ?? {};
  const names = tables ?? [...new Set([...Object.keys(counts(before)), ...Object.keys(counts(after))])].sort();
  for (const t of names) {
    if (counts(before)[t] !== counts(after)[t]) problems.push(`${t}: ${counts(before)[t] ?? "no table"} rows before, ${counts(after)[t] ?? "no table"} after`);
  }
  const keyNames = tables ?? [...new Set([...Object.keys(before.tables ?? {}), ...Object.keys(after.tables ?? {})])].sort();
  for (const t of keyNames) {
    const a = before.tables?.[t];
    const b = after.tables?.[t];
    if (!a && !b) continue;
    if (!a || !b) {
      problems.push(`${t}: only ${a ? "before" : "after"} has it`);
      continue;
    }
    if (a.rowsSha256 !== b.rowsSha256) problems.push(`${t}: the rows differ`);
    if (a.decryptedSha256 !== b.decryptedSha256 || a.decrypted !== b.decrypted) problems.push(`${t}: the decrypted values differ (${a.decrypted} before, ${b.decrypted} after)`);
    if (b.undecryptable) problems.push(`${t}: ${b.undecryptable} encrypted values don't open with the escrowed key`);
  }
  return problems;
}

/** Totals over the key tables, for the report and the "nothing to prove" check. */
export function fingerprintTotals(fp) {
  let encrypted = 0;
  let decrypted = 0;
  let undecryptable = 0;
  const kids = new Set();
  for (const t of Object.values(fp.tables ?? {})) {
    encrypted += t.encrypted;
    decrypted += t.decrypted;
    undecryptable += t.undecryptable;
    for (const k of t.kids) kids.add(k);
  }
  return { encrypted, decrypted, undecryptable, kids: [...kids].sort() };
}
