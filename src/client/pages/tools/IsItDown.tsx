import { useState, type FormEvent } from "react";
import { Activity, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { ToolLayout, Panel, ResultRow, Notice } from "./ToolLayout";

/** Shape returned by POST /api/tools/is-it-down. */
interface CheckResponse {
  up: boolean;
  status: number | null;
  durationMs: number;
  error?: string;
}

/** A resolved check outcome the UI renders, plus the URL it was run against. */
interface Outcome extends CheckResponse {
  url: string;
}

/**
 * Ensure the input is a fetchable http(s) URL: add a scheme when the user typed
 * a bare host ("example.com"), and reject anything that still won't parse. Kept
 * lenient — the worker re-validates and applies the SSRF guard authoritatively.
 */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Map a machine error code from the worker to a friendly, human sentence. */
function describeError(code: string | undefined): string {
  switch (code) {
    case "timeout":
      return "The request timed out before the server responded.";
    case "dns_error":
      return "The domain name couldn't be resolved (DNS lookup failed).";
    case "tls_error":
      return "The TLS/SSL handshake failed (certificate or protocol problem).";
    case "too_many_redirects":
      return "The site redirected too many times.";
    case "blocked_url":
      return "A redirect pointed to a private or internal address and was blocked.";
    case "server_error":
      return "The server responded, but with a 5xx server error.";
    case "unreachable":
    case "network_error":
    default:
      return "The server couldn't be reached.";
  }
}

export default function IsItDown() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError("Enter a valid http(s) URL, e.g. https://example.com.");
      setOutcome(null);
      return;
    }

    setLoading(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await fetch("/api/tools/is-it-down", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });

      if (res.status === 429) {
        setError("You're checking too quickly. Wait a minute and try again.");
        return;
      }
      const data = (await res.json().catch(() => null)) as CheckResponse | { error?: string } | null;
      if (res.status === 400) {
        const code = data && "error" in data ? data.error : undefined;
        setError(
          code === "blocked_url"
            ? "That URL can't be checked — it points to a private, loopback, or internal address."
            : "Enter a valid http(s) URL, e.g. https://example.com.",
        );
        return;
      }
      if (!res.ok || !data || !("up" in data)) {
        setError("The check couldn't be completed. Please try again.");
        return;
      }
      setOutcome({ ...(data as CheckResponse), url: normalized });
    } catch {
      setError("The check couldn't be completed. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ToolLayout
      icon={Activity}
      title="Is it down?"
      intro="Check whether a website or API is reachable right now. We send a single request from our servers and report whether it responded, its HTTP status, and how long it took."
    >
      <Panel>
        <form onSubmit={(e) => void onSubmit(e)}>
          <label htmlFor="iid-url" className="block text-sm font-medium text-ink">
            Website or API URL
          </label>
          <div className="mt-2 grid gap-3 sm:grid-cols-[1fr_auto]">
            <input
              id="iid-url"
              type="text"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="input font-mono"
              aria-describedby="iid-hint"
            />
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-canvas transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Activity className="size-4" />
              )}
              {loading ? "Checking…" : "Check"}
            </button>
          </div>
          <p id="iid-hint" className="mt-2 text-xs text-ink-faint">
            Only public http(s) URLs can be checked. Private, loopback, and
            internal addresses are blocked.
          </p>
        </form>
      </Panel>

      <div className="mt-6" aria-live="polite">
        {error && <Notice>{error}</Notice>}

        {!error && outcome && (
          <Panel>
            <div
              className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
                outcome.up
                  ? "border-up/40 bg-up/10 text-up"
                  : "border-down/40 bg-down/10 text-down"
              }`}
            >
              {outcome.up ? (
                <CheckCircle2 className="size-6 shrink-0" aria-hidden="true" />
              ) : (
                <XCircle className="size-6 shrink-0" aria-hidden="true" />
              )}
              <div>
                <p className="text-base font-semibold">
                  {outcome.up ? "It's up" : "It looks down"}
                </p>
                <p className="text-sm opacity-90">
                  <span className="break-all font-mono">{outcome.url}</span>
                </p>
              </div>
            </div>

            <dl className="mt-4">
              <ResultRow label="Status">
                {outcome.up ? "Reachable" : "Not reachable"}
              </ResultRow>
              <ResultRow label="HTTP status code">
                {outcome.status ?? "—"}
              </ResultRow>
              <ResultRow label="Response time">
                {Math.round(outcome.durationMs)} ms
              </ResultRow>
              {!outcome.up && (
                <ResultRow label="Reason">{describeError(outcome.error)}</ResultRow>
              )}
            </dl>
          </Panel>
        )}
      </div>

      <div className="mt-6 rounded-card border border-line bg-surface/50 p-5 text-sm leading-relaxed text-ink-muted">
        <h2 className="mb-1.5 text-sm font-semibold text-ink">How this works</h2>
        <p>
          The check runs from OpenPing's servers, not your browser, so it reflects
          whether the site is reachable from the public internet — a result
          independent of your own network or DNS cache. A site can be up for us
          but down for you (or the reverse). We report only whether it responded,
          its status code, and the response time; we never return the page
          contents. If a site is only up here, the problem is likely local to
          your connection.
        </p>
      </div>
    </ToolLayout>
  );
}
