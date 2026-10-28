/**
 * SQL for "this column is one of these values" that binds a single parameter,
 * however many values there are. D1 allows at most 100 bound parameters in one
 * statement (developers.cloudflare.com/d1/platform/limits/), so an
 * `IN (?, ?, ...)` with one `?` per value fails once a list passes that: a
 * status page with more than 100 monitors, or a feed of more than 100
 * incidents. Instead the values travel as one JSON array and SQLite unpacks it
 * with `json_each`:
 *
 *   db.prepare(`SELECT ... WHERE id ${IN_JSON_LIST}`).bind(jsonList(ids))
 *
 * An empty list matches nothing (and is valid SQL, unlike `IN ()`).
 */
export const IN_JSON_LIST = "IN (SELECT value FROM json_each(?))";

/** The single parameter for {@link IN_JSON_LIST}. */
export function jsonList(values: readonly (string | number)[]): string {
  return JSON.stringify(values);
}
