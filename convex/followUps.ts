import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { membershipFor, requireThreadAccess } from "./access";
import { isClaimActive } from "./lib/claimLocks";
import { canUseLiveMail } from "./lib/tenant";
import { commitFollowUpDelivery, reserveOutbox } from "./outbox";

export const FOLLOW_UP_DELAY_MS = 48 * 60 * 60 * 1000;

/**
 * The only text a follow-up email may ever carry. It states nothing about
 * the property, so approving it asserts no new fact; staff approve exactly
 * this string and the approval is bound to it.
 */
export const FOLLOW_UP_EMAIL_TEXT = "Just checking whether you still need help with your inquiry. Reply here if you have any questions.";
export const FOLLOW_UP_EMAIL_MIN_DELAY_MS = 60 * 1000;
export const FOLLOW_UP_EMAIL_MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
export const FOLLOW_UP_EMAIL_DEFAULT_DELAY_MS = FOLLOW_UP_DELAY_MS;
/** Email approvals cancelled per transaction when a member is removed. */
export const FOLLOW_UP_CANCEL_BATCH = 100;

type Ctx = QueryCtx | MutationCtx;

const isEmail = (row: Doc<"followUps">) => row.kind === "email";
/** An email approval that can still lead to a send (or already did). */
const isLiveEmail = (row: Doc<"followUps">) => isEmail(row) && (row.status === "scheduled" || row.status === "reserved" || row.status === "sent");

// ---------------------------------------------------------------------------
// Reminders (unchanged behaviour): never outbound mail.
// ---------------------------------------------------------------------------

/**
 * Follow-up reminders are never outbound mail: when a reply to a booking
 * inquiry goes unanswered for FOLLOW_UP_DELAY_MS the thread surfaces as
 * `needs_staff` with the reminder marked due. A guest reply cancels it.
 */
export async function scheduleFollowUp(ctx: MutationCtx, threadId: Id<"threads">, now: number) {
  await cancelReminders(ctx, threadId);
  const dueAt = now + FOLLOW_UP_DELAY_MS;
  const followUpId = await ctx.db.insert("followUps", { threadId, dueAt, status: "scheduled", kind: "reminder" });
  const scheduledId = await ctx.scheduler.runAt(dueAt, internal.followUps.fire, { followUpId });
  await ctx.db.patch(followUpId, { scheduledId });
  return followUpId;
}

async function cancelPendingJob(ctx: MutationCtx, scheduledId: Id<"_scheduled_functions"> | undefined) {
  if (!scheduledId) return;
  const scheduled = await ctx.db.system.get(scheduledId);
  if (scheduled && (scheduled.state.kind === "pending" || scheduled.state.kind === "inProgress")) {
    await ctx.scheduler.cancel(scheduledId);
  }
}

async function cancelReminders(ctx: MutationCtx, threadId: Id<"threads">) {
  const rows = await ctx.db
    .query("followUps")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  for (const row of rows) {
    if (isEmail(row)) continue;
    if (row.status !== "scheduled" && row.status !== "due") continue;
    await cancelPendingJob(ctx, row.scheduledId);
    await ctx.db.patch(row._id, { status: "cancelled" });
  }
}

/**
 * A newer guest message ends the turn: reminders are cancelled as before and
 * any approved email for the thread is withdrawn before it can go out.
 */
export async function cancelFollowUps(ctx: MutationCtx, threadId: Id<"threads">, reason = "a newer guest message arrived") {
  await cancelReminders(ctx, threadId);
  await cancelEmailFollowUps(ctx, threadId, reason);
}

