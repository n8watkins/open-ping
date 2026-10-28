import { describe, expect, it } from "vitest";
import { statusPageSchema } from "../../shared/schemas";
import type { StatusPageRecord } from "../db/status-pages";
import { mergeStatusPagePatch, statusPagePatchSchema } from "./status-pages";

const page: StatusPageRecord = {
  id: "sp_default",
  slug: "default",
  name: "Status",
  description: "All systems",
  enabled: true,
  isDefault: true,
  includeMode: "all",
  categoryIds: [],
  monitorIds: [],
  theme: null,
  accent: "#6d8bff",
  logo: null,
  homepage: "https://example.com",
  footer: null,
  attribution: true,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

describe("mergeStatusPagePatch", () => {
  it("changes only the given fields and yields a valid full page", () => {
    const merged = mergeStatusPagePatch(page, { name: "Acme status", homepage: null });
    const parsed = statusPageSchema.parse(merged);
    expect(parsed).toMatchObject({
      slug: "default",
      name: "Acme status",
      description: "All systems",
      enabled: true,
      theme: "dark",
      accent: "#6d8bff",
    });
    expect(parsed.homepage).toBeUndefined();
  });

  it("rejects fields a page does not have", () => {
    expect(statusPagePatchSchema.safeParse({ isDefault: false }).success).toBe(false);
    expect(statusPagePatchSchema.safeParse({ name: "x" }).success).toBe(true);
  });
});
