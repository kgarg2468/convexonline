import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { readEnv } from "./lib/env";
import { describeError } from "./lib/errors";
import { isClaimActive } from "./lib/claimLocks";
import { isCorrectionTextApproved } from "./lib/sendGuards";
import { replyToMessage } from "./providers/agentmail";
import { scheduleFollowUp } from "./followUps";
import { recheckSentClaim } from "./pages";

export type ReserveArgs = {
  innId: Id<"inns">;
  threadId: Id<"threads">;
  kind: "reply" | "correction";
  draftId?: Id<"drafts">;
  correctionId?: Id<"corrections">;
  replyToMessageId: Id<"messages">;
  providerInboxId?: string;
  providerMessageId?: string;
  text: string;
  textSource: "model" | "staff" | "fixture";
  reservedBy: Id<"users">;
  simulated: boolean;
};

/** Inserts the immutable reservation row. Callers have already decided the send is allowed. */
export async function reserveOutbox(ctx: MutationCtx, args: ReserveArgs): Promise<Id<"outbox">> {
  return await ctx.db.insert("outbox", { ...args, reservedAt: Date.now(), status: "reserved" });
}

export async function outboxStatusesFor(
  ctx: MutationCtx,
  key: { draftId: Id<"drafts"> } | { correctionId: Id<"corrections"> },
): Promise<Doc<"outbox">["status"][]> {
  const rows =
    "draftId" in key
      ? await ctx.db
          .query("outbox")
          .withIndex("by_draft", (q) => q.eq("draftId", key.draftId))
          .collect()
      : await ctx.db
          .query("outbox")
          .withIndex("by_correction", (q) => q.eq("correctionId", key.correctionId))
          .collect();
  return rows.map((r) => r.status);
}

const IN_FLIGHT: ReadonlySet<Doc<"outbox">["status"]> = new Set(["reserved", "sending", "unknown"]);

export type ReplyTurnState = {
  /** Statuses of every normal-reply reservation for this inbound, across all drafts. */
  statuses: Doc<"outbox">["status"][];
  /** A normal reply answering this inbound was delivered (any draft, including legacy rows without an outbox entry). */
  delivered: boolean;
  inFlight: boolean;
};

/**
 * The send state of one guest turn: every normal-reply reservation for the
 * inbound, whichever draft it came from, plus whether a reply was delivered.
 * Corrections are deliberate later messages and never count. Reads the
 * thread's outbox index and filters on the immutable reply target, so two
 * regenerated drafts for the same inbound share one barrier.
 */
export async function replyTurnState(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  replyToMessageId: Id<"messages">,
  excludeOutboxId?: Id<"outbox">,
): Promise<ReplyTurnState> {
  const rows = await ctx.db
    .query("outbox")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  const statuses = rows
    .filter((r) => r.kind === "reply" && r.replyToMessageId === replyToMessageId && r._id !== excludeOutboxId)
    .map((r) => r.status);
  let delivered = statuses.includes("sent");
  if (!delivered) {
    const replies = await ctx.db
      .query("sentReplies")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    for (const reply of replies) {
      if (reply.kind === "correction") continue;
      const draft = await ctx.db.get(reply.draftId);
      if (draft?.replyToMessageId === replyToMessageId) {
        delivered = true;
        break;
      }
    }
  }
  return { statuses, delivered, inFlight: statuses.some((s) => IN_FLIGHT.has(s)) };
}

/**
 * Re-checks the reservation right before the external call and flips it to
 * `sending` in the same transaction, so a duplicate delivery worker or a
 * reservation that lost its preconditions (new inbound, lost claim, draft
 * already sent) can never reach the provider.
 */
