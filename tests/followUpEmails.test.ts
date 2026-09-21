import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  FOLLOW_UP_CANCEL_BATCH,
  FOLLOW_UP_DELAY_MS,
  FOLLOW_UP_EMAIL_MAX_DELAY_MS,
  FOLLOW_UP_EMAIL_MIN_DELAY_MS,
  FOLLOW_UP_EMAIL_TEXT,
} from "../convex/followUps";
import { makeTest, signedInUser } from "./setup";
import { agentmailReplyRoute, json, seedInboundThread, seedLiveInn, stubFetch, withEnv } from "./integrationSetup";

type T = ReturnType<typeof makeTest>;

const ANSWER = "Yes! Dogs are welcome for a $25 per night pet fee.";
const HOUR = 60 * 60 * 1000;
const BASE = Date.parse("2026-09-21T09:00:00Z");
const INQUIRY = { checkIn: "2026-10-09", checkOut: "2026-10-11", party: 2, status: "inquiry" as const };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Runs every scheduled function whose time has come under fake timers (never a real 48 h wait). */
const drain = (t: T) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(10));
/** Moves the fake clock forward and runs what became due. */
async function advance(t: T, ms: number) {
  vi.advanceTimersByTime(ms);
  await drain(t);
}

const outboxRows = (t: T) => t.run((ctx) => ctx.db.query("outbox").collect());
const followUpRows = (t: T) => t.run((ctx) => ctx.db.query("followUps").collect());
const emailRows = async (t: T) => (await followUpRows(t)).filter((r) => r.kind === "email");
const sentReplies = (t: T) => t.run((ctx) => ctx.db.query("sentReplies").collect());
const outMessages = async (t: T) => (await t.run((ctx) => ctx.db.query("messages").collect())).filter((m) => m.direction === "out");
const scheduledNames = async (t: T) =>
  (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).map((s) => ({ name: s.name, state: s.state.kind }));

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return String(e);
  }
}

async function seedReadyDraft(t: T, threadId: Id<"threads">, messageId: Id<"messages">, pageId: Id<"pages">, versionId: Id<"pageVersions">) {
  return await t.run(async (ctx) => {
    const draftId = await ctx.db.insert("drafts", {
      threadId,
      replyToMessageId: messageId,
      class: "answerable",
      answer: ANSWER,
      abstain: false,
      status: "ready",
      model: "test",
      verifiedText: ANSWER,
      textSource: "model",
      judgeVerdict: { entailed: true, promisedOutsideQuotes: false, notes: "ok" },
    });
    const thread = (await ctx.db.get(threadId))!;
    await ctx.db.insert("claims", {
      draftId,
      threadId,
      innId: thread.innId,
      statement: "Dogs $25/night",
      pageId,
      pageVersionId: versionId,
      url: "https://seagull.example/policies",
      quote: "$25 per night pet fee",
      verified: true,
      verifyMethod: "strict",
      status: "ok",
    });
    await ctx.db.patch(threadId, { status: "ready", stay: INQUIRY });
    return draftId;
  });
}

/**
 * A live inn whose owner has actually delivered the reply to an inquiry
 * through the provider: the thread waits on the guest with the 48 h reminder
 * scheduled, exactly the state in which a follow-up may be approved.
 */
async function answeredInquiry(t: T) {
  withEnv({ AGENTMAIL_API_KEY: "am-test" });
  const owner = await signedInUser(t, { name: "Owner" });
  const inn = await seedLiveInn(t, owner.userId);
  const { threadId, messageId } = await seedInboundThread(t, inn.innId, { providerMessageId: "msg_in_1" });
  const draftId = await seedReadyDraft(t, threadId, messageId, inn.pageId, inn.versionId);
  const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1", thread_id: "thr_1" }))]);
  await owner.as.mutation(api.threads.claim, { threadId });
  const { outboxId: replyOutboxId } = await owner.as.mutation(api.drafts.send, { draftId });
  await drain(t);
  expect(calls).toHaveLength(1);
  expect((await t.run((ctx) => ctx.db.get(threadId)))?.status).toBe("waiting_guest");
  vi.unstubAllGlobals();
  return { owner, ...inn, threadId, messageId, draftId, replyOutboxId };
}

const approveArgs = (threadId: Id<"threads">, dueAt = Date.now() + 72 * HOUR) => ({ threadId, text: FOLLOW_UP_EMAIL_TEXT, dueAt });

function receiveArgs(providerMessageId: string, text: string) {
  return {
    inboxId: "seagull@agentmail.to",
    eventId: `evt_${providerMessageId}`,
    providerMessageId,
    providerThreadId: "thr_1",
    from: "guest@example.com",
    to: "seagull@agentmail.to",
    subject: "Re: Dog?",
    text,
    receivedAt: Date.now(),
  };
}

const membershipOf = (t: T, innId: Id<"inns">, userId: Id<"users">) =>
  t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_inn_user", (q) => q.eq("innId", innId).eq("userId", userId))
      .unique(),
  );

describe("the reminder alone never sends mail", () => {
  it("a sent inquiry reply schedules a reminder only; when it fires the thread needs staff and nothing goes out", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const rows = await followUpRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "reminder", status: "scheduled" });
    expect(rows[0].dueAt - (BASE + FOLLOW_UP_DELAY_MS)).toBeLessThan(1000);
    expect(rows[0].approvedText).toBeUndefined();
    const names = await scheduledNames(t);
    expect(names.filter((s) => s.name === "followUps:fire" && s.state === "pending")).toHaveLength(1);
    expect(names.filter((s) => s.name === "followUps:fireEmail")).toEqual([]);
    const view = await s.owner.as.query(api.followUps.emailForThread, { threadId: s.threadId });
    expect(view).toMatchObject({ text: FOLLOW_UP_EMAIL_TEXT, canApprove: true, blockedReason: null, simulated: false, current: null, history: [], requiresClaim: false });
    const now = Date.now();
    expect(view.defaultDueAt).toBe(now + FOLLOW_UP_DELAY_MS);
    expect(view.minDueAt).toBe(now + FOLLOW_UP_EMAIL_MIN_DELAY_MS);
    expect(view.maxDueAt).toBe(now + FOLLOW_UP_EMAIL_MAX_DELAY_MS);

    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    await advance(t, FOLLOW_UP_DELAY_MS + 1000);
    expect((await followUpRows(t))[0].status).toBe("due");
    expect((await t.run((ctx) => ctx.db.get(s.threadId)))?.status).toBe("needs_staff");
    expect(calls).toEqual([]);
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply"]);
    expect(await outMessages(t)).toHaveLength(1);
    expect((await s.owner.as.query(api.threads.get, { threadId: s.threadId })).followUp).toMatchObject({ status: "due" });
  });

  it("legacy reminder rows and rows without an approval are never treated as email by either worker", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const legacyId = await t.run((ctx) => ctx.db.insert("followUps", { threadId: s.threadId, dueAt: BASE - 1000, status: "scheduled" }));
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    expect(await t.mutation(internal.followUps.fireEmail, { followUpId: legacyId })).toEqual({ fired: false, reason: "not scheduled" });
    await drain(t);
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply"]);
    expect(calls).toEqual([]);
    // The reminder worker treats the legacy row exactly as before.
    await t.mutation(internal.followUps.fire, { followUpId: legacyId });
    expect((await t.run((ctx) => ctx.db.get(legacyId)))?.status).toBe("due");
    // ...and ignores email rows entirely.
    const { followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId));
    await t.mutation(internal.followUps.fire, { followUpId });
    expect((await t.run((ctx) => ctx.db.get(followUpId)))?.status).toBe("scheduled");
  });
});

