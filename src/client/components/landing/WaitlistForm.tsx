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

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  // The honeypot: hidden from people (and from screen readers), so only a bot fills it in.
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setState({ kind: "sending" });
    try {
      const res = await fetch(WAITLIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website }),
      });
      if (res.ok) return setState({ kind: "done" });
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
        You're on the list. I'll email you once, when Hosted opens.
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
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={state.kind === "sending" || email.trim() === ""}
          className="op-lift inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
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
        <p role="alert" className="mt-2 text-sm text-down">
          {state.message}
        </p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-ink-faint">
        Just your email, used once to tell you when Hosted opens. No newsletter, never shared.
      </p>
    </form>
  );
}
