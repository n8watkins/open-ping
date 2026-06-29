import { describe, it, expect } from "vitest";
import { resolveIncident } from "./incidents";
import type { Env } from "../types";

/**
 * resolveIncident is a thin D1 wrapper, so it is exercised here through a tiny
 * in-memory fake of the `incidents` / `incident_events` tables. The fake models
 * just enough SQL — the by-id SELECT, the `status = 'open'`-guarded UPDATE (whose
 * `meta.changes` the function keys off), and the recovery-event INSERT — to prove
 * the idempotency contract: a repeat resolve must not re-stamp resolved_at,
 * inflate the duration, or write a second `recovered` event. (The repo has no D1
 * test harness yet; see vitest.config.ts.)
 */

const NOW = 1_700_000_000_000; // fixed reference "now"

interface FakeIncidentRow {
  id: string;
  monitor_id: string;
  status: string;
  title: string | null;
  root_cause: string | null;
  started_at: number;
  last_observed_at: number | null;
  resolved_at: number | null;
  duration_seconds: number | null;
  http_status: number | null;
  error: string | null;
  private_notes: string | null;
  public_message: string | null;
  resolution: string | null;
  public: number;
  is_flapping: number;
  notified: number;
  created_at: number;
  updated_at: number;
}

/** An open incident that started 5s before NOW (→ 5s duration when resolved). */
function openIncidentRow(overrides: Partial<FakeIncidentRow> = {}): FakeIncidentRow {
  return {
    id: "inc_1",
    monitor_id: "mon_1",
    status: "open",
    title: "Example is down",
    root_cause: null,
    started_at: NOW - 5_000,
    last_observed_at: NOW - 1_000,
    resolved_at: null,
    duration_seconds: null,
    http_status: null,
    error: null,
    private_notes: null,
    public_message: null,
    resolution: null,
    public: 0,
    is_flapping: 0,
    notified: 0,
    created_at: NOW - 5_000,
    updated_at: NOW - 1_000,
    ...overrides,
  };
}

/**
 * Minimal fake `env.DB`: one mutable incident row keyed by id plus a log of the
 * recovery events inserted. Recognises the three statements resolveIncident
 * issues by keyword; the guarded UPDATE only "changes" a row while it is open.
 */
function makeFakeEnv(rows: FakeIncidentRow[]) {
  const recoveredEvents: { incidentId: string; at: number }[] = [];

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            // getIncidentById: SELECT * FROM incidents WHERE id = ?
            async first<T>(): Promise<T | null> {
              const id = args[0];
              return (rows.find((r) => r.id === id) ?? null) as T | null;
            },
            async run() {
              if (/UPDATE incidents/.test(sql)) {
                // bind(resolved_at, duration_seconds, updated_at, id)
                const [resolvedAt, durationSeconds, updatedAt, id] = args as [
                  number,
                  number,
                  number,
                  string,
                ];
                const row = rows.find((r) => r.id === id);
                // WHERE id = ? AND status = 'open'
                if (row && row.status === "open") {
                  row.status = "resolved";
                  row.resolved_at = resolvedAt;
                  row.duration_seconds = durationSeconds;
                  row.updated_at = updatedAt;
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              if (/INSERT INTO incident_events/.test(sql)) {
                // bind(eventId, incident_id, at, message)
                const [, incidentId, at] = args as [string, string, number, string];
                recoveredEvents.push({ incidentId, at });
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };

  return { env: { DB: db } as unknown as Env, recoveredEvents };
}

describe("resolveIncident (idempotency)", () => {
  it("resolves an open incident: stamps resolved_at/duration and writes one recovered event", async () => {
    const { env, recoveredEvents } = makeFakeEnv([openIncidentRow()]);

    const resolved = await resolveIncident(env, "inc_1", { at: NOW });

    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).toBe(NOW);
    expect(resolved?.durationSeconds).toBe(5); // (NOW - (NOW - 5000)) / 1000
    expect(recoveredEvents).toHaveLength(1);
  });

  it("is a no-op on a repeat resolve: stable resolved_at/duration, no second event", async () => {
    const { env, recoveredEvents } = makeFakeEnv([openIncidentRow()]);

    const first = await resolveIncident(env, "inc_1", { at: NOW });
    // A racing double-resolve lands 60s later. Without the `status = 'open'`
    // guard this would re-stamp resolved_at, inflate duration to 65s, and append
    // a second `recovered` event.
    const second = await resolveIncident(env, "inc_1", { at: NOW + 60_000 });

    expect(second?.status).toBe("resolved");
    expect(second?.resolvedAt).toBe(first?.resolvedAt);
    expect(second?.resolvedAt).toBe(NOW); // unchanged, not NOW + 60_000
    expect(second?.durationSeconds).toBe(first?.durationSeconds);
    expect(second?.durationSeconds).toBe(5); // unchanged, not 65
    expect(recoveredEvents).toHaveLength(1); // exactly one recovered event
  });

  it("returns null and writes nothing when the incident does not exist", async () => {
    const { env, recoveredEvents } = makeFakeEnv([]);

    const result = await resolveIncident(env, "inc_missing", { at: NOW });

    expect(result).toBeNull();
    expect(recoveredEvents).toHaveLength(0);
  });
});
