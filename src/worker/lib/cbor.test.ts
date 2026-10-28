import { describe, expect, it } from "vitest";
import { CborError, decodeCbor, decodeCborFirst, encodeCbor, type CborMap } from "./cbor";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe("decodeCbor", () => {
  // Vectors from RFC 8949 Appendix A.
  it.each([
    ["00", 0],
    ["17", 23],
    ["1818", 24],
    ["1903e8", 1000],
    ["1a000f4240", 1000000],
    ["1b000000e8d4a51000", 1000000000000],
    ["20", -1],
    ["3863", -100],
    ["3903e7", -1000],
    ["f4", false],
    ["f5", true],
    ["f6", null],
    ["6161", "a"],
    ["64f0908591", "\u{10151}"],
  ])("decodes %s", (input, expected) => {
    expect(decodeCbor(hex(input))).toEqual(expected);
  });

  it("decodes byte strings, arrays and maps with integer and text keys", () => {
    expect(decodeCbor(hex("4401020304"))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(decodeCbor(hex("83010203"))).toEqual([1, 2, 3]);
    const map = decodeCbor(hex("a201020304")) as CborMap;
    expect([...map]).toEqual([
      [1, 2],
      [3, 4],
    ]);
    const nested = decodeCbor(hex("a26161016162820203")) as CborMap;
    expect(nested.get("a")).toBe(1);
    expect(nested.get("b")).toEqual([2, 3]);
  });

  it("keeps negative COSE labels as numbers", () => {
    const map = decodeCbor(hex("a2200121f5")) as CborMap;
    expect(map.get(-1)).toBe(1);
    expect(map.get(-2)).toBe(true);
  });

  it.each([
    ["indefinite-length array", "9f01ff"],
    ["indefinite-length byte string", "5f4101ff"],
    ["a tag", "c11a514b67b0"],
    ["a float", "f93c00"],
    ["a reserved additional value", "1c"],
    ["a truncated integer", "1903"],
    ["a byte string longer than the input", "5a00010000"],
    ["an array longer than the input", "9a00010000"],
    ["a map with an array key", "a1800102"],
    ["a map with a duplicate key", "a201020103"],
    ["invalid UTF-8 text", "62c328"],
    ["a 64-bit integer beyond 2^53", "1bffffffffffffffff"],
  ])("rejects %s", (_label, input) => {
    expect(() => decodeCbor(hex(input))).toThrow(CborError);
  });

  it("rejects trailing bytes but decodeCborFirst reports the item length", () => {
    expect(() => decodeCbor(hex("0102"))).toThrow(CborError);
    expect(decodeCborFirst(hex("a1010203"))).toEqual({ value: new Map([[1, 2]]), length: 3 });
  });

  it("rejects nesting deeper than 16 levels", () => {
    expect(() => decodeCbor(new Uint8Array([...new Array(40).fill(0x81), 0x00]))).toThrow(/deeply/);
  });

  it("round-trips through encodeCbor", () => {
    const value: CborMap = new Map<number | string, never>();
    (value as CborMap).set("fmt", "none");
    (value as CborMap).set("attStmt", new Map());
    (value as CborMap).set(-7, new Uint8Array(300).fill(7));
    (value as CborMap).set(70000, [true, false, null, -70000]);
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });
});
