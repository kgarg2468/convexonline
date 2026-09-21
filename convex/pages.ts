import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireInnAccess } from "./access";
import { sha256Hex, verifyQuote } from "./lib/quotes";
import { findReplacementPassage } from "./lib/sourceChange";
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
        lastCheckedAt: page.lastCheckedAt ?? null,
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
    return {
      _id: version._id,
      markdown: version.markdown,
      hash: version.hash,
      scrapedAt: version.scrapedAt,
      diffText: version.diffText ?? null,
    };
  },
});

export type RecordVersionResult = {
  pageVersionId: Id<"pageVersions">;
  changeStatus: "new" | "same" | "changed";
  /** Sent claims whose evidence vanished / still holds. */
  affected: number;
  unaffected: number;
  /** Distinct sent replies in each group (a reply with any vanished claim is affected). */
  affectedReplies: number;
  unaffectedReplies: number;
  correctionIds: Id<"corrections">[];
};

export type Proposals = "generate" | "none";

/**
 * The correction the guest heard last: ordered by actual delivery time (the
 * linked sent reply), not by when the proposal was written, since a proposal
 * drafted earlier may be delivered after a later one. Proposal creation time
 * is only the fallback for legacy sent rows without a linked sent reply.
 */
export async function latestSentCorrection(
  ctx: QueryCtx | MutationCtx,
  claimId: Id<"claims">,
): Promise<Doc<"corrections"> | null> {
  const rows = await ctx.db
    .query("corrections")
    .withIndex("by_claim", (q) => q.eq("claimId", claimId))
    .collect();
  const sent: Array<{ correction: Doc<"corrections">; deliveredAt: number; tieBreak: number }> = [];
  for (const correction of rows) {
    if (correction.status !== "sent") continue;
    const reply = correction.sentReplyIdForCorrection ? await ctx.db.get(correction.sentReplyIdForCorrection) : null;
    sent.push({
      correction,
      deliveredAt: reply?.sentAt ?? correction._creationTime,
      tieBreak: reply?._creationTime ?? correction._creationTime,
    });
  }
  sent.sort((a, b) => b.deliveredAt - a.deliveredAt || b.tieBreak - a.tieBreak);
  return sent[0]?.correction ?? null;
}

async function openCorrections(ctx: MutationCtx, claimId: Id<"claims">): Promise<Doc<"corrections">[]> {
  const rows = await ctx.db
    .query("corrections")
    .withIndex("by_claim", (q) => q.eq("claimId", claimId))
    .collect();
  return rows.filter((c) => c.status === "needs_review" || c.status === "approved");
}

export type RecheckOutcome =
  | { outcome: "skipped" }
  | { outcome: "verified"; replyId: Id<"sentReplies"> }
  | { outcome: "vanished" | "unverifiable"; replyId: Id<"sentReplies">; correctionId: Id<"corrections"> };

/**
 * Re-verifies one *sent* claim against a page version. The evidence checked is
 * whatever the guest last heard: the passage of the latest sent correction when
 * one exists, otherwise the original quote. The claim's transient status
 * (`needs_review` from an earlier change) never makes the original quote
 * authoritative again once a correction has gone out.
 *  - evidence still present → control; a claim under review returns to `ok`
 *    (or `corrected` when a correction was sent) and open proposals are superseded;
 *  - evidence vanished → `needs_review` plus one fresh proposal against this
 *    version; older open proposals are superseded;
 *  - the last sent correction carries no evidence quote → nothing can be
 *    checked mechanically: `needs_review` with a proposal that says so. The
 *    original quote is never used as a stand-in.
 * Unsent drafts are skipped.
 */
export async function recheckSentClaim(
  ctx: MutationCtx,
  claim: Doc<"claims">,
  version: { _id: Id<"pageVersions">; markdown: string },
  proposals: Proposals,
): Promise<RecheckOutcome> {
  if (claim.status === "stripped" || !claim.pageId || !claim.pageVersionId) return { outcome: "skipped" };
  const reply = await ctx.db
    .query("sentReplies")
    .withIndex("by_draft", (q) => q.eq("draftId", claim.draftId))
    .first();
  if (!reply) return { outcome: "skipped" };

  const sentCorrection = await latestSentCorrection(ctx, claim._id);
  const evidenceQuote = sentCorrection ? sentCorrection.evidenceQuote : claim.quote;
  const evidenceVersionId = sentCorrection ? sentCorrection.newVersionId : claim.pageVersionId;
  const verification = evidenceQuote ? verifyQuote(version.markdown, evidenceQuote) : { verified: false as const };

  if (verification.verified) {
    const patch: Partial<Doc<"claims">> = { checkedAgainstVersionId: version._id };
    if (claim.status === "needs_review") patch.status = sentCorrection ? "corrected" : "ok";
    for (const open of await openCorrections(ctx, claim._id)) {
      await ctx.db.patch(open._id, { status: "superseded", statusReason: "quote restored by a newer page version" });
    }
    await ctx.db.patch(claim._id, patch);
    return { outcome: "verified", replyId: reply._id };
  }

  await ctx.db.patch(claim._id, { status: "needs_review", checkedAgainstVersionId: version._id });
  const unverifiable = evidenceQuote === undefined;
  const correctionId = await ctx.db.insert("corrections", {
    innId: claim.innId,
    sentReplyId: reply._id,
    threadId: claim.threadId,
    claimId: claim._id,
    pageId: claim.pageId,
    oldVersionId: evidenceVersionId,
    newVersionId: version._id,
    // Without evidence the only passage on record is the one the original reply rested on.
    oldQuote: evidenceQuote ?? sentCorrection?.oldQuote ?? claim.quote,
    newPassage: evidenceQuote ? findReplacementPassage(version.markdown, evidenceQuote) : undefined,
    status: "needs_review",
    statusReason: unverifiable
      ? "the last correction sent to this guest has no evidence quote; check what they were told against the current page"
      : undefined,
  });
  for (const open of await openCorrections(ctx, claim._id)) {
    if (open._id === correctionId) continue;
    await ctx.db.patch(open._id, {
      status: "superseded",
      supersededById: correctionId,
      statusReason: "the page changed again; review the newer proposal",
    });
  }
  if (proposals === "generate" && !unverifiable) {
    await ctx.scheduler.runAfter(0, internal.corrections.generateProposal, { correctionId });
  }
  return { outcome: unverifiable ? "unverifiable" : "vanished", replyId: reply._id, correctionId };
}

