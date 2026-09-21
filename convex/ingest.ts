import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireInnAccess } from "./access";
import { readEnv } from "./lib/env";
import { describeError } from "./lib/errors";
import { classifyPage, isWatchedKind, selectPages, titleFromMarkdown, MAX_PAGE_CHARS, MAX_PAGES, MAX_TOTAL_CHARS } from "./lib/siteSelection";
import { isPublicHttpsUrl, mapSite, scrapePage } from "./providers/firecrawl";
import { recordPageVersion } from "./pages";

export const INN_COOLDOWN_MS = 10 * 60 * 1000;
export const USER_RUNS_PER_HOUR = 6;
const RESCRAPE_MIN_AGE_MS = 55 * 60 * 1000;
const RESCRAPE_BATCH = 20;

export const runs = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    await requireInnAccess(ctx, innId);
    const rows = await ctx.db
      .query("crawlRuns")
      .withIndex("by_inn_startedAt", (q) => q.eq("innId", innId))
      .order("desc")
      .take(10);
    return rows.map((r) => ({
      _id: r._id,
      trigger: r.trigger,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
      status: r.status,
      pagesStored: r.pagesStored,
      pagesSkipped: r.pagesSkipped,
      reason: r.reason ?? null,
    }));
  },
});

/**
 * Authorizes a staff crawl and opens the run in one transaction. Demo inns and
 * anonymous users never get here (no credits), and cooldowns bound what a
 * self-signed-up account can spend: one run per inn per 10 minutes and
 * USER_RUNS_PER_HOUR runs per user.
 */
export const beginRun = internalMutation({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    const { inn, user } = await requireInnAccess(ctx, innId);
    if (inn.isDemo || user.isAnonymous === true) {
      throw new ConvexError({ code: "demo_inn", message: "Demo inns are seeded; nothing is crawled" });
    }
    if (!isPublicHttpsUrl(inn.siteUrl)) {
      throw new ConvexError({ code: "invalid_site_url", message: "The inn site must be a public https URL" });
    }
    const now = Date.now();
    if (inn.lastCrawlStartedAt !== undefined && now - inn.lastCrawlStartedAt < INN_COOLDOWN_MS) {
      throw new ConvexError({ code: "cooldown", retryAt: inn.lastCrawlStartedAt + INN_COOLDOWN_MS });
    }
    const recent = await ctx.db
      .query("crawlRuns")
      .withIndex("by_user_startedAt", (q) => q.eq("userId", user._id).gt("startedAt", now - 60 * 60 * 1000))
      .collect();
    if (recent.length >= USER_RUNS_PER_HOUR) {
      throw new ConvexError({ code: "cooldown", retryAt: Math.min(...recent.map((r) => r.startedAt)) + 60 * 60 * 1000 });
    }
    await ctx.db.patch(innId, { lastCrawlStartedAt: now });
    const runId = await ctx.db.insert("crawlRuns", {
      innId,
      userId: user._id,
      trigger: "staff",
      startedAt: now,
      status: "running",
      pagesStored: 0,
      pagesSkipped: 0,
    });
    return { runId, siteUrl: inn.siteUrl };
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("crawlRuns"),
    status: v.union(v.literal("done"), v.literal("failed")),
    pagesStored: v.number(),
    pagesSkipped: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { runId, ...rest }) => {
    await ctx.db.patch(runId, { ...rest, finishedAt: Date.now() });
    return null;
  },
});