async function preflight(ctx: MutationCtx, row: Doc<"outbox">, now: number): Promise<string | null> {
  const thread = await ctx.db.get(row.threadId);
  if (!thread) return "thread missing";
  if (thread.lastInboundMessageId !== row.replyToMessageId) return "a newer guest message arrived before dispatch";
  if (!isClaimActive(thread, now) || thread.claimedBy !== row.reservedBy) return "thread claim expired or changed before dispatch";
  if (row.kind === "reply") {
    if (!row.draftId) return "reservation has no draft";
    const draft = await ctx.db.get(row.draftId);
    if (!draft || draft.status === "sent" || draft.status === "superseded") return "draft is no longer sendable";
    if (draft.answer !== row.text) return "draft text changed after reservation";
    const prior = await ctx.db
      .query("sentReplies")
      .withIndex("by_draft", (q) => q.eq("draftId", row.draftId!))
      .first();
    if (prior) return "draft already sent";
    // Another draft answering the same guest message must not slip through
    // while this turn is in flight or once it was delivered.
    const turn = await replyTurnState(ctx, row.threadId, row.replyToMessageId, row._id);
    if (turn.inFlight) return "another reply to this guest message is in flight";
    if (turn.delivered) return "this guest message was already answered";
    for (const claim of await ctx.db
      .query("claims")
      .withIndex("by_draft", (q) => q.eq("draftId", row.draftId!))
      .collect()) {
      if (claim.status !== "ok") continue;
      if (claim.pageId && claim.pageVersionId) {
        const page = await ctx.db.get(claim.pageId);
        if (!page || page.lastVersionId !== claim.pageVersionId) return "a cited page changed before dispatch";
      }
      if (claim.staffFactId) {
        const fact = await ctx.db.get(claim.staffFactId);
        if (!fact || fact.supersededBy !== undefined) return "a cited staff fact changed before dispatch";
      }
    }
  } else {
    if (!row.correctionId) return "reservation has no correction";
    const correction = await ctx.db.get(row.correctionId);
    if (!correction || correction.status !== "approved") return "correction is no longer approved";
    if (correction.proposedText !== row.text) return "correction text changed after reservation";
    if (!isCorrectionTextApproved(correction)) return "correction text is no longer verified (judge or evidence) before dispatch";
    const page = await ctx.db.get(correction.pageId);
    if (!page || page.lastVersionId !== correction.newVersionId) return "the page changed again before dispatch";
  }
  return null;
}

export const beginSend = internalMutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    if (!row) return { ok: false as const, reason: "missing" };
    if (row.status !== "reserved") return { ok: false as const, reason: `status ${row.status}` };
    const problem = await preflight(ctx, row, Date.now());
    if (problem) {
      await ctx.db.patch(outboxId, { status: "failed", errorKind: "precondition", errorMessage: problem });
      return { ok: false as const, reason: problem };
    }
    if (row.simulated) {
      return { ok: false as const, reason: "simulated rows never dispatch" };
    }
    const inn = await ctx.db.get(row.innId);
    const inboxId = row.providerInboxId ?? inn?.inboxId;
    if (!inn || inn.isDemo || !inboxId) {
      await ctx.db.patch(outboxId, { status: "failed", errorKind: "inbox_not_configured", errorMessage: "no inbox bound to this inn" });
      return { ok: false as const, reason: "inbox not configured" };
    }
    if (!row.providerMessageId) {
      await ctx.db.patch(outboxId, { status: "failed", errorKind: "no_reply_target", errorMessage: "inbound has no provider id" });
      return { ok: false as const, reason: "no provider message id" };
    }
    await ctx.db.patch(outboxId, { status: "sending" });
    return { ok: true as const, inboxId, providerMessageId: row.providerMessageId, text: row.text };
  },
});

