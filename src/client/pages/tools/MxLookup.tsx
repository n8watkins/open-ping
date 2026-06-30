import { useState, type FormEvent } from "react";
import { Mail, Loader2 } from "lucide-react";
import { ToolLayout, Panel, Notice } from "./ToolLayout";
import { dohLookup, parseMxData, type DohResult } from "./lib";

export default function MxLookup() {
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DohResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queried, setQueried] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const name = domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!name) {
      setError("Enter a domain to look up.");
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setQueried(name);
    try {
      setResult(await dohLookup(name, "MX"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The MX lookup failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const servers = (result?.answers ?? [])
    .map((a) => parseMxData(a.data))
    .sort((a, b) => a.priority - b.priority);

  return (
    <ToolLayout
      icon={Mail}
      title="MX lookup"
      intro="Find the mail servers responsible for a domain, in priority order. Useful for diagnosing email delivery and verifying your MX records resolve correctly."
    >
      <Panel>
        <form onSubmit={(e) => void onSubmit(e)}>
          <label htmlFor="mx-domain" className="block text-sm font-medium text-ink">
            Domain
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input
              id="mx-domain"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="input font-mono"
            />
            <button
              type="submit"
              disabled={loading}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-canvas transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
              Find mail servers
            </button>
          </div>
        </form>
      </Panel>

      <div className="mt-6" aria-live="polite">
        {error && <Notice>{error}</Notice>}

        {!error && result && queried && (
          <Panel>
            <h2 className="mb-3 text-sm font-semibold text-ink">
              Mail servers for{" "}
              <span className="font-mono text-accent">{queried}</span>
            </h2>

            {servers.length === 0 ? (
              <Notice tone="info">
                No MX records found for this domain
                {result.status !== 0 ? ` — resolver returned ${result.statusText}.` : "."}{" "}
                Mail for it may be handled directly by its A/AAAA record, or it may not
                accept email.
              </Notice>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  <caption className="sr-only">MX records for {queried}</caption>
                  <thead>
                    <tr className="border-b border-line bg-surface-2/60 text-left text-xs uppercase tracking-wide text-ink-faint">
                      <th scope="col" className="px-4 py-2 font-medium">Priority</th>
                      <th scope="col" className="px-4 py-2 font-medium">Mail server</th>
                    </tr>
                  </thead>
                  <tbody>
                    {servers.map((s, i) => (
                      <tr key={i} className="border-b border-line/60 last:border-0">
                        <td className="px-4 py-2.5 font-mono text-ink-muted">{s.priority}</td>
                        <td className="px-4 py-2.5 font-mono text-ink break-all">{s.exchange}</td>
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
        <h2 className="mb-1.5 text-sm font-semibold text-ink">Reading MX records</h2>
        <p>
          A domain can list several mail servers. The lowest priority number is tried
          first; equal priorities are load-balanced. Lookups run client-side over
          DNS-over-HTTPS via Google's public resolver, so they reflect what the
          public DNS currently returns.
        </p>
      </div>
    </ToolLayout>
  );
}