export const fire = internalMutation({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    const row = await ctx.db.get(followUpId);
    if (!row || isEmail(row) || row.status !== "scheduled") return null;
    const thread = await ctx.db.get(row.threadId);
    if (!thread) return null;
    // Anything the guest sent after the reply already cancelled us; be defensive.
    if (thread.lastInboundAt > row._creationTime) {
      await ctx.db.patch(followUpId, { status: "cancelled" });
      return null;
    }
    await ctx.db.patch(followUpId, { status: "due" });
    if (thread.status === "waiting_guest" || thread.status === "sent") {
      await ctx.db.patch(thread._id, { status: "needs_staff" });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Approved follow-up emails.
// ---------------------------------------------------------------------------

/**
 * The thread is still waiting on the guest: `waiting_guest` (or legacy
 * `sent`), or `needs_staff` only because the reminder for it came due.
 */
export async function threadAwaitingGuest(ctx: Ctx, thread: Doc<"threads">): Promise<boolean> {
  if (thread.status === "waiting_guest" || thread.status === "sent") return true;
  if (thread.status !== "needs_staff") return false;
  const rows = await ctx.db
    .query("followUps")
    .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
    .collect();
  return rows.some((r) => !isEmail(r) && r.status === "due");
}

/**
 * Who may approve or dispatch a follow-up: live mail authority on a real inn,
 * or the anonymous visitor inside their own isolated demo inn (simulated only).
 */
export function followUpAuthority(
  user: Doc<"users">,
  inn: Doc<"inns">,
  membership: Doc<"memberships"> | null,
): { allowed: true; simulated: boolean } | { allowed: false; reason: string } {
  const live = canUseLiveMail(user, inn, membership);
  if (live.allowed) return { allowed: true, simulated: false };
  if (inn.isDemo && membership !== null && membership.innId === inn._id && inn.createdBy === user._id) {
    return { allowed: true, simulated: true };
  }
  return { allowed: false, reason: live.reason };
}

/** The normal reply that answered `inbound`, if one was actually delivered. */
async function deliveredReplyFor(ctx: Ctx, threadId: Id<"threads">, inboundId: Id<"messages">) {
  const replies = await ctx.db
    .query("sentReplies")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  let found: { sentReply: Doc<"sentReplies">; draft: Doc<"drafts"> } | null = null;
  for (const reply of replies) {
    if (reply.kind === "correction") continue;
    const draft = await ctx.db.get(reply.draftId);
    if (draft?.replyToMessageId !== inboundId) continue;
    if (!found || reply.sentAt > found.sentReply.sentAt) found = { sentReply: reply, draft };
  }
  return found;
}

type Eligibility =
  | { ok: true; thread: Doc<"threads">; inbound: Doc<"messages">; original: NonNullable<Awaited<ReturnType<typeof deliveredReplyFor>>> }
  | { ok: false; reason: string; code: string };

/**
 * What must hold for the thread, independently of who asks: an open inquiry
 * still waiting on the guest whose current message was actually answered.
 */
async function threadEligibility(ctx: Ctx, thread: Doc<"threads">): Promise<Eligibility> {
  if (thread.status === "closed") return { ok: false, code: "closed", reason: "the thread is closed" };
  if (thread.stay?.status !== "inquiry") return { ok: false, code: "not_inquiry", reason: "the thread is not an open stay inquiry" };
  if (!thread.lastInboundMessageId) return { ok: false, code: "no_reply_target", reason: "no guest message to follow up on" };
  const inbound = await ctx.db.get(thread.lastInboundMessageId);
  if (!inbound) return { ok: false, code: "no_reply_target", reason: "no guest message to follow up on" };
  if (!(await threadAwaitingGuest(ctx, thread))) {
    return { ok: false, code: "not_waiting", reason: "the thread is not waiting on the guest" };
  }
  const original = await deliveredReplyFor(ctx, thread._id, inbound._id);
  if (!original) return { ok: false, code: "not_answered", reason: "the guest's current message has not been answered yet" };
  return { ok: true, thread, inbound, original };
}

function emailRowsFor(rows: Doc<"followUps">[], inboundId: Id<"messages"> | undefined) {
  return rows.filter((r) => isEmail(r) && r.inboundMessageId === inboundId);
}

async function summarizeEmail(ctx: Ctx, row: Doc<"followUps">) {
  const outbox = row.outboxId ? await ctx.db.get(row.outboxId) : null;
  const approver = row.innId && row.approvedBy ? await membershipFor(ctx, row.innId, row.approvedBy) : null;
  return {
    _id: row._id,
    status: row.status,
    dueAt: row.dueAt,
    text: row.approvedText ?? null,
    approvedAt: row.approvedAt ?? null,
    approvedBy: row.approvedBy ?? null,
    approvedByName: approver?.name ?? null,
    inboundMessageId: row.inboundMessageId ?? null,
    simulated: row.simulated ?? false,
    outboxId: row.outboxId ?? null,
    delivery: outbox
      ? { status: outbox.status, errorKind: outbox.errorKind ?? null, errorMessage: outbox.errorMessage ?? null, sentAt: outbox.sentAt ?? null }
      : null,
    sentAt: row.sentAt ?? null,
    statusReason: row.statusReason ?? null,
    cancelledAt: row.cancelledAt ?? null,
  };
}

/**
 * Everything the thread view needs: the exact text that would be approved,
 * the time bounds, whether an approval could be made right now, the current
 * approval for the guest's present message and the thread's email history.
 */
export const emailForThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { thread, inn, user, membership } = await requireThreadAccess(ctx, threadId);
    const now = Date.now();
    const rows = await ctx.db
      .query("followUps")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    const eligibility = await threadEligibility(ctx, thread);
    const authority = followUpAuthority(user, inn, membership);
    const forTurn = emailRowsFor(rows, thread.lastInboundMessageId);
    const current = forTurn.filter(isLiveEmail).at(-1) ?? null;
    const history = [];
    for (const row of rows.filter(isEmail).reverse()) history.push(await summarizeEmail(ctx, row));
    let blocked: string | null = null;
    if (!eligibility.ok) blocked = eligibility.reason;
    else if (!authority.allowed) blocked = `you cannot approve mail here (${authority.reason})`;
    else if (current && current.status !== "scheduled") blocked = current.status === "sent" ? "a follow-up was already sent for this message" : "a follow-up is already being delivered for this message";
    return {
      text: FOLLOW_UP_EMAIL_TEXT,
      minDueAt: now + FOLLOW_UP_EMAIL_MIN_DELAY_MS,
      maxDueAt: now + FOLLOW_UP_EMAIL_MAX_DELAY_MS,
      defaultDueAt: now + FOLLOW_UP_EMAIL_DEFAULT_DELAY_MS,
      simulated: authority.allowed ? authority.simulated : inn.isDemo,
      /** An approval (or a reschedule of the current one) would be accepted, claim permitting. */
      canApprove: blocked === null,
      blockedReason: blocked,
      requiresClaim: !(isClaimActive(thread, now) && thread.claimedBy === user._id),
      current: current ? await summarizeEmail(ctx, current) : null,
      history,
    };
  },
});

