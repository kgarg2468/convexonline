import type { WorkspaceView } from "../types";

/**
 * Pathname routing for the workspace. The static host serves index.html for
 * any path, so the address bar can name the view (and the open thread):
 *
 *   /inbox              inbox, nothing selected
 *   /inbox/:threadId    inbox with a thread open
 *   /changes            policy-change review
 *   /knowledge          knowledge
 *   /settings           settings
 *
 * `/` and anything else resolve to the inn's landing view. Only the pathname
 * is read; the query string and the fragment (`#invite=` is handled by
 * lib/invitations.ts) are carried along untouched and never interpreted here.
 * These helpers are pure so they can be unit-tested; `useRoute` in hooks.ts
 * binds them to history.
 */

export type Route =
  | { view: "inbox"; threadId: string | null }
  | { view: "corrections" }
  | { view: "knowledge" }
  | { view: "settings" };

/**
 * How a navigation should look. Read by the `<ViewTransition>` around the
 * routed view (see styles/motion.css); "nav-none" changes the URL and state
 * without a transition class, e.g. selecting a thread beside an open queue.
 */
export type NavTransition = "nav-forward" | "nav-back" | "nav-mobile-detail" | "nav-none";

/**
 * Loose shape of a Convex document id. Keeps arbitrary path segments out of
 * `threads.get`; it proves nothing about existence or access, which the
 * server decides.
 */
export const THREAD_ID = /^[a-z0-9]{16,64}$/i;

const VIEW_PATH: Record<Exclude<WorkspaceView, "inbox">, string> = {
  corrections: "/changes",
  knowledge: "/knowledge",
  settings: "/settings",
};

/** The view a pathname names, or null when it names nothing (the caller falls back to the landing view). */
export function parsePath(pathname: string): Route | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const [head, tail] = parts;
  if (head === "inbox") {
    if (tail === undefined) return { view: "inbox", threadId: null };
    // A malformed id is not an error worth a screen: it is the inbox with nothing open.
    return { view: "inbox", threadId: THREAD_ID.test(tail) ? tail : null };
  }
  if (tail !== undefined) return null;
  for (const view of Object.keys(VIEW_PATH) as (keyof typeof VIEW_PATH)[]) {
    if (VIEW_PATH[view] === `/${head}`) return { view };
  }
  return null;
}

export function formatRoute(route: Route): string {
  if (route.view === "inbox") return route.threadId ? `/inbox/${route.threadId}` : "/inbox";
  return VIEW_PATH[route.view];
}

/** Judges land on the policy-change review; staff land on the inbox. */
export function landingRoute(isDemo: boolean): Route {
  return isDemo ? { view: "corrections" } : { view: "inbox", threadId: null };
}

export function routeFor(view: WorkspaceView, threadId: string | null = null): Route {
  return view === "inbox" ? { view, threadId } : { view };
}

export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