describe("approving a follow-up email", () => {
  it("binds the approval to the exact text, approver, inbound, sent reply and inbox, and schedules the due worker", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const dueAt = BASE + 72 * HOUR;
    const result = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, dueAt));
    expect(result).toMatchObject({ dueAt, replaced: false });
    const [row] = await emailRows(t);
    expect(row).toMatchObject({
      _id: result.followUpId,
      kind: "email",
      status: "scheduled",
      dueAt,
      innId: s.innId,
      inboundMessageId: s.messageId,
      approvedText: FOLLOW_UP_EMAIL_TEXT,
      approvedBy: s.owner.userId,
      originalDraftId: s.draftId,
      originalOutboxId: s.replyOutboxId,
      providerInboxId: "seagull@agentmail.to",
      providerMessageId: "msg_in_1",
      simulated: false,
    });
    expect(row.originalSentReplyId).toBe((await sentReplies(t))[0]._id);
    expect(row.approvedAt).toBeGreaterThanOrEqual(BASE);
    const job = await t.run((ctx) => ctx.db.system.get(row.scheduledId!));
    expect(job).toMatchObject({ name: "followUps:fireEmail", scheduledTime: dueAt, state: { kind: "pending" } });
    // The reminder is untouched and the thread view still shows it as the reminder.
    expect((await followUpRows(t)).filter((r) => r.kind === "reminder").map((r) => r.status)).toEqual(["scheduled"]);
    const detail = await s.owner.as.query(api.threads.get, { threadId: s.threadId });
    expect(detail.followUp?.status).toBe("scheduled");
    expect(detail.followUp!.dueAt - (BASE + FOLLOW_UP_DELAY_MS)).toBeLessThan(1000);
    const view = await s.owner.as.query(api.followUps.emailForThread, { threadId: s.threadId });
    expect(view.current).toMatchObject({ _id: result.followUpId, status: "scheduled", dueAt, text: FOLLOW_UP_EMAIL_TEXT, approvedByName: "Owner", delivery: null });
    expect(view.history).toHaveLength(1);
    expect(view.canApprove).toBe(true);
    // Nothing was sent by approving.
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply"]);
  });

  it("refuses anything but the exact proposed text and times outside 1 minute to 30 days", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const now = Date.now();
    for (const text of [FOLLOW_UP_EMAIL_TEXT + " ", FOLLOW_UP_EMAIL_TEXT.toLowerCase(), "We have a special offer for you!", ""]) {
      expect(await failure(s.owner.as.mutation(api.followUps.approveEmail, { threadId: s.threadId, text, dueAt: now + HOUR }))).toMatch(/text_mismatch/);
    }
    for (const dueAt of [now - 1, now, now + FOLLOW_UP_EMAIL_MIN_DELAY_MS - 1, now + FOLLOW_UP_EMAIL_MAX_DELAY_MS + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await failure(s.owner.as.mutation(api.followUps.approveEmail, { threadId: s.threadId, text: FOLLOW_UP_EMAIL_TEXT, dueAt }))).toMatch(/due_out_of_range/);
    }
    expect(await emailRows(t)).toEqual([]);
    // The bounds themselves are accepted.
    await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, now + FOLLOW_UP_EMAIL_MIN_DELAY_MS));
    await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, now + FOLLOW_UP_EMAIL_MAX_DELAY_MS));
    expect((await emailRows(t)).map((r) => r.status).sort()).toEqual(["cancelled", "scheduled"]);
  });

  it("requires the caller to hold the claim, an open inquiry still waiting on the guest, and an actually delivered reply", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    // Claim expired.
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(await failure(s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/claimed/);
    // Claim held by someone else.
    const staff = await signedInUser(t, { name: "Staff" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId: s.innId, userId: staff.userId, role: "staff", name: "Staff" }));
    await staff.as.mutation(api.threads.claim, { threadId: s.threadId });
    expect(await failure(s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/claimed/);
    expect((await s.owner.as.query(api.followUps.emailForThread, { threadId: s.threadId })).requiresClaim).toBe(true);
    // Booked stay.
    await t.run((ctx) => ctx.db.patch(s.threadId, { stay: { ...INQUIRY, status: "booked" } }));
    expect(await failure(staff.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/not_inquiry/);
    expect((await staff.as.query(api.followUps.emailForThread, { threadId: s.threadId })).canApprove).toBe(false);
    // Closed thread.
    await t.run((ctx) => ctx.db.patch(s.threadId, { stay: INQUIRY, status: "closed" }));
    expect(await failure(staff.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/closed/);
    // Needs staff for a reason other than a due reminder.
    await t.run((ctx) => ctx.db.patch(s.threadId, { status: "needs_staff" }));
    expect(await failure(staff.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/not_waiting/);
    await t.run((ctx) => ctx.db.patch(s.threadId, { status: "waiting_guest" }));
    expect(await emailRows(t)).toEqual([]);

    // A thread whose current message was never actually answered (draft ready, nothing delivered).
    const { threadId: fresh, messageId: freshMsg } = await seedInboundThread(t, s.innId, { providerMessageId: "msg_in_9" });
    await seedReadyDraft(t, fresh, freshMsg, s.pageId, s.versionId);
    await t.run((ctx) => ctx.db.patch(fresh, { status: "waiting_guest" }));
    await staff.as.mutation(api.threads.claim, { threadId: fresh });
    expect(await failure(staff.as.mutation(api.followUps.approveEmail, approveArgs(fresh)))).toMatch(/not_answered/);
    // A reservation that never delivered (unknown outcome) is not a delivered reply either.
    const draftId = (await t.run((ctx) => ctx.db.query("drafts").withIndex("by_thread", (q) => q.eq("threadId", fresh)).collect()))[0]._id;
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        innId: s.innId,
        threadId: fresh,
        kind: "reply",
        draftId,
        replyToMessageId: freshMsg,
        text: ANSWER,
        textSource: "model",
        reservedBy: staff.userId,
        reservedAt: Date.now(),
        status: "unknown",
        simulated: false,
      }),
    );
    expect(await failure(staff.as.mutation(api.followUps.approveEmail, approveArgs(fresh)))).toMatch(/not_answered/);
    expect(await emailRows(t)).toEqual([]);
  });

  it("is refused for strangers, other tenants, anonymous members, unauthenticated callers and unbound inboxes", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    expect(await failure(t.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/unauthenticated/);
    expect(await failure(t.query(api.followUps.emailForThread, { threadId: s.threadId }))).toMatch(/unauthenticated/);
    const stranger = await signedInUser(t, { name: "Stranger" });
    expect(await failure(stranger.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/forbidden/);
    expect(await failure(stranger.as.query(api.followUps.emailForThread, { threadId: s.threadId }))).toMatch(/forbidden/);
    const otherOwner = await signedInUser(t, { name: "Other" });
    await seedLiveInn(t, otherOwner.userId, { inboxId: "other@agentmail.to" });
    expect(await failure(otherOwner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/forbidden/);
    const anon = await signedInUser(t, { name: "Anon", isAnonymous: true });
    await t.run((ctx) => ctx.db.insert("memberships", { innId: s.innId, userId: anon.userId, role: "staff", name: "Anon" }));
    await t.run((ctx) => ctx.db.patch(s.threadId, { claimedBy: anon.userId, claimedAt: Date.now() }));
    expect(await failure(anon.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/live_mail_forbidden/);
    expect((await anon.as.query(api.followUps.emailForThread, { threadId: s.threadId })).blockedReason).toMatch(/anonymous_user/);
    expect(await emailRows(t)).toEqual([]);

    await t.run((ctx) => ctx.db.patch(s.threadId, { claimedBy: undefined, claimedAt: undefined }));
    await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
    await t.run((ctx) => ctx.db.patch(s.innId, { inboxId: undefined, inboxAddress: undefined }));
    expect(await failure(s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/inbox_not_configured/);
    await t.run((ctx) => ctx.db.patch(s.innId, { inboxId: "seagull@agentmail.to", inboxAddress: "seagull@agentmail.to" }));
    await t.run((ctx) => ctx.db.patch(s.messageId, { agentmailMessageId: undefined }));
    expect(await failure(s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/no_reply_target/);
    expect(await emailRows(t)).toEqual([]);
  });

  it("re-approving the same time is idempotent; a new time replaces the schedule in one transaction and the stale job is a no-op", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const first = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 72 * HOUR));
    const again = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 72 * HOUR));
    expect(again).toEqual({ followUpId: first.followUpId, dueAt: BASE + 72 * HOUR, replaced: false });
    expect(await emailRows(t)).toHaveLength(1);

    const moved = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 96 * HOUR));
    expect(moved.replaced).toBe(true);
    expect(moved.followUpId).not.toBe(first.followUpId);
    const rows = await emailRows(t);
    const old = rows.find((r) => r._id === first.followUpId)!;
    expect(old).toMatchObject({ status: "cancelled", statusReason: "rescheduled by staff", cancelledBy: s.owner.userId });
    expect((await t.run((ctx) => ctx.db.system.get(old.scheduledId!)))?.state.kind).toBe("canceled");
    const fresh = rows.find((r) => r._id === moved.followUpId)!;
    expect(fresh).toMatchObject({ status: "scheduled", dueAt: BASE + 96 * HOUR });
    expect((await t.run((ctx) => ctx.db.system.get(fresh.scheduledId!)))?.state.kind).toBe("pending");
    const view = await s.owner.as.query(api.followUps.emailForThread, { threadId: s.threadId });
    expect(view.current?._id).toBe(moved.followUpId);
    expect(view.history.map((h) => h.status)).toEqual(["scheduled", "cancelled"]);

    // A stale job for the replaced row does nothing even once its time has passed.
    vi.setSystemTime(BASE + 100 * HOUR);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    expect(await t.mutation(internal.followUps.fireEmail, { followUpId: first.followUpId })).toEqual({ fired: false, reason: "not scheduled" });
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply"]);
    expect(calls).toEqual([]);
    // Not due yet is also a no-op that keeps the schedule.
    vi.setSystemTime(BASE + 80 * HOUR);
    expect(await t.mutation(internal.followUps.fireEmail, { followUpId: moved.followUpId })).toEqual({ fired: false, reason: "not due yet" });
    expect((await t.run((ctx) => ctx.db.get(moved.followUpId)))?.status).toBe("scheduled");
  });
});

