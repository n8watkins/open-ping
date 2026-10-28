import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProdConfig, parseJsonc } from "./prod-config.mjs";

const ID = "11111111-2222-3333-4444-555555555555";
const template = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));

describe("parseJsonc", () => {
  it("drops comments and trailing commas but keeps them inside strings", () => {
    const text = '{\n  // note\n  "a": "x // y /* z */", /* block */\n  "b": [1, 2,],\n}';
    expect(parseJsonc(text)).toEqual({ a: "x // y /* z */", b: [1, 2] });
  });

  it("keeps commas before a bracket inside strings", () => {
    expect(parseJsonc('{"a": "x,}", "b": "y, ]",}')).toEqual({ a: "x,}", b: "y, ]" });
  });

  it("drops a trailing comma followed by a comment", () => {
    expect(parseJsonc('{"a": 1, // last\n}')).toEqual({ a: 1 });
  });

  it("keeps escaped quotes inside strings", () => {
    expect(parseJsonc('{"a": "say \\"hi\\" // not a comment"}')).toEqual({
      a: 'say "hi" // not a comment',
    });
  });

  it("parses the real wrangler.jsonc", () => {
    expect(template.name).toBe("open-ping");
    expect(template.d1_databases[0].database_id).toBe("REPLACE_WITH_YOUR_D1_DATABASE_ID");
  });
});

describe("buildProdConfig", () => {
  it("swaps in the database id and overrides vars, keeping everything else", () => {
    const config = buildProdConfig(template, {
      database_id: ID,
      vars: { WAITLIST_ENABLED: "true" },
    });
    expect(config.d1_databases[0]).toEqual({ ...template.d1_databases[0], database_id: ID });
    expect(config.vars).toEqual({ ...template.vars, WAITLIST_ENABLED: "true" });
    expect(config.triggers).toEqual(template.triggers);
    expect(config.main).toBe(template.main);
  });

  it("keeps the template's vars when no overrides are given", () => {
    expect(buildProdConfig(template, { database_id: ID }).vars).toEqual(template.vars);
  });

  it("rejects a missing or malformed database id", () => {
    expect(() => buildProdConfig(template, {})).toThrow(/database_id/);
    expect(() => buildProdConfig(template, { database_id: "nope" })).toThrow(/database_id/);
  });

  it("rejects a var the template does not define, so typos fail loudly", () => {
    expect(() =>
      buildProdConfig(template, { database_id: ID, vars: { WAITLIST_ENABLE: "true" } }),
    ).toThrow(/unknown var "WAITLIST_ENABLE"/);
  });

  it("rejects non-string var values", () => {
    expect(() =>
      buildProdConfig(template, { database_id: ID, vars: { WAITLIST_ENABLED: true } }),
    ).toThrow(/must be a string/);
  });
});