function requireHeldClaim(thread: Doc<"threads">, userId: Id<"users">, now: number) {
  if (!isClaimActive(thread, now) || thread.claimedBy !== userId) {
    throw new ConvexError({ code: "claimed", heldBy: thread.claimedBy ?? null, message: "Claim the thread before approving a follow-up" });
  }
}

/**
 * Approves the fixed follow-up text for the guest's current message and
 * schedules it. The caller must hold the thread claim, have live mail
 * authority (or own the demo inn), and submit the exact template: the
 * approval is bound to that text, the approver, the inbound, the sent reply
 * it chases and the inn's inbox as bound now. Re-approving the same time is
 * idempotent; a different time replaces the pending schedule in this same
 * transaction. Once the due worker has reserved delivery nothing can change it.
 */
export const approveEmail = mutation({
  args: { threadId: v.id("threads"), text: v.string(), dueAt: v.number() },
  handler: async (ctx, { threadId, text, dueAt }) => {
    const { thread, inn, user, membership } = await requireThreadAccess(ctx, threadId);
    const now = Date.now();
    requireHeldClaim(thread, user._id, now);
    const authority = followUpAuthority(user, inn, membership);
    if (!authority.allowed) throw new ConvexError({ code: "live_mail_forbidden", reason: authority.reason });
    if (text !== FOLLOW_UP_EMAIL_TEXT) {
      throw new ConvexError({ code: "text_mismatch", message: "Only the exact proposed follow-up text can be approved" });
    }
    if (!Number.isFinite(dueAt) || dueAt < now + FOLLOW_UP_EMAIL_MIN_DELAY_MS || dueAt > now + FOLLOW_UP_EMAIL_MAX_DELAY_MS) {
      throw new ConvexError({
        code: "due_out_of_range",
        message: "The follow-up must be scheduled between 1 minute and 30 days from now",
        minDueAt: now + FOLLOW_UP_EMAIL_MIN_DELAY_MS,
        maxDueAt: now + FOLLOW_UP_EMAIL_MAX_DELAY_MS,
      });
    }
    const eligibility = await threadEligibility(ctx, thread);
    if (!eligibility.ok) throw new ConvexError({ code: eligibility.code, message: `Cannot schedule a follow-up: ${eligibility.reason}` });
    const { inbound, original } = eligibility;
    let providerInboxId: string | undefined;
    let providerMessageId: string | undefined;
    if (!authority.simulated) {
      if (!inn.inboxId) throw new ConvexError({ code: "inbox_not_configured", message: "This inn has no inbox yet" });
      if (!inbound.agentmailMessageId) throw new ConvexError({ code: "no_reply_target", message: "The guest message has no provider id" });
      providerInboxId = inbound.inboxId ?? inn.inboxId;
      providerMessageId = inbound.agentmailMessageId;
    }
    const rows = await ctx.db
      .query("followUps")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    const existing = emailRowsFor(rows, inbound._id).filter(isLiveEmail);
    let replaced = false;
    for (const row of existing) {
      if (row.status !== "scheduled") {
        throw new ConvexError({
          code: row.status === "sent" ? "already_sent" : "in_flight",
          message: row.status === "sent" ? "A follow-up was already sent for this message" : "This follow-up is already being delivered and cannot change",
        });
      }
      if (
        row.dueAt === dueAt &&
        row.approvedText === text &&
        row.approvedBy === user._id &&
        row.approvedByMembershipId === membership._id &&
        row.providerInboxId === providerInboxId
      ) {
        return { followUpId: row._id, dueAt: row.dueAt, replaced: false };
      }
      await cancelEmailRow(ctx, row, "rescheduled by staff", user._id, now);
      replaced = true;
    }
    const followUpId = await ctx.db.insert("followUps", {
      threadId,
      kind: "email",
      innId: inn._id,
      dueAt,
      status: "scheduled",
      inboundMessageId: inbound._id,
      approvedText: text,
      approvedBy: user._id,
      approvedByMembershipId: membership._id,
      approvedAt: now,
      originalSentReplyId: original.sentReply._id,
      originalDraftId: original.draft._id,
      originalOutboxId: original.sentReply.outboxId,
      providerInboxId,
      providerMessageId,
      simulated: authority.simulated,
    });
    const scheduledId = await ctx.scheduler.runAt(dueAt, internal.followUps.fireEmail, { followUpId });
    await ctx.db.patch(followUpId, { scheduledId });
    return { followUpId, dueAt, replaced };
  },
});