/** Upserts the page row and records the version; sent claims on a changed page get proposals. */
/** The site root (with or without a trailing slash) is always watched. */
function isHomePage(url: string, siteUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(siteUrl);
    return a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

export const storePage = internalMutation({
  args: { innId: v.id("inns"), url: v.string(), markdown: v.string(), diffText: v.optional(v.string()) },
  handler: async (ctx, { innId, url, markdown, diffText }) => {
    const inn = await ctx.db.get(innId);
    if (!inn || inn.isDemo) throw new ConvexError({ code: "invalid", message: "not a real inn" });
    let page = await ctx.db
      .query("pages")
      .withIndex("by_inn_url", (q) => q.eq("innId", innId).eq("url", url))
      .unique();
    const kind = classifyPage(url);
    const title = titleFromMarkdown(markdown, url);
    let pageId: Id<"pages">;
    if (page) {
      pageId = page._id;
      if (page.title !== title) await ctx.db.patch(pageId, { title });
    } else {
      pageId = await ctx.db.insert("pages", { innId, url, title, kind, watched: isWatchedKind(kind) || isHomePage(url, inn.siteUrl) });
    }
    const result = await recordPageVersion(ctx, pageId, markdown, diffText, "generate");
    return { pageId, changeStatus: result.changeStatus, affected: result.affected };
  },
});

async function scrapeInto(
  ctx: { runMutation: (ref: typeof internal.ingest.storePage, args: { innId: Id<"inns">; url: string; markdown: string; diffText?: string }) => Promise<{ affected: number }> },
  apiKey: string,
  innId: Id<"inns">,
  url: string,
  budget: { remaining: number },
): Promise<{ stored: boolean; affected: number; reason?: string }> {
  try {
    const page = await scrapePage({ apiKey, url, tag: `inn-${innId}` });
    const markdown = page.markdown.slice(0, MAX_PAGE_CHARS);
    if (markdown.length > budget.remaining) return { stored: false, affected: 0, reason: "site budget exhausted" };
    budget.remaining -= markdown.length;
    const result = await ctx.runMutation(internal.ingest.storePage, { innId, url, markdown, diffText: page.diffText });
    return { stored: true, affected: result.affected };
  } catch (e) {
    return { stored: false, affected: 0, reason: describeError(e).message };
  }
}

/**
 * Staff-triggered crawl: map the inn's site, keep same-origin https pages,
 * scrape at most MAX_PAGES within the body budget, store each version.
 */
export const crawlSite = action({
  args: { innId: v.id("inns") },
  handler: async (
    ctx,
    { innId },
  ): Promise<{ runId: Id<"crawlRuns">; pagesStored: number; pagesSkipped: number; affectedClaims: number }> => {
    const { runId, siteUrl }: { runId: Id<"crawlRuns">; siteUrl: string } = await ctx.runMutation(internal.ingest.beginRun, { innId });
    const apiKey = readEnv("FIRECRAWL_API_KEY");
    if (!apiKey) {
      await ctx.runMutation(internal.ingest.finishRun, { runId, status: "failed", pagesStored: 0, pagesSkipped: 0, reason: "FIRECRAWL_API_KEY is not configured" });
      throw new ConvexError({ code: "firecrawl_unavailable", message: "Site crawling is not configured on this deployment" });
    }
    let urls: string[];
    try {
      const map = await mapSite({ apiKey, url: siteUrl, limit: 50 });
      urls = selectPages(siteUrl, map.urls, MAX_PAGES);
    } catch (e) {
      const err = describeError(e);
      await ctx.runMutation(internal.ingest.finishRun, { runId, status: "failed", pagesStored: 0, pagesSkipped: 0, reason: `map failed: ${err.message}` });
      throw new ConvexError({ code: "crawl_failed", message: `Could not map the site (${err.kind})` });
    }
    const budget = { remaining: MAX_TOTAL_CHARS };
    let pagesStored = 0;
    let pagesSkipped = 0;
    let affectedClaims = 0;
    const skipped: string[] = [];
    for (const url of urls) {
      const r = await scrapeInto(ctx, apiKey, innId, url, budget);
      if (r.stored) {
        pagesStored += 1;
        affectedClaims += r.affected;
      } else {
        pagesSkipped += 1;
        if (r.reason) skipped.push(`${url}: ${r.reason}`);
      }
    }
    await ctx.runMutation(internal.ingest.finishRun, {
      runId,
      status: pagesStored > 0 ? "done" : "failed",
      pagesStored,
      pagesSkipped,
      reason: skipped.length > 0 ? skipped.slice(0, 5).join("; ").slice(0, 1000) : undefined,
    });
    return { runId, pagesStored, pagesSkipped, affectedClaims };
  },
});

// ---- Cron rescrape -----------------------------------------------------------

export const duePages = internalQuery({
  args: { before: v.number(), limit: v.number() },
  handler: async (ctx, { before, limit }) => {
    // Bounded scan: real inns only, watched pages whose last check is older than `before`.
    const inns = await ctx.db.query("inns").collect();
    const out: Array<{ innId: Id<"inns">; url: string }> = [];
    const perInn = new Map<string, number>();
    for (const inn of inns) {
      if (inn.isDemo || !isPublicHttpsUrl(inn.siteUrl)) continue;
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_inn", (q) => q.eq("innId", inn._id))
        .collect();
      for (const page of pages) {
        if (!page.watched || !page.lastVersionId) continue;
        if ((page.lastCheckedAt ?? 0) > before) continue;
        if (!isPublicHttpsUrl(page.url)) continue;
        const count = perInn.get(inn._id) ?? 0;
        if (count >= MAX_PAGES) continue;
        perInn.set(inn._id, count + 1);
        out.push({ innId: inn._id, url: page.url });
        if (out.length >= limit) return out;
      }
    }
    return out;
  },
});

export const recordCronRun = internalMutation({
  args: { innId: v.id("inns"), pagesStored: v.number(), pagesSkipped: v.number(), reason: v.optional(v.string()) },
  handler: async (ctx, { innId, pagesStored, pagesSkipped, reason }) => {
    const now = Date.now();
    await ctx.db.insert("crawlRuns", {
      innId,
      trigger: "cron",
      startedAt: now,
      finishedAt: now,
      status: pagesStored > 0 || pagesSkipped === 0 ? "done" : "failed",
      pagesStored,
      pagesSkipped,
      reason,
    });
    return null;
  },
});

/** Hourly: re-read watched pages of real inns (≤ RESCRAPE_BATCH per run) through storePage. */
export const rescrapeDue = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scraped: number; reason: string | undefined }> => {
    const apiKey = readEnv("FIRECRAWL_API_KEY");
    if (!apiKey) return { scraped: 0, reason: "FIRECRAWL_API_KEY is not configured" };
    const due: Array<{ innId: Id<"inns">; url: string }> = await ctx.runQuery(internal.ingest.duePages, { before: Date.now() - RESCRAPE_MIN_AGE_MS, limit: RESCRAPE_BATCH });
    const perInn = new Map<Id<"inns">, { stored: number; skipped: number; reasons: string[] }>();
    for (const { innId, url } of due) {
      const stats = perInn.get(innId) ?? { stored: 0, skipped: 0, reasons: [] };
      const r = await scrapeInto(ctx, apiKey, innId, url, { remaining: MAX_PAGE_CHARS });
      if (r.stored) stats.stored += 1;
      else {
        stats.skipped += 1;
        if (r.reason) stats.reasons.push(`${url}: ${r.reason}`);
      }
      perInn.set(innId, stats);
    }
    for (const [innId, stats] of perInn) {
      await ctx.runMutation(internal.ingest.recordCronRun, {
        innId,
        pagesStored: stats.stored,
        pagesSkipped: stats.skipped,
        reason: stats.reasons.length ? stats.reasons.slice(0, 5).join("; ").slice(0, 1000) : undefined,
      });
    }
    return { scraped: due.length, reason: undefined };
  },
});
