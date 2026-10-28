import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { isTimeRange, type TimeRange } from "../../shared/time-range";

const STORAGE_PREFIX = "openping:range:";

function readStored(page: string): TimeRange | null {
  try {
    const v = window.localStorage.getItem(STORAGE_PREFIX + page);
    return isTimeRange(v) ? v : null;
  } catch {
    // Storage can be blocked (private windows, strict settings); the URL still works.
    return null;
  }
}

function writeStored(page: string, range: TimeRange): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + page, range);
  } catch {
    // Best effort only.
  }
}

/**
 * The history range a page shows, kept in the `?range=` query so a link or a
 * reload shows the same view, and remembered per page in localStorage as a
 * convenience for the next visit. `page` names the memory ("overview",
 * "monitor"); the URL always wins over it.
 */
export function useTimeRange(
  page: string,
  fallback: TimeRange = "7d",
): [TimeRange, (next: TimeRange) => void] {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("range");
  const range: TimeRange = isTimeRange(fromUrl) ? fromUrl : (readStored(page) ?? fallback);

  const setRange = useCallback(
    (next: TimeRange) => {
      writeStored(page, next);
      setParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          sp.set("range", next);
          return sp;
        },
        { replace: true },
      );
    },
    [page, setParams],
  );

  return [range, setRange];
}
