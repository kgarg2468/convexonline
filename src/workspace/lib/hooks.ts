import { addTransitionType, startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage } from "./format";
import { formatRoute, landingRoute, parsePath, sameRoute, type NavTransition, type Route } from "./router";

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

/**
 * Set once the first workspace mount has read the address bar. Later mounts
 * (switching property re-keys the workspace) start on that inn's landing view
 * instead of re-reading a path that belonged to the previous one.
 */
let urlConsumed = false;

function replaceUrl(path: string) {
  try {
    window.history.replaceState(window.history.state, "", path + window.location.search + window.location.hash);
  } catch {
    /* history unavailable; state still updates */
  }
}

/**
 * The workspace route, derived from the pathname and kept in sync with
 * history. `navigate` pushes a new entry (or replaces the current one) and
 * applies the route inside a React transition tagged with `transition`, so
 * the `<ViewTransition>` around the routed view can animate by kind.
 * Back/forward restore the route through `popstate`. The fragment and query
 * string are never read or rewritten here.
 */
export function useRoute(isDemo: boolean): {
  route: Route;
  navigate: (to: Route, transition?: NavTransition, options?: { replace?: boolean }) => void;
} {
  const landing = useMemo(() => landingRoute(isDemo), [isDemo]);
  const [route, setRoute] = useState<Route>(() => {
    const fromUrl = urlConsumed ? null : parsePath(window.location.pathname);
    const initial = fromUrl ?? landing;
    const path = formatRoute(initial);
    if (path !== window.location.pathname) replaceUrl(path);
    return initial;
  });

  useEffect(() => {
    urlConsumed = true;
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const parsed = parsePath(window.location.pathname);
      const next = parsed ?? landing;
      if (!parsed) replaceUrl(formatRoute(next));
      startTransition(() => {
        addTransitionType("nav-back");
        setRoute((current) => (sameRoute(current, next) ? current : next));
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [landing]);

  const navigate = useCallback(
    (to: Route, transition: NavTransition = "nav-forward", options?: { replace?: boolean }) => {
      const path = formatRoute(to);
      if (path !== window.location.pathname) {
        try {
          const url = path + window.location.search + window.location.hash;
          if (options?.replace) window.history.replaceState(window.history.state, "", url);
          else window.history.pushState(null, "", url);
        } catch {
          /* history unavailable; the view still changes */
        }
      }
      startTransition(() => {
        addTransitionType(transition);
        setRoute((current) => (sameRoute(current, to) ? current : to));
      });
    },
    [],
  );

  return { route, navigate };
}
