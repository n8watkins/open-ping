import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorRecord } from "../db/monitors";
import type { Env } from "../types";
import {
  confirmRegions,
  lookupColo,
  parseTraceColo,
  pickRegion,
  regionalRechecker,
  DURABLE_OBJECT_SUBREQUESTS,
  REMOTE_RECHECK_OVERHEAD,
  resetKnownColos,
  supportsRemoteRecheck,
  TRACE_URL,
  type RegionRecheckResult,
} from "./region";
import { probeFetchLimit } from "./runner";

const monitor = {
  id: "mon_1",
  type: "http",
  config: { url: "https://x.test", followRedirects: true, timeoutMs: 10_000 },
  assertions: [],
} as unknown as MonitorRecord;

const down: RegionRecheckResult["attempt"] = {
  result: { ok: false, statusCode: 503, error: "status_out_of_range" },
  ok: false,
};

/** A stand-in Durable Object namespace whose objects answer from `colos[region]`. */
function fakeNamespace(answer: (region: string) => Promise<RegionRecheckResult>) {
  const asked: { name: string; hint: string | undefined }[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }, opts?: { locationHint?: string }) => {
      asked.push({ name: id.name, hint: opts?.locationHint });
      const region = id.name.replace("region:", "");
      return { recheck: () => answer(region) };
    },
  };
  return { ns: ns as unknown as Env["REGION_PROBE"] & object, asked };
}

beforeEach(() => resetKnownColos());
afterEach(() => vi.restoreAllMocks());

describe("confirmRegions", () => {
  const ns = {} as Env["REGION_PROBE"] & object;

  it("reads the hints in order, ignoring unknown ones and repeats", () => {
    expect(confirmRegions({ REGION_PROBE: ns, CONFIRM_REGIONS: " WEUR, enam,mars,weur ,apac" })).toEqual([
      "weur",
      "enam",
      "apac",
    ]);
  });

  it("is off when unset, empty, \"off\" or without the binding", () => {
    expect(confirmRegions({ REGION_PROBE: ns })).toEqual([]);
    expect(confirmRegions({ REGION_PROBE: ns, CONFIRM_REGIONS: "" })).toEqual([]);
    expect(confirmRegions({ REGION_PROBE: ns, CONFIRM_REGIONS: "off" })).toEqual([]);
    expect(confirmRegions({ CONFIRM_REGIONS: "weur" })).toEqual([]);
  });
});

describe("the data-center lookup", () => {
  it("reads colo= from Cloudflare's trace", () => {
    expect(parseTraceColo("fl=123\nh=www.cloudflare.com\nip=1.2.3.4\ncolo=FRA\nloc=DE\n")).toBe("FRA");
    expect(parseTraceColo("h=x\nloc=DE\n")).toBeNull();
  });

  it("asks the trace endpoint once, and is null on any failure", async () => {
    const ok = vi.fn().mockResolvedValue(new Response("colo=SJC\n"));
    expect(await lookupColo(ok)).toBe("SJC");
    expect(ok).toHaveBeenCalledOnce();
    expect(ok.mock.calls[0]?.[0]).toBe(TRACE_URL);
    expect(await lookupColo(vi.fn().mockResolvedValue(new Response("", { status: 500 })))).toBeNull();
    expect(await lookupColo(vi.fn().mockRejectedValue(new Error("down")))).toBeNull();
  });
});

