import { describe, it, expect } from "vitest";
import { evaluateAssertions, resolveJsonPath } from "./assertions";
import type { Assertion } from "../../shared/schemas";

describe("resolveJsonPath", () => {
  const root = {
    data: {
      items: [
        { name: "alpha", tags: ["x", "y"] },
        { name: "beta" },
      ],
      count: 2,
      active: true,
    },
    list: [10, 20, 30],
  };

  it("resolves nested object properties via dot notation", () => {
    expect(resolveJsonPath(root, "data.count")).toBe(2);
    expect(resolveJsonPath(root, "data.active")).toBe(true);
  });

  it("resolves array indices via bracket notation", () => {
    expect(resolveJsonPath(root, "list[1]")).toBe(20);
    expect(resolveJsonPath(root, "data.items[0].name")).toBe("alpha");
    expect(resolveJsonPath(root, "data.items[1].name")).toBe("beta");
    expect(resolveJsonPath(root, "data.items[0].tags[1]")).toBe("y");
  });

  it("resolves a leading bracket index against an array root", () => {
    expect(resolveJsonPath([{ x: 7 }], "[0].x")).toBe(7);
  });

  it("returns undefined for missing paths without throwing", () => {
    expect(resolveJsonPath(root, "data.missing")).toBeUndefined();
    expect(resolveJsonPath(root, "data.items[5].name")).toBeUndefined();
    expect(resolveJsonPath(root, "list[0].nope")).toBeUndefined();
    expect(resolveJsonPath(root, "data.count[0]")).toBeUndefined();
    expect(resolveJsonPath(null, "a.b")).toBeUndefined();
  });
});

