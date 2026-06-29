import type { Assertion } from "../../shared/schemas";

/**
 * Content / JSON response assertion engine (PRD §6.2).
 *
 * Pure, dependency-free, and I/O-free so it runs identically in Cloudflare
 * Workers and Node (vitest). Given a list of assertions and a response context
 * it returns whether every assertion passed plus human-readable failure
 * messages (which intentionally never echo secrets — only configured values).
 */

export interface AssertionResult {
  /** True when every assertion passed (vacuously true for an empty list). */
  passed: boolean;
  /** One human-readable message per failed assertion. */
  failures: string[];
}

/**
 * Resolve a value from a parsed JSON structure using a minimal JSON-path
 * syntax supporting dot and bracket notation:
 *
 *   "a.b"               -> root.a.b
 *   "data.items[0].name" -> root.data.items[0].name
 *   "[0].x"             -> root[0].x
 *   "results[2]"        -> root.results[2]
 *
 * Property names are read from objects; `[n]` indices are read from arrays.
 * Any missing/mismatched step (e.g. indexing a non-array, reading a key off a
 * primitive, or a key that does not exist) resolves to `undefined` rather than
 * throwing.
 */
export function resolveJsonPath(root: unknown, path: string): unknown {
  let current: unknown = root;

  for (const segment of path.split(".")) {
    if (segment === "") continue; // tolerate leading/trailing/empty segments

    // A segment is a property name optionally followed by `[n]` indices, or it
    // may be purely bracket indices (e.g. "[0]" or "[0][1]").
    const tokenRe = /([^[\]]+)|\[(\d+)\]/g;
    let match: RegExpExecArray | null;

    while ((match = tokenRe.exec(segment)) !== null) {
      if (current === undefined || current === null) return undefined;

      if (match[1] !== undefined) {
        // Property access.
        if (typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[match[1]];
      } else if (match[2] !== undefined) {
        // Array index access.
        if (!Array.isArray(current)) return undefined;
        current = current[Number(match[2])];
      }
    }
  }

  return current;
}

/**
 * Evaluate every assertion against the response context. An empty list passes.
 */
export function evaluateAssertions(
  assertions: Assertion[],
  ctx: { body: string; statusCode?: number },
): AssertionResult {
  const failures: string[] = [];

  // Parse the body as JSON at most once, shared across all json_* assertions.
  let parsed: { ok: true; value: unknown } | { ok: false } | undefined;
  const getJson = (): { ok: true; value: unknown } | { ok: false } => {
    if (parsed === undefined) {
      try {
        parsed = { ok: true, value: JSON.parse(ctx.body) };
      } catch {
        parsed = { ok: false };
      }
    }
    return parsed;
  };

  const stringify = (value: unknown): string =>
    typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value);

  for (const assertion of assertions) {
    switch (assertion.kind) {
      case "contains": {
        const haystack = assertion.caseSensitive
          ? ctx.body
          : ctx.body.toLowerCase();
        const needle = assertion.caseSensitive
          ? assertion.value
          : assertion.value.toLowerCase();
        if (!haystack.includes(needle)) {
          failures.push(
            `Expected body to contain "${assertion.value}"${
              assertion.caseSensitive ? "" : " (case-insensitive)"
            }`,
          );
        }
        break;
      }

      case "not_contains": {
        const haystack = assertion.caseSensitive
          ? ctx.body
          : ctx.body.toLowerCase();
        const needle = assertion.caseSensitive
          ? assertion.value
          : assertion.value.toLowerCase();
        if (haystack.includes(needle)) {
          failures.push(
            `Expected body to not contain "${assertion.value}"${
              assertion.caseSensitive ? "" : " (case-insensitive)"
            }`,
          );
        }
        break;
      }

      case "not_empty": {
        if (ctx.body.trim().length === 0) {
          failures.push("Expected body to not be empty");
        }
        break;
      }

      case "is_json": {
        if (!getJson().ok) {
          failures.push("Expected body to be valid JSON");
        }
        break;
      }

      case "json_path_exists": {
        const json = getJson();
        if (!json.ok) {
          failures.push(
            `Cannot evaluate JSON path "${assertion.path}": body is not valid JSON`,
          );
          break;
        }
        if (resolveJsonPath(json.value, assertion.path) === undefined) {
          failures.push(`Expected JSON path "${assertion.path}" to exist`);
        }
        break;
      }

      case "json_path_equals": {
        const json = getJson();
        if (!json.ok) {
          failures.push(
            `Cannot evaluate JSON path "${assertion.path}": body is not valid JSON`,
          );
          break;
        }
        const resolved = resolveJsonPath(json.value, assertion.path);
        if (resolved === undefined) {
          failures.push(
            `Expected JSON path "${assertion.path}" to equal "${assertion.value}" but the path was missing`,
          );
        } else if (String(resolved) !== assertion.value) {
          failures.push(
            `Expected JSON path "${assertion.path}" to equal "${assertion.value}" but got "${String(resolved)}"`,
          );
        }
        break;
      }

      case "json_path_contains": {
        const json = getJson();
        if (!json.ok) {
          failures.push(
            `Cannot evaluate JSON path "${assertion.path}": body is not valid JSON`,
          );
          break;
        }
        const resolved = resolveJsonPath(json.value, assertion.path);
        if (resolved === undefined) {
          failures.push(
            `Expected JSON path "${assertion.path}" to contain "${assertion.value}" but the path was missing`,
          );
        } else if (!stringify(resolved).includes(assertion.value)) {
          failures.push(
            `Expected JSON path "${assertion.path}" value to contain "${assertion.value}"`,
          );
        }
        break;
      }
    }
  }

  return { passed: failures.length === 0, failures };
}