describe("delivery of an approved follow-up", () => {
  it("the scheduler fires the due worker, which makes exactly one provider call with the approved text and records only the follow-up", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const dueAt = BASE + 72 * HOUR;
    const { followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, dueAt));
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_fu_1", thread_id: "thr_1" }))]);
    // Nothing happens before the due time (the reminder fires at 48 h, as before).
    await advance(t, FOLLOW_UP_DELAY_MS + 1000);
    expect(calls).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(s.threadId)))?.status).toBe("needs_staff");
    expect((await followUpRows(t)).find((r) => r.kind === "reminder")?.status).toBe("due");

    await advance(t, 24 * HOUR);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.agentmail.to/v0/inboxes/seagull%40agentmail.to/messages/msg_in_1/reply");
    expect(calls[0].body).toEqual({ text: FOLLOW_UP_EMAIL_TEXT });
    const rows = await outboxRows(t);
    expect(rows.map((r) => r.kind)).toEqual(["reply", "follow_up"]);
    const fu = rows[1];
    expect(fu).toMatchObject({
      kind: "follow_up",
      followUpId,
      status: "sent",
      sentProviderMessageId: "msg_fu_1",
      text: FOLLOW_UP_EMAIL_TEXT,
      textSource: "staff",
      reservedBy: s.owner.userId,
      replyToMessageId: s.messageId,
      providerInboxId: "seagull@agentmail.to",
      providerMessageId: "msg_in_1",
      simulated: false,
    });
    expect(fu.draftId).toBeUndefined();
    const approval = (await t.run((ctx) => ctx.db.get(followUpId)))!;
    expect(approval).toMatchObject({ status: "sent", outboxId: fu._id, approvedText: FOLLOW_UP_EMAIL_TEXT });
    const out = await outMessages(t);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ _id: approval.sentMessageId, text: FOLLOW_UP_EMAIL_TEXT, agentmailMessageId: "msg_fu_1", innId: s.innId, inboxId: "seagull@agentmail.to" });
    // No duplicate provenance, no touched draft, no new timers, thread state left alone.
    expect(await sentReplies(t)).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(s.draftId)))?.status).toBe("sent");
    expect((await followUpRows(t)).map((r) => r.kind).sort()).toEqual(["email", "reminder"]);
    expect((await scheduledNames(t)).filter((j) => j.state === "pending")).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(s.threadId)))?.status).toBe("needs_staff");
    const view = await s.owner.as.query(api.followUps.emailForThread, { threadId: s.threadId });
    expect(view.current).toMatchObject({ status: "sent", delivery: { status: "sent" } });
    expect(view).toMatchObject({ canApprove: false, blockedReason: "a follow-up was already sent for this message" });
    // One email per answered inquiry: no second approval, no recursion.
    await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
    expect(await failure(s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, Date.now() + HOUR)))).toMatch(/already_sent/);
    // Duplicate worker runs never reserve or send again.
    expect(await t.mutation(internal.followUps.fireEmail, { followUpId })).toEqual({ fired: false, reason: "not scheduled" });
    await t.action(internal.outbox.deliver, { outboxId: fu._id });
    expect(calls).toHaveLength(1);
    expect(await outboxRows(t)).toHaveLength(2);
    const detail = await s.owner.as.query(api.threads.get, { threadId: s.threadId });
    expect(detail.outbox[1]).toMatchObject({ kind: "follow_up", followUpId, status: "sent" });
  });

  it("concurrent due-worker calls and duplicate deliveries produce one reservation and one provider call", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const { followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 72 * HOUR));
    vi.setSystemTime(BASE + 72 * HOUR + 1);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_fu_1" }))]);
    const results = await Promise.all([
      t.mutation(internal.followUps.fireEmail, { followUpId }),
      t.mutation(internal.followUps.fireEmail, { followUpId }),
      t.mutation(internal.followUps.fireEmail, { followUpId }),
    ]);
    expect(results.filter((r) => r.fired)).toHaveLength(1);
    const fus = (await outboxRows(t)).filter((r) => r.kind === "follow_up");
    expect(fus).toHaveLength(1);
    await Promise.all([t.action(internal.outbox.deliver, { outboxId: fus[0]._id }), t.action(internal.outbox.deliver, { outboxId: fus[0]._id })]);
    await drain(t);
    expect(calls).toHaveLength(1);
    expect((await outboxRows(t)).filter((r) => r.kind === "follow_up")).toHaveLength(1);
    expect(await outMessages(t)).toHaveLength(2);
  });

  it("a demo inn simulates the same reservation and commit with zero provider traffic", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    const waiting = await visitor.as.query(api.threads.queue, { innId, status: "waiting_guest" });
    const thread = waiting.find((th) => th.stay?.status === "inquiry")!;
    expect(thread).toBeDefined();
    const { calls } = stubFetch([]);
    // Demo authority is the visitor's own demo inn; a real owner elsewhere has no access here.
    const owner = await signedInUser(t, { name: "Owner" });
    await seedLiveInn(t, owner.userId);
    expect(await failure(owner.as.mutation(api.followUps.approveEmail, approveArgs(thread._id)))).toMatch(/forbidden/);
    expect(await failure(visitor.as.mutation(api.followUps.approveEmail, approveArgs(thread._id)))).toMatch(/claimed/);
    await visitor.as.mutation(api.threads.claim, { threadId: thread._id });
    const view = await visitor.as.query(api.followUps.emailForThread, { threadId: thread._id });
    expect(view).toMatchObject({ simulated: true, canApprove: true });
    const { followUpId } = await visitor.as.mutation(api.followUps.approveEmail, approveArgs(thread._id, BASE + 2 * HOUR));
    const approved = (await t.run((ctx) => ctx.db.get(followUpId)))!;
    expect(approved.simulated).toBe(true);
    expect(approved.providerInboxId).toBeUndefined();
    expect(approved.providerMessageId).toBeUndefined();
    await advance(t, 2 * HOUR + 1000);
    expect(calls).toEqual([]);
    const approval = (await t.run((ctx) => ctx.db.get(followUpId)))!;
    expect(approval.status).toBe("sent");
    const fu = (await t.run((ctx) => ctx.db.get(approval.outboxId!)))!;
    expect(fu).toMatchObject({ kind: "follow_up", status: "sent", simulated: true, textSource: "fixture", text: FOLLOW_UP_EMAIL_TEXT });
    const sent = (await t.run((ctx) => ctx.db.get(approval.sentMessageId!)))!;
    expect(sent).toMatchObject({ direction: "out", text: FOLLOW_UP_EMAIL_TEXT, threadId: thread._id, innId });
    expect(await scheduledNames(t)).not.toContainEqual({ name: "outbox:deliver", state: "pending" });
    const detail = await visitor.as.query(api.threads.get, { threadId: thread._id });
    expect(detail.outbox.map((o) => o.kind)).toEqual(["follow_up"]);
    expect(detail.sentReplies).toHaveLength(1);
  });

  it("a demo visitor cannot approve on a live inn even if handed a membership row", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    await t.run((ctx) => ctx.db.insert("memberships", { innId: s.innId, userId: visitor.userId, role: "demo", name: "V" }));
    await t.run((ctx) => ctx.db.patch(s.threadId, { claimedBy: visitor.userId, claimedAt: Date.now() }));
    expect(await failure(visitor.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)))).toMatch(/live_mail_forbidden/);
    expect(await emailRows(t)).toEqual([]);
  });
});

