import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check } from "lucide-react";

/**
 * The OpenPing Hosted waitlist form. Every install serves this landing page, so
 * it always posts to the canonical install, which is the only one that stores
 * sign-ups (WAITLIST_ENABLED). Override with VITE_WAITLIST_URL in development.
 */
export const WAITLIST_URL =
  (import.meta as ImportMeta & { env?: { VITE_WAITLIST_URL?: string } }).env?.VITE_WAITLIST_URL ??
  "https://openping.n8builds.dev/api/waitlist";

/** Cloudflare Turnstile's script; the server's CSP allows this origin (src/worker/security-headers.ts). */
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      theme: "auto";
      size: "flexible";
      appearance: "interaction-only";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
    },
  ): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Loads Turnstile's script once and resolves with its API. */
function loadTurnstile(): Promise<TurnstileApi> {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    let script = document.querySelector<HTMLScriptElement>("script[data-turnstile]");
    if (!script) {
      script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.dataset.turnstile = "";
      document.head.appendChild(script);
    }
    script.addEventListener("load", () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile_missing"))));
    script.addEventListener("error", () => reject(new Error("turnstile_blocked")));
  });
}

/**
 * What the OpenPing website does with a waitlist address: section 13 of the
 * privacy policy (docs/legal/PRIVACY.md). Its GitHub copy until the Hosted
 * domain serves it at app.<domain>/privacy.
 */
export const PRIVACY_NOTICE_URL = "https://github.com/n8watkins/open-ping/blob/main/docs/legal/PRIVACY.md#13-the-openping-website-openpingn8buildsdev";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string };

/** A light check before posting; the server validates for real. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WaitlistForm({ onJoined }: { onJoined?: () => void } = {}) {
  const [email, setEmail] = useState("");
  // The honeypot: hidden from people (and from screen readers), so only a bot fills it in.
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  // Turnstile, when the canonical install has its keys set (GET /api/waitlist/config):
  // an invisible check that only shows a challenge to a visitor who needs one.
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const challenge = useRef<HTMLDivElement>(null);
  const widget = useRef<string | undefined>(undefined);
  const token = useRef("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${WAITLIST_URL}/config`);
        if (!res.ok) return;
        const config = (await res.json()) as { turnstileSiteKey?: string | null };
        if (!cancelled && config.turnstileSiteKey) setSiteKey(config.turnstileSiteKey);
      } catch {
        // Without the config the form still posts; the server decides.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!siteKey || !challenge.current) return;
    let cancelled = false;
    const container = challenge.current;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled) return;
        widget.current = turnstile.render(container, {
          sitekey: siteKey,
          theme: "auto",
          size: "flexible",
          appearance: "interaction-only",
          callback: (t) => {
            token.current = t;
          },
          "error-callback": () => {
            token.current = "";
          },
          "expired-callback": () => {
            token.current = "";
          },
        });
      })
      .catch(() => setState({ kind: "error", message: "The human check couldn't load. Turn off content blockers for this page and reload." }));
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = undefined;
      token.current = "";
    };
  }, [siteKey]);

  /** A token works once, so every try after the first needs a fresh one. */
  function resetChallenge() {
    token.current = "";
    if (widget.current) window.turnstile?.reset(widget.current);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (state.kind === "sending") return;
    // The button stays enabled (a dimmed one reads as broken), so check here.
    if (!LOOKS_LIKE_EMAIL.test(email.trim())) {
      setState({ kind: "error", message: "Enter your email address, like you@company.com." });
      return;
    }
    if (siteKey && !token.current) {
      setState({ kind: "error", message: "Still checking that you're human. Try again in a moment." });
      return;
    }
    setState({ kind: "sending" });
    try {
      const res = await fetch(WAITLIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website, ...(token.current ? { turnstile: token.current } : {}) }),
      });
      if (res.ok) {
        onJoined?.();
        return setState({ kind: "done" });
      }
      resetChallenge();
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "turnstile_failed") {
          return setState({ kind: "error", message: "We couldn't confirm you're human. Please try again." });
        }
        return setState({ kind: "error", message: "That doesn't look like an email address." });
      }
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
        Check your inbox for a link to confirm your spot. Then one email when Hosted opens, nothing else.
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
      {siteKey && <div ref={challenge} className="mt-2 empty:hidden" />}
      {state.kind === "error" && (
        <p id="waitlist-error" role="alert" className="mt-2 text-sm text-down">
          {state.message}
        </p>
      )}
      <p id="waitlist-note" className="mt-3 text-xs leading-relaxed text-ink-faint">
        No date yet. Confirm your address from one email, then I'll email you once when it opens, with early pricing. No newsletter, never shared.{" "}
        <a href={PRIVACY_NOTICE_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
          Privacy notice
        </a>
      </p>
    </form>
  );
}
