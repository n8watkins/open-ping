import { describe, it, expect } from "vitest";
import {
  isMethodAllowed,
  checkSecret,
  parseHeartbeatPayload,
} from "./heartbeats";

describe("isMethodAllowed", () => {
  it("defaults to POST/HEAD only when the allowlist is undefined", () => {
    // Intentional: GET is what link-preview/prefetch bots use, so it must not
    // record a beat unless explicitly opted in via acceptedMethods.
    expect(isMethodAllowed(undefined, "POST")).toBe(true);
    expect(isMethodAllowed(undefined, "HEAD")).toBe(true);
    expect(isMethodAllowed(undefined, "GET")).toBe(false);
    expect(isMethodAllowed(undefined, "DELETE")).toBe(false);
  });

  it("defaults to POST/HEAD only when the allowlist is empty", () => {
    expect(isMethodAllowed([], "POST")).toBe(true);
    expect(isMethodAllowed([], "GET")).toBe(false);
  });

  it("allows GET only when explicitly opted in", () => {
    expect(isMethodAllowed(["GET"], "GET")).toBe(true);
  });

  it("allows a listed method case-insensitively", () => {
    expect(isMethodAllowed(["POST"], "post")).toBe(true);
    expect(isMethodAllowed(["get", "POST"], "GET")).toBe(true);
  });

  it("rejects a method that is not listed", () => {
    expect(isMethodAllowed(["POST"], "GET")).toBe(false);
    expect(isMethodAllowed(["GET", "HEAD"], "DELETE")).toBe(false);
  });
});

describe("checkSecret", () => {
  it("passes when no secret is configured", async () => {
    expect(await checkSecret(undefined, undefined)).toBe(true);
    expect(await checkSecret(undefined, "anything")).toBe(true);
    expect(await checkSecret("", "anything")).toBe(true);
  });

  it("passes when the provided secret matches", async () => {
    expect(await checkSecret("s3cret", "s3cret")).toBe(true);
  });

  it("fails when the provided secret does not match", async () => {
    expect(await checkSecret("s3cret", "nope")).toBe(false);
  });

  it("fails when a secret is configured but none is provided", async () => {
    expect(await checkSecret("s3cret", undefined)).toBe(false);
  });
});

describe("parseHeartbeatPayload", () => {
  it("returns an empty object when nothing is supplied", () => {
    expect(parseHeartbeatPayload({}, undefined)).toEqual({});
  });

  it("reads duration/status/message/runId from query aliases", () => {
    expect(
      parseHeartbeatPayload(
        { duration: "120", status: "0", msg: "ok", rid: "run-1" },
        undefined,
      ),
    ).toEqual({ durationMs: 120, exitStatus: 0, message: "ok", runId: "run-1" });

    expect(
      parseHeartbeatPayload(
        { ms: "50", exit: "2", message: "boom", run_id: "r2" },
        undefined,
      ),
    ).toEqual({ durationMs: 50, exitStatus: 2, message: "boom", runId: "r2" });
  });

  it("coerces numeric strings and ignores NaN", () => {
    expect(parseHeartbeatPayload({ duration: "abc" }, undefined)).toEqual({});
    expect(parseHeartbeatPayload({ status: "x1" }, undefined)).toEqual({});
    expect(parseHeartbeatPayload({ duration: "0" }, undefined)).toEqual({
      durationMs: 0,
    });
  });

  it("lets the body take precedence over query params", () => {
    const out = parseHeartbeatPayload(
      { duration: "1", status: "1", msg: "from-query", rid: "q" },
      {
        durationMs: 999,
        exitStatus: 0,
        message: "from-body",
        runId: "b",
      },
    );
    expect(out).toEqual({
      durationMs: 999,
      exitStatus: 0,
      message: "from-body",
      runId: "b",
    });
  });

  it("accepts body aliases (duration/status/run_id)", () => {
    expect(
      parseHeartbeatPayload({}, { duration: 30, status: 3, run_id: "rb" }),
    ).toEqual({ durationMs: 30, exitStatus: 3, runId: "rb" });
  });

  it("filters metrics to numeric values only", () => {
    expect(
      parseHeartbeatPayload(
        {},
        { metrics: { rows: 10, name: "skip", ratio: 0.5, bad: NaN } },
      ),
    ).toEqual({ metrics: { rows: 10, ratio: 0.5 } });
  });

  it("omits metrics when none are numeric or it is not an object", () => {
    expect(parseHeartbeatPayload({}, { metrics: { a: "x" } })).toEqual({});
    expect(parseHeartbeatPayload({}, { metrics: "nope" })).toEqual({});
  });
});
