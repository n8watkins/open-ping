import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Logo } from "../Logo";
import { SignInPanel } from "../SignInPanel";

/**
 * The owner sign-in dialog, opened from the landing page's footer. The form
 * itself is the same SignInPanel as /login, which stays the deep link.
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

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
      // Without scrolling, so a link that moved the page (to #pricing) stays put.
      previousFocus.current?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

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

      {/* Backdrop: click to dismiss. Hidden from AT: keyboard users dismiss via
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
        className="op-modal-panel relative z-10 w-full max-h-[calc(100dvh-2rem)] max-w-sm overflow-y-auto rounded-card border border-line bg-surface p-6 shadow-2xl shadow-black/50"
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

        <div className="mt-4">
          <SignInPanel titleId="signin-modal-title" titleAs="h2" onNavigate={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
