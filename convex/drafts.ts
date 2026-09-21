import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireLiveMailAccess, requireThreadAccess } from "./access";
import { evaluateClaim } from "./lib/claimLocks";
import { decideDraftSend } from "./lib/sendGuards";
import { outboxStatusesFor, replyTurnState, reserveOutbox } from "./outbox";

const REGENERATE_COOLDOWN_MS = 60 * 1000;

/** Every `ok` claim of the draft still cites the page's latest version / a live fact. */
export async function draftSourcesCurrent(ctx: MutationCtx, draftId: Id<"drafts">): Promise<boolean> {
  const claims = await ctx.db
    .query("claims")
    .withIndex("by_draft", (q) => q.eq("draftId", draftId))
    .collect();
  for (const claim of claims) {
    if (claim.status !== "ok") continue;
    if (claim.pageId && claim.pageVersionId) {
      const page = await ctx.db.get(claim.pageId);
      if (!page || page.lastVersionId !== claim.pageVersionId) return false;
    }
    if (claim.staffFactId) {
      const fact = await ctx.db.get(claim.staffFactId);
      if (!fact || fact.supersededBy !== undefined) return false;
    }
  }
  return true;
}

export type AuthorizedDraftSend = {
  draft: Doc<"drafts">;
  thread: Doc<"threads">;
  inn: Doc<"inns">;
  user: Doc<"users">;
  inbound: Doc<"messages">;
  textSource: "model" | "staff" | "fixture";
};

/**
 * Shared decision for live and simulated sends: tenant access, active claim
 * held by the caller, ready-and-verified exact text (or an explicit
 * staff-authored send of an edited draft), latest inbound unchanged, cited
 * sources current, and no prior or in-flight send for the draft.
 */
export async function authorizeDraftSend(
  ctx: MutationCtx,
  draftId: Id<"drafts">,
  staffAuthored: boolean,
): Promise<AuthorizedDraftSend> {
  const draft = await ctx.db.get(draftId);
  if (!draft) throw new ConvexError({ code: "forbidden", message: "No access to this draft" });
  const { thread, inn, user } = await requireThreadAccess(ctx, draft.threadId);
  const priorSent = await ctx.db
    .query("sentReplies")
    .withIndex("by_draft", (q) => q.eq("draftId", draftId))
    .first();
  // The barrier is the guest turn, not the draft: a regenerated draft for the
  // same inbound shares the in-flight / already-sent state of every earlier one.
  const turn = draft.replyToMessageId ? await replyTurnState(ctx, draft.threadId, draft.replyToMessageId) : null;
  const decision = decideDraftSend({
    actor: user._id,
    now: Date.now(),
    thread,
    draft,
    staffAuthored,
    sourcesCurrent: await draftSourcesCurrent(ctx, draftId),
    priorSent: priorSent !== null || turn?.delivered === true,
    outboxStatuses: [...(await outboxStatusesFor(ctx, { draftId })), ...(turn?.statuses ?? [])],
  });
  if (!decision.ok) {
    throw new ConvexError({ code: decision.reason, message: `Cannot send: ${decision.reason.replace(/_/g, " ")}` });
  }
  const inbound = draft.replyToMessageId ? await ctx.db.get(draft.replyToMessageId) : null;
  if (!inbound) throw new ConvexError({ code: "no_reply_target", message: "No guest message to reply to" });
  return { draft, thread, inn, user, inbound, textSource: decision.textSource };
}

/**
 * Staff edit of the draft answer. The previous verdict no longer applies to
 * the new text, so the draft drops to needs_edit and (for real inns) the
 * exact edited text is re-judged. A draft with a reservation is frozen.
 */
