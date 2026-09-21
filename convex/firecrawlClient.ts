/**
 * Firecrawl transport over the installed @firecrawl/firecrawl-convex
 * component (convex.config.ts binds its FIRECRAWL_API_KEY to the app's typed
 * env, so no key ever crosses a function boundary). Both entry points apply
 * the same URL safety check and the same response guards as the direct
 * adapters in providers/firecrawl.ts, and every component failure is
 * re-raised as a sanitized ProviderError so describeError never surfaces a
 * provider body.
 */
import { ConvexError } from "convex/values";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { components } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import {
  assertPublicHttpsUrl,
  FIRECRAWL_DEFAULT_TIMEOUT_MS,
  mapLimit,
  parseMapLinks,
  parseScrapeDocument,
  scrapeRequestOptions,
  type MapSiteResult,
  type ScrapePageResult,
} from "./providers/firecrawl";
import { httpError, ProviderError, requireNonEmpty } from "./providers/shared";

const firecrawl = new FirecrawlClient(components.firecrawl);

type Transport = Pick<ActionCtx, "runAction" | "runQuery" | "runMutation">;

/**
 * Maps the component's ConvexError ({ code, status, path, message }) onto the
 * app's ProviderError vocabulary. The component message embeds the provider's
 * error body, so it is deliberately dropped; only the status survives.
 */
function toProviderError(e: unknown): unknown {
  if (!(e instanceof ConvexError)) return e;
  const data = e.data as { code?: unknown; status?: unknown } | undefined;
  const code = typeof data?.code === "string" ? data.code : "";
  if (code === "firecrawl_missing_api_key") {
    return new ProviderError({ provider: "firecrawl", kind: "missing_credentials", message: "apiKey is required", retryable: false });
  }
  if (code === "firecrawl_request_failed") {
    const status = typeof data?.status === "number" ? data.status : 0;
    // The component already retried transient statuses; status 0 is its
    // marker for a network-level failure it could not get past.
    if (status > 0) return httpError("firecrawl", status, false);
    return new ProviderError({ provider: "firecrawl", kind: "network", message: "network request failed", retryable: true, cause: e });
  }
  return new ProviderError({ provider: "firecrawl", kind: "invalid_response", message: "component request failed", retryable: false, cause: e });
}

/** Scrapes one public https page through the component; same options and guards as providers/firecrawl.scrapePage. */
export async function scrapePageViaComponent(ctx: Transport, args: { url: string; tag?: string }): Promise<ScrapePageResult> {
  const target = assertPublicHttpsUrl(requireNonEmpty("firecrawl", "url", args.url));
  let document: unknown;
  try {
    document = await firecrawl.scrape(ctx, target.toString(), {
      ...scrapeRequestOptions(args.tag),
      // Bounds the provider's own work per page; the component's request
      // retries stay inside this action's Convex deadline.
      timeout: FIRECRAWL_DEFAULT_TIMEOUT_MS,
    });
  } catch (e) {
    throw toProviderError(e);
  }
  return parseScrapeDocument(document, target);
}

/** Maps a public https site through the component; same filtering as providers/firecrawl.mapSite. */
export async function mapSiteViaComponent(ctx: Transport, args: { url: string; limit?: number }): Promise<MapSiteResult> {
  const target = assertPublicHttpsUrl(requireNonEmpty("firecrawl", "url", args.url));
  const limit = mapLimit(args.limit);
  let result: unknown;
  try {
    result = await firecrawl.map(ctx, target.toString(), { limit, timeout: FIRECRAWL_DEFAULT_TIMEOUT_MS });
  } catch (e) {
    throw toProviderError(e);
  }
  const links = typeof result === "object" && result !== null ? (result as { links?: unknown }).links : undefined;
  return parseMapLinks(links, target, limit);
}
