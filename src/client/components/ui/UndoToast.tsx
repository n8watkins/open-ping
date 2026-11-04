import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createUndoQueue, type UndoQueue, type UndoToast } from "../../lib/undo-queue";

// "Monitor deleted · Undo". A delete hides the item at once and shows this toast; the request
// to the server is only sent when the toast closes (after about six seconds), when it is
// dismissed, or when the tab is hidden or closed (a keepalive request then outlives the page).
// Undo just cancels the request, so the item comes back exactly as it was. If the tab dies
// without a chance to send it, the item simply is not deleted: nothing is ever lost by mistake.

type DeleteLater = {
  /** Keys of what is being deleted, e.g. "monitor:<id>"; views hide them while pending. */
  keys: string[];
  /** "Monitor deleted", "3 monitors deleted", ... */
  message: string;
  /** Sends the delete(s); pass `keepalive` on to fetch so it outlives a closing tab. */
  commit: (keepalive: boolean) => Promise<unknown>;
  /** Shown when the delete fails (the item reappears); a function gets the error. */
  failure?: string | ((error: unknown) => string);
};

type UndoApi = {
  deleteLater: (input: DeleteLater) => void;
  /** True once `key` is deleted in the UI: while its toast shows, and after (it is gone). */
  isPending: (key: string) => boolean;
};

const UndoContext = createContext<UndoApi | null>(null);

/** Fired after a delete reached the server or failed, so views reload their data. */
export const UNDO_SETTLED = "openping:undo-settled";

/** Reloads a view's data whenever a delete settles, wherever it was started. */
export function useReloadOnUndoSettled(reload: () => unknown) {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  useEffect(() => {
    const listener = () => void latest.current();
    window.addEventListener(UNDO_SETTLED, listener);
    return () => window.removeEventListener(UNDO_SETTLED, listener);
  }, []);
}

export function useUndo(): UndoApi {
  const value = useContext(UndoContext);
  if (!value) throw new Error("useUndo must be used inside UndoToastProvider");
  return value;
}

function isTextField(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}

export function UndoToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<UndoToast[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState("");
  const [queue] = useState<UndoQueue>(() => createUndoQueue({ onChange: setToasts }));

  const release = useCallback((keys: string[]) => {
    setPending((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    const flush = () => queue.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [queue]);

  useEffect(() => {
    // Ctrl/Cmd+Z undoes the newest toast while one shows, unless the user is typing.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      if (!queue.size || isTextField(e.target)) return;
      e.preventDefault();
      void queue.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue]);

  // The pointer or focus that paused the countdown leaves with the last toast.
  useEffect(() => {
    if (!toasts.length) queue.resume();
  }, [toasts, queue]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const deleteLater = useCallback(
    ({ keys, message, commit, failure }: DeleteLater) => {
      setNotice("");
      setPending((current) => new Set([...current, ...keys]));
      queue.push({
        id: keys.join(","),
        message,
        undo: () => release(keys),
        commit: async () => {
          try {
            await commit(true);
            // Deleted for good: the keys stay hidden, so a view that still holds the old
            // data never flashes the item back before it reloads.
          } catch (error) {
            release(keys);
            setNotice(
              (typeof failure === "function" ? failure(error) : failure) ??
                "Couldn't delete that, so it's back. Try again.",
            );
          }
          window.dispatchEvent(new Event(UNDO_SETTLED));
        },
      });
    },
    [queue, release],
  );

  const value = useMemo<UndoApi>(() => ({ deleteLater, isPending: (key) => pending.has(key) }), [deleteLater, pending]);

  return (
    <UndoContext.Provider value={value}>
      {children}
      {/* Above the phone tab bar (AppLayout), lower on wider screens. */}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-1/2 md:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-[60] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2"
        onPointerEnter={() => queue.pause()}
        onPointerLeave={() => queue.resume()}
        onFocus={() => queue.pause()}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) queue.resume();
        }}
      >
        {/* A polite live region: announced without taking focus. */}
        <div aria-live="polite" aria-relevant="additions text" className="flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="pointer-events-auto flex min-h-[52px] animate-enter items-center gap-1 rounded-xl border border-line bg-surface-2 py-1.5 pr-1.5 pl-4 text-sm text-ink shadow-2xl shadow-black/50"
            >
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t.message}</span>
              <button
                type="button"
                onClick={() => void queue.undo(t.id)}
                className="min-h-11 min-w-11 rounded-lg px-3.5 font-semibold text-accent transition-colors hover:bg-accent-soft hover:text-accent-hover"
              >
                Undo
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => queue.dismiss(t.id)}
                className="grid min-h-11 min-w-11 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          ))}
          {notice && (
            <div role="alert" className="pointer-events-auto animate-enter rounded-xl border border-down/40 bg-surface-2 px-4 py-3.5 text-sm text-ink shadow-2xl shadow-black/50">
              {notice}
            </div>
          )}
        </div>
      </div>
    </UndoContext.Provider>
  );
}
