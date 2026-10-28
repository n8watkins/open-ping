/**
 * A stand-in for a customer's OpenPing behind the fake namespace, answering
 * the contract's internal paths the way OpenPing does (CONTRACT.md, section
 * 6): only for a platform call whose header matches its call id, migrations
 * applied by the first scheduled run, health ok once they are.
 */

import {
  INTERNAL_HEADER,
  PLATFORM_HEALTH_PATH,
  PLATFORM_SCHEDULED_PATH,
  isPlatformCall,
  type HealthResponse,
  type ScheduledRequest,
  type ScheduledRunSummary,
} from "../../src/shared/hosted-contract";
import type { FakeScript } from "./fake-cloudflare";
import type { FakeUserWorker } from "./fake-dispatcher";

export const BUNDLED_SCHEMA_VERSION = 19;

export interface FakeOpenPingState {
  schemaVersion: number;
  scheduledRuns: ScheduledRequest[];
  /** Make the next scheduled run answer "failed". */
  failNextRun?: boolean;
  /** Vars and secrets the upload gave it, as its env would have them. */
  env: Record<string, string>;
}

export function fakeOpenPing(script: FakeScript): { worker: FakeUserWorker; state: FakeOpenPingState } {
  const env: Record<string, string> = {};
  for (const b of script.metadata.bindings) {
    if (b.type === "plain_text" || b.type === "secret_text") env[b.name] = b.text;
    if (b.type === "d1") env[b.name] = `d1:${b.database_id}`;
  }
  const state: FakeOpenPingState = { schemaVersion: 0, scheduledRuns: [], env };
  const worker: FakeUserWorker = async (request, props) => {
    const url = new URL(request.url);
    const internal = url.pathname.startsWith("/__platform/");
    if (internal && !isPlatformCall(props, request.headers.get(INTERNAL_HEADER))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.pathname === PLATFORM_HEALTH_PATH) {
      const ok = state.schemaVersion === BUNDLED_SCHEMA_VERSION;
      const body: HealthResponse = {
        ok,
        version: "0.10.1",
        schemaVersion: state.schemaVersion,
        bundledSchemaVersion: BUNDLED_SCHEMA_VERSION,
        migrating: false,
        lastRun: null,
      };
      return Response.json(body, { status: ok ? 200 : 503 });
    }
    if (url.pathname === PLATFORM_SCHEDULED_PATH && request.method === "POST") {
      const run = (await request.json()) as ScheduledRequest;
      state.scheduledRuns.push(run);
      const failed = state.failNextRun === true;
      state.failNextRun = false;
      const applied = failed ? 0 : BUNDLED_SCHEMA_VERSION - state.schemaVersion;
      if (!failed) state.schemaVersion = BUNDLED_SCHEMA_VERSION;
      const summary: ScheduledRunSummary = {
        runId: run.runId,
        outcome: failed ? "failed" : "ran",
        version: "0.10.1",
        schemaVersion: state.schemaVersion,
        migrationsApplied: applied,
        startedAt: run.scheduledTime,
        durationMs: 5,
        checked: 0,
        failures: 0,
        deferred: 0,
        d1Queries: 3,
        ...(failed ? { error: "migration 0004 failed" } : {}),
      };
      return Response.json(summary);
    }
    return new Response(`OpenPing for ${props.tenant.slug}`, { headers: { "content-type": "text/plain" } });
  };
  return { worker, state };
}
