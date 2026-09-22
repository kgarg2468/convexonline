import { addTransitionType, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { convexToJson, type Value } from "convex/values";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
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

export type QueryResult<T> =
  | { status: "loading"; data?: undefined; error?: undefined }
  | { status: "ok"; data: T; error?: undefined }
  | { status: "error"; data?: undefined; error: Error };

/**
 * `useQuery` that reports a refused subscription instead of throwing it. A
 * deep link can name a thread the server refuses (a malformed id, another
 * inn's thread); the pane that asked for it should say so in place, not take
 * the whole workspace down with it.
 */
export function useQueryResult<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q> | "skip",
): QueryResult<FunctionReturnType<Q>> {
  const skip = args === "skip";
  const argsKey = skip ? "" : JSON.stringify(convexToJson(args));
  // `api.x.y` is a fresh proxy on every access, so the memo keys on the name.
  const queryName = getFunctionName(query);
  const queries = useMemo<RequestForQueries>(
    () => {
      const request: RequestForQueries = {};
      if (!skip) request.query = { query, args: args as Record<string, Value> };
      return request;
    },
    // Stringified args and the function name, as convex/react does, so equal
    // requests never re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryName, argsKey, skip],
  );
  const result = useQueries(queries)["query"] as FunctionReturnType<Q> | Error | undefined;
  if (result instanceof Error) return { status: "error", error: result };
  if (result === undefined) return { status: "loading" };
  return { status: "ok", data: result };
}

export const useIsNarrow = () => useMediaQuery("(max-width: 900px)");

/** Between the phone layout and the three-pane inbox: the sources pane becomes a sheet. */
export const useIsMid = () => useMediaQuery("(width > 900px) and (width < 1440px)");

/**
 * True once `active` has been continuously true for `delayMs`, false the
 * moment it drops. Gates skeletons so a load that finishes quickly never
 * flashes one (research-motion §2.5: ~150ms).
 */
export function useDelayedFlag(active: boolean, delayMs = 150): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => setOn(true), delayMs);
    return () => {
      window.clearTimeout(id);
      setOn(false);
    };
  }, [active, delayMs]);
  return on && active;
}

/**
 * `value` as it stood `delayMs` ago (or now, if it has been still that long).
 * Feeds a query from a controlled input without subscribing per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 180): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

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
 * instead of re-reading a path that belonged to the previous one. Reset by
 * `forgetConsumedUrl` when the signed-in session ends, so a deep link opened
 * after signing back in within the same tab is honoured again.
 */
let urlConsumed = false;

export function forgetConsumedUrl() {
  urlConsumed = false;
}

/** What this hook keeps in `history.state`; callers may add their own keys (e.g. `fdFromList`). */
type RouteState = { fdIndex?: number } & Record<string, unknown>;

function historyState(): RouteState | null {
  const state: unknown = window.history.state;
  return state !== null && typeof state === "object" ? (state as RouteState) : null;
}

/** Replaces the address bar's path, keeping the query string, the fragment and the entry's state. */
export function replaceUrl(path: string, state: RouteState | null = historyState()) {
  try {
    window.history.replaceState(state, "", path + window.location.search + window.location.hash);
  } catch {
    /* history unavailable; state still updates */
  }
}

/**
 * The workspace route, derived from the pathname and kept in sync with
 * history. `navigate` pushes a new entry (or replaces the current one) and
 * applies the route inside a React transition tagged with `transition`, so
 * the `<ViewTransition>` around the routed view can animate by kind.
 * Back/forward restore the route through `popstate`; each entry carries an
 * index in `history.state.fdIndex` so the two directions can be told apart.
 * The fragment and query string are never read here. The fragment is carried
 * to every new entry; the query string only to an inbox route, since the one
 * query the app knows (`?filter=`) belongs to the inbox and must not follow
 * the visitor to another view.
 */
export function useRoute(isDemo: boolean): {
  route: Route;
  navigate: (to: Route, transition?: NavTransition, options?: { replace?: boolean; state?: Record<string, unknown> }) => void;
} {
  const landing = useMemo(() => landingRoute(isDemo), [isDemo]);
  // Pure: the address bar is only read here; it is written in the mount effect below.
  const [route, setRoute] = useState<Route>(() => (urlConsumed ? null : parsePath(window.location.pathname)) ?? landing);
  // Index of the entry the route currently shows, to tell back from forward on popstate.
  const index = useRef(historyState()?.fdIndex ?? 0);

  useEffect(() => {
    urlConsumed = true;
    // Normalise the entry: the canonical path for the route, and an index if it has none yet.
    const path = formatRoute(route);
    const state = historyState();
    if (path !== window.location.pathname || state?.fdIndex === undefined) {
      replaceUrl(path, { ...state, fdIndex: index.current });
    }
    // Mount only: `route` here is the initial one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const parsed = parsePath(window.location.pathname);
      const next = parsed ?? landing;
      const entryIndex = historyState()?.fdIndex;
      // An entry without an index predates this hook (or was pushed elsewhere): treat it as back.
      const forward = entryIndex !== undefined && entryIndex > index.current;
      if (entryIndex !== undefined) index.current = entryIndex;
      if (!parsed) replaceUrl(formatRoute(next));
      startTransition(() => {
        addTransitionType(forward ? "nav-forward" : "nav-back");
        setRoute((current) => (sameRoute(current, next) ? current : next));
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [landing]);

  const navigate = useCallback(
    (to: Route, transition: NavTransition = "nav-forward", options?: { replace?: boolean; state?: Record<string, unknown> }) => {
      const path = formatRoute(to);
      if (path !== window.location.pathname) {
        try {
          const url = path + (to.view === "inbox" ? window.location.search : "") + window.location.hash;
          // A rewritten entry keeps its index but not the old route's keys.
          if (options?.replace) {
            window.history.replaceState({ ...options.state, fdIndex: index.current }, "", url);
          } else {
            index.current += 1;
            window.history.pushState({ ...options?.state, fdIndex: index.current }, "", url);
          }
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
