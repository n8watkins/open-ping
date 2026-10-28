/**
 * Test-only stub for the Workers built-in `cloudflare:workers` module, which
 * has no implementation in the Node-based vitest environment. It only gives
 * the worker entry's Durable Object class (src/worker/region-probe.ts) a base
 * class to extend; suites that exercise the Durable Object run in the Workers
 * pool (vitest.integration.config.ts).
 */
export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}
