import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalAction, internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireInnAccess, requireLiveMailAccess, requireThreadAccess } from "./access";
import { evaluateClaim } from "./lib/claimLocks";
import { currentDateIn, readEnv } from "./lib/env";
import { describeError } from "./lib/errors";
import { groundClaims } from "./lib/grounding";
import { verifyQuote } from "./lib/quotes";
import { decideCorrectionSend, isCorrectionTextApproved } from "./lib/sendGuards";
import { generateGroundedDraft, judgeDraft, DRAFT_MODEL_DEFAULT, JUDGE_MODEL_DEFAULT } from "./providers/openai";
import { outboxStatusesFor, reserveOutbox } from "./outbox";
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
      const sentReply = await ctx.db.get(c.sentReplyId);
      const sentDraft = sentReply ? await ctx.db.get(sentReply.draftId) : null;
      out.push({
        _id: c._id,
        status: c.status,
        threadId: c.threadId,
        sentReplyId: c.sentReplyId,
        claimId: c.claimId,
        subject: thread?.subject ?? "",
        guestEmail: thread?.guestEmail ?? "",
        statement: claim?.statement ?? "",
        sentText: sentReply?.text ?? sentDraft?.answer ?? "",
        pageUrl: page?.url ?? "",
        oldQuote: c.oldQuote,
        newPassage: c.newPassage ?? null,
        proposedText: c.proposedText ?? null,
        evidenceQuote: c.evidenceQuote ?? null,
        textSource: c.textSource ?? null,
        judgeVerdict: c.judgeVerdict ?? null,
        statusReason: c.statusReason ?? null,
        oldVersionId: c.oldVersionId,
        newVersionId: c.newVersionId,
        isCurrent: page?.lastVersionId === c.newVersionId,
        reviewedAt: c.reviewedAt ?? null,
        supersededById: c.supersededById ?? null,
        createdAt: c._creationTime,
      });
    }
    return out;
  },
});

/**
 * Most sent replies an *initial* page of `unaffectedControls` walks, whatever
 * `numItems` the client asks for. A reactive re-query of an existing range
 * (`endCursor`) is bounded by `CONTROLS_MAX_ROWS_READ` instead, so one call
 * may walk up to that many replies.
 */
const CONTROLS_REPLIES_PER_PAGE = 25;
/** Most claims of one draft the query reads; a draft beyond it is reported unchecked, never assumed true. */
const CONTROLS_CLAIMS_PER_DRAFT = 50;
/**
 * Correction-row budget of one corrected claim; the claim reads at most this
 * many rows plus one lookahead row before its reply is reported unchecked.
 */
const CONTROLS_CORRECTIONS_PER_CLAIM = 20;
/**
 * Correction-row budget of one call across all its replies; the call reads at
 * most this many rows plus one lookahead row, and corrected replies beyond it
 * are reported unchecked.
 */
const CONTROLS_CORRECTIONS_PER_QUERY = 400;
/**
 * Server-owned scan caps for the reply walk. A client may pass `endCursor`
 * (reactive pagination splits pages that way), which overrides `numItems`, so
 * the row and byte caps are what actually bound one call: a reactive range
 * may span up to `CONTROLS_MAX_ROWS_READ` replies. The row cap leaves
 * headroom over a full page so an initial page of exactly
 * `CONTROLS_REPLIES_PER_PAGE` replies is never reported as needing a split.
 */
const CONTROLS_MAX_ROWS_READ = CONTROLS_REPLIES_PER_PAGE * 2;
const CONTROLS_MAX_BYTES_READ = 1 << 20;

/**
 * `latestSentCorrection` under a read budget: the same "delivered last" choice
 * over every correction of the claim, or `overflow` when the claim's history
 * is larger than this call may read. An overflow never falls back to an older
 * correction or to the original quote; the caller reports the reply unchecked.
 *
 * Every row actually read is charged to `budget`, including the one lookahead
 * row that proves an overflow, so an oversized history is never a free read.
 * A claim reads at most `CONTROLS_CORRECTIONS_PER_CLAIM + 1` rows, and once
 * the budget is spent the call reports overflow without querying at all: a
 * whole call reads at most `CONTROLS_CORRECTIONS_PER_QUERY + 1` correction
 * rows (the budget plus a final lookahead row).
 */
