import { Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * For the few actions that cannot be undone (revoking a token, removing a passkey, signing
 * out). A native modal <dialog>: the page behind is inert, Escape cancels and focus returns to
 * the button that opened it. The confirm button names the action.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy = false,
  error,
  tone = "danger",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  /** "danger" for destroying something; "default" for a weighty but harmless change. */
  tone?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-2xl shadow-black/60 backdrop:bg-canvas/70 backdrop:backdrop-blur-sm"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <div id={bodyId} className="mt-2 space-y-2 text-sm text-ink-muted">
          {children}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-down">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={onCancel}
            className="min-h-11 rounded-lg border border-line px-4 text-sm font-medium text-ink-muted transition-colors hover:border-ink-faint hover:text-ink disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={
              "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors disabled:opacity-60 " +
              (tone === "danger" ? "bg-down text-canvas hover:bg-down/85" : "bg-accent text-canvas hover:bg-accent-hover")
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** State for one ConfirmDialog: which item it asks about, and the running request. */
export function useConfirm<T>() {
  const [target, setTarget] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    target,
    busy,
    error,
    ask: (item: T) => {
      setError(null);
      setTarget(item);
    },
    cancel: () => {
      if (!busy) setTarget(null);
    },
    /** Runs the action; closes on success, keeps the dialog open with the message on failure. */
    run: async (action: (item: T) => Promise<unknown>, failure: (e: unknown) => string) => {
      if (target === null) return;
      setBusy(true);
      setError(null);
      try {
        await action(target);
        setTarget(null);
      } catch (e) {
        setError(failure(e));
      } finally {
        setBusy(false);
      }
    },
  };
}
