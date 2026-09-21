/**
 * Firecrawl adapters: scrapePage (POST /v2/scrape with markdown + git-diff
 * changeTracking) and mapSite (POST /v2/map, filtered to same-origin https).
 * Only public https URLs are ever fetched through the provider.
 */
import { httpError, isRecord, optionalString, postJson, ProviderError, requireNonEmpty, type FetchLike } from "./shared";

export const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
export const FIRECRAWL_DEFAULT_TIMEOUT_MS = 60_000;
export const FIRECRAWL_MAX_MARKDOWN_CHARS = 400_000;
export const FIRECRAWL_MAX_DIFF_CHARS = 100_000;
export const FIRECRAWL_MAX_MAP_URLS = 200;

// ---- URL validation ---------------------------------------------------------

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("::ffff:")) return isPrivateIpv4(h.slice(7));
  return /^(fc|fd|fe[89ab])/.test(h);
}

/** Returns the parsed URL when it is a public https URL without credentials; throws otherwise. */
export function assertPublicHttpsUrl(raw: string): URL {
  const reject = (why: string) =>
    new ProviderError({ provider: "firecrawl", kind: "invalid_input", message: `unsafe url: ${why}`, retryable: false });
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw reject("unparseable");
  }
  if (u.protocol !== "https:") throw reject("scheme must be https");
  if (u.username || u.password) throw reject("credentials not allowed");
  const host = u.hostname.toLowerCase();
  if (!host) throw reject("missing host");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw reject("local hostname");
  }
  if (host.startsWith("[") || host.includes(":")) {
    if (isPrivateIpv6(host)) throw reject("private ipv6 address");
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIpv4(host)) throw reject("private ipv4 address");
  } else if (/^\d+$/.test(host) || /^0x/i.test(host)) {
    throw reject("numeric host");
  } else if (!host.includes(".")) {
    throw reject("host must be a public domain");
  }
  return u;
}

export function isPublicHttpsUrl(raw: string): boolean {
  try {
    assertPublicHttpsUrl(raw);
    return true;
  } catch {
    return false;
  }
}

// ---- scrapePage -------------------------------------------------------------

export type ScrapePageArgs = {
  apiKey: string;
  url: string;
  /** Optional Firecrawl changeTracking tag to scope diff history (e.g. per inn). */
  tag?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
};

export type ChangeStatus = "new" | "same" | "changed" | "removed" | "unknown";

export type ScrapePageResult = {
  url: string;
  markdown: string;
  changeStatus: ChangeStatus;
  diffText?: string;
  metadata: { title?: string; sourceUrl?: string; statusCode?: number; previousScrapeAt?: string };
};

function parseChangeStatus(x: unknown): ChangeStatus {
  return x === "new" || x === "same" || x === "changed" || x === "removed" ? x : "unknown";
}

/**
 * The scrape request options every transport sends: markdown plus git-diff
 * changeTracking (scoped by `tag`), main content only, and `maxAge: 0`.
 * maxAge: 0 forces a fresh fetch. Firecrawl's default (172800000 ms, two
 * days) may serve a cached body, which would hide source changes from the
 * rescrape loop.
 */
export function scrapeRequestOptions(tag?: string): {
  formats: ["markdown", { type: "changeTracking"; modes: string[]; tag?: string }];
  onlyMainContent: true;
  maxAge: 0;
} {
  const changeTracking: { type: "changeTracking"; modes: string[]; tag?: string } = { type: "changeTracking", modes: ["git-diff"] };
  if (tag) changeTracking.tag = tag;
  return { formats: ["markdown", changeTracking], onlyMainContent: true, maxAge: 0 };
}

/**
 * Validates a Firecrawl scrape document (`data` of the /v2/scrape envelope)
 * for `target` and shapes it into a ScrapePageResult. Shared by the direct
 * adapter and the component transport so both apply exactly the same guards.
 * `status` is the provider's own HTTP status, recorded on rejections.
 */
