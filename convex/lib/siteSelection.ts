/**
 * Which pages of an inn site to ingest. Bounded (MAX_PAGES) and prioritized
 * toward the pages replies cite: policies, rooms, rates, notices, FAQ.
 */

export const MAX_PAGES = 10;
export const MAX_PAGE_CHARS = 200_000;
export const MAX_TOTAL_CHARS = 600_000;

export type PageKind = "policies" | "rooms" | "rates" | "notices" | "other";

const KIND_PATTERNS: Array<[PageKind, RegExp]> = [
  ["policies", /polic|terms|cancel|pet|rules|faq|question|check-?in|house/i],
  ["rooms", /room|suite|accommodat|cottage|cabin|stay/i],
  ["rates", /rate|price|pricing|package|special|offer|deal/i],
  ["notices", /news|notice|update|announce|blog|event|season/i],
];

export function classifyPage(url: string): PageKind {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  for (const [kind, re] of KIND_PATTERNS) if (re.test(path)) return kind;
  return "other";
}

export function isWatchedKind(kind: PageKind): boolean {
  return kind !== "other";
}

const PRIORITY: Record<PageKind, number> = { policies: 0, rooms: 1, rates: 2, notices: 3, other: 4 };

function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    u.hash = "";
    u.search = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
}

export type SelectPagesOptions = {
  /**
   * Hosted-site scoping: keep only URLs whose raw path segments start with
   * these segments (the inn's own `/inn/<id>` prefix). Compared per segment,
   * so `/inn/<id>x` and `/inn/<id>%2F..` never match; segments needing
   * decoding are rejected. Same-origin alone is not enough when every hosted
   * inn shares the deployment origin.
   */
  withinPath?: string;
};

function withinPathSegments(pathname: string, prefix: string): boolean {
  const want = prefix.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);
  if (have.length < want.length) return false;
  for (let i = 0; i < want.length; i++) if (have[i] !== want[i]) return false;
  return have.every((s) => !s.includes("%") && s !== "." && s !== "..");
}

/** Same-origin https URLs, home page first, then by kind priority and path depth. */
export function selectPages(siteUrl: string, candidates: string[], max = MAX_PAGES, opts: SelectPagesOptions = {}): string[] {
  const home = normalizeUrl(siteUrl);
  if (!home) return [];
  const origin = new URL(home).origin;
  const seen = new Set<string>();
  const picked: Array<{ url: string; rank: number; depth: number }> = [];
  for (const raw of [home, ...candidates]) {
    const url = normalizeUrl(raw);
    if (!url || seen.has(url)) continue;
    const parsed = new URL(url);
    if (parsed.origin !== origin) continue;
    if (opts.withinPath !== undefined && !withinPathSegments(parsed.pathname, opts.withinPath)) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|css|js|xml)$/i.test(parsed.pathname)) continue;
    seen.add(url);
    const kind = classifyPage(url);
    const depth = parsed.pathname.split("/").filter(Boolean).length;
    picked.push({ url, rank: url === home ? -1 : PRIORITY[kind], depth });
  }
  picked.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.url.localeCompare(b.url));
  return picked.slice(0, Math.max(1, Math.min(max, MAX_PAGES))).map((p) => p.url);
}

export function titleFromMarkdown(markdown: string, url: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  if (heading) return heading[1].trim().slice(0, 200);
  try {
    const path = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    if (path) return path.replace(/[-_]+/g, " ").slice(0, 200);
  } catch {
    // ignore
  }
  return url.slice(0, 200);
}
