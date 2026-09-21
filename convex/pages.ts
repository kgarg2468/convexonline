import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireInnAccess } from "./access";
import { sha256Hex } from "./lib/quotes";
import { findReplacementPassage, partitionClaimsBySourceChange } from "./lib/sourceChange";
import { changeStatus } from "./schema";

export const list = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    await requireInnAccess(ctx, innId);
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_inn", (q) => q.eq("innId", innId))
      .collect();
    const out = [];
    for (const page of pages) {
      const version = page.lastVersionId ? await ctx.db.get(page.lastVersionId) : null;
      out.push({
        _id: page._id,
        url: page.url,
        title: page.title,
        kind: page.kind,
        watched: page.watched,
        lastVersion: version
          ? { _id: version._id, hash: version.hash, scrapedAt: version.scrapedAt, changeStatus: version.changeStatus }
          : null,
      });
    }
    return out;
  },
});

export const getVersion = query({
  args: { pageVersionId: v.id("pageVersions") },
  handler: async (ctx, { pageVersionId }) => {
    const version = await ctx.db.get(pageVersionId);
    if (!version) throw new ConvexError({ code: "forbidden", message: "No access to this page" });
    const page = await ctx.db.get(version.pageId);
    if (!page) throw new ConvexError({ code: "forbidden", message: "No access to this page" });
    await requireInnAccess(ctx, page.innId);
    return { _id: version._id, markdown: version.markdown, hash: version.hash, scrapedAt: version.scrapedAt };
  },
});

export type RecordVersionResult = {
  pageVersionId: Id<"pageVersions">;
  changeStatus: "new" | "same" | "changed";
  affected: number;
  unaffected: number;
};

/**
 * Stores a newly observed page body. On a hash change, every sent claim citing
 * this page is re-verified: vanished quotes become `needs_review` claims with
 * a correction proposal; surviving quotes are recorded as re-checked controls.
 */
export async function recordPageVersion(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  markdown: string,
  diffText?: string,
): Promise<RecordVersionResult> {
  const page = await ctx.db.get(pageId);
  if (!page) throw new ConvexError({ code: "not_found", message: "Page not found" });
  const hash = await sha256Hex(markdown);
  const previous = page.lastVersionId ? await ctx.db.get(page.lastVersionId) : null;
  const status = previous ? (previous.hash === hash ? "same" : "changed") : "new";
  if (status === "same" && previous) {
    return { pageVersionId: previous._id, changeStatus: "same", affected: 0, unaffected: 0 };
  }
  const pageVersionId = await ctx.db.insert("pageVersions", {
    pageId,
    markdown,
    hash,
    scrapedAt: Date.now(),
    changeStatus: status,
    diffText,
  });
  await ctx.db.patch(pageId, { lastVersionId: pageVersionId });
  if (status === "new" || !previous) {
    return { pageVersionId, changeStatus: status, affected: 0, unaffected: 0 };
  }

  const citing = await ctx.db
    .query("claims")
    .withIndex("by_page", (q) => q.eq("pageId", pageId))
    .collect();
  const sent = [];
  for (const claim of citing) {
    if (claim.status !== "ok") continue;
    const reply = await ctx.db
      .query("sentReplies")
      .withIndex("by_draft", (q) => q.eq("draftId", claim.draftId))
      .first();
    if (reply) sent.push({ ...claim, sentReplyId: reply._id });
  }
  const { affected, unaffected } = partitionClaimsBySourceChange(sent, pageId, markdown);
  for (const claim of unaffected) {
    await ctx.db.patch(claim._id, { checkedAgainstVersionId: pageVersionId });
  }
  for (const claim of affected) {
    await ctx.db.patch(claim._id, { status: "needs_review", checkedAgainstVersionId: pageVersionId });
    await ctx.db.insert("corrections", {
      innId: claim.innId,
      sentReplyId: claim.sentReplyId,
      threadId: claim.threadId,
      claimId: claim._id,
      pageId,
      oldVersionId: claim.pageVersionId,
      newVersionId: pageVersionId,
      oldQuote: claim.quote,
      newPassage: findReplacementPassage(markdown, claim.quote),
      status: "needs_review",
    });
  }
  return { pageVersionId, changeStatus: "changed", affected: affected.length, unaffected: unaffected.length };
}

/** Used by the scraper (next slice) once it has fetched a watched page. */
export const recordVersion = internalMutation({
  args: {
    pageId: v.id("pages"),
    markdown: v.string(),
    diffText: v.optional(v.string()),
    reportedStatus: v.optional(changeStatus),
  },
  handler: async (ctx, { pageId, markdown, diffText }) => recordPageVersion(ctx, pageId, markdown, diffText),
});

/**
 * Staff-supplied page content. For demo inns this is how "the inn edits its
 * policy page" happens without a live crawl; for real inns it lets staff paste
 * a page when the crawler cannot reach it.
 */
export const submitContent = mutation({
  args: { pageId: v.id("pages"), markdown: v.string() },
  handler: async (ctx, { pageId, markdown }) => {
    const page = await ctx.db.get(pageId);
    if (!page) throw new ConvexError({ code: "forbidden", message: "No access to this page" });
    await requireInnAccess(ctx, page.innId);
    if (markdown.trim().length === 0 || markdown.length > 500_000) {
      throw new ConvexError({ code: "invalid", message: "Page content must be between 1 and 500000 characters" });
    }
    return recordPageVersion(ctx, pageId, markdown);
  },
});
