import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireInnAccess } from "./access";
import { correctionStatus } from "./schema";

export const list = query({
  args: { innId: v.id("inns"), status: v.optional(correctionStatus) },
  handler: async (ctx, { innId, status }) => {
    await requireInnAccess(ctx, innId);
    const rows = await ctx.db
      .query("corrections")
      .withIndex("by_inn_status", (q) =>
        status ? q.eq("innId", innId).eq("status", status) : q.eq("innId", innId),
      )
      .order("desc")
      .collect();
    const out = [];
    for (const c of rows) {
      const thread = await ctx.db.get(c.threadId);
      const claim = await ctx.db.get(c.claimId);
      const page = await ctx.db.get(c.pageId);
      out.push({
        _id: c._id,
        status: c.status,
        threadId: c.threadId,
        subject: thread?.subject ?? "",
        guestEmail: thread?.guestEmail ?? "",
        statement: claim?.statement ?? "",
        pageUrl: page?.url ?? "",
        oldQuote: c.oldQuote,
        newPassage: c.newPassage ?? null,
        proposedText: c.proposedText ?? null,
        oldVersionId: c.oldVersionId,
        newVersionId: c.newVersionId,
      });
    }
    return out;
  },
});

/**
 * Sent claims that still hold after the latest change of their page: the
 * controls shown beside affected replies in the review screen.
 */
export const unaffectedControls = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    await requireInnAccess(ctx, innId);
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_inn", (q) => q.eq("innId", innId))
      .collect();
    const out = [];
    for (const page of pages) {
      if (!page.lastVersionId) continue;
      const claims = await ctx.db
        .query("claims")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .collect();
      for (const claim of claims) {
        if (claim.status !== "ok" || claim.checkedAgainstVersionId !== page.lastVersionId) continue;
        const thread = await ctx.db.get(claim.threadId);
        out.push({
          claimId: claim._id,
          threadId: claim.threadId,
          subject: thread?.subject ?? "",
          statement: claim.statement,
          quote: claim.quote,
          pageUrl: page.url,
        });
      }
    }
    return out;
  },
});

export const review = mutation({
  args: {
    correctionId: v.id("corrections"),
    decision: v.union(v.literal("approve"), v.literal("dismiss")),
    proposedText: v.optional(v.string()),
  },
  handler: async (ctx, { correctionId, decision, proposedText }) => {
    const correction = await ctx.db.get(correctionId);
    if (!correction) throw new ConvexError({ code: "forbidden", message: "No access to this correction" });
    const { user } = await requireInnAccess(ctx, correction.innId);
    if (correction.status !== "needs_review") {
      throw new ConvexError({ code: "invalid", message: "Correction was already reviewed" });
    }
    const text = proposedText?.trim();
    if (decision === "approve" && !(text || correction.proposedText)) {
      throw new ConvexError({ code: "invalid", message: "A correction needs text before approval" });
    }
    await ctx.db.patch(correctionId, {
      status: decision === "approve" ? "approved" : "dismissed",
      proposedText: text || correction.proposedText,
      reviewedBy: user._id,
      reviewedAt: Date.now(),
    });
    return null;
  },
});