describe("cancellation before dispatch", () => {
  it("staff cancel withdraws the schedule; the job never fires and nothing is sent", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const { followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 72 * HOUR));
    const staff = await signedInUser(t, { name: "Staff" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId: s.innId, userId: staff.userId, role: "staff", name: "Staff" }));
    expect(await failure(staff.as.mutation(api.followUps.cancelEmail, { followUpId }))).toMatch(/claimed/);
    const stranger = await signedInUser(t, { name: "Stranger" });
    expect(await failure(stranger.as.mutation(api.followUps.cancelEmail, { followUpId }))).toMatch(/forbidden/);
    expect(await s.owner.as.mutation(api.followUps.cancelEmail, { followUpId })).toEqual({ status: "cancelled" });
    const row = (await t.run((ctx) => ctx.db.get(followUpId)))!;
    expect(row).toMatchObject({ status: "cancelled", statusReason: "cancelled by staff", cancelledBy: s.owner.userId });
    expect(row.cancelledAt).toBeGreaterThanOrEqual(BASE);
    expect((await t.run((ctx) => ctx.db.system.get(row.scheduledId!)))?.state.kind).toBe("canceled");
    expect(await s.owner.as.mutation(api.followUps.cancelEmail, { followUpId })).toEqual({ status: "cancelled" });
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    await advance(t, 80 * HOUR);
    expect(calls).toEqual([]);
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply"]);
    expect((await s.owner.as.query(api.followUps.emailForThread, { threadId: s.threadId })).current).toBeNull();
    // The reminder ran as usual and staff may approve a new schedule.
    expect((await followUpRows(t)).find((r) => r.kind === "reminder")?.status).toBe("due");
    await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
    const next = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, Date.now() + HOUR));
    expect(next.followUpId).not.toBe(followUpId);
  });

  it("the guest replying, the thread closing, the approver being removed or the inbox rebinding each cancel with a visible reason", async () => {
    // Guest reply.
    let t = makeTest();
    let s = await answeredInquiry(t);
    let { followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId));
    vi.advanceTimersByTime(60_000);
    await t.mutation(internal.inbound.receive, receiveArgs("msg_in_2", "Great, booking now."));
    let row = (await t.run((ctx) => ctx.db.get(followUpId)))!;
    expect(row).toMatchObject({ status: "cancelled", statusReason: "a newer guest message arrived" });
    expect((await t.run((ctx) => ctx.db.system.get(row.scheduledId!)))?.state.kind).toBe("canceled");
    expect((await followUpRows(t)).map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    let { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    await advance(t, 80 * HOUR);
    expect(calls).toEqual([]);
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply"]);

    // Closure by staff (only the email is withdrawn; the reminder keeps its own semantics).
    t = makeTest();
    vi.setSystemTime(BASE);
    s = await answeredInquiry(t);
    ({ followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)));
    await s.owner.as.mutation(api.threads.setStatus, { threadId: s.threadId, status: "closed" });
    row = (await t.run((ctx) => ctx.db.get(followUpId)))!;
    expect(row).toMatchObject({ status: "cancelled", statusReason: "the thread was closed", cancelledBy: s.owner.userId });
    ({ calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]));
    await advance(t, 80 * HOUR);
    expect(calls).toEqual([]);
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply"]);

    // Approver removed by the owner: cancelled through the approver index, bounded.
    t = makeTest();
    vi.setSystemTime(BASE);
    s = await answeredInquiry(t);
    const staff = await signedInUser(t, { name: "Staff" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId: s.innId, userId: staff.userId, role: "staff", name: "Staff" }));
    await t.run((ctx) => ctx.db.patch(s.threadId, { claimedBy: undefined, claimedAt: undefined }));
    await staff.as.mutation(api.threads.claim, { threadId: s.threadId });
    ({ followUpId } = await staff.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)));
    // Another member's approval on a second thread must survive the removal.
    const other = await seedInboundThread(t, s.innId, { providerMessageId: "msg_in_5" });
    const otherDraft = await seedReadyDraft(t, other.threadId, other.messageId, s.pageId, s.versionId);
    const tmp = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_5" }))]);
    await s.owner.as.mutation(api.threads.claim, { threadId: other.threadId });
    await s.owner.as.mutation(api.drafts.send, { draftId: otherDraft });
    await drain(t);
    expect(tmp.calls).toHaveLength(1);
    const ownerApproval = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(other.threadId));
    expect(await s.owner.as.mutation(api.teams.removeStaff, { innId: s.innId, userId: staff.userId })).toEqual({ released: 1 });
    row = (await t.run((ctx) => ctx.db.get(followUpId)))!;
    expect(row).toMatchObject({ status: "cancelled", statusReason: "the approving staff member was removed" });
    expect((await t.run((ctx) => ctx.db.system.get(row.scheduledId!)))?.state.kind).toBe("canceled");
    expect((await t.run((ctx) => ctx.db.get(ownerApproval.followUpId)))?.status).toBe("scheduled");
    ({ calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_fu_owner" }))]));
    await advance(t, 80 * HOUR);
    // Only the owner's approval went out.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/messages/msg_in_5/reply");
    expect((await t.run((ctx) => ctx.db.get(ownerApproval.followUpId)))?.status).toBe("sent");

    // Inbox rebound before the due time: the worker refuses and says why.
    t = makeTest();
    vi.setSystemTime(BASE);
    s = await answeredInquiry(t);
    ({ followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId)));
    await t.run((ctx) => ctx.db.patch(s.innId, { inboxId: "other@agentmail.to", inboxAddress: "other@agentmail.to" }));
    ({ calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]));
    await advance(t, 80 * HOUR);
    expect(calls).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(followUpId))).toMatchObject({ status: "cancelled", statusReason: "the inn's inbox changed since approval" });
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply"]);
  });

  /** A staff member on the inn plus the id of the membership row they hold right now. */
  async function staffMember(t: T, innId: Id<"inns">) {
    const staff = await signedInUser(t, { name: "Staff" });
    const membershipId = await t.run((ctx) => ctx.db.insert("memberships", { innId, userId: staff.userId, role: "staff", name: "Staff" }));
    return { ...staff, membershipId };
  }

  /** Re-invites a removed member the real way: a fresh invitation accepted, which creates a new membership row. */
  async function rejoin(t: T, s: Awaited<ReturnType<typeof answeredInquiry>>, staff: Awaited<ReturnType<typeof signedInUser>>) {
    const invite = await s.owner.as.action(api.teams.createInvite, { innId: s.innId });
    expect(await staff.as.mutation(api.teams.acceptInvite, { token: invite.token })).toEqual({ innId: s.innId, joined: true });
    return (await membershipOf(t, s.innId, staff.userId))!._id;
  }

  /** Direct scheduled approvals under one membership row, as the approve mutation would write them. */
  async function seedScheduledApprovals(t: T, s: Awaited<ReturnType<typeof answeredInquiry>>, userId: Id<"users">, membershipId: Id<"memberships">, count: number) {
    const ids: Id<"followUps">[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        ids.push(
          await ctx.db.insert("followUps", {
            threadId: s.threadId,
            kind: "email",
            innId: s.innId,
            dueAt: BASE + 72 * HOUR,
            status: "scheduled",
            inboundMessageId: s.messageId,
            approvedText: FOLLOW_UP_EMAIL_TEXT,
            approvedBy: userId,
            approvedByMembershipId: membershipId,
            approvedAt: BASE,
            providerInboxId: "seagull@agentmail.to",
            providerMessageId: "msg_in_1",
            simulated: false,
          }),
        );
      }
    });
    return ids;
  }

  it("removing a member with many pending approvals stays bounded per transaction and drains in the background", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const staff = await staffMember(t, s.innId);
    const total = FOLLOW_UP_CANCEL_BATCH * 2 + 5;
    await seedScheduledApprovals(t, s, staff.userId, staff.membershipId, total);
    const result = await s.owner.as.mutation(api.teams.removeStaff, { innId: s.innId, userId: staff.userId });
    expect(result).toEqual({ released: 0, cleanupScheduled: true });
    const pending = async () => (await emailRows(t)).filter((r) => r.status === "scheduled").length;
    expect(await pending()).toBe(total - FOLLOW_UP_CANCEL_BATCH);
    await drain(t);
    expect(await pending()).toBe(0);
    expect((await emailRows(t)).every((r) => r.statusReason === "the approving staff member was removed")).toBe(true);
    // The chain ended on its own: one batch in the removal, two in the background for 205 rows.
    const jobs = (await scheduledNames(t)).filter((j) => j.name === "teams:releaseRemovedMemberClaims");
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.state === "success")).toBe(true);
  });

  it("a member re-invited before the backlog drains: their old approvals stay dead and are still cleaned up, a new approval after rejoining survives and fires", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const staff = await staffMember(t, s.innId);
    const total = FOLLOW_UP_CANCEL_BATCH * 2 + 5;
    const old = await seedScheduledApprovals(t, s, staff.userId, staff.membershipId, total);
    expect(await s.owner.as.mutation(api.teams.removeStaff, { innId: s.innId, userId: staff.userId })).toEqual({ released: 0, cleanupScheduled: true });
    const pending = async () => (await emailRows(t)).filter((r) => r.status === "scheduled");
    expect(await pending()).toHaveLength(total - FOLLOW_UP_CANCEL_BATCH);

    // Rejoined through a fresh invitation before the continuation ran.
    const freshMembershipId = await rejoin(t, s, staff);
    expect(freshMembershipId).not.toBe(staff.membershipId);
    // An old approval the cleanup has not reached yet cannot send even though the person is a member again.
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const survivor = (await pending())[0];
    expect(old).toContain(survivor._id);
    vi.setSystemTime(BASE + 72 * HOUR + 1);
    expect(await t.mutation(internal.followUps.fireEmail, { followUpId: survivor._id })).toEqual({ fired: false, reason: "the membership that approved this follow-up has ended" });
    expect(await t.run((ctx) => ctx.db.get(survivor._id))).toMatchObject({ status: "cancelled", statusReason: "the membership that approved this follow-up has ended" });
    expect(calls).toEqual([]);
    vi.setSystemTime(BASE);

    // A new approval made under the new membership row.
    await t.run((ctx) => ctx.db.patch(s.threadId, { claimedBy: undefined, claimedAt: undefined }));
    await staff.as.mutation(api.threads.claim, { threadId: s.threadId });
    const fresh = await staff.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 72 * HOUR));
    expect(await t.run((ctx) => ctx.db.get(fresh.followUpId))).toMatchObject({ status: "scheduled", approvedBy: staff.userId, approvedByMembershipId: freshMembershipId });

    // The continuation keeps draining the old row's approvals and leaves the new one alone.
    await drain(t);
    expect((await pending()).map((r) => r._id)).toEqual([fresh.followUpId]);
    for (const id of old) {
      const row = (await t.run((ctx) => ctx.db.get(id)))!;
      expect(row.status).toBe("cancelled");
    }
    // The old row's claims are the member's again after rejoining; the approvals never are.
    expect(await membershipOf(t, s.innId, staff.userId)).toMatchObject({ _id: freshMembershipId, role: "staff" });

    // The new approval fires normally.
    vi.unstubAllGlobals();
    const live = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_fu_fresh" }))]);
    await advance(t, 80 * HOUR);
    expect(live.calls).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get(fresh.followUpId))).toMatchObject({ status: "sent" });
    expect(await outMessages(t)).toHaveLength(2);
  });

  it("an approval whose membership binding is missing never sends", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const { followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 72 * HOUR));
    await t.run((ctx) => ctx.db.patch(followUpId, { approvedByMembershipId: undefined }));
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    await advance(t, 80 * HOUR);
    expect(calls).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(followUpId))).toMatchObject({ status: "cancelled", statusReason: "the approval is incomplete" });
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply"]);
  });

  it("the due worker refuses a booked stay, a closed thread, a thread that moved on, a lost membership or tampered text", async () => {
    const cases: { name: string; mutate: (t: T, s: Awaited<ReturnType<typeof answeredInquiry>>) => Promise<void>; reason: RegExp }[] = [
      { name: "booked", mutate: (t, s) => t.run((ctx) => ctx.db.patch(s.threadId, { stay: { ...INQUIRY, status: "booked" } })), reason: /no longer an open inquiry/ },
      { name: "closed", mutate: (t, s) => t.run((ctx) => ctx.db.patch(s.threadId, { status: "closed" })), reason: /closed/ },
      {
        // needs_staff without a due reminder behind it (the reminder is withdrawn here, so it is not the cause).
        name: "needs staff for another reason",
        mutate: (t, s) =>
          t.run(async (ctx) => {
            for (const r of await ctx.db.query("followUps").collect()) if (r.kind === "reminder") await ctx.db.patch(r._id, { status: "cancelled" });
            await ctx.db.patch(s.threadId, { status: "needs_staff" });
          }),
        reason: /no longer waiting/,
      },
      {
        name: "newer inbound stored directly",
        mutate: async (t, s) => {
          await t.run(async (ctx) => {
            const m = await ctx.db.insert("messages", { threadId: s.threadId, direction: "in", from: "g", to: "i", text: "more", at: Date.now() });
            await ctx.db.patch(s.threadId, { lastInboundMessageId: m });
          });
        },
        reason: /guest wrote again/,
      },
      {
        name: "membership removed",
        mutate: async (t, s) => {
          const m = (await membershipOf(t, s.innId, s.owner.userId))!;
          await t.run((ctx) => ctx.db.delete(m._id));
        },
        reason: /no_membership/,
      },
      // The owner created the inn, so demo authority would hold, but a live approval never becomes a simulated send.
      { name: "inn turned demo", mutate: (t, s) => t.run((ctx) => ctx.db.patch(s.innId, { isDemo: true })), reason: /changed between demo and live/ },
      {
        name: "member downgraded to demo role",
        mutate: async (t, s) => {
          const m = (await membershipOf(t, s.innId, s.owner.userId))!;
          await t.run((ctx) => ctx.db.patch(m._id, { role: "demo" }));
        },
        reason: /demo_role/,
      },
      { name: "text tampered", mutate: (t) => t.run(async (ctx) => {
          const [row] = (await ctx.db.query("followUps").collect()).filter((r) => r.kind === "email");
          await ctx.db.patch(row._id, { approvedText: "Book now for a discount!" });
        }), reason: /incomplete/ },
    ];
    for (const c of cases) {
      vi.setSystemTime(BASE);
      const t = makeTest();
      const s = await answeredInquiry(t);
      const { followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 72 * HOUR));
      await c.mutate(t, s);
      const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
      await advance(t, 80 * HOUR);
      const row = (await t.run((ctx) => ctx.db.get(followUpId)))!;
      expect(row.status, c.name).toBe("cancelled");
      expect(row.statusReason, c.name).toMatch(c.reason);
      expect(calls, c.name).toEqual([]);
      expect((await outboxRows(t)).map((r) => r.kind), c.name).toEqual(["reply"]);
      expect(await outMessages(t), c.name).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });
});

