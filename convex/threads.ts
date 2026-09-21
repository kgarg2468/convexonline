import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireInnAccess, requireThreadAccess } from "./access";
import { CLAIM_TTL_MS, evaluateClaim, evaluateRelease, isClaimActive } from "./lib/claimLocks";
import { cancelEmailFollowUps } from "./followUps";
import { threadStatus } from "./schema";

async function nameFor(ctx: QueryCtx, innId: Id<"inns">, userId: Id<"users"> | undefined) {
  if (!userId) return null;
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_inn_user", (q) => q.eq("innId", innId).eq("userId", userId))
    .unique();
  return membership?.name ?? null;
}

async function summarize(ctx: QueryCtx, thread: Doc<"threads">, now: number) {
  const active = isClaimActive(thread, now);
  return {
    _id: thread._id,
    guestEmail: thread.guestEmail,
    subject: thread.subject,
    snippet: thread.snippet,
    status: thread.status,
    stay: thread.stay ?? null,
    lastInboundAt: thread.lastInboundAt,
    lastInboundMessageId: thread.lastInboundMessageId ?? null,
    claim: active
      ? {
          userId: thread.claimedBy!,
          name: await nameFor(ctx, thread.innId, thread.claimedBy),
          expiresAt: thread.claimedAt! + CLAIM_TTL_MS,
        }
      : null,
  };
}

export const queue = query({
  args: { innId: v.id("inns"), status: v.optional(threadStatus) },
  handler: async (ctx, { innId, status }) => {
    await requireInnAccess(ctx, innId);
    const threads = status
      ? await ctx.db
          .query("threads")
          .withIndex("by_inn_status", (q) => q.eq("innId", innId).eq("status", status))
          .order("desc")
          .collect()
      : await ctx.db
          .query("threads")
          .withIndex("by_inn_lastInbound", (q) => q.eq("innId", innId))
          .order("desc")
          .collect();
    const now = Date.now();
    const out = [];
    for (const thread of threads) out.push(await summarize(ctx, thread, now));
    return out;
  },
});

/** Full-text search over subject, guest email and snippet. */
export const search = query({
  args: { innId: v.id("inns"), text: v.string() },
  handler: async (ctx, { innId, text }) => {
    await requireInnAccess(ctx, innId);
    const trimmed = text.trim();
    if (!trimmed) return [];
    const threads = await ctx.db
      .query("threads")
      .withSearchIndex("search_threads", (q) => q.search("searchableText", trimmed).eq("innId", innId))
      .take(25);
    const now = Date.now();
    const out = [];
    for (const thread of threads) out.push(await summarize(ctx, thread, now));
    return out;
  },
});

/** Real counts over the inn's tables (no aggregate component). */
export const stats = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    await requireInnAccess(ctx, innId);
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_inn_lastInbound", (q) => q.eq("innId", innId))
      .collect();
    const count = (s: Doc<"threads">["status"]) => threads.filter((t) => t.status === s).length;
    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    let sentTotal = 0;
    let sentToday = 0;
    for (const t of threads) {
      const replies = await ctx.db
        .query("sentReplies")
        .withIndex("by_thread", (q) => q.eq("threadId", t._id))
        .collect();
      sentTotal += replies.length;
      sentToday += replies.filter((r) => r.sentAt >= dayStart).length;
    }
    const pending = await ctx.db
      .query("corrections")
      .withIndex("by_inn_status", (q) => q.eq("innId", innId).eq("status", "needs_review"))
      .collect();
    const responseTimes = threads
      .map((t) => t.firstResponseMs)
      .filter((x): x is number => typeof x === "number")
      .sort((a, b) => a - b);
    const median =
      responseTimes.length === 0
        ? null
        : responseTimes.length % 2 === 1
          ? responseTimes[(responseTimes.length - 1) / 2]
          : (responseTimes[responseTimes.length / 2 - 1] + responseTimes[responseTimes.length / 2]) / 2;
    return {
      open: count("new") + count("drafting") + count("needs_staff") + count("ready"),
      needsStaff: count("needs_staff"),
      ready: count("ready"),
      waitingGuest: count("waiting_guest"),
      sentToday,
      sentTotal,
      pendingCorrections: pending.length,
      medianFirstResponseMs: median,
    };
  },
});

