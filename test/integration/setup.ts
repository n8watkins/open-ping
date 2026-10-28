/**
 * Integration tests never reach the internet. Creating a monitor runs its first
 * check right away (checks/first-check.ts), so without this every test that
 * creates an http/dns/tcp/domain monitor would make a real request to an
 * example.com address. Outbound fetches fail like an unreachable host unless a
 * test stubs them (vi.spyOn(globalThis, "fetch") wraps this, and mockRestore
 * comes back to it).
 */
globalThis.fetch = async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`network_error: no outbound requests in integration tests (${url})`);
};