describe("evaluateAssertions", () => {
  it("passes for an empty assertion list", () => {
    const result = evaluateAssertions([], { body: "anything" });
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  describe("contains", () => {
    it("passes when the substring is present", () => {
      const a: Assertion[] = [
        { kind: "contains", value: "Hello", caseSensitive: true },
      ];
      expect(evaluateAssertions(a, { body: "Hello world" }).passed).toBe(true);
    });

    it("respects caseSensitive=false", () => {
      const a: Assertion[] = [
        { kind: "contains", value: "HELLO", caseSensitive: false },
      ];
      expect(evaluateAssertions(a, { body: "hello world" }).passed).toBe(true);
    });

    it("fails when the substring is absent", () => {
      const a: Assertion[] = [
        { kind: "contains", value: "missing", caseSensitive: true },
      ];
      const result = evaluateAssertions(a, { body: "hello world" });
      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
    });

    it("fails when case does not match and caseSensitive=true", () => {
      const a: Assertion[] = [
        { kind: "contains", value: "HELLO", caseSensitive: true },
      ];
      expect(evaluateAssertions(a, { body: "hello" }).passed).toBe(false);
    });
  });

  describe("not_contains", () => {
    it("passes when the substring is absent", () => {
      const a: Assertion[] = [
        { kind: "not_contains", value: "error", caseSensitive: true },
      ];
      expect(evaluateAssertions(a, { body: "all good" }).passed).toBe(true);
    });

    it("fails (case-insensitive) when the substring is present", () => {
      const a: Assertion[] = [
        { kind: "not_contains", value: "ERROR", caseSensitive: false },
      ];
      expect(evaluateAssertions(a, { body: "an error occurred" }).passed).toBe(
        false,
      );
    });
  });

  describe("not_empty", () => {
    it("passes for non-whitespace content", () => {
      const a: Assertion[] = [{ kind: "not_empty" }];
      expect(evaluateAssertions(a, { body: "  x  " }).passed).toBe(true);
    });

    it("fails for empty / whitespace-only content", () => {
      const a: Assertion[] = [{ kind: "not_empty" }];
      expect(evaluateAssertions(a, { body: "   \n\t " }).passed).toBe(false);
    });
  });

  describe("is_json", () => {
    it("passes for valid JSON", () => {
      const a: Assertion[] = [{ kind: "is_json" }];
      expect(evaluateAssertions(a, { body: '{"a":1}' }).passed).toBe(true);
    });

    it("fails for invalid JSON", () => {
      const a: Assertion[] = [{ kind: "is_json" }];
      expect(evaluateAssertions(a, { body: "not json" }).passed).toBe(false);
    });
  });

  describe("json_path_exists", () => {
    it("passes when the path resolves", () => {
      const a: Assertion[] = [
        { kind: "json_path_exists", path: "data.items[0].name" },
      ];
      const body = JSON.stringify({ data: { items: [{ name: "alpha" }] } });
      expect(evaluateAssertions(a, { body }).passed).toBe(true);
    });

    it("fails when the path is missing", () => {
      const a: Assertion[] = [
        { kind: "json_path_exists", path: "data.items[3].name" },
      ];
      const body = JSON.stringify({ data: { items: [{ name: "alpha" }] } });
      expect(evaluateAssertions(a, { body }).passed).toBe(false);
    });
  });

  describe("json_path_equals", () => {
    it("passes when the stringified value matches", () => {
      const a: Assertion[] = [
        { kind: "json_path_equals", path: "data.count", value: "2" },
      ];
      const body = JSON.stringify({ data: { count: 2 } });
      expect(evaluateAssertions(a, { body }).passed).toBe(true);
    });

    it("coerces booleans via String()", () => {
      const a: Assertion[] = [
        { kind: "json_path_equals", path: "ok", value: "true" },
      ];
      expect(evaluateAssertions(a, { body: '{"ok":true}' }).passed).toBe(true);
    });

    it("fails when the value differs", () => {
      const a: Assertion[] = [
        { kind: "json_path_equals", path: "data.count", value: "3" },
      ];
      const body = JSON.stringify({ data: { count: 2 } });
      expect(evaluateAssertions(a, { body }).passed).toBe(false);
    });
  });

  describe("json_path_contains", () => {
    it("passes for a substring of a string value", () => {
      const a: Assertion[] = [
        { kind: "json_path_contains", path: "msg", value: "ell" },
      ];
      expect(evaluateAssertions(a, { body: '{"msg":"hello"}' }).passed).toBe(
        true,
      );
    });

    it("passes against the JSON-stringified form of an array value", () => {
      const a: Assertion[] = [
        { kind: "json_path_contains", path: "tags", value: '"y"' },
      ];
      expect(
        evaluateAssertions(a, { body: '{"tags":["x","y"]}' }).passed,
      ).toBe(true);
    });

    it("fails when the substring is not present", () => {
      const a: Assertion[] = [
        { kind: "json_path_contains", path: "msg", value: "zzz" },
      ];
      expect(evaluateAssertions(a, { body: '{"msg":"hello"}' }).passed).toBe(
        false,
      );
    });
  });

  it("fails gracefully (no throw) when a json_path assertion runs on invalid JSON", () => {
    const a: Assertion[] = [
      { kind: "json_path_exists", path: "data.x" },
      { kind: "json_path_equals", path: "data.x", value: "1" },
      { kind: "json_path_contains", path: "data.x", value: "1" },
    ];
    let result!: ReturnType<typeof evaluateAssertions>;
    expect(() => {
      result = evaluateAssertions(a, { body: "<html>not json</html>" });
    }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(3);
    for (const message of result.failures) {
      expect(message).toContain("not valid JSON");
    }
  });

  it("aggregates failures across multiple assertions", () => {
    const a: Assertion[] = [
      { kind: "contains", value: "yes", caseSensitive: true },
      { kind: "not_empty" },
      { kind: "is_json" },
    ];
    const result = evaluateAssertions(a, { body: "no" });
    expect(result.passed).toBe(false);
    // contains fails + is_json fails; not_empty passes.
    expect(result.failures).toHaveLength(2);
  });
});
