import { describe, expect, it } from "vitest";
import { describeCause, groupIncidents, type IncidentLike } from "./incident-groups";

const MIN = 60_000;
const inc = (id: string, monitor: string, startedAt: number, over: Partial<IncidentLike> = {}): IncidentLike => ({
  id,
  monitorId: monitor,
  monitorName: monitor.toUpperCase(),
  status: "resolved",
  startedAt,
  resolvedAt: startedAt + 30 * MIN,
  durationSeconds: 1800,
  error: "suspended",
  ...over,
});

describe("groupIncidents", () => {
  it("joins incidents that start together, newest group first", () => {
    const groups = groupIncidents([
      inc("a1", "a", 0),
      inc("b1", "b", 2 * MIN),
      inc("c1", "c", 1 * MIN, { durationSeconds: 3600, resolvedAt: 61 * MIN }),
      inc("a2", "a", 600 * MIN, { error: "timeout" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ id: "a2", causes: ["timeout"], monitors: [{ id: "a", name: "A" }] });
    expect(groups[1]).toMatchObject({
      startedAt: 0,
      durationSeconds: 3600,
      resolvedAt: 61 * MIN,
      open: false,
      causes: ["suspended"],
    });
    expect(groups[1]!.monitors.map((m) => m.name)).toEqual(["A", "B", "C"]);
  });

  it("keeps a group open while any incident in it is open", () => {
    const now = 100 * MIN;
    const [g] = groupIncidents(
      [inc("a", "a", 40 * MIN), inc("b", "b", 41 * MIN, { status: "open", resolvedAt: null, durationSeconds: null })],
      now,
    );
    expect(g).toMatchObject({ open: true, resolvedAt: null, durationSeconds: 59 * 60 });
  });
});

describe("describeCause", () => {
  it("puts stored error codes in plain words", () => {
    expect(describeCause("suspended")).toBe("Suspended by the host");
    expect(describeCause("http_503")).toBe("HTTP 503");
    expect(describeCause("some_new_code")).toBe("Some new code");
  });
});