/** Records the delivered message and closes out the draft or correction. */
export async function commitDelivery(
  ctx: MutationCtx,
  row: Doc<"outbox">,
  delivered: { providerMessageId?: string; providerThreadId?: string },
) {
  const now = Date.now();
  const thread = await ctx.db.get(row.threadId);
  const inn = await ctx.db.get(row.innId);
  const inbound = await ctx.db.get(row.replyToMessageId);
  if (!thread || !inn) throw new ConvexError({ code: "invalid", message: "thread missing at commit" });
  const messageId = await ctx.db.insert("messages", {
    threadId: row.threadId,
    direction: "out",
    agentmailMessageId: delivered.providerMessageId,
    from: inn.inboxAddress ?? inn.inboxId ?? `${inn.name} (demo)`,
    to: thread.guestEmail,
    text: row.text,
    at: now,
    inReplyTo: inbound?.rfcMessageId,
    inboxId: row.providerInboxId,
    agentmailThreadId: delivered.providerThreadId ?? thread.agentmailThreadId,
  });
  let draftId = row.draftId;
  let correction: Doc<"corrections"> | null = null;
  if (row.kind === "correction" && row.correctionId) {
    correction = await ctx.db.get(row.correctionId);
    if (correction) {
      const claim = await ctx.db.get(correction.claimId);
      draftId = claim?.draftId ?? draftId;
    }
  }
  if (!draftId) throw new ConvexError({ code: "invalid", message: "no draft for sent reply" });
  const sentReplyId = await ctx.db.insert("sentReplies", {
    threadId: row.threadId,
    innId: row.innId,
    draftId,
    agentmailMessageId: delivered.providerMessageId,
    sentBy: row.reservedBy,
    sentAt: now,
    kind: row.kind,
    correctionId: row.correctionId,
    outboxId: row._id,
    messageId,
    text: row.text,
    textSource: row.textSource,
    simulated: row.simulated,
  });
  await ctx.db.patch(row._id, { status: "sent", sentAt: now, sentProviderMessageId: delivered.providerMessageId });
  const proposals = inn.isDemo || row.simulated ? "none" : "generate";
  if (row.kind === "reply") {
    await ctx.db.patch(draftId, { status: "sent" });
    const patch: Partial<Doc<"threads">> = {};
    // The first response is measured against the inbound it answered, not a newer one.
    if (thread.firstResponseMs === undefined) patch.firstResponseMs = Math.max(0, now - (inbound?.at ?? thread.lastInboundAt));
    // A guest message that arrived while the provider call was in flight owns the
    // thread state now: this delivery is history, not the current turn.
    const answersLatestInbound = thread.lastInboundMessageId === row.replyToMessageId;
    if (answersLatestInbound) patch.status = "waiting_guest";
    if (Object.keys(patch).length > 0) await ctx.db.patch(thread._id, patch);
    if (answersLatestInbound && thread.stay?.status === "inquiry") await scheduleFollowUp(ctx, thread._id, now);
    await recheckAgainstCurrentPages(ctx, draftId, proposals);
  } else if (correction) {
    await ctx.db.patch(correction._id, {
      status: "sent",
      sentReplyIdForCorrection: sentReplyId,
      supersededById: undefined,
      statusReason: undefined,
    });
    await ctx.db.patch(correction.claimId, { status: "corrected" });
    const page = await ctx.db.get(correction.pageId);
    if (page?.lastVersionId && page.lastVersionId !== correction.newVersionId) {
      // The page moved on while this correction was in flight: what the guest
      // just heard is history; check it against the page as it is now.
      const claim = await ctx.db.get(correction.claimId);
      const version = await ctx.db.get(page.lastVersionId);
      if (claim && version) await recheckSentClaim(ctx, claim, version, proposals);
    }
  }
  return { sentReplyId, messageId };
}

/**
 * A cited page may have changed between preflight and the provider's answer.
 * The reply went out either way, so its claims are re-verified against the
 * current version right away instead of waiting for the next crawl (which
 * skips claims whose page did not change again).
 */
