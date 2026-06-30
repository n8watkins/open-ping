import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Github, Loader2, Mail, X } from "lucide-react";
import { Logo } from "../Logo";
import { api } from "../../lib/api";
import { useBootstrap } from "../../lib/bootstrap";

/**
 * Accessible sign-in modal for the marketing landing page.
 *
 * Mirrors the provider logic in pages/Login.tsx but is fully self-contained so
 * the landing page can offer sign-in without a full-page navigation. /login
 * remains a working deep-link fallback.
 *
 * Accessibility: role="dialog" + aria-modal, labelled by its heading, Escape to
 * close, click-backdrop to close, a Tab focus-trap, focus restored to the
 * trigger on close, and body scroll locked while open.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SignInModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { status } = useBootstrap();
  const githubEnabled = status?.githubEnabled ?? false;
  const emailEnabled = status?.emailAdminConfigured ?? false;

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Reset transient form state whenever the modal is dismissed.
  useEffect(() => {
    if (!open) {
      setEmail("");
      setSubmitting(false);
      setSent(false);
      setEmailError(null);
    }
  }, [open]);

  // Focus trap, Escape handling, scroll lock, and focus restoration.
  useEffect(() => {
    if (!open) return;

    previousFocus.current = document.activeElement as HTMLElement | null;

    const getFocusable = () => {
      const node = dialogRef.current;
      if (!node) return [] as HTMLElement[];
      return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    };

    // Defer initial focus so the portal node is mounted.
    const focusTimer = window.setTimeout(() => {
      getFocusable()[0]?.focus();
    }, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = getFocusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      previousFocus.current?.focus?.();
    };
  }, [open, onClose]);

  const requestMagicLink = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setSubmitting(true);
      setEmailError(null);
      try {
        // The server always responds { ok: true } regardless of whether the
        // address is allowed, so we show the same generic confirmation either way.
        await api("/api/auth/magic/request", { method: "POST", json: { email } });
        setSent(true);
      } catch (err) {
        setEmailError(
          err instanceof Error
            ? err.message
            : "Could not send a sign-in link. Please try again.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [email],
  );

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <style>{`
        @keyframes op-modal-backdrop-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes op-modal-panel-in {
          from { opacity: 0; transform: translateY(12px) scale(0.97) }
          to { opacity: 1; transform: translateY(0) scale(1) }
        }
        .op-modal-backdrop { animation: op-modal-backdrop-in .2s ease-out both }
        .op-modal-panel { animation: op-modal-panel-in .26s cubic-bezier(.16,1,.3,1) both }
        @media (prefers-reduced-motion: reduce) {
          .op-modal-backdrop, .op-modal-panel { animation: none !important }
        }
      `}</style>

      {/* Backdrop: click to dismiss. Hidden from AT — keyboard users dismiss via
          Escape or the labelled close button, so AT isn't shown two controls. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="op-modal-backdrop absolute inset-0 bg-canvas/80 backdrop-blur-sm"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-modal-title"
        className="op-modal-panel relative z-10 w-full max-w-sm rounded-card border border-line bg-surface p-6 shadow-2xl shadow-black/50"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3.5 top-3.5 grid size-9 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X className="size-4" />
        </button>

        <div className="flex justify-center">
          <Logo />
        </div>

        <h2
          id="signin-modal-title"
          className="mt-4 text-center text-lg font-semibold tracking-tight text-ink"
        >
          Sign in
        </h2>
        <p className="mt-1 text-center text-sm text-ink-muted">
          OpenPing is single-administrator. Only the configured identity can sign in.
        </p>

        <div className="mt-6 space-y-3">
          {githubEnabled ? (
            <a
              href="/auth/github/start"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-opacity hover:opacity-90"
            >
              <Github className="size-4" />
              Continue with GitHub
            </a>
          ) : (
            <button
              type="button"
              disabled
              title="GitHub sign-in isn't configured on this installation."
              className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-canvas opacity-40"
            >
              <Github className="size-4" />
              Continue with GitHub
            </button>
          )}

          {emailEnabled &&
            (sent ? (
              <p className="rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-center text-sm text-up">
                If that address is allowed, a sign-in link has been sent.
              </p>
            ) : (
              <form onSubmit={(e) => void requestMagicLink(e)} className="space-y-2">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  aria-label="Email address"
                  className="input"
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-line disabled:opacity-40"
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Mail className="size-4" />
                  )}
                  Email magic link
                </button>
                {emailError && (
                  <p className="text-center text-sm text-down">{emailError}</p>
                )}
              </form>
            ))}

          {!githubEnabled && !emailEnabled && (
            <p className="rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-center text-sm text-ink-muted">
              No sign-in options are configured on this installation yet.
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          Self-hosted on your own Cloudflare account.
        </p>
      </div>
    </div>,
    document.body,
  );
}