async function latestSentCorrectionWithin(
  ctx: QueryCtx,
  claimId: Id<"claims">,
  budget: { remaining: number },
): Promise<{ overflow: true } | { overflow: false; correction: Doc<"corrections"> | null }> {
  if (budget.remaining <= 0) return { overflow: true };
  const limit = Math.min(CONTROLS_CORRECTIONS_PER_CLAIM, budget.remaining);
  const rows = await ctx.db
    .query("corrections")
    .withIndex("by_claim", (q) => q.eq("claimId", claimId))
    .take(limit + 1);
  budget.remaining -= rows.length;
  if (rows.length > limit) return { overflow: true };
  let best: { correction: Doc<"corrections">; deliveredAt: number; tieBreak: number } | null = null;
  for (const correction of rows) {
    if (correction.status !== "sent") continue;
    const reply = correction.sentReplyIdForCorrection ? await ctx.db.get(correction.sentReplyIdForCorrection) : null;
    const candidate = {
      correction,
      deliveredAt: reply?.sentAt ?? correction._creationTime,
      tieBreak: reply?._creationTime ?? correction._creationTime,
    };
    if (!best || candidate.deliveredAt > best.deliveredAt || (candidate.deliveredAt === best.deliveredAt && candidate.tieBreak > best.tieBreak)) {
      best = candidate;
    }
  }
  return { overflow: false, correction: best?.correction ?? null };
}

type UnaffectedControlRow =
  | {
      kind: "control";
      claimId: Id<"claims">;
      threadId: Id<"threads">;
      sentReplyId: Id<"sentReplies">;
      subject: string;
      statement: string;
      quote: string;
      pageUrl: string;
    }
  | { kind: "unchecked"; threadId: Id<"threads">; sentReplyId: Id<"sentReplies">; subject: string };

/**
 * Sent claims that still hold after the latest change of their page: the
 * controls shown beside affected replies in the review screen. A corrected
 * claim counts when the passage its sent correction rests on still holds; the
 * quote shown is then that passage, the last thing the guest was told.
 *
 * Paginated over the inn's sent replies (newest first, at most
 * `CONTROLS_REPLIES_PER_PAGE` replies per initial page and at most
 * `CONTROLS_MAX_ROWS_READ` per reactive `endCursor` range), so one call never
 * walks the inn's whole history. Each page is the flattened control rows of its replies:
 * `page` may be shorter or longer than the reply count, and `isDone` is the
 * only signal that every sent reply has been checked.
 *
 * Each row carries the *original* sent reply of its draft (the same
 * `sentReplies.by_draft` first row `recheckSentClaim` uses, so a corrective
 * email never counts as a new control for the claim it corrected), and the UI
 * counts distinct replies from it. A reply is only a control as a whole: when
 * any claim of the same draft is still `needs_review` (including one whose
 * correction is approved or dismissed but not yet sent or restored), none of
 * that draft's claims are listed, so the reply never shows as both affected
 * and "still true". A draft with more claims than the query reads, or a
 * corrected claim whose correction history exceeds the call's read budget,
 * yields one `unchecked` row instead of control rows: its reply is neither
 * listed nor counted as still true, and none of its other claims are listed.
 */
