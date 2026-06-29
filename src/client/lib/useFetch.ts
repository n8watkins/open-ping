import { useCallback, useEffect, useState } from "react";
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

  const reload = useCallback(async () => {
    if (path === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setLoading(false);
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
    let ignore = false;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (!ignore) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!ignore) setError(e instanceof Error ? e.message : "error");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [path]);

  return { data, loading, error, reload };
}
