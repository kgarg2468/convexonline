import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./format";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export const useIsNarrow = () => useMediaQuery("(max-width: 900px)");

export type AsyncState = { busy: boolean; error: string | null };

/**
 * Wraps a mutation call so buttons can disable while pending and show the
 * server's message on failure without each component re-implementing it.
 */
export function useAsyncAction() {
  const [state, setState] = useState<AsyncState>({ busy: false, error: null });
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setState({ busy: true, error: null });
    try {
      const result = await fn();
      setState({ busy: false, error: null });
      return result;
    } catch (error) {
      setState({ busy: false, error: errorMessage(error) });
      return undefined;
    }
  }, []);
  const clear = useCallback(() => setState((s) => ({ ...s, error: null })), []);
  return { ...state, run, clear };
}

export function useStoredState<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (window.localStorage.getItem(key) as T | null) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* storage unavailable; state still updates */
      }
    },
    [key],
  );
  return [value, set];
}

/** Re-renders on an interval so relative times and claim countdowns stay honest. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