async function recheckAgainstCurrentPages(ctx: MutationCtx, draftId: Id<"drafts">, proposals: "generate" | "none") {
  const claims = await ctx.db
    .query("claims")
    .withIndex("by_draft", (q) => q.eq("draftId", draftId))
    .collect();
  for (const claim of claims) {
    if (claim.status !== "ok" || !claim.pageId || !claim.pageVersionId) continue;
    const page = await ctx.db.get(claim.pageId);
    if (!page?.lastVersionId || page.lastVersionId === claim.pageVersionId) continue;
    if (claim.checkedAgainstVersionId === page.lastVersionId) continue;
    const version = await ctx.db.get(page.lastVersionId);
    if (version) await recheckSentClaim(ctx, claim, version, proposals);
  }
}

export const commit = internalMutation({
  args: { outboxId: v.id("outbox"), providerMessageId: v.string(), providerThreadId: v.optional(v.string()) },
  handler: async (ctx, { outboxId, providerMessageId, providerThreadId }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "sending") return null;
    await commitDelivery(ctx, row, { providerMessageId, providerThreadId });
    return null;
  },
});

export const markFailed = internalMutation({
  args: {
    outboxId: v.id("outbox"),
    errorKind: v.string(),
    errorMessage: v.string(),
    ambiguous: v.boolean(),
    /** Provider id of a message that was accepted but could not be recorded; kept for reconciliation. */
    sentProviderMessageId: v.optional(v.string()),
  },
  handler: async (ctx, { outboxId, errorKind, errorMessage, ambiguous, sentProviderMessageId }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "sending") return null;
    const patch: Partial<Doc<"outbox">> = { status: ambiguous ? "unknown" : "failed", errorKind, errorMessage };
    if (sentProviderMessageId !== undefined) patch.sentProviderMessageId = sentProviderMessageId;
    await ctx.db.patch(outboxId, patch);
    return null;
  },
});

/**
 * Delivers one reservation. Receives only the outbox id; the text and target
 * come from the row. An ambiguous provider failure (timeout, 5xx, network)
 * leaves the row `unknown` and is never retried: the guest may already have
 * the message and a second attempt could double-send.
 *
 * The provider call and the local commit are separate phases. Once the
 * provider has accepted the message, no local failure may make the row
 * retryable: it becomes `unknown` with the provider message id kept for
 * reconciliation, and if even that write fails the row stays `sending`,
 * which blocks resends just the same.
 */
export const deliver = internalAction({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const begin = await ctx.runMutation(internal.outbox.beginSend, { outboxId });
    if (!begin.ok) return null;
    const apiKey = readEnv("AGENTMAIL_API_KEY");
    if (!apiKey) {
      await ctx.runMutation(internal.outbox.markFailed, {
        outboxId,
        errorKind: "agentmail_unavailable",
        errorMessage: "AGENTMAIL_API_KEY is not configured; nothing was sent",
        ambiguous: false,
      });
      return null;
    }
    let result: { messageId: string; threadId?: string };
    try {
      result = await replyToMessage({
        apiKey,
        inboxId: begin.inboxId,
        messageId: begin.providerMessageId,
        text: begin.text,
      });
    } catch (e) {
      const err = describeError(e);
      await ctx.runMutation(internal.outbox.markFailed, {
        outboxId,
        errorKind: err.kind,
        errorMessage: err.ambiguous ? `${err.message} (delivery unknown; not retried)` : err.message,
        ambiguous: err.ambiguous,
      });
      return null;
    }
    // From here on the guest may have the message: nothing below may allow a resend.
    try {
      await ctx.runMutation(internal.outbox.commit, {
        outboxId,
        providerMessageId: result.messageId,
        providerThreadId: result.threadId,
      });
    } catch {
      try {
        await ctx.runMutation(internal.outbox.markFailed, {
          outboxId,
          errorKind: "commit_failed",
          errorMessage: "the provider accepted the message but recording it failed (delivery unknown; not retried)",
          ambiguous: true,
          sentProviderMessageId: result.messageId,
        });
      } catch {
        // The row is still `sending`, which blocks any further send just as `unknown` does.
      }
    }
    return null;
  },
});