describe("supportsRemoteRecheck", () => {
  it("covers http, dns and tcp, not domain (RDAP answers the same everywhere)", () => {
    expect(["http", "dns", "tcp", "domain", "heartbeat"].map((t) => supportsRemoteRecheck(t as never))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("regionalRechecker", () => {
  it("is null when the install doesn't confirm from another region", () => {
    expect(regionalRechecker({ CONFIRM_REGIONS: "weur" })).toBeNull();
    expect(regionalRechecker({ REGION_PROBE: fakeNamespace(async () => ({ attempt: down, colo: null, fetches: 1 })).ns })).toBeNull();
  });

  it("asks a region by its hint, records where it ran and charges only the hop and the lookup", async () => {
    const { ns, asked } = fakeNamespace(async () => ({ attempt: down, colo: "FRA", fetches: 2 }));
    const lookupHere = vi.fn().mockResolvedValue("IAD");
    const recheck = regionalRechecker({ REGION_PROBE: ns, CONFIRM_REGIONS: "weur,enam" }, { lookupHere })!;

    const first = await recheck(monitor, { warmup: false });
    expect(asked).toEqual([{ name: "region:weur", hint: "weur" }]);
    // The Durable Object's own 2 requests are its own invocation's, not the run's.
    expect(first).toEqual({ attempt: down, colo: "FRA", fetches: 1 + 1 });

    // The run looks up where it is once; later re-checks share it.
    const second = await recheck(monitor, { warmup: false });
    expect(lookupHere).toHaveBeenCalledOnce();
    expect(second.fetches).toBe(1);
  });

  it("never charges more than the overhead the scheduler holds", async () => {
    const { ns } = fakeNamespace(async () => ({ attempt: down, colo: "FRA", fetches: 1 + probeFetchLimit(monitor) }));
    const recheck = regionalRechecker({ REGION_PROBE: ns, CONFIRM_REGIONS: "weur" }, { lookupHere: async () => "IAD" })!;
    expect((await recheck(monitor, { warmup: false })).fetches).toBeLessThanOrEqual(REMOTE_RECHECK_OVERHEAD);
  });

  it("keeps the Durable Object's re-check inside its own 50 requests per call", () => {
    // Its probe's worst case (every redirect followed) plus its data-center lookup.
    const worst = Math.max(...(["http", "dns", "tcp"] as const).map((type) =>
      probeFetchLimit({ type, config: type === "http" ? { followRedirects: true } : {} } as never),
    ));
    expect(worst + 1).toBeLessThanOrEqual(DURABLE_OBJECT_SUBREQUESTS);
  });

  it("moves away from a region that turned out to be where the run is", async () => {
    const colos: Record<string, string> = { weur: "FRA", enam: "IAD" };
    const { ns, asked } = fakeNamespace(async (r) => ({ attempt: down, colo: colos[r]!, fetches: 1 }));

    // Run 1 is in Frankfurt and doesn't know weur lives there yet: it asks
    // weur, which still re-checks but isn't recorded as from elsewhere.
    const run1 = regionalRechecker({ REGION_PROBE: ns, CONFIRM_REGIONS: "weur,enam" }, { lookupHere: async () => "FRA" })!;
    const same = await run1(monitor, { warmup: false });
    expect(same.attempt).toEqual(down);
    expect(same).not.toHaveProperty("colo");

    // Next time it knows, so it asks enam instead.
    const elsewhere = await run1(monitor, { warmup: false });
    expect(elsewhere.colo).toBe("IAD");
    expect(asked.map((a) => a.hint)).toEqual(["weur", "enam"]);

    // A run in Ashburn goes to weur.
    expect(pickRegion(["weur", "enam"], "IAD")).toBe("weur");
  });

  it("degrades to a re-check here when the Durable Object fails, leaving room for it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ns } = fakeNamespace(async () => {
      throw new Error("Durable Object reset");
    });
    const recheck = regionalRechecker({ REGION_PROBE: ns, CONFIRM_REGIONS: "weur" }, { lookupHere: async () => "IAD" })!;
    const res = await recheck(monitor, { warmup: false });
    expect(res.attempt).toBeNull();
    expect(res.fetches).toBe(1 + 1);
    // The hold is a local re-check plus the overhead: the fallback still fits.
    expect(res.fetches + probeFetchLimit(monitor)).toBeLessThanOrEqual(probeFetchLimit(monitor) + REMOTE_RECHECK_OVERHEAD);
    expect(error).toHaveBeenCalledOnce();
  });

  it("gives up on a Durable Object that doesn't answer in time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ns } = fakeNamespace(() => new Promise(() => {}));
    const recheck = regionalRechecker(
      { REGION_PROBE: ns, CONFIRM_REGIONS: "weur" },
      { lookupHere: async () => null, timeoutMs: 5 },
    )!;
    expect((await recheck(monitor, { warmup: false })).attempt).toBeNull();
  });

  it("goes on without knowing where the run is", async () => {
    const { ns } = fakeNamespace(async () => ({ attempt: down, colo: "SIN", fetches: 1 }));
    const recheck = regionalRechecker({ REGION_PROBE: ns, CONFIRM_REGIONS: "apac" }, { lookupHere: async () => null })!;
    expect((await recheck(monitor, { warmup: false })).colo).toBe("SIN");
  });
});
