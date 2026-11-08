import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUndoQueue, UNDO_TOAST_MS, type UndoToast } from "./undo-queue";

function setup(options: { maxVisible?: number } = {}) {
  let toasts: UndoToast[] = [];
  const undoErrors: string[] = [];
  const queue = createUndoQueue({ onChange: (next) => { toasts = next; }, onUndoError: (entry) => undoErrors.push(entry.id), ...options });
  return { queue, toasts: () => toasts, undoErrors };
}

// Commits run a microtask after the toast closes; a few turns of the queue let them land.
const flushPromises = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe("undo queue", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("commits an action once its toast times out", async () => {
    const { queue, toasts } = setup();
    const commit = vi.fn();
    const undo = vi.fn();
    queue.push({ id: "a", message: "Monitor deleted", undo, commit });
    expect(toasts()).toEqual([{ id: "a", message: "Monitor deleted" }]);
    vi.advanceTimersByTime(UNDO_TOAST_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it("undo restores and never commits", async () => {
    const { queue, toasts } = setup();
    const commit = vi.fn();
    const undo = vi.fn();
    queue.push({ id: "a", message: "Monitor deleted", undo, commit });
    await expect(queue.undo("a")).resolves.toBe(true);
    vi.advanceTimersByTime(UNDO_TOAST_MS * 2);
    await flushPromises();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
    await expect(queue.undo("a")).resolves.toBe(false);
  });

  it("undo without an id targets the newest toast, as Ctrl+Z does", async () => {
    const { queue } = setup();
    const first = vi.fn();
    const second = vi.fn();
    queue.push({ id: "a", message: "A deleted", undo: first });
    queue.push({ id: "b", message: "B deleted", undo: second });
    await queue.undo();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
  });

  it("reports a failed undo and keeps the action from committing twice", async () => {
    const { queue, undoErrors } = setup();
    const commit = vi.fn();
    queue.push({ id: "a", message: "A deleted", undo: () => Promise.reject(new Error("gone")), commit });
    await expect(queue.undo("a")).resolves.toBe(false);
    expect(undoErrors).toEqual(["a"]);
    vi.advanceTimersByTime(UNDO_TOAST_MS);
    await flushPromises();
    expect(commit).not.toHaveBeenCalled();
  });

  it("pausing stops the countdown and resuming continues from where it stopped", async () => {
    const { queue } = setup();
    const commit = vi.fn();
    queue.push({ id: "a", message: "A deleted", undo: vi.fn(), commit });
    vi.advanceTimersByTime(4_000);
    queue.pause();
    vi.advanceTimersByTime(60_000);
    await flushPromises();
    expect(commit).not.toHaveBeenCalled();
    queue.resume();
    vi.advanceTimersByTime(UNDO_TOAST_MS - 4_000 - 1);
    await flushPromises();
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("keeps a short stack and commits the oldest toast when it overflows", async () => {
    const { queue, toasts } = setup({ maxVisible: 2 });
    const commits: string[] = [];
    for (const id of ["a", "b", "c"]) queue.push({ id, message: `${id} deleted`, undo: vi.fn(), commit: () => { commits.push(id); } });
    await flushPromises();
    expect(toasts().map((toast) => toast.id)).toEqual(["b", "c"]);
    expect(commits).toEqual(["a"]);
  });

  it("flush commits everything at once, as when the page is hidden", async () => {
    const { queue, toasts } = setup();
    const commits: string[] = [];
    for (const id of ["a", "b"]) queue.push({ id, message: `${id} deleted`, undo: vi.fn(), commit: () => { commits.push(id); } });
    queue.flush();
    await flushPromises();
    expect(commits).toEqual(["a", "b"]);
    expect(toasts()).toEqual([]);
  });

  it("dismiss closes one toast and commits it", async () => {
    const { queue, toasts } = setup();
    const commit = vi.fn();
    queue.push({ id: "a", message: "A deleted", undo: vi.fn(), commit });
    queue.push({ id: "b", message: "B deleted", undo: vi.fn() });
    queue.dismiss("a");
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(toasts().map((toast) => toast.id)).toEqual(["b"]);
  });
});
