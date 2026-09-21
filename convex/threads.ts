import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireInnAccess, requireThreadAccess } from "./access";
import { CLAIM_TTL_MS, evaluateClaim, evaluateRelease, isClaimActive } from "./lib/claimLocks";
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

export const search = query({
  args: { innId: v.id("inns"), text: v.string() },
  handler: async (ctx, { innId, text }) => {
    await requireInnAccess(ctx, innId);
    const trimmed = text.trim();
    if (!trimmed) return [];
    const threads = await ctx.db
      .query("threads")
      .withSearchIndex("search_threads", (q) => q.search("snippet", trimmed).eq("innId", innId))
      .take(25);
    const now = Date.now();
    const out = [];
    for (const thread of threads) out.push(await summarize(ctx, thread, now));
    return out;
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
          }
        : null,
      claims: claims.map((c) => ({
        _id: c._id,
        statement: c.statement,
        url: c.url,
        quote: c.quote,
        verified: c.verified,
        verifyMethod: c.verifyMethod ?? null,
        status: c.status,
      })),
      facts: facts.map((f) => ({ _id: f._id, question: f.question, answer: f.answer, authorName: f.authorName })),
      sentReplies: sentReplies.map((r) => ({ _id: r._id, sentAt: r.sentAt })),
      corrections: corrections.map((c) => ({
        _id: c._id,
        status: c.status,
        oldQuote: c.oldQuote,
        newPassage: c.newPassage ?? null,
      })),
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
    return null;
  },
});
