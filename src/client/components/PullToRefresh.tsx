import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import { cn } from "../lib/cn";
import { PAGE_REFRESHED_EVENT, PULL_THRESHOLD, decidePull, pullDistance, shouldRefresh, type PullDecision } from "../lib/pull-to-refresh";
import { isShowingSavedData } from "../lib/offline";

/** Shortest time the spinner shows, so a fast refresh still reads as one. */
const MIN_SPIN_MS = 450;
/** The indicator's own size (px), parked just out of sight above its slot. */
const INDICATOR = 40;

/**
 * Why a touch here can't start a pull: it is inside something that scrolls on
 * its own and isn't at its top, a fixed panel (a sheet, a menu), or a field.
 */
function blocksPull(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.matches("input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-no-pull]")) return true;
    const style = getComputedStyle(el);
    if (style.position === "fixed") return true;
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight && el.scrollTop > 0) return true;
    el = el.parentElement;
  }
  return false;
}

function pageScrollTop(): number {
  return document.scrollingElement?.scrollTop ?? window.scrollY;
}

/**
 * Pull down from the top of the page to refresh it, on touch screens.
 *
 * Render it once on a page and pass what reloads that page's data. It listens
 * to touches on the whole document, starts only at the very top of the page
 * and only for a downward one-finger drag, so it never fights a scroll, a
 * sideways chart swipe or a scrolling panel. The shell turns off the browser's
 * own pull-to-refresh (overscroll-behavior in index.css). It also refreshes
 * when the connection comes back while the page shows saved data.
 */
export function PullToRefresh({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);

  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);
  const refreshingRef = useRef(false);

  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    let decision: PullDecision = "undecided";
    let current = 0;

    async function run() {
      refreshingRef.current = true;
      setRefreshing(true);
      setDistance(PULL_THRESHOLD);
      const began = Date.now();
      try {
        await onRefreshRef.current();
        window.dispatchEvent(new Event(PAGE_REFRESHED_EVENT));
      } catch {
        // The page shows its own error state.
      } finally {
        const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - began));
        window.setTimeout(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          setDistance(0);
        }, wait);
      }
    }

    function reset() {
      start = null;
      decision = "undecided";
      current = 0;
      setDragging(false);
    }

    function onStart(e: TouchEvent) {
      if (refreshingRef.current || e.touches.length !== 1 || pageScrollTop() > 0 || blocksPull(e.target)) {
        start = null;
        return;
      }
      const t = e.touches[0]!;
      start = { x: t.clientX, y: t.clientY };
      decision = "undecided";
      current = 0;
    }

    function onMove(e: TouchEvent) {
      if (!start) return;
      if (e.touches.length !== 1) {
        reset();
        setDistance(0);
        return;
      }
      const t = e.touches[0]!;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (decision === "undecided") {
        decision = decidePull(dx, dy);
        if (decision === "ignore") {
          start = null;
          return;
        }
        if (decision === "undecided") return;
        setDragging(true);
      }
      // A pull: the page stays put and the indicator follows the finger.
      if (e.cancelable) e.preventDefault();
      current = pullDistance(dy);
      setDistance(current);
    }

    function onEnd() {
      if (!start) return;
      const pulled = decision === "pull";
      const release = current;
      reset();
      if (pulled && shouldRefresh(release)) void run();
      else setDistance(0);
    }

    function onOnline() {
      if (isShowingSavedData() && !refreshingRef.current) void run();
    }

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onEnd, { passive: true });
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const progress = Math.min(1, distance / PULL_THRESHOLD);
  const visible = distance > 0 || refreshing;

  // On <body>: the page's entrance animation would otherwise make its wrapper
  // the containing block for this fixed indicator.
  return createPortal(
    <>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none fixed left-1/2 z-10 -ml-5 grid size-10 place-items-center rounded-full border border-line bg-surface text-accent shadow-lg",
          // Just under the phone's top bar; at the very top where there is none.
          "top-[calc(3.5rem+env(safe-area-inset-top))] md:top-[env(safe-area-inset-top)]",
          !dragging && "transition-[transform,opacity] duration-200 ease-out-quart",
        )}
        style={{
          transform: `translateY(${distance - INDICATOR + 8}px)`,
          opacity: visible ? Math.max(0.35, progress) : 0,
        }}
      >
        <RefreshCw
          className={cn("size-[18px]", refreshing && "animate-spin")}
          style={refreshing ? undefined : { transform: `rotate(${progress * 270}deg)` }}
        />
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {refreshing ? "Refreshing" : ""}
      </span>
    </>,
    document.body,
  );
}