/**
 * Withdraws an email approval. A pending schedule is cancelled outright; a
 * reservation the worker has made but not yet handed to the provider is
 * failed with a visible reason (and the worker's preflight refuses it again
 * independently). Anything the provider may already have cannot be recalled.
 */
export const cancelEmail = mutation({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    const row = await ctx.db.get(followUpId);
    if (!row || !isEmail(row)) throw new ConvexError({ code: "forbidden", message: "No access to this follow-up" });
    const { thread, user } = await requireThreadAccess(ctx, row.threadId);
    const now = Date.now();
    requireHeldClaim(thread, user._id, now);
    if (row.status === "cancelled" || row.status === "failed") return { status: row.status };
    if (row.status === "sent") throw new ConvexError({ code: "already_sent", message: "This follow-up was already sent" });
    const cancelled = await cancelEmailRow(ctx, row, "cancelled by staff", user._id, now);
    if (!cancelled) throw new ConvexError({ code: "in_flight", message: "This follow-up is with the mail provider and cannot be recalled" });
    return { status: "cancelled" as const };
  },
});

/**
 * Cancels one email approval if nothing has reached the provider. Returns
 * false when the outbox row is already sending, sent or unknown.
 */
export async function cancelEmailRow(
  ctx: MutationCtx,
  row: Doc<"followUps">,
  reason: string,
  by: Id<"users"> | undefined,
  now: number,
): Promise<boolean> {
  if (row.status === "scheduled") {
    await cancelPendingJob(ctx, row.scheduledId);
    await ctx.db.patch(row._id, { status: "cancelled", statusReason: reason, cancelledAt: now, cancelledBy: by });
    return true;
  }
  if (row.status !== "reserved") return false;
  const outbox = row.outboxId ? await ctx.db.get(row.outboxId) : null;
  if (outbox && outbox.status !== "reserved") return false;
  if (outbox) await ctx.db.patch(outbox._id, { status: "failed", errorKind: "precondition", errorMessage: `follow-up cancelled before dispatch (${reason})` });
  await ctx.db.patch(row._id, { status: "cancelled", statusReason: reason, cancelledAt: now, cancelledBy: by });
  return true;
}

/** Cancels every email approval of the thread that has not reached the provider. */
export async function cancelEmailFollowUps(ctx: MutationCtx, threadId: Id<"threads">, reason: string, by?: Id<"users">) {
  const rows = await ctx.db
    .query("followUps")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  const now = Date.now();
  let cancelled = 0;
  for (const row of rows) {
    if (!isEmail(row)) continue;
    if (await cancelEmailRow(ctx, row, reason, by, now)) cancelled += 1;
  }
  return cancelled;
}

/**
 * One bounded batch of pending email approvals made under the membership row
 * `membershipId`, cancelled because that membership ended. Keyed on the row,
 * not the user: approvals made after a rejoin belong to a new row and are
 * never touched, and the batch is safe to continue after a rejoin. Reserved
 * rows are left alone; the due worker and the dispatch preflight refuse them
 * without any scan because the membership row they name no longer exists.
 */
