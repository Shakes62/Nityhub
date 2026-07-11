"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/types/api";

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface UseAsyncData<T> extends AsyncState<T> {
  /** Re-run the fetcher (e.g. after a mutation). */
  reload: () => Promise<void>;
  /** Update the cached data locally without refetching. */
  setData: (updater: T) => void;
}

/**
 * Standardizes the "load data, show skeleton, handle error" pattern used by
 * every dashboard page. The fetcher re-runs when the serialized `deps` change,
 * and results from a superseded request are ignored to avoid race conditions.
 */
export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options: { enabled?: boolean } = {},
): UseAsyncData<T> {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: enabled,
    error: null,
  });
  const requestId = useRef(0);

  // Keep the latest fetcher without making it a hook dependency, so callers can
  // pass inline closures without triggering refetch loops. Written in an effect
  // (not during render) to respect the rules of refs.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await fetcherRef.current();
      if (id === requestId.current) {
        setState({ data: result, loading: false, error: null });
      }
    } catch (err) {
      if (id === requestId.current) {
        const message =
          err instanceof ApiError || err instanceof Error
            ? err.message
            : "Something went wrong";
        setState((prev) => ({ ...prev, loading: false, error: message }));
      }
    }
  }, []);

  const depsKey = JSON.stringify(deps);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    // Fetching from the server is a legitimate effect (synchronizing React with
    // an external system). The loading flag set inside run() is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run();
  }, [enabled, run, depsKey]);

  const setData = useCallback((updater: T) => {
    setState((prev) => ({ ...prev, data: updater }));
  }, []);

  return { ...state, reload: run, setData };
}
