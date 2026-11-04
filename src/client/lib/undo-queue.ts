// The state behind "Deleted · Undo" toasts, kept free of React and the DOM so it can be tested.
//
// Each entry is an action that already happened in the UI. While its toast shows the user can
// undo it; once the toast times out, is dismissed, or the page is hidden, the entry commits
// (the server drops a soft-deleted row for good). Undo and commit each run once.

export const UNDO_TOAST_MS = 6_000;
export const MAX_VISIBLE_TOASTS = 3;

export type UndoEntry = {
  id: string;
  message: string;
  /** Restores what the action removed. A rejection keeps the toast closed and reports the error. */
  undo: () => Promise<void> | void;
  /** Makes the action final. Called at most once, never after undo. */
  commit?: () => Promise<void> | void;
};

export type UndoToast = { id: string; message: string };

type Timer = ReturnType<typeof setTimeout>;

type Scheduler = {
  setTimeout: (callback: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer) => void;
  now: () => number;
};

type Pending = UndoEntry & { remaining: number; startedAt: number; timer: Timer | null };

export function createUndoQueue(options: {
  onChange: (toasts: UndoToast[]) => void;
  onUndoError?: (entry: UndoToast, error: unknown) => void;
  duration?: number;
  maxVisible?: number;
  scheduler?: Scheduler;
}) {
  const duration = options.duration ?? UNDO_TOAST_MS;
  const maxVisible = options.maxVisible ?? MAX_VISIBLE_TOASTS;
  const scheduler: Scheduler = options.scheduler ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (timer) => clearTimeout(timer), now: () => Date.now() };
  let entries: Pending[] = [];
  let paused = false;

  const publish = () => options.onChange(entries.map(({ id, message }) => ({ id, message })));

  function arm(entry: Pending) {
    if (paused || entry.timer) return;
    entry.startedAt = scheduler.now();
    entry.timer = scheduler.setTimeout(() => finish(entry.id), entry.remaining);
  }

  function disarm(entry: Pending) {
    if (!entry.timer) return;
    scheduler.clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = Math.max(0, entry.remaining - (scheduler.now() - entry.startedAt));
  }

  function take(id: string) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return null;
    disarm(entry);
    entries = entries.filter((item) => item.id !== id);
    publish();
    return entry;
  }

  /**
   * Closes a toast and commits its action. The commit starts synchronously: during pagehide
   * a request (keepalive) must be started before the handler returns or it may never be sent.
   */
  function finish(id: string) {
    const entry = take(id);
    if (!entry?.commit) return;
    try {
      void Promise.resolve(entry.commit()).catch(() => undefined);
    } catch {
      // A commit that throws synchronously is treated like one that rejected.
    }
  }

  return {
    push(entry: UndoEntry) {
      // Re-pushing an id replaces the old toast; the old action is committed first.
      if (entries.some((item) => item.id === entry.id)) finish(entry.id);
      const pending: Pending = { ...entry, remaining: duration, startedAt: scheduler.now(), timer: null };
      entries = [...entries, pending];
      // Older toasts beyond the visible stack are committed rather than silently kept.
      for (let oldest = entries[0]; oldest && entries.length > maxVisible; oldest = entries[0]) finish(oldest.id);
      arm(pending);
      publish();
    },
    async undo(id?: string) {
      const target = id ?? entries.at(-1)?.id;
      if (!target) return false;
      const entry = take(target);
      if (!entry) return false;
      try {
        await entry.undo();
        return true;
      } catch (error) {
        options.onUndoError?.({ id: entry.id, message: entry.message }, error);
        return false;
      }
    },
    dismiss(id: string) { finish(id); },
    /** Commits everything now, e.g. when the page is being hidden or closed. */
    flush() { for (const entry of [...entries]) finish(entry.id); },
    /** Stops every countdown while the pointer or keyboard focus is on the toasts. */
    pause() { paused = true; for (const entry of entries) disarm(entry); },
    resume() { paused = false; for (const entry of entries) arm(entry); },
    get size() { return entries.length; },
  };
}

export type UndoQueue = ReturnType<typeof createUndoQueue>;