export async function cancelRemovedApproverBatch(
  ctx: MutationCtx,
  membershipId: Id<"memberships">,
): Promise<{ cancelled: number; more: boolean }> {
  const pending = await ctx.db
    .query("followUps")
    .withIndex("by_approver_membership_status", (q) => q.eq("approvedByMembershipId", membershipId).eq("status", "scheduled"))
    .take(FOLLOW_UP_CANCEL_BATCH + 1);
  const batch = pending.slice(0, FOLLOW_UP_CANCEL_BATCH);
  const now = Date.now();
  for (const row of batch) {
    if (!isEmail(row)) continue;
    await cancelEmailRow(ctx, row, "the approving staff member was removed", undefined, now);
  }
  return { cancelled: batch.length, more: pending.length > FOLLOW_UP_CANCEL_BATCH };
}

/**
 * The due worker. Re-establishes every condition of the approval before
 * reserving delivery: the approval is intact and due, the approver still has
 * authority on this inn as it is bound now under the very membership row that
 * approved it, the guest has not written since,
 * the thread is still an open inquiry waiting on them, and no delivery for
 * this approval exists. Refusals cancel the approval with the reason. Real
 * inns hand the reservation to the outbox action (which rechecks again right
 * before the provider call); demo inns commit the simulated delivery here and
 * never touch a provider.
 */
export const fireEmail = internalMutation({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    const row = await ctx.db.get(followUpId);
    if (!row || !isEmail(row) || row.status !== "scheduled") return { fired: false as const, reason: "not scheduled" };
    const now = Date.now();
    if (row.dueAt > now) return { fired: false as const, reason: "not due yet" };
    const refuse = async (reason: string) => {
      await ctx.db.patch(row._id, { status: "cancelled", statusReason: reason, cancelledAt: now });
      return { fired: false as const, reason };
    };
    if (row.approvedText !== FOLLOW_UP_EMAIL_TEXT || !row.approvedBy || !row.approvedByMembershipId || !row.innId || !row.inboundMessageId) {
      return await refuse("the approval is incomplete");
    }
    const thread = await ctx.db.get(row.threadId);
    if (!thread) return await refuse("the thread no longer exists");
    if (thread.innId !== row.innId) return await refuse("the thread no longer belongs to this inn");
    const inn = await ctx.db.get(row.innId);
    if (!inn) return await refuse("the inn no longer exists");
    const user = await ctx.db.get(row.approvedBy);
    if (!user) return await refuse("the approving user no longer exists");
    const membership = await membershipFor(ctx, inn._id, user._id);
    const authority = followUpAuthority(user, inn, membership);
    if (!authority.allowed) return await refuse(`the approver lost mail authority (${authority.reason})`);
    // The approval was made under one membership row. If that row is gone the
    // approval died with it, even if the same person has since been re-invited.
    if (membership?._id !== row.approvedByMembershipId) return await refuse("the membership that approved this follow-up has ended");
    if (authority.simulated !== (row.simulated === true)) return await refuse("the inn changed between demo and live");
    if (!authority.simulated) {
      if (!inn.inboxId || inn.inboxId !== row.providerInboxId) return await refuse("the inn's inbox changed since approval");
      if (!row.providerMessageId) return await refuse("the guest message has no provider id");
    }
    if (thread.lastInboundMessageId !== row.inboundMessageId) return await refuse("the guest wrote again");
    if (thread.status === "closed") return await refuse("the thread was closed");
    if (thread.stay?.status !== "inquiry") return await refuse("the stay is no longer an open inquiry");
    if (!(await threadAwaitingGuest(ctx, thread))) return await refuse(`the thread is no longer waiting on the guest (${thread.status})`);
    const attempts = await ctx.db
      .query("outbox")
      .withIndex("by_followUp", (q) => q.eq("followUpId", row._id))
      .collect();
    if (attempts.some((o) => o.status !== "failed")) return await refuse("a delivery for this follow-up already exists");

    const outboxId = await reserveOutbox(ctx, {
      innId: inn._id,
      threadId: thread._id,
      kind: "follow_up",
      followUpId: row._id,
      replyToMessageId: row.inboundMessageId,
      providerInboxId: row.providerInboxId,
      providerMessageId: row.providerMessageId,
      text: row.approvedText,
      textSource: authority.simulated ? "fixture" : "staff",
      reservedBy: user._id,
      simulated: authority.simulated,
    });
    await ctx.db.patch(row._id, { status: "reserved", outboxId });
    if (authority.simulated) {
      const outbox = (await ctx.db.get(outboxId))!;
      await commitFollowUpDelivery(ctx, outbox, {});
      return { fired: true as const, outboxId, simulated: true as const };
    }
    await ctx.scheduler.runAfter(0, internal.outbox.deliver, { outboxId });
    return { fired: true as const, outboxId, simulated: false as const };
  },
});
