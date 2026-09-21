import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { bareAddress } from "./lib/inboundPayload";
import { cancelFollowUps } from "./followUps";

export type InboundOutcome = "stored" | "duplicate" | "unknown_inbox";

export function searchableTextFor(subject: string, guestEmail: string, snippet: string): string {
  return `${subject}\n${guestEmail}\n${snippet}`.slice(0, 4000);
}

/** Marks every unsent draft of the thread superseded; a newer inbound makes them stale. */
export async function supersedeUnsentDrafts(ctx: MutationCtx, threadId: Id<"threads">, reason: string) {
  const drafts = await ctx.db
    .query("drafts")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  for (const draft of drafts) {
    if (draft.status === "sent" || draft.status === "superseded") continue;
    await ctx.db.patch(draft._id, { status: "superseded", statusReason: reason });
  }
}

/**
 * Applies one verified `message.received` delivery. Runs entirely in one
 * transaction: inbox → inn mapping, event/message dedupe scoped to that inn,
 * thread match by (inn, provider thread id) with a fallback on In-Reply-To,
 * message insert, draft supersession, follow-up cancellation and scheduling of
 * the drafter. Deliveries for inboxes no inn owns are acknowledged and dropped.
 */
export const receive = internalMutation({
  args: {
    eventId: v.string(),
    inboxId: v.string(),
    providerMessageId: v.string(),
    providerThreadId: v.string(),
    from: v.string(),
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    inReplyTo: v.optional(v.string()),
    rfcMessageId: v.optional(v.string()),
    receivedAt: v.number(),
  },
  handler: async (ctx, args): Promise<{ outcome: InboundOutcome; threadId?: Id<"threads"> }> => {
    const inn = await ctx.db
      .query("inns")
      .withIndex("by_inboxId", (q) => q.eq("inboxId", args.inboxId))
      .first();
    if (!inn || inn.isDemo) return { outcome: "unknown_inbox" };

    const seenEvent = await ctx.db
      .query("webhookEvents")
      .withIndex("by_inn_event", (q) => q.eq("innId", inn._id).eq("eventId", args.eventId))
      .first();
    if (seenEvent) return { outcome: "duplicate" };
    const seenMessage = await ctx.db
      .query("webhookEvents")
      .withIndex("by_inn_message", (q) => q.eq("innId", inn._id).eq("providerMessageId", args.providerMessageId))
      .first();
    if (seenMessage) return { outcome: "duplicate" };
    await ctx.db.insert("webhookEvents", {
      innId: inn._id,
      eventId: args.eventId,
      providerMessageId: args.providerMessageId,
      receivedAt: Date.now(),
    });

    const guestEmail = bareAddress(args.from);
    const snippet = args.text.replace(/\s+/g, " ").trim().slice(0, 200);
    let thread = await ctx.db
      .query("threads")
      .withIndex("by_inn_agentmail_thread", (q) => q.eq("innId", inn._id).eq("agentmailThreadId", args.providerThreadId))
      .first();
    if (!thread && args.inReplyTo) {
      const parent = await ctx.db
        .query("messages")
        .withIndex("by_rfc_message_id", (q) => q.eq("rfcMessageId", args.inReplyTo))
        .first();
      const parentThread = parent ? await ctx.db.get(parent.threadId) : null;
      if (parentThread && parentThread.innId === inn._id) thread = parentThread;
    }
    const receivedAt = Math.min(args.receivedAt, Date.now());
    let threadId: Id<"threads">;
    if (thread) {
      threadId = thread._id;
    } else {
      threadId = await ctx.db.insert("threads", {
        innId: inn._id,
        agentmailThreadId: args.providerThreadId,
        guestEmail,
        subject: args.subject,
        snippet,
        status: "new",
        lastInboundAt: receivedAt,
        searchableText: searchableTextFor(args.subject, guestEmail, snippet),
      });
    }
    const messageId = await ctx.db.insert("messages", {
      threadId,
      direction: "in",
      agentmailMessageId: args.providerMessageId,
      rfcMessageId: args.rfcMessageId,
      from: args.from,
      to: args.to,
      text: args.text,
      at: receivedAt,
      inReplyTo: args.inReplyTo,
      inboxId: args.inboxId,
      agentmailThreadId: args.providerThreadId,
    });
    // Webhook deliveries can arrive out of order (retries, provider delays). A
    // message older than the thread's current turn is kept as history only: it
    // must not become the turn drafts reply to, supersede current drafts, cancel
    // follow-ups or trigger a fresh generation. Equal timestamps keep the
    // existing turn (deterministic: first stored wins) unless the thread has no
    // inbound turn yet.
    const advancesTurn = !thread || receivedAt > thread.lastInboundAt || (receivedAt === thread.lastInboundAt && !thread.lastInboundMessageId);
    if (thread && !advancesTurn) {
      if (!thread.agentmailThreadId) await ctx.db.patch(threadId, { agentmailThreadId: args.providerThreadId });
      return { outcome: "stored", threadId };
    }
    await supersedeUnsentDrafts(ctx, threadId, "a newer guest message arrived");
    await cancelFollowUps(ctx, threadId);
    await ctx.db.patch(threadId, {
      status: "drafting",
      snippet,
      lastInboundAt: Math.max(thread?.lastInboundAt ?? 0, receivedAt),
      lastInboundMessageId: messageId,
      searchableText: searchableTextFor(thread?.subject ?? args.subject, guestEmail, snippet),
      agentmailThreadId: thread?.agentmailThreadId ?? args.providerThreadId,
    });
    await ctx.scheduler.runAfter(0, internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    return { outcome: "stored", threadId };
  },
});
