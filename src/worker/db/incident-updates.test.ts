import { describe, expect, it } from "vitest";
import { createUpdateSchema, editUpdateSchema, MAX_UPDATE_MESSAGE } from "./incident-updates";

describe("incident update validation", () => {
  it("accepts the four statuses with a trimmed message", () => {
    for (const status of ["investigating", "identified", "monitoring", "resolved"]) {
      expect(createUpdateSchema.parse({ status, message: "  Looking into it \n" })).toEqual({
        status,
        message: "Looking into it",
      });
    }
  });

  it("rejects an unknown status, an empty or blank message and an over-long one", () => {
    expect(createUpdateSchema.safeParse({ status: "fixed", message: "x" }).success).toBe(false);
    expect(createUpdateSchema.safeParse({ status: "Resolved", message: "x" }).success).toBe(false);
    expect(createUpdateSchema.safeParse({ status: "identified", message: "" }).success).toBe(false);
    expect(createUpdateSchema.safeParse({ status: "identified", message: "   \n " }).success).toBe(false);
    expect(createUpdateSchema.safeParse({ status: "identified" }).success).toBe(false);
    expect(
      createUpdateSchema.safeParse({ status: "identified", message: "x".repeat(MAX_UPDATE_MESSAGE + 1) }).success,
    ).toBe(false);
    expect(
      createUpdateSchema.safeParse({ status: "identified", message: "x".repeat(MAX_UPDATE_MESSAGE) }).success,
    ).toBe(true);
  });

  it("edits need a status or a message, each validated the same way", () => {
    expect(editUpdateSchema.safeParse({}).success).toBe(false);
    expect(editUpdateSchema.parse({ status: "resolved" })).toEqual({ status: "resolved" });
    expect(editUpdateSchema.parse({ message: " Fixed " })).toEqual({ message: "Fixed" });
    expect(editUpdateSchema.safeParse({ message: " " }).success).toBe(false);
    expect(editUpdateSchema.safeParse({ status: "done" }).success).toBe(false);
  });
});
