import { describe, expect, it } from "vitest";
import { csvCell } from "./incidents";

describe("csvCell", () => {
  it.each(["=1+1", "+cmd", "-2+3", "@SUM(A1:A2)", "  =HYPERLINK(\"https://example.com\")"])(
    "neutralizes spreadsheet formula text: %s",
    (value) => {
      const cell = csvCell(value);
      const content = cell.startsWith('"') ? cell.slice(1) : cell;
      expect(content.startsWith("'")).toBe(true);
    },
  );

  it("does not alter typed numeric values", () => {
    expect(csvCell(-42)).toBe("-42");
  });

  it("preserves RFC 4180 quoting after neutralization", () => {
    expect(csvCell('=HYPERLINK("https://example.com")')).toBe(
      '"\'=HYPERLINK(""https://example.com"")"',
    );
  });
});