describe("races between reservation and the provider", () => {
  /** Approve, then run the due worker only (delivery stays scheduled, not yet started). */
  async function reserved(t: T, s: Awaited<ReturnType<typeof answeredInquiry>>) {
    const { followUpId } = await s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 72 * HOUR));
    vi.setSystemTime(BASE + 72 * HOUR + 1);
    const fired = await t.mutation(internal.followUps.fireEmail, { followUpId });
    expect(fired.fired).toBe(true);
    const outboxId = (fired as { outboxId: Id<"outbox"> }).outboxId;
    expect(await t.run((ctx) => ctx.db.get(followUpId))).toMatchObject({ status: "reserved", outboxId });
    return { followUpId, outboxId };
  }

  it("a staff cancel after reservation fails the reservation before dispatch and the worker's preflight refuses it too", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const { followUpId, outboxId } = await reserved(t, s);
    // The approval is frozen: no reschedule while reserved.
    await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
    expect(await failure(s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, Date.now() + HOUR)))).toMatch(/in_flight/);
    expect(await s.owner.as.mutation(api.followUps.cancelEmail, { followUpId })).toEqual({ status: "cancelled" });
    expect(await t.run((ctx) => ctx.db.get(outboxId))).toMatchObject({ status: "failed", errorKind: "precondition", errorMessage: "follow-up cancelled before dispatch (cancelled by staff)" });
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    await drain(t);
    await t.action(internal.outbox.deliver, { outboxId });
    expect(calls).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(followUpId))).toMatchObject({ status: "cancelled", statusReason: "cancelled by staff" });

    // A cancellation that only reached the approval (not the outbox row) is still caught by beginSend.
    const t2 = makeTest();
    vi.setSystemTime(BASE);
    const s2 = await answeredInquiry(t2);
    const r2 = await reserved(t2, s2);
    await t2.run((ctx) => ctx.db.patch(r2.followUpId, { status: "cancelled", statusReason: "cancelled by staff" }));
    const c2 = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const begin = await t2.mutation(internal.outbox.beginSend, { outboxId: r2.outboxId });
    expect(begin).toEqual({ ok: false, reason: "follow-up was cancelled before dispatch (cancelled by staff)" });
    expect(await t2.run((ctx) => ctx.db.get(r2.outboxId))).toMatchObject({ status: "failed", errorKind: "precondition" });
    expect(c2.calls).toEqual([]);
  });

  it("membership removed, guest reply, closure or a booked stay between reservation and dispatch is refused at beginSend and visible on the approval", async () => {
    const cases: { name: string; mutate: (t: T, s: Awaited<ReturnType<typeof answeredInquiry>>) => Promise<void>; reason: RegExp; approvalReason?: RegExp }[] = [
      {
        name: "membership removed",
        mutate: async (t, s) => {
          const m = (await membershipOf(t, s.innId, s.owner.userId))!;
          await t.run((ctx) => ctx.db.delete(m._id));
        },
        reason: /the membership that approved this follow-up ended before dispatch/,
      },
      {
        name: "guest replied",
        mutate: async (t) => void (await t.mutation(internal.inbound.receive, receiveArgs("msg_in_3", "Booked elsewhere, thanks."))),
        reason: /cancelled before dispatch \(a newer guest message arrived\)/,
        approvalReason: /a newer guest message arrived/,
      },
      {
        name: "closed",
        mutate: async (_t, s) => void (await s.owner.as.mutation(api.threads.setStatus, { threadId: s.threadId, status: "closed" })),
        reason: /cancelled before dispatch \(the thread was closed\)/,
        approvalReason: /the thread was closed/,
      },
      { name: "booked", mutate: (t, s) => t.run((ctx) => ctx.db.patch(s.threadId, { stay: { ...INQUIRY, status: "booked" } })), reason: /no longer an open inquiry/ },
      { name: "inbox rebound", mutate: (t, s) => t.run((ctx) => ctx.db.patch(s.innId, { inboxId: "other@agentmail.to", inboxAddress: "other@agentmail.to" })), reason: /inbox changed/ },
    ];
    for (const c of cases) {
      vi.setSystemTime(BASE);
      const t = makeTest();
      const s = await answeredInquiry(t);
      const { followUpId, outboxId } = await reserved(t, s);
      if (c.name === "closed") await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
      await c.mutate(t, s);
      const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
      await drain(t);
      await t.action(internal.outbox.deliver, { outboxId });
      const row = (await t.run((ctx) => ctx.db.get(outboxId)))!;
      expect(row.status, c.name).toBe("failed");
      expect(row.errorKind, c.name).toBe("precondition");
      expect(row.errorMessage, c.name).toMatch(c.reason);
      const approval = (await t.run((ctx) => ctx.db.get(followUpId)))!;
      expect(["cancelled", "failed"], c.name).toContain(approval.status);
      expect(approval.statusReason, c.name).toMatch(c.approvalReason ?? c.reason);
      expect(calls, c.name).toEqual([]);
      expect(await outMessages(t), c.name).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it("a reservation made before the approver was removed never dispatches after they are re-invited; an unknown delivery stays frozen and is not resent", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const staff = await signedInUser(t, { name: "Staff" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId: s.innId, userId: staff.userId, role: "staff", name: "Staff" }));
    await t.run((ctx) => ctx.db.patch(s.threadId, { claimedBy: undefined, claimedAt: undefined }));
    await staff.as.mutation(api.threads.claim, { threadId: s.threadId });
    const { followUpId } = await staff.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, BASE + 72 * HOUR));
    vi.setSystemTime(BASE + 72 * HOUR + 1);
    const fired = await t.mutation(internal.followUps.fireEmail, { followUpId });
    expect(fired.fired).toBe(true);
    const outboxId = (fired as { outboxId: Id<"outbox"> }).outboxId;
    // Removed after reservation, before the delivery worker ran; nothing pending, so no background job.
    expect(await s.owner.as.mutation(api.teams.removeStaff, { innId: s.innId, userId: staff.userId })).toEqual({ released: 1 });
    expect(await t.run((ctx) => ctx.db.get(followUpId))).toMatchObject({ status: "reserved", outboxId });
    // Re-invited before dispatch: the membership exists again, but it is a different row.
    const invite = await s.owner.as.action(api.teams.createInvite, { innId: s.innId });
    expect(await staff.as.mutation(api.teams.acceptInvite, { token: invite.token })).toEqual({ innId: s.innId, joined: true });
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    await drain(t);
    await t.action(internal.outbox.deliver, { outboxId });
    expect(calls).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(outboxId))).toMatchObject({
      status: "failed",
      errorKind: "precondition",
      errorMessage: "the membership that approved this follow-up ended before dispatch",
    });
    expect(await t.run((ctx) => ctx.db.get(followUpId))).toMatchObject({ status: "failed", statusReason: "the membership that approved this follow-up ended before dispatch" });
    expect(await outMessages(t)).toHaveLength(1);
    // The rejoined member may deliberately approve again under the new row.
    await staff.as.mutation(api.threads.claim, { threadId: s.threadId });
    const next = await staff.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, Date.now() + HOUR));
    expect(next.followUpId).not.toBe(followUpId);
  });

  it("a delivery the provider may already hold (unknown outcome) is untouched when the approver is removed: not recalled, not resent, no cleanup loop", async () => {
    const t2 = makeTest();
    const s2 = await answeredInquiry(t2);
    const staff2 = await signedInUser(t2, { name: "Staff" });
    await t2.run((ctx) => ctx.db.insert("memberships", { innId: s2.innId, userId: staff2.userId, role: "staff", name: "Staff" }));
    await t2.run((ctx) => ctx.db.patch(s2.threadId, { claimedBy: undefined, claimedAt: undefined }));
    await staff2.as.mutation(api.threads.claim, { threadId: s2.threadId });
    const r2 = await staff2.as.mutation(api.followUps.approveEmail, approveArgs(s2.threadId, BASE + 72 * HOUR));
    const c2 = stubFetch([agentmailReplyRoute(() => json(503, { error: "down" }))]);
    await advance(t2, 80 * HOUR);
    expect(c2.calls).toHaveLength(1);
    const unknownOutboxId = (await t2.run((ctx) => ctx.db.get(r2.followUpId)))!.outboxId!;
    expect(await t2.run((ctx) => ctx.db.get(unknownOutboxId))).toMatchObject({ status: "unknown" });
    // Their (expired) claim lock is released; no approvals are pending, so no background job is needed.
    expect(await s2.owner.as.mutation(api.teams.removeStaff, { innId: s2.innId, userId: staff2.userId })).toEqual({ released: 1 });
    await drain(t2);
    expect(await t2.run((ctx) => ctx.db.get(r2.followUpId))).toMatchObject({ status: "reserved", outboxId: unknownOutboxId });
    expect(await t2.run((ctx) => ctx.db.get(unknownOutboxId))).toMatchObject({ status: "unknown" });
    await t2.action(internal.outbox.deliver, { outboxId: unknownOutboxId });
    expect(c2.calls).toHaveLength(1);
    expect((await scheduledNames(t2)).filter((j) => j.state === "pending")).toEqual([]);
  });

  it("a guest message arriving after beginSend: the accepted delivery is recorded without overriding the new turn", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const { followUpId, outboxId } = await reserved(t, s);
    stubFetch([]);
    const begin = await t.mutation(internal.outbox.beginSend, { outboxId });
    expect(begin).toMatchObject({ ok: true, inboxId: "seagull@agentmail.to", providerMessageId: "msg_in_1", text: FOLLOW_UP_EMAIL_TEXT });
    // Cancel cannot recall what the provider has.
    await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
    expect(await failure(s.owner.as.mutation(api.followUps.cancelEmail, { followUpId }))).toMatch(/in_flight/);
    vi.advanceTimersByTime(5);
    await t.mutation(internal.inbound.receive, receiveArgs("msg_in_4", "Actually, is the room still free?"));
    const mid = (await t.run((ctx) => ctx.db.get(s.threadId)))!;
    expect(mid.status).toBe("drafting");
    expect(mid.lastInboundMessageId).not.toBe(s.messageId);
    // The approval could not be cancelled by the inbound either: the row was already sending.
    expect((await t.run((ctx) => ctx.db.get(followUpId)))?.status).toBe("reserved");
    const before = (await followUpRows(t)).length;

    await t.mutation(internal.outbox.commit, { outboxId, providerMessageId: "msg_fu_late", providerThreadId: "thr_1" });
    expect(await t.run((ctx) => ctx.db.get(outboxId))).toMatchObject({ status: "sent", sentProviderMessageId: "msg_fu_late" });
    expect(await t.run((ctx) => ctx.db.get(followUpId))).toMatchObject({ status: "sent" });
    const out = await outMessages(t);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ text: FOLLOW_UP_EMAIL_TEXT, agentmailMessageId: "msg_fu_late" });
    const after = (await t.run((ctx) => ctx.db.get(s.threadId)))!;
    expect(after.status).toBe("drafting");
    expect(after.lastInboundMessageId).toBe(mid.lastInboundMessageId);
    expect(await sentReplies(t)).toHaveLength(1);
    expect((await followUpRows(t)).length).toBe(before);
    // The original due job still fires later and is a no-op; nothing was scheduled for the new turn.
    stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    await advance(t, 72 * HOUR);
    expect((await scheduledNames(t)).filter((j) => j.name === "followUps:fireEmail" && j.state === "pending")).toEqual([]);
    expect((await outboxRows(t)).map((r) => r.kind)).toEqual(["reply", "follow_up"]);
    expect(await outMessages(t)).toHaveLength(2);
  });

  it("an ambiguous provider failure leaves the follow-up frozen and unretryable; a definite failure is visible and allows a new approval", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    const { followUpId, outboxId } = await reserved(t, s);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(503, { error: "down" }))]);
    await drain(t);
    expect(calls).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get(outboxId))).toMatchObject({ status: "unknown", errorKind: "agentmail_http" });
    const approval = (await t.run((ctx) => ctx.db.get(followUpId)))!;
    expect(approval.status).toBe("reserved");
    expect(approval.statusReason).toMatch(/not retried/);
    await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
    expect(await failure(s.owner.as.mutation(api.followUps.approveEmail, approveArgs(s.threadId, Date.now() + HOUR)))).toMatch(/in_flight/);
    expect(await failure(s.owner.as.mutation(api.followUps.cancelEmail, { followUpId }))).toMatch(/in_flight/);
    const view = await s.owner.as.query(api.followUps.emailForThread, { threadId: s.threadId });
    expect(view).toMatchObject({ canApprove: false, current: { status: "reserved", delivery: { status: "unknown" } } });
    await t.action(internal.outbox.deliver, { outboxId });
    expect(await t.mutation(internal.followUps.fireEmail, { followUpId })).toEqual({ fired: false, reason: "not scheduled" });
    expect(calls).toHaveLength(1);
    expect(await outMessages(t)).toHaveLength(1);

    // Definite rejection.
    const t2 = makeTest();
    vi.setSystemTime(BASE);
    const s2 = await answeredInquiry(t2);
    const r2 = await reserved(t2, s2);
    const c2 = stubFetch([agentmailReplyRoute(() => json(422, { error: "bad" }))]);
    await drain(t2);
    expect(c2.calls).toHaveLength(1);
    expect(await t2.run((ctx) => ctx.db.get(r2.outboxId))).toMatchObject({ status: "failed", errorKind: "agentmail_http" });
    expect(await t2.run((ctx) => ctx.db.get(r2.followUpId))).toMatchObject({ status: "failed" });
    expect((await t2.run((ctx) => ctx.db.get(r2.followUpId)))?.statusReason).not.toContain("bad");
    // The thread is still eligible: staff may deliberately approve again.
    await s2.owner.as.mutation(api.threads.claim, { threadId: s2.threadId });
    const next = await s2.owner.as.mutation(api.followUps.approveEmail, approveArgs(s2.threadId, Date.now() + HOUR));
    expect(next.followUpId).not.toBe(r2.followUpId);
    expect((await s2.owner.as.query(api.followUps.emailForThread, { threadId: s2.threadId })).history.map((h) => h.status)).toEqual(["scheduled", "failed"]);
  });

  it("the normal reply guards are untouched: a follow-up in flight does not block corrections and claims are still required for replies", async () => {
    const t = makeTest();
    const s = await answeredInquiry(t);
    await reserved(t, s);
    // The follow-up row is not part of the reply turn barrier.
    const turn = await t.run(async (ctx) => (await import("../convex/outbox")).replyTurnState(ctx, s.threadId, s.messageId));
    expect(turn.statuses).toEqual(["sent"]);
    expect(turn.delivered).toBe(true);
    // A regular reply reservation still needs an active claim at dispatch.
    const { threadId, messageId } = await seedInboundThread(t, s.innId, { providerMessageId: "msg_in_7" });
    const draftId = await seedReadyDraft(t, threadId, messageId, s.pageId, s.versionId);
    await s.owner.as.mutation(api.threads.claim, { threadId });
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId });
    await t.run((ctx) => ctx.db.patch(threadId, { claimedBy: undefined, claimedAt: undefined }));
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_fu_1" }))]);
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(outboxId))).toMatchObject({ status: "failed", errorMessage: "thread claim expired or changed before dispatch" });
    // Only the reserved follow-up (which needs no claim) reached the provider.
    expect(calls.map((c) => c.url)).toEqual(["https://api.agentmail.to/v0/inboxes/seagull%40agentmail.to/messages/msg_in_1/reply"]);
  });
});
