import { describe, expect, it } from "vitest";
import { coloCity } from "./colos";

describe("coloCity", () => {
  it("names a data center by its city, whatever the case", () => {
    expect(coloCity("FRA")).toBe("Frankfurt");
    expect(coloCity("iad")).toBe("Ashburn");
  });

  it("shows an unknown code as it is", () => {
    expect(coloCity("xyz")).toBe("XYZ");
  });
});
