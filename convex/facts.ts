import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { internal } from "./_generated/api";
import { requireInnAccess } from "./access";
import { regenerateDemoDraftFromFact } from "./demo";
import { factScope } from "./schema";

export const list = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    await requireInnAccess(ctx, innId);
    const general = await ctx.db
      .query("staffFacts")
      .withIndex("by_inn_scope", (q) => q.eq("innId", innId).eq("scope", "general"))
      .order("desc")
      .collect();
    return general
      .filter((f) => f.supersededBy === undefined)
      .map((f) => ({
        _id: f._id,
        question: f.question,
        answer: f.answer,
        authorName: f.authorName,
        createdAt: f.createdAt,
      }));
  },
});

/**
 * Records a staff answer. When it answers a thread's knowledge gap the thread
 * is redrafted: real inns schedule the drafter with the new fact in scope;
 * demo inns build a fixture draft that cites the fact verbatim.
 */
export const add = mutation({
  args: {
    innId: v.id("inns"),
    question: v.string(),
    answer: v.string(),
    scope: factScope,
    threadId: v.optional(v.id("threads")),
  },
  handler: async (ctx, args) => {
    const { user, membership, inn } = await requireInnAccess(ctx, args.innId);
    const question = args.question.trim();
    const answer = args.answer.trim();
    if (!question || !answer || question.length > 2000 || answer.length > 5000) {
      throw new ConvexError({ code: "invalid", message: "Question and answer are required" });
    }
    if (args.scope === "thread" && !args.threadId) {
      throw new ConvexError({ code: "invalid", message: "Thread-scoped facts need a thread" });
    }
    if (args.threadId) {
      const thread = await ctx.db.get(args.threadId);
      if (!thread || thread.innId !== args.innId) {
        throw new ConvexError({ code: "forbidden", message: "No access to this thread" });
      }
    }
    const factId = await ctx.db.insert("staffFacts", {
      innId: args.innId,
      question,
      answer,
      scope: args.scope,
      threadId: args.threadId,
      author: user._id,
      authorName: membership.name,
      createdAt: Date.now(),
    });
    if (args.threadId) {
      const thread = await ctx.db.get(args.threadId);
      if (thread && (thread.status === "needs_staff" || thread.status === "new")) {
        if (inn.isDemo) {
          await regenerateDemoDraftFromFact(ctx, thread, factId);
        } else if (thread.lastInboundMessageId) {
          await ctx.db.patch(args.threadId, { status: "drafting", lastGenerationAt: Date.now() });
          await ctx.scheduler.runAfter(0, internal.generation.generateForThread, {
            threadId: args.threadId,
            inboundMessageId: thread.lastInboundMessageId,
          });
        } else {
          await ctx.db.patch(args.threadId, { status: "drafting" });
        }
      }
    }
    return factId;
  },
});
