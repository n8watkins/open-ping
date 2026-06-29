import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** Minimal GET-and-cache hook. Pass null to skip fetching. */
export function useFetch<T>(path: string | null): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);

  // Monotonic token shared by the effect and `reload`: every request claims the
  // next value and only commits if it is still the latest. The effect cleanup
  // bumps it on unmount/path change so no in-flight request (including a stale
  // `reload` bound to an old path) can setState after unmount or clobber newer
  // data.
  const tokenRef = useRef(0);

  const reload = useCallback(async () => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const token = ++tokenRef.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (tokenRef.current !== token) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (tokenRef.current !== token) return;
      setError(e instanceof Error ? e.message : "error");
    } finally {
      if (tokenRef.current === token) setLoading(false);
    }
  }, [path]);

  // Fetch on path change with an out-of-order guard: a slow earlier response
  // must not overwrite a newer one (e.g. on rapid filter changes). `reload`
  // stays available for user-triggered refreshes.
  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const token = ++tokenRef.current;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (tokenRef.current === token) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (tokenRef.current === token) {
          setError(e instanceof Error ? e.message : "error");
        }
      })
      .finally(() => {
        if (tokenRef.current === token) setLoading(false);
      });
    return () => {
      // Invalidate this effect's request and any in-flight `reload` so neither
      // commits after the path changes or the component unmounts.
      tokenRef.current++;
    };
  }, [path]);

  return { data, loading, error, reload };
}
