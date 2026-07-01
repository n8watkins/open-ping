/**
 * Test-only stub for the Workers built-in `cloudflare:sockets` module, which has
 * no implementation in the Node-based vitest environment. Suites that actually
 * exercise the TCP executor factory-mock this module via `vi.mock`; this stub
 * only satisfies module resolution for suites that transitively import the TCP
 * executor without ever dialing a socket (e.g. the worker entry test).
 */
export function connect(): never {
  throw new Error(
    'cloudflare:sockets connect() is unavailable in the Node test environment; ' +
      'mock it with vi.mock("cloudflare:sockets") in tests that dial sockets.',
  );
}
