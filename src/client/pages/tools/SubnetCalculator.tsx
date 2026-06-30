import { useMemo, useState } from "react";
import { Network } from "lucide-react";
import { ToolLayout, Panel, ResultRow, Notice } from "./ToolLayout";
import { parseCidr, type SubnetResult } from "./lib";

const EXAMPLES = ["192.168.1.0/24", "10.0.0.0/8", "172.16.5.0/22", "203.0.113.7/32"];

export default function SubnetCalculator() {
  const [input, setInput] = useState("192.168.1.0/24");

  const { result, error } = useMemo(() => {
    try {
      return { result: parseCidr(input) as SubnetResult, error: null as string | null };
    } catch (e) {
      return { result: null, error: (e as Error).message };
    }
  }, [input]);

  return (
    <ToolLayout
      icon={Network}
      title="Subnet calculator"
      intro="Enter an IPv4 address in CIDR notation to see its network and broadcast addresses, subnet mask, wildcard mask, usable host range, and host counts."
    >
      <Panel>
        <label htmlFor="cidr" className="block text-sm font-medium text-ink">
          IPv4 CIDR block
        </label>
        <input
          id="cidr"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="192.168.1.0/24"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-describedby="cidr-help"
          className="input mt-2 font-mono"
        />
        <p id="cidr-help" className="mt-2 text-xs text-ink-faint">
          Format: address/prefix, e.g. 192.168.1.0/24
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setInput(ex)}
              className="rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-xs text-ink-muted transition-colors hover:text-ink"
            >
              {ex}
            </button>
          ))}
        </div>
      </Panel>

      <div className="mt-6" aria-live="polite">
        {error ? (
          <Notice>{error}</Notice>
        ) : result ? (
          <Panel>
            <h2 className="mb-2 text-sm font-semibold text-ink">
              Results for{" "}
              <span className="font-mono text-accent">{result.cidr}</span>
            </h2>
            <dl>
              <ResultRow label="Network address">{result.networkAddress}</ResultRow>
              <ResultRow label="Broadcast address">{result.broadcastAddress}</ResultRow>
              <ResultRow label="Subnet mask">{result.netmask}</ResultRow>
              <ResultRow label="Wildcard mask">{result.wildcardMask}</ResultRow>
              <ResultRow label="Usable host range">{result.hostRange}</ResultRow>
              <ResultRow label="Total addresses">
                {result.totalHosts.toLocaleString()}
              </ResultRow>
              <ResultRow label="Usable hosts">
                {result.usableHosts.toLocaleString()}
              </ResultRow>
            </dl>
          </Panel>
        ) : null}
      </div>

      <div className="mt-6 rounded-card border border-line bg-surface/50 p-5 text-sm leading-relaxed text-ink-muted">
        <h2 className="mb-1.5 text-sm font-semibold text-ink">About subnets</h2>
        <p>
          The prefix (the number after the slash) sets how many leading bits are
          fixed as the network portion. The first address in a block is the network
          address and the last is the broadcast address, so an ordinary subnet has
          two fewer usable hosts than total addresses. A /31 is a special
          point-to-point link (RFC 3021) and a /32 is a single host route.
        </p>
      </div>
    </ToolLayout>
  );
}
