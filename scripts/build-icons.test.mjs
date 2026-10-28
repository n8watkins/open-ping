import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICONS } from "./build-icons.mjs";

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path) {
  const buf = readFileSync(new URL(`../public/${path}`, import.meta.url));
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("build-icons", () => {
  it("has a committed PNG at the right size for every icon it renders", () => {
    for (const [out, , size] of ICONS) {
      expect(pngSize(out), out).toEqual({ width: size, height: size });
    }
  });
});