export function parseScrapeDocument(data: unknown, target: URL, status?: number): ScrapePageResult {
  const invalid = (why: string) =>
    new ProviderError({ provider: "firecrawl", kind: "invalid_response", status, message: why, retryable: false });
  if (!isRecord(data)) throw invalid("scrape response not successful");
  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  if (markdown.trim().length === 0) throw invalid("scrape returned empty markdown");

  const ct = isRecord(data.changeTracking) ? data.changeTracking : {};
  const diff = isRecord(ct.diff) ? optionalString(ct.diff.text) : undefined;
  const meta = isRecord(data.metadata) ? data.metadata : {};
  // Firecrawl reports success for its own request even when the *target* page
  // answered with an error (e.g. a 403 "Forbidden" body). Such a body is not
  // knowledge about the inn; refuse it so ingest records a failure instead of
  // a bogus page version. A missing status code stays accepted (fixtures and
  // older provider payloads omit it); only an explicit non-2xx or an explicit
  // provider error marker rejects.
  const targetStatus = typeof meta.statusCode === "number" ? meta.statusCode : undefined;
  if (targetStatus !== undefined && (targetStatus < 200 || targetStatus >= 300)) {
    throw new ProviderError({
      provider: "firecrawl",
      kind: "invalid_response",
      status,
      message: `target page responded with HTTP ${targetStatus}`,
      retryable: targetStatus === 429 || targetStatus >= 500,
    });
  }
  if (optionalString(meta.error)?.trim()) throw invalid("target page reported a scrape error");
  const result: ScrapePageResult = {
    url: target.toString(),
    markdown: markdown.slice(0, FIRECRAWL_MAX_MARKDOWN_CHARS),
    changeStatus: parseChangeStatus(ct.changeStatus),
    metadata: {
      title: optionalString(meta.title),
      sourceUrl: optionalString(meta.sourceURL),
      statusCode: typeof meta.statusCode === "number" ? meta.statusCode : undefined,
      previousScrapeAt: optionalString(ct.previousScrapeAt),
    },
  };
  if (diff) result.diffText = diff.slice(0, FIRECRAWL_MAX_DIFF_CHARS);
  return result;
}

export async function scrapePage(args: ScrapePageArgs): Promise<ScrapePageResult> {
  const apiKey = requireNonEmpty("firecrawl", "apiKey", args.apiKey);
  const target = assertPublicHttpsUrl(requireNonEmpty("firecrawl", "url", args.url));
  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as FetchLike);

  const res = await postJson(
    "firecrawl",
    fetchImpl,
    `${args.baseUrl ?? FIRECRAWL_BASE_URL}/v2/scrape`,
    apiKey,
    { url: target.toString(), ...scrapeRequestOptions(args.tag) },
    args.timeoutMs ?? FIRECRAWL_DEFAULT_TIMEOUT_MS,
    /* ambiguousOnFailure */ false,
  );
  if (!res.ok) throw httpError("firecrawl", res.status, false);

  const body = res.json;
  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) {
    throw new ProviderError({ provider: "firecrawl", kind: "invalid_response", status: res.status, message: "scrape response not successful", retryable: false });
  }
  return parseScrapeDocument(body.data, target, res.status);
}

// ---- mapSite ----------------------------------------------------------------

export type MapSiteArgs = {
  apiKey: string;
  url: string;
  limit?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
};

export type MapSiteResult = { origin: string; urls: string[] };

/** Clamps a requested map size to [1, FIRECRAWL_MAX_MAP_URLS]. */
export function mapLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? FIRECRAWL_MAX_MAP_URLS, FIRECRAWL_MAX_MAP_URLS));
}

/**
 * Validates the `links` of a /v2/map response and keeps only public https
 * URLs on `target`'s origin, deduplicated without fragments and capped at
 * `limit`. Shared by the direct adapter and the component transport so both
 * apply exactly the same guards. `status` is the provider's own HTTP status.
 */
export function parseMapLinks(links: unknown, target: URL, limit: number, status?: number): MapSiteResult {
  if (!Array.isArray(links)) {
    throw new ProviderError({
      provider: "firecrawl",
      kind: "invalid_response",
      status,
      message: "map response not successful",
      retryable: false,
    });
  }
  const seen = new Set<string>();
  for (const link of links) {
    // v2 returns either strings or {url,title,description}.
    const raw = typeof link === "string" ? link : isRecord(link) ? optionalString(link.url) : undefined;
    if (!raw || !isPublicHttpsUrl(raw)) continue;
    const u = new URL(raw);
    if (u.origin !== target.origin) continue;
    u.hash = "";
    seen.add(u.toString());
    if (seen.size >= limit) break;
  }
  return { origin: target.origin, urls: [...seen] };
}

export async function mapSite(args: MapSiteArgs): Promise<MapSiteResult> {
  const apiKey = requireNonEmpty("firecrawl", "apiKey", args.apiKey);
  const target = assertPublicHttpsUrl(requireNonEmpty("firecrawl", "url", args.url));
  const limit = mapLimit(args.limit);
  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as FetchLike);

  const res = await postJson(
    "firecrawl",
    fetchImpl,
    `${args.baseUrl ?? FIRECRAWL_BASE_URL}/v2/map`,
    apiKey,
    { url: target.toString(), limit },
    args.timeoutMs ?? FIRECRAWL_DEFAULT_TIMEOUT_MS,
    false,
  );
  if (!res.ok) throw httpError("firecrawl", res.status, false);

  const body = res.json;
  if (!isRecord(body) || body.success !== true) {
    throw new ProviderError({
      provider: "firecrawl",
      kind: "invalid_response",
      status: res.status,
      message: "map response not successful",
      retryable: false,
    });
  }
  return parseMapLinks(body.links, target, limit, res.status);
}
