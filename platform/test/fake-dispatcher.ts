/**
 * An in-memory TenantDispatcher: user Workers are plain handler functions
 * registered by script name, and every call is recorded so a test can check
 * exactly what reached a tenant (the request as forwarded, the props, the
 * limits). Same interface as the real NamespaceDispatcher.
 */

import type { TenantProps } from "../../src/shared/hosted-contract";
import type { DispatchLimits, DispatchResult, TenantDispatcher } from "../src/dispatch";

export type FakeUserWorker = (request: Request, props: TenantProps) => Response | Promise<Response>;

export interface RecordedCall {
  scriptName: string;
  request: Request;
  props: TenantProps;
  limits: DispatchLimits;
}

export class FakeDispatcher implements TenantDispatcher {
  readonly calls: RecordedCall[] = [];
  private readonly workers = new Map<string, FakeUserWorker>();

  /** Registers (or replaces) the user Worker for `scriptName`. */
  register(scriptName: string, worker: FakeUserWorker): this {
    this.workers.set(scriptName, worker);
    return this;
  }

  remove(scriptName: string): void {
    this.workers.delete(scriptName);
  }

  async dispatch(
    scriptName: string,
    request: Request,
    props: TenantProps,
    limits: DispatchLimits,
  ): Promise<DispatchResult> {
    this.calls.push({ scriptName, request: request.clone(), props, limits });
    const worker = this.workers.get(scriptName);
    if (!worker) return { kind: "missing" };
    return { kind: "response", response: await worker(request, props) };
  }
}

/** A user Worker that echoes what it received, the way OpenPing would see it. */
export const echoWorker: FakeUserWorker = (request, props) =>
  Response.json({
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    invocation: props.invocation,
    tenant: props.tenant,
  });