export const unaffectedControls = query({
  args: { innId: v.id("inns"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { innId, paginationOpts }) => {
    await requireInnAccess(ctx, innId);
    const replies = await ctx.db
      .query("sentReplies")
      .withIndex("by_inn", (q) => q.eq("innId", innId))
      .order("desc")
      .paginate({
        ...paginationOpts,
        numItems: Math.max(1, Math.min(paginationOpts.numItems, CONTROLS_REPLIES_PER_PAGE)),
        maximumRowsRead: CONTROLS_MAX_ROWS_READ,
        maximumBytesRead: CONTROLS_MAX_BYTES_READ,
      });
    const budget = { remaining: CONTROLS_CORRECTIONS_PER_QUERY };
    const pages = new Map<Id<"pages">, Doc<"pages"> | null>();
    const pageFor = async (pageId: Id<"pages">) => {
      let page = pages.get(pageId);
      if (page === undefined) {
        page = await ctx.db.get(pageId);
        pages.set(pageId, page);
      }
      return page;
    };
    const page: UnaffectedControlRow[] = [];
    for (const reply of replies.page) {
      if (reply.kind === "correction") continue;
      // The reply a claim is listed under is the first `by_draft` row of its
      // draft; any other row of the same draft is skipped so a reply is never
      // listed twice or under a later row.
      const original = await ctx.db
        .query("sentReplies")
        .withIndex("by_draft", (q) => q.eq("draftId", reply.draftId))
        .first();
      if (!original || original._id !== reply._id) continue;
      const claims = await ctx.db
        .query("claims")
        .withIndex("by_draft", (q) => q.eq("draftId", reply.draftId))
        .take(CONTROLS_CLAIMS_PER_DRAFT + 1);
      if (claims.length <= CONTROLS_CLAIMS_PER_DRAFT && claims.some((claim) => claim.status === "needs_review")) continue;
      // Rows of this reply are held back until every claim is resolved: an
      // overflow anywhere in the draft reports the reply unchecked as a whole
      // rather than listing the claims read before it.
      const rows: UnaffectedControlRow[] = [];
      let unchecked = claims.length > CONTROLS_CLAIMS_PER_DRAFT;
      let subject: string | undefined;
      for (const claim of unchecked ? [] : claims) {
        if (!claim.pageId) continue;
        const source = await pageFor(claim.pageId);
        if (!source || source.innId !== innId || !source.lastVersionId) continue;
        if (claim.checkedAgainstVersionId !== source.lastVersionId) continue;
        let quote = claim.quote;
        if (claim.status === "corrected") {
          const sent = await latestSentCorrectionWithin(ctx, claim._id, budget);
          if (sent.overflow) {
            unchecked = true;
            break;
          }
          if (!sent.correction?.evidenceQuote) continue;
          quote = sent.correction.evidenceQuote;
        } else if (claim.status !== "ok") continue;
        if (subject === undefined) subject = (await ctx.db.get(claim.threadId))?.subject ?? "";
        rows.push({
          kind: "control",
          claimId: claim._id,
          threadId: claim.threadId,
          sentReplyId: reply._id,
          subject,
          statement: claim.statement,
          quote,
          pageUrl: source.url,
        });
      }
      if (unchecked) {
        const thread = await ctx.db.get(reply.threadId);
        page.push({ kind: "unchecked", threadId: reply.threadId, sentReplyId: reply._id, subject: thread?.subject ?? "" });
        continue;
      }
      page.push(...rows);
    }
    return { ...replies, page };
  },
});

async function loadCorrection(ctx: MutationCtx, correctionId: Id<"corrections">) {
  const correction = await ctx.db.get(correctionId);
  if (!correction) throw new ConvexError({ code: "forbidden", message: "No access to this correction" });
  const access = await requireThreadAccess(ctx, correction.threadId);
  const page = await ctx.db.get(correction.pageId);
  if (!page) throw new ConvexError({ code: "forbidden", message: "No access to this correction" });
  return { correction, page, ...access };
}

/** Staff-authored correction text; the optional evidence quote must sit in the current page version. */
export const setText = mutation({
  args: { correctionId: v.id("corrections"), proposedText: v.string(), evidenceQuote: v.optional(v.string()) },
  handler: async (ctx, { correctionId, proposedText, evidenceQuote }) => {
    const { correction, page, thread, user } = await loadCorrection(ctx, correctionId);
    if (correction.status !== "needs_review" && correction.status !== "approved") {
      throw new ConvexError({ code: "invalid", message: "Correction can no longer be edited" });
    }
    const lock = evaluateClaim(thread, user._id, Date.now());
    if (!lock.ok) throw new ConvexError({ code: "claimed", heldBy: lock.heldBy, expiresAt: lock.expiresAt });
    if (page.lastVersionId !== correction.newVersionId) {
      throw new ConvexError({ code: "stale_source", message: "The page changed again; review the newer proposal" });
    }
    const statuses = await outboxStatusesFor(ctx, { correctionId });
    if (statuses.some((s) => s !== "failed")) throw new ConvexError({ code: "in_flight", message: "Already handed to the sender" });
    const text = proposedText.trim();
    if (text.length === 0 || text.length > 20_000) throw new ConvexError({ code: "invalid", message: "Text is required" });
    let evidence: { quote: string; method: "strict" | "normalized" } | undefined;
    if (evidenceQuote !== undefined && evidenceQuote.trim().length > 0) {
      const version = await ctx.db.get(correction.newVersionId);
      const verification = version ? verifyQuote(version.markdown, evidenceQuote) : { verified: false as const };
      if (!verification.verified) throw new ConvexError({ code: "invalid_quote", message: "Quote is not in the current page" });
      evidence = { quote: evidenceQuote, method: verification.method };
    }
    await ctx.db.patch(correctionId, {
      proposedText: text,
      textSource: "staff",
      judgeVerdict: undefined,
      evidenceQuote: evidence?.quote,
      evidenceVerifyMethod: evidence?.method,
      // Editing an approved correction withdraws the approval.
      status: "needs_review",
      reviewedBy: undefined,
      reviewedAt: undefined,
      statusReason: undefined,
    });
    return null;
  },
});

export const review = mutation({
  args: {
    correctionId: v.id("corrections"),
    decision: v.union(v.literal("approve"), v.literal("dismiss")),
    proposedText: v.optional(v.string()),
  },
  handler: async (ctx, { correctionId, decision, proposedText }) => {
    const { correction, page, thread, user } = await loadCorrection(ctx, correctionId);
    if (correction.status !== "needs_review") {
      throw new ConvexError({ code: "invalid", message: "Correction was already reviewed" });
    }
    const text = proposedText?.trim();
    if (decision === "approve") {
      if (page.lastVersionId !== correction.newVersionId) {
        throw new ConvexError({ code: "stale_source", message: "The page changed again; review the newer proposal" });
      }
      const lock = evaluateClaim(thread, user._id, Date.now());
      if (!lock.ok) throw new ConvexError({ code: "claimed", heldBy: lock.heldBy, expiresAt: lock.expiresAt });
      if (!(text || correction.proposedText)) {
        throw new ConvexError({ code: "invalid", message: "A correction needs text before approval" });
      }
      // Re-submitting the drafter's text unchanged is not an edit: a proposal the
      // judge rejected (or never saw) must actually be rewritten before approval.
      const changed = text !== undefined && text !== correction.proposedText;
      const approvable = changed
        ? { proposedText: text, textSource: "staff" as const }
        : { ...correction, proposedText: correction.proposedText };
      if (!isCorrectionTextApproved(approvable)) {
        throw new ConvexError({
          code: "unverified_proposal",
          message: "This proposal was not accepted by the judge or has no verified evidence; edit the text before approving",
        });
      }
      // Approval also takes the thread claim so the send that follows is owned.
      await ctx.db.patch(thread._id, { claimedBy: user._id, claimedAt: Date.now() });
    }
    const textChanged = text !== undefined && text !== correction.proposedText;
    await ctx.db.patch(correctionId, {
      status: decision === "approve" ? "approved" : "dismissed",
      proposedText: text || correction.proposedText,
      textSource: textChanged ? "staff" : correction.textSource,
      judgeVerdict: textChanged ? undefined : correction.judgeVerdict,
      reviewedBy: user._id,
      reviewedAt: Date.now(),
    });
    return null;
  },
});

export type AuthorizedCorrectionSend = {
  correction: Doc<"corrections">;
  thread: Doc<"threads">;
  inn: Doc<"inns">;
  user: Doc<"users">;
  inbound: Doc<"messages">;
};

export async function authorizeCorrectionSend(ctx: MutationCtx, correctionId: Id<"corrections">): Promise<AuthorizedCorrectionSend> {
  const { correction, page, thread, inn, user } = await loadCorrection(ctx, correctionId);
  const decision = decideCorrectionSend({
    actor: user._id,
    now: Date.now(),
    thread,
    correction,
    pageLastVersionId: page.lastVersionId,
    outboxStatuses: await outboxStatusesFor(ctx, { correctionId }),
  });
  if (!decision.ok) {
    throw new ConvexError({ code: decision.reason, message: `Cannot send: ${decision.reason.replace(/_/g, " ")}` });
  }
  const inbound = thread.lastInboundMessageId ? await ctx.db.get(thread.lastInboundMessageId) : null;
  if (!inbound || inbound.threadId !== thread._id) throw new ConvexError({ code: "no_reply_target", message: "No guest message" });
  return { correction, thread, inn, user, inbound };
}

/** Reserves a live correction send into the original guest thread. */
export const send = mutation({
  args: { correctionId: v.id("corrections") },
  handler: async (ctx, { correctionId }) => {
    const authorized = await authorizeCorrectionSend(ctx, correctionId);
    const access = await requireLiveMailAccess(ctx, authorized.thread.innId);
    if (!access.inn.inboxId) throw new ConvexError({ code: "inbox_not_configured", message: "This inn has no inbox yet" });
    if (!authorized.inbound.agentmailMessageId) {
      throw new ConvexError({ code: "no_reply_target", message: "The guest message has no provider id" });
    }
    const outboxId = await reserveOutbox(ctx, {
      innId: access.inn._id,
      threadId: authorized.thread._id,
      kind: "correction",
      correctionId,
      replyToMessageId: authorized.inbound._id,
      providerInboxId: authorized.inbound.inboxId ?? access.inn.inboxId,
      providerMessageId: authorized.inbound.agentmailMessageId,
      text: authorized.correction.proposedText!,
      textSource: authorized.correction.textSource === "staff" ? "staff" : "model",
      reservedBy: access.user._id,
      simulated: false,
    });
    await ctx.scheduler.runAfter(0, internal.outbox.deliver, { outboxId });
    return { outboxId };
  },
});

export const regenerateProposal = mutation({
  args: { correctionId: v.id("corrections") },
  handler: async (ctx, { correctionId }) => {
    const { correction, inn } = await loadCorrection(ctx, correctionId);
    if (inn.isDemo) throw new ConvexError({ code: "demo_inn", message: "Demo proposals come from fixtures" });
    if (correction.status !== "needs_review") throw new ConvexError({ code: "invalid", message: "Only pending proposals regenerate" });
    await ctx.scheduler.runAfter(0, internal.corrections.generateProposal, { correctionId });
    return null;
  },
});

// ---- Drafter-written proposals -------------------------------------------

export const proposalContext = internalQuery({
  args: { correctionId: v.id("corrections") },
  handler: async (ctx, { correctionId }) => {
    const correction = await ctx.db.get(correctionId);
    if (!correction) return null;
    const inn = await ctx.db.get(correction.innId);
    const page = await ctx.db.get(correction.pageId);
    const version = await ctx.db.get(correction.newVersionId);
    const thread = await ctx.db.get(correction.threadId);
    const sentReply = await ctx.db.get(correction.sentReplyId);
    const sentDraft = sentReply ? await ctx.db.get(sentReply.draftId) : null;
    const claim = await ctx.db.get(correction.claimId);
    if (!inn || !page || !version || !thread || !claim) return null;
    return {
      status: correction.status,
      isDemo: inn.isDemo,
      timezone: inn.timezone,
      isCurrent: page.lastVersionId === correction.newVersionId,
      page: { pageId: page._id, url: page.url, versionId: version._id, markdown: version.markdown },
      subject: thread.subject,
      sentText: sentReply?.text ?? sentDraft?.answer ?? "",
      statement: claim.statement,
      oldQuote: correction.oldQuote,
    };
  },
});

export const applyProposal = internalMutation({
  args: {
    correctionId: v.id("corrections"),
    newVersionId: v.id("pageVersions"),
    proposedText: v.optional(v.string()),
    evidenceQuote: v.optional(v.string()),
    evidenceVerifyMethod: v.optional(v.union(v.literal("strict"), v.literal("normalized"))),
    judgeVerdict: v.optional(v.object({ entailed: v.boolean(), promisedOutsideQuotes: v.boolean(), notes: v.string() })),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const correction = await ctx.db.get(args.correctionId);
    // Only a still-pending proposal against the same version accepts the drafter's text.
    if (!correction || correction.status !== "needs_review" || correction.newVersionId !== args.newVersionId) return null;
    if (correction.textSource === "staff") return null;
    await ctx.db.patch(args.correctionId, {
      proposedText: args.proposedText,
      evidenceQuote: args.evidenceQuote,
      evidenceVerifyMethod: args.evidenceVerifyMethod,
      textSource: args.proposedText ? "generated" : undefined,
      judgeVerdict: args.judgeVerdict,
      statusReason: args.reason,
    });
    return null;
  },
});

/**
 * Asks the drafter for a correction grounded only in the new page version;
 * the quote is verified mechanically and the exact text judged. Without a
 * key, or on any failure, the proposal stays empty with a reason so staff
 * write it themselves.
 */
export const generateProposal = internalAction({
  args: { correctionId: v.id("corrections") },
  handler: async (ctx, { correctionId }) => {
    const c = await ctx.runQuery(internal.corrections.proposalContext, { correctionId });
    if (!c || c.isDemo || c.status !== "needs_review" || !c.isCurrent) return null;
    const apiKey = readEnv("OPENAI_API_KEY");
    type ProposalPatch = {
      proposedText?: string;
      evidenceQuote?: string;
      evidenceVerifyMethod?: "strict" | "normalized";
      judgeVerdict?: { entailed: boolean; promisedOutsideQuotes: boolean; notes: string };
      reason?: string;
    };
    const apply = (patch: ProposalPatch) =>
      ctx.runMutation(internal.corrections.applyProposal, { correctionId, newVersionId: c.page.versionId, ...patch });
    if (!apiKey) {
      await apply({ reason: "drafter unavailable: OPENAI_API_KEY is not configured; write the correction" });
      return null;
    }
    // A generated correction (draft + judge) is one budget operation for the
    // inn that owns the page; a denial leaves the proposal empty with the
    // retry time so staff can write it or regenerate later.
    const budget = await ctx.runMutation(internal.modelBudget.reserve, {
      scope: { kind: "correction", correctionId, newVersionId: c.page.versionId },
    });
    if (!budget.ok) {
      if (budget.kind === "throttled") await apply({ reason: `drafting paused: ${budget.reason}; write the correction or regenerate later` });
      return null;
    }
    // Historical context only, so the drafter can tell which topic the guest
    // was told about. Instructions live in the adapter's correction mode, not
    // here: this block is untrusted data to the drafter and never evidence.
    const inquiry = [
      `Subject: Re: ${c.subject}`,
      "",
      "Reply already sent to this guest:",
      c.sentText,
      "",
      `Passage of the old page that reply relied on (no longer on the page): "${c.oldQuote}"`,
      `Statement it supported: "${c.statement}"`,
    ].join("\n");
    const currentDate = currentDateIn(c.timezone);
    try {
      const generated = await generateGroundedDraft({
        apiKey,
        inquiry,
        pages: [{ url: c.page.url, versionId: c.page.versionId, markdown: c.page.markdown }],
        facts: [],
        currentDate,
        mode: "correction",
        model: DRAFT_MODEL_DEFAULT,
      });
      const grounded = groundClaims(generated.claims, [
        { kind: "page", id: c.page.versionId, url: c.page.url, markdown: c.page.markdown, pageId: c.page.pageId },
      ]);
      const ok = grounded.filter((g) => g.status === "ok");
      // A non-answerable class means the drafter needs a staff fact or an
      // availability/approval decision; never judge or persist such text.
      if (generated.class !== "answerable") {
        await apply({ reason: `drafter classified the correction as ${generated.class}; write it by hand` });
        return null;
      }
      if (generated.abstain || generated.answer.trim().length === 0 || ok.length === 0 || ok.length !== grounded.length) {
        await apply({ reason: "drafter could not ground a correction in the new page; write it by hand" });
        return null;
      }
      const j = await judgeDraft({
        apiKey,
        reply: generated.answer,
        statements: ok.map((g) => ({ statement: g.statement, quote: g.quote, url: g.url })),
        currentDate,
        model: JUDGE_MODEL_DEFAULT,
      });
      const verdict = { entailed: j.entailed, promisedOutsideQuotes: j.promised, notes: j.notes };
      if (!j.entailed || j.promised) {
        await apply({
          proposedText: generated.answer,
          evidenceQuote: ok[0].quote,
          evidenceVerifyMethod: ok[0].verification.verified ? ok[0].verification.method : undefined,
          judgeVerdict: verdict,
          reason: "judge did not accept the generated correction; edit before approving",
        });
        return null;
      }
      await apply({
        proposedText: generated.answer,
        evidenceQuote: ok[0].quote,
        evidenceVerifyMethod: ok[0].verification.verified ? ok[0].verification.method : undefined,
        judgeVerdict: verdict,
      });
    } catch (e) {
      const err = describeError(e);
      await apply({ reason: `drafter failed (${err.kind}): ${err.message}` });
    }
    return null;
  },
});
