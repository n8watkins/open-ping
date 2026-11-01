// Quoting values for the SQL the drills send with `wrangler d1 execute`.
// Pure, so the workerd tests can import it. Every value the drills put in SQL
// is generated or checked first; quoting is the second line.

export function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("a SQL number must be finite");
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

export const sqlList = (values) => `(${values.map(sqlValue).join(", ")})`;
