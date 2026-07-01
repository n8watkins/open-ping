import { describe, it, expect } from "vitest";
import { rowToCategory } from "./categories";
import { categorySchema } from "../../shared/schemas";

// These tests cover the pure pieces of the category data layer (row mapping and
// input validation) without touching D1, matching the repo's node test env.

describe("rowToCategory", () => {
  it("maps a full row to a camelCase record", () => {
    expect(
      rowToCategory({
        id: "cat_1",
        slug: "web-services",
        name: "Web Services",
        description: "Public web endpoints",
        sort_order: 3,
        created_at: 1000,
        updated_at: 2000,
      }),
    ).toEqual({
      id: "cat_1",
      slug: "web-services",
      name: "Web Services",
      description: "Public web endpoints",
      sortOrder: 3,
      createdAt: 1000,
      updatedAt: 2000,
    });
  });

  it("coerces a null description to null and a null sort_order to 0", () => {
    const rec = rowToCategory({
      id: "cat_2",
      slug: "api",
      name: "APIs",
      description: null,
      sort_order: null,
      created_at: 5,
      updated_at: 5,
    });
    expect(rec.description).toBeNull();
    expect(rec.sortOrder).toBe(0);
  });
});

describe("categorySchema", () => {
  it("accepts a valid lowercase-hyphen slug and defaults sortOrder to 0", () => {
    const parsed = categorySchema.safeParse({ name: "Web", slug: "web-services" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sortOrder).toBe(0);
  });

  it("rejects slugs with uppercase, spaces, or underscores", () => {
    expect(categorySchema.safeParse({ name: "Web", slug: "Web" }).success).toBe(false);
    expect(categorySchema.safeParse({ name: "Web", slug: "web services" }).success).toBe(false);
    expect(categorySchema.safeParse({ name: "Web", slug: "web_services" }).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(categorySchema.safeParse({ name: "", slug: "web" }).success).toBe(false);
  });
});
