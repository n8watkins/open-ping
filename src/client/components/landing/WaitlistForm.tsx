import { useState, type FormEvent } from "react";
import { ArrowRight, Check } from "lucide-react";

/**
 * The OpenPing Hosted waitlist form. Every install serves this landing page, so
 * it always posts to the canonical install, which is the only one that stores
 * sign-ups (WAITLIST_ENABLED). Override with VITE_WAITLIST_URL in development.
 */
export const WAITLIST_URL =
  (import.meta as ImportMeta & { env?: { VITE_WAITLIST_URL?: string } }).env?.VITE_WAITLIST_URL ??
  "https://openping.n8builds.dev/api/waitlist";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string };

/** A light check before posting; the server validates for real. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WaitlistForm({ onJoined }: { onJoined?: () => void } = {}) {
  const [email, setEmail] = useState("");
  // The honeypot: hidden from people (and from screen readers), so only a bot fills it in.
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (state.kind === "sending") return;
    // The button stays enabled (a dimmed one reads as broken), so check here.
    if (!LOOKS_LIKE_EMAIL.test(email.trim())) {
      setState({ kind: "error", message: "Enter your email address, like you@company.com." });
      return;
    }
    setState({ kind: "sending" });
    try {
      const res = await fetch(WAITLIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website }),
      });
      if (res.ok) {
        onJoined?.();
        return setState({ kind: "done" });
      }
      if (res.status === 400) return setState({ kind: "error", message: "That doesn't look like an email address." });
      if (res.status === 429) return setState({ kind: "error", message: "Too many tries. Give it a minute and try again." });
      setState({ kind: "error", message: "The waitlist isn't taking sign-ups right now. Try again later." });
    } catch {
      setState({ kind: "error", message: "Couldn't reach the waitlist. Check your connection and try again." });
    }
  }

  if (state.kind === "done") {
    return (
      <p role="status" className="flex items-center gap-2 rounded-lg border border-up/40 bg-up/10 px-4 py-3 text-sm font-medium text-ink">
        <Check className="size-4 shrink-0 text-up" />
        You're on the list. One email when Hosted opens, nothing else.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <label htmlFor="waitlist-email" className="sr-only">
        Email address
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="waitlist-email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={state.kind === "error" ? true : undefined}
          aria-describedby={state.kind === "error" ? "waitlist-error waitlist-note" : "waitlist-note"}
          className="h-11 w-full min-w-0 rounded-lg sm:flex-1 border border-line bg-canvas px-3.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          aria-disabled={state.kind === "sending" ? true : undefined}
          className="op-lift inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-accent/50 bg-accent-soft px-4 text-sm font-semibold text-ink hover:border-accent hover:bg-accent/20"
        >
          {state.kind === "sending" ? "Joining..." : "Join the waitlist"}
          <ArrowRight className="size-4" />
        </button>
      </div>
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="waitlist-website">Website</label>
        <input
          id="waitlist-website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>
      {state.kind === "error" && (
        <p id="waitlist-error" role="alert" className="mt-2 text-sm text-down">
          {state.message}
        </p>
      )}
      <p id="waitlist-note" className="mt-3 text-xs leading-relaxed text-ink-faint">
        No date yet. I'll email you once when it opens, with early pricing. No newsletter, never shared.
      </p>
    </form>
  );
}