/**
 * Stores a newly observed page body. On a hash change every *sent* claim citing
 * this page is re-verified against the new version:
 *  - quote still present → control, `checkedAgainstVersionId` advanced; a claim
 *    previously under review whose quote came back returns to `ok` and its
 *    open corrections are superseded;
 *  - quote vanished → claim `needs_review` (never "false") and a fresh
 *    correction proposal against the new version. Any older pending or
 *    approved proposal is superseded; dismissed ones stay as history and the
 *    claim is re-evaluated; a claim already corrected is re-checked through the
 *    passage its sent correction rested on.
 * Unsent drafts and claims citing other pages are never touched.
 */
export async function recordPageVersion(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  markdown: string,
  diffText?: string,
  proposals: Proposals = "none",
): Promise<RecordVersionResult> {
  const page = await ctx.db.get(pageId);
  if (!page) throw new ConvexError({ code: "not_found", message: "Page not found" });
  const hash = await sha256Hex(markdown);
  const previous = page.lastVersionId ? await ctx.db.get(page.lastVersionId) : null;
  const status = previous ? (previous.hash === hash ? "same" : "changed") : "new";
  const now = Date.now();
  if (status === "same" && previous) {
    await ctx.db.patch(pageId, { lastCheckedAt: now });
    return {
      pageVersionId: previous._id,
      changeStatus: "same",
      affected: 0,
      unaffected: 0,
      affectedReplies: 0,
      unaffectedReplies: 0,
      correctionIds: [],
    };
  }
  const pageVersionId = await ctx.db.insert("pageVersions", {
    pageId,
    markdown,
    hash,
    scrapedAt: now,
    changeStatus: status,
    diffText,
  });
  await ctx.db.patch(pageId, { lastVersionId: pageVersionId, lastCheckedAt: now });
  const empty = { affected: 0, unaffected: 0, affectedReplies: 0, unaffectedReplies: 0, correctionIds: [] };
  if (status === "new" || !previous) {
    return { pageVersionId, changeStatus: status, ...empty };
  }

  const citing = await ctx.db
    .query("claims")
    .withIndex("by_page", (q) => q.eq("pageId", pageId))
    .collect();
  const affectedReplies = new Set<string>();
  const unaffectedReplies = new Set<string>();
  let affected = 0;
  let unaffected = 0;
  const correctionIds: Id<"corrections">[] = [];
  for (const claim of citing) {
    const result = await recheckSentClaim(ctx, claim, { _id: pageVersionId, markdown }, proposals);
    if (result.outcome === "skipped") continue;
    if (result.outcome === "verified") {
      unaffected += 1;
      unaffectedReplies.add(result.replyId);
      continue;
    }
    affected += 1;
    affectedReplies.add(result.replyId);
    correctionIds.push(result.correctionId);
  }
  // A reply with any vanished claim is affected, not a control.
  for (const id of affectedReplies) unaffectedReplies.delete(id);
  return {
    pageVersionId,
    changeStatus: "changed",
    affected,
    unaffected,
    affectedReplies: affectedReplies.size,
    unaffectedReplies: unaffectedReplies.size,
    correctionIds,
  };
}

/** Scraper entry point (site ingestion and the rescrape cron). */
export const recordVersion = internalMutation({
  args: {
    pageId: v.id("pages"),
    markdown: v.string(),
    diffText: v.optional(v.string()),
    reportedStatus: v.optional(changeStatus),
  },
  handler: async (ctx, { pageId, markdown, diffText }) => recordPageVersion(ctx, pageId, markdown, diffText, "generate"),
});

/**
 * Staff-supplied page content. For demo inns this is how "the inn edits its
 * policy page" happens without a live crawl; for real inns it lets staff paste
 * a page when the crawler cannot reach it. Real inns get drafter proposals for
 * any affected reply; demo inns never spend provider credits.
 */
export const submitContent = mutation({
  args: { pageId: v.id("pages"), markdown: v.string() },
  handler: async (ctx, { pageId, markdown }) => {
    const page = await ctx.db.get(pageId);
    if (!page) throw new ConvexError({ code: "forbidden", message: "No access to this page" });
    const { inn } = await requireInnAccess(ctx, page.innId);
    if (markdown.trim().length === 0 || markdown.length > 500_000) {
      throw new ConvexError({ code: "invalid", message: "Page content must be between 1 and 500000 characters" });
    }
    return recordPageVersion(ctx, pageId, markdown, undefined, inn.isDemo ? "none" : "generate");
  },
});

export const setWatched = mutation({
  args: { pageId: v.id("pages"), watched: v.boolean() },
  handler: async (ctx, { pageId, watched }) => {
    const page = await ctx.db.get(pageId);
    if (!page) throw new ConvexError({ code: "forbidden", message: "No access to this page" });
    await requireInnAccess(ctx, page.innId);
    await ctx.db.patch(pageId, { watched });
    return null;
  },
});
