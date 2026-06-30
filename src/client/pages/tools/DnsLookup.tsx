import { useState, type FormEvent } from "react";
import { Search, Loader2 } from "lucide-react";
import { ToolLayout, Panel, Notice } from "./ToolLayout";
import { dohLookup, DNS_TYPE_CODES, type DohResult } from "./lib";

const RECORD_TYPES = Object.keys(DNS_TYPE_CODES); // A, NS, CNAME, SOA, MX, TXT, AAAA

export default function DnsLookup() {
  const [host, setHost] = useState("");
  const [type, setType] = useState("A");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DohResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queried, setQueried] = useState<{ host: string; type: string } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const name = host.trim();
    if (!name) {
      setError("Enter a hostname to look up.");
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setQueried({ host: name, type });
    try {
      setResult(await dohLookup(name, type));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The DNS query failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ToolLayout
      icon={Search}
      title="DNS lookup"
      intro="Resolve DNS records for any hostname over secure DNS-over-HTTPS. The lookup runs straight from your browser via Google's public resolver."
    >
      <Panel>
        <form onSubmit={(e) => void onSubmit(e)}>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label htmlFor="dns-host" className="block text-sm font-medium text-ink">
                Hostname
              </label>
              <input
                id="dns-host"
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="example.com"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="input mt-2 font-mono"
              />
            </div>
            <div>
              <label htmlFor="dns-type" className="block text-sm font-medium text-ink">
                Record type
              </label>
              <select
                id="dns-type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="input mt-2 sm:w-32"
              >
                {RECORD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-canvas transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            Look up records
          </button>
        </form>
      </Panel>

      <div className="mt-6" aria-live="polite">
        {error && <Notice>{error}</Notice>}

        {!error && result && queried && (
          <Panel>
            <h2 className="mb-3 text-sm font-semibold text-ink">
              {queried.type} records for{" "}
              <span className="font-mono text-accent">{queried.host}</span>
            </h2>

            {result.answers.length === 0 ? (
              <Notice tone="info">
                No {queried.type} records found
                {result.status !== 0 ? ` — resolver returned ${result.statusText}.` : "."}
              </Notice>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    {queried.type} records for {queried.host}
                  </caption>
                  <thead>
                    <tr className="border-b border-line bg-surface-2/60 text-left text-xs uppercase tracking-wide text-ink-faint">
                      <th scope="col" className="px-3 py-2 font-medium">Name</th>
                      <th scope="col" className="px-3 py-2 font-medium">Type</th>
                      <th scope="col" className="px-3 py-2 font-medium">TTL</th>
                      <th scope="col" className="px-3 py-2 font-medium">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.answers.map((a, i) => (
                      <tr key={i} className="border-b border-line/60 last:border-0">
                        <td className="px-3 py-2 font-mono text-ink-muted">{a.name}</td>
                        <td className="px-3 py-2 font-mono text-ink">{a.type}</td>
                        <td className="px-3 py-2 font-mono text-ink-muted">{a.ttl}s</td>
                        <td className="px-3 py-2 font-mono text-ink break-all">{a.data}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}
      </div>

      <div className="mt-6 rounded-card border border-line bg-surface/50 p-5 text-sm leading-relaxed text-ink-muted">
        <h2 className="mb-1.5 text-sm font-semibold text-ink">About this lookup</h2>
        <p>
          Queries are sent over DNS-over-HTTPS to{" "}
          <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">dns.google</code>, so they're
          encrypted in transit and resolved fresh — bypassing any cached records on your local
          machine. Results reflect what a public resolver currently sees, which may differ from
          a recently changed zone that hasn't fully propagated.
        </p>
      </div>
    </ToolLayout>
  );
}