export const get = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { thread, inn } = await requireThreadAccess(ctx, threadId);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    const drafts = await ctx.db
      .query("drafts")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    const draft = drafts.filter((d) => d.status !== "superseded").at(-1) ?? null;
    const claims = draft
      ? await ctx.db
          .query("claims")
          .withIndex("by_draft", (q) => q.eq("draftId", draft._id))
          .collect()
      : [];
    const facts = await ctx.db
      .query("staffFacts")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    const sentReplies = await ctx.db
      .query("sentReplies")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    const corrections = [];
    for (const reply of sentReplies) {
      const forReply = await ctx.db
        .query("corrections")
        .withIndex("by_sentReply", (q) => q.eq("sentReplyId", reply._id))
        .collect();
      corrections.push(...forReply);
    }
    const outbox = await ctx.db
      .query("outbox")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    const followUps = await ctx.db
      .query("followUps")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    // The reminder only; approved follow-up emails are read through followUps.emailForThread.
    const followUp = followUps.filter((f) => f.kind !== "email" && (f.status === "scheduled" || f.status === "due")).at(-1) ?? null;
    const claimsOut = [];
    for (const c of claims) {
      let currentSource = true;
      if (c.pageId && c.pageVersionId) {
        const page = await ctx.db.get(c.pageId);
        currentSource = page?.lastVersionId === c.pageVersionId;
      } else if (c.staffFactId) {
        const fact = await ctx.db.get(c.staffFactId);
        currentSource = fact !== null && fact.supersededBy === undefined;
      }
      claimsOut.push({
        _id: c._id,
        statement: c.statement,
        url: c.url,
        quote: c.quote,
        verified: c.verified,
        verifyMethod: c.verifyMethod ?? null,
        status: c.status,
        source: c.staffFactId ? ("fact" as const) : ("page" as const),
        pageVersionId: c.pageVersionId ?? null,
        staffFactId: c.staffFactId ?? null,
        currentSource,
      });
    }
    return {
      thread: await summarize(ctx, thread, Date.now()),
      inn: { _id: inn._id, name: inn.name, isDemo: inn.isDemo },
      messages: messages.map((m) => ({
        _id: m._id,
        direction: m.direction,
        from: m.from,
        to: m.to,
        text: m.text,
        at: m.at,
      })),
      draft: draft
        ? {
            _id: draft._id,
            class: draft.class,
            answer: draft.answer,
            abstain: draft.abstain,
            gapQuestion: draft.gapQuestion ?? null,
            status: draft.status,
            model: draft.model,
            judgeVerdict: draft.judgeVerdict ?? null,
            verifiedText: draft.verifiedText ?? null,
            statusReason: draft.statusReason ?? null,
            textSource: draft.textSource ?? "model",
            replyToMessageId: draft.replyToMessageId ?? null,
          }
        : null,
      claims: claimsOut,
      facts: facts.map((f) => ({ _id: f._id, question: f.question, answer: f.answer, authorName: f.authorName })),
      sentReplies: sentReplies.map((r) => ({
        _id: r._id,
        sentAt: r.sentAt,
        kind: r.kind ?? "reply",
        text: r.text ?? null,
        textSource: r.textSource ?? null,
        simulated: r.simulated ?? false,
        outboxId: r.outboxId ?? null,
        correctionId: r.correctionId ?? null,
      })),
      corrections: corrections.map((c) => ({
        _id: c._id,
        status: c.status,
        oldQuote: c.oldQuote,
        newPassage: c.newPassage ?? null,
        proposedText: c.proposedText ?? null,
      })),
      outbox: outbox.map((o) => ({
        _id: o._id,
        kind: o.kind,
        draftId: o.draftId ?? null,
        correctionId: o.correctionId ?? null,
        followUpId: o.followUpId ?? null,
        status: o.status,
        errorKind: o.errorKind ?? null,
        errorMessage: o.errorMessage ?? null,
        reservedAt: o.reservedAt,
        sentAt: o.sentAt ?? null,
        simulated: o.simulated,
      })),
      followUp: followUp ? { dueAt: followUp.dueAt, status: followUp.status as "scheduled" | "due" } : null,
    };
  },
});

export const claim = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { thread, user } = await requireThreadAccess(ctx, threadId);
    const now = Date.now();
    const decision = evaluateClaim(thread, user._id, now);
    if (!decision.ok) {
      const holder = await nameFor(ctx, thread.innId, decision.heldBy as Id<"users">);
      throw new ConvexError({
        code: "claimed",
        heldBy: decision.heldBy,
        heldByName: holder,
        expiresAt: decision.expiresAt,
      });
    }
    await ctx.db.patch(threadId, { claimedBy: user._id, claimedAt: now });
    return { kind: decision.kind, expiresAt: now + CLAIM_TTL_MS };
  },
});

export const release = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { thread, user } = await requireThreadAccess(ctx, threadId);
    const decision = evaluateRelease(thread, user._id, Date.now());
    if (!decision.ok) {
      throw new ConvexError({ code: "claimed", heldBy: decision.heldBy });
    }
    await ctx.db.patch(threadId, { claimedBy: undefined, claimedAt: undefined });
    return null;
  },
});

export const setStatus = mutation({
  args: {
    threadId: v.id("threads"),
    status: v.union(v.literal("closed"), v.literal("waiting_guest"), v.literal("needs_staff")),
  },
  handler: async (ctx, { threadId, status }) => {
    const { thread, user } = await requireThreadAccess(ctx, threadId);
    const lock = evaluateClaim(thread, user._id, Date.now());
    if (!lock.ok) {
      throw new ConvexError({ code: "claimed", heldBy: lock.heldBy, expiresAt: lock.expiresAt });
    }
    await ctx.db.patch(threadId, { status });
    // Closing withdraws any approved follow-up email that has not reached the provider.
    if (status === "closed") await cancelEmailFollowUps(ctx, threadId, "the thread was closed", user._id);
    return null;
  },
});
