import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TcpConfig } from "../../shared/schemas";
import { tcpConfigSchema } from "../../shared/schemas";

// Vitest runs in Node, where the `cloudflare:sockets` module does not exist, so
// it must be factory-mocked (hoisted above the import of the module under test).
vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));
import { connect } from "cloudflare:sockets";
import { runTcpCheck } from "./tcp";

const mockedConnect = vi.mocked(connect);

/** Build a complete TcpConfig with sensible defaults, overridable per test. */
function makeConfig(overrides: Partial<TcpConfig> = {}): TcpConfig {
  return { host: "example.com", port: 443, timeoutMs: 1000, ...overrides };
}

/** A fake Socket with a controllable `opened` promise and a spyable `close`. */
function fakeSocket(opened: Promise<unknown>): {
  opened: Promise<unknown>;
  close: ReturnType<typeof vi.fn>;
} {
  return { opened, close: vi.fn().mockResolvedValue(undefined) };
}

describe("runTcpCheck", () => {
  beforeEach(() => mockedConnect.mockReset());

  it("is up when the socket opens, and closes the socket", async () => {
    const sock = fakeSocket(Promise.resolve({ remoteAddress: "1.2.3.4" }));
    mockedConnect.mockReturnValue(sock as unknown as ReturnType<typeof connect>);

    const r = await runTcpCheck(makeConfig({ host: "example.com", port: 443 }));
    expect(r.ok).toBe(true);
    expect(mockedConnect).toHaveBeenCalledWith({
      hostname: "example.com",
      port: 443,
    });
    expect(sock.close).toHaveBeenCalled();
  });

  it("is down (tcp_refused) when the connection rejects, and still closes", async () => {
    const sock = fakeSocket(Promise.reject(new Error("connection refused")));
    mockedConnect.mockReturnValue(sock as unknown as ReturnType<typeof connect>);

    const r = await runTcpCheck(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("tcp_refused");
    expect(sock.close).toHaveBeenCalled();
  });

  it("is down (tcp_timeout) when the socket never opens", async () => {
    const sock = fakeSocket(new Promise<never>(() => {})); // never settles
    mockedConnect.mockReturnValue(sock as unknown as ReturnType<typeof connect>);

    const r = await runTcpCheck(makeConfig({ host: "example.com", port: 9999, timeoutMs: 20 }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("tcp_timeout");
    expect(sock.close).toHaveBeenCalled();
  });

  it("returns blocked_host for a loopback/private target without dialing", async () => {
    const r = await runTcpCheck(makeConfig({ host: "127.0.0.1", port: 80 }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("blocked_host");
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it("rejects port 25 at the zod layer", () => {
    expect(
      tcpConfigSchema.safeParse({ host: "mail.example.com", port: 25 }).success,
    ).toBe(false);
    expect(
      tcpConfigSchema.safeParse({ host: "mail.example.com", port: 587 }).success,
    ).toBe(true);
  });
});