export const edit = mutation({
  args: { draftId: v.id("drafts"), answer: v.string() },
  handler: async (ctx, { draftId, answer }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) throw new ConvexError({ code: "forbidden", message: "No access to this draft" });
    const { thread, user, inn } = await requireThreadAccess(ctx, draft.threadId);
    if (draft.status === "sent" || draft.status === "superseded" || draft.status === "verifying") {
      throw new ConvexError({ code: "invalid", message: "This draft can no longer be edited" });
    }
    const lock = evaluateClaim(thread, user._id, Date.now());
    if (!lock.ok) {
      throw new ConvexError({ code: "claimed", heldBy: lock.heldBy, expiresAt: lock.expiresAt });
    }
    const statuses = await outboxStatusesFor(ctx, { draftId });
    if (statuses.some((s) => s !== "failed")) {
      throw new ConvexError({ code: "in_flight", message: "This draft was already handed to the sender" });
    }
    const trimmed = answer.trim();
    if (trimmed.length === 0 || trimmed.length > 20_000) {
      throw new ConvexError({ code: "invalid", message: "Answer must be between 1 and 20000 characters" });
    }
    await ctx.db.patch(draftId, {
      answer: trimmed,
      status: "needs_edit",
      judgeVerdict: undefined,
      verifiedText: undefined,
      textSource: "staff",
      statusReason: inn.isDemo ? "edited by staff (demo: no re-judge)" : "edited by staff; re-judging the exact text",
    });
    if (thread.lastInboundMessageId === draft.replyToMessageId || thread.lastInboundMessageId === undefined) {
      await ctx.db.patch(thread._id, { status: "needs_staff" });
    }
    if (!inn.isDemo) await ctx.scheduler.runAfter(0, internal.generation.reverify, { draftId });
    return { status: "needs_edit" as const };
  },
});

/**
 * Reserves a live send. Runs every guard in one transaction and hands the
 * scheduler only the outbox id; delivery happens in internal.outbox.deliver.
 */
export const send = mutation({
  args: { draftId: v.id("drafts"), staffAuthored: v.optional(v.boolean()) },
  handler: async (ctx, { draftId, staffAuthored }) => {
    const authorized = await authorizeDraftSend(ctx, draftId, staffAuthored === true);
    const access = await requireLiveMailAccess(ctx, authorized.thread.innId);
    if (!access.inn.inboxId) throw new ConvexError({ code: "inbox_not_configured", message: "This inn has no inbox yet" });
    if (!authorized.inbound.agentmailMessageId) {
      throw new ConvexError({ code: "no_reply_target", message: "The guest message has no provider id" });
    }
    const outboxId = await reserveOutbox(ctx, {
      innId: access.inn._id,
      threadId: authorized.thread._id,
      kind: "reply",
      draftId,
      replyToMessageId: authorized.inbound._id,
      providerInboxId: authorized.inbound.inboxId ?? access.inn.inboxId,
      providerMessageId: authorized.inbound.agentmailMessageId,
      text: authorized.draft.answer,
      textSource: authorized.textSource,
      reservedBy: access.user._id,
      simulated: false,
    });
    await ctx.scheduler.runAfter(0, internal.outbox.deliver, { outboxId });
    return { outboxId };
  },
});

/** Re-runs the drafter for the thread's latest inbound (real inns, 60 s cooldown). */
export const regenerate = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { thread, inn, user } = await requireThreadAccess(ctx, threadId);
    if (inn.isDemo) throw new ConvexError({ code: "demo_inn", message: "Demo inns regenerate from staff facts only" });
    const lock = evaluateClaim(thread, user._id, Date.now());
    if (!lock.ok) throw new ConvexError({ code: "claimed", heldBy: lock.heldBy, expiresAt: lock.expiresAt });
    if (!thread.lastInboundMessageId) throw new ConvexError({ code: "no_reply_target", message: "No guest message yet" });
    // A new draft for a turn that was answered or is being answered would only
    // mislead the queue; the send guards enforce this independently.
    const turn = await replyTurnState(ctx, threadId, thread.lastInboundMessageId);
    if (turn.delivered) throw new ConvexError({ code: "already_sent", message: "This guest message was already answered" });
    if (turn.inFlight) throw new ConvexError({ code: "in_flight", message: "A reply to this guest message is being sent" });
    const now = Date.now();
    if (thread.lastGenerationAt !== undefined && now - thread.lastGenerationAt < REGENERATE_COOLDOWN_MS) {
      throw new ConvexError({ code: "cooldown", retryAt: thread.lastGenerationAt + REGENERATE_COOLDOWN_MS });
    }
    await ctx.db.patch(threadId, { lastGenerationAt: now });
    await ctx.scheduler.runAfter(0, internal.generation.generateForThread, {
      threadId,
      inboundMessageId: thread.lastInboundMessageId,
    });
    return null;
  },
});
