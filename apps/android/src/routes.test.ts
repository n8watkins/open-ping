import { describe, expect, it } from "vitest";
import { parseRoute } from "./routes";

describe("parseRoute", () => {
  it("knows the screens", () => {
    expect(parseRoute("")).toEqual({ name: "boot" });
    expect(parseRoute("#/picker")).toEqual({ name: "picker" });
    expect(parseRoute("#/add")).toEqual({ name: "add" });
    expect(parseRoute("#/add/own")).toEqual({ name: "add-own" });
    expect(parseRoute("#/add/hosted")).toEqual({ name: "add-hosted" });
    expect(parseRoute("#/webview")).toEqual({ name: "webview" });
    expect(parseRoute("#/nonsense")).toEqual({ name: "boot" });
  });

  it("reads the offline screen's address and reason", () => {
    const url = encodeURIComponent("https://status.example.com/incidents/42?x=1");
    expect(parseRoute(`#/offline?url=${url}&reason=certificate`)).toEqual({
      name: "offline",
      origin: "https://status.example.com",
      path: "/incidents/42?x=1",
      reason: "certificate",
    });
    expect(parseRoute(`#/offline?url=${url}`)).toMatchObject({ reason: "network" });
  });

  it("never offers to retry anything but an https address", () => {
    expect(parseRoute(`#/offline?url=${encodeURIComponent("javascript:alert(1)")}`)).toMatchObject({ origin: null, path: "/" });
    expect(parseRoute("#/offline?url=http%3A%2F%2Fexample.com")).toMatchObject({ origin: null });
    expect(parseRoute("#/offline")).toMatchObject({ origin: null });
  });
});
