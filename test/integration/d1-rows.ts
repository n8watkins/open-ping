/** Rows read and written, as D1 bills them (each result's meta). */
export interface Rows {
  read: number;
  written: number;
}

/**
 * A D1 binding that adds up the rows every query read and wrote into `rows`.
 * `first()` and `raw()` don't report rows, so they pass through uncounted; the
 * write path uses batches, `run()` and `all()`.
 */
export function rowsD1(db: D1Database, rows: Rows): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const add = <T>(result: T): T => {
    for (const r of Array.isArray(result) ? result : [result]) {
      const meta = (r as { meta?: { rows_read?: number; rows_written?: number } } | null)?.meta;
      rows.read += meta?.rows_read ?? 0;
      rows.written += meta?.rows_written ?? 0;
    }
    return result;
  };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (prop === "run" || prop === "all") {
          const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
          return async (...args: unknown[]) => add(await fn.apply(target, args));
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query));
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) =>
          add(await target.batch(statements.map((s) => real.get(s) ?? s)));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
