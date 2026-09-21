import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { BURST_OPERATIONS, HOURLY_OPERATIONS } from "../convex/modelBudget";
import { makeTest, signedInUser, type T } from "./setup";
import { draftOutput, judgeOutput, openaiRoutes, responsesOutput, seedInboundThread, seedLiveInn, settle, stubFetch, withEnv } from "./integrationSetup";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** Mid-hour so the burst bucket and the clock-aligned hourly window are told apart. */
const BASE = Date.parse("2026-09-21T09:00:00Z");

beforeEach(() => {
  // Only the clock is faked: scheduled functions still run on real timers so
  // `settle` (and the component's own worker) behave as in production.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const peek = (t: T, innId: Id<"inns">) => t.query(internal.modelBudget.peek, { innId });

/** A real inn with one open (verifying) draft: the cheapest valid draft scope. */
async function innWithVerifyingDraft(t: T, name = "Owner") {
  const owner = await signedInUser(t, { name });
  const inn = await seedLiveInn(t, owner.userId);
  const { threadId, messageId } = await seedInboundThread(t, inn.innId);
  const draftId = await t.mutation(internal.generation.begin, { threadId, inboundMessageId: messageId, model: "test" });
  if (!draftId) throw new Error("begin refused");
  return { owner, ...inn, threadId, messageId, draftId };
}

const reserveDraft = (t: T, draftId: Id<"drafts">, inboundMessageId: Id<"messages">) =>
  t.mutation(internal.modelBudget.reserve, { scope: { kind: "draft", draftId, inboundMessageId } });

async function exhaustBurst(t: T, draftId: Id<"drafts">, inboundMessageId: Id<"messages">) {
  for (let i = 0; i < BURST_OPERATIONS; i++) {
    expect(await reserveDraft(t, draftId, inboundMessageId)).toEqual({ ok: true });
  }
}

describe("model budget (real rate-limiter component)", () => {
  it("charges both limits for an operation within the limit", async () => {
    const t = makeTest();
    const s = await innWithVerifyingDraft(t);
    expect(await peek(t, s.innId)).toEqual({ modelBurst: BURST_OPERATIONS, modelHourly: HOURLY_OPERATIONS });
    expect(await reserveDraft(t, s.draftId, s.messageId)).toEqual({ ok: true });
    expect(await peek(t, s.innId)).toEqual({ modelBurst: BURST_OPERATIONS - 1, modelHourly: HOURLY_OPERATIONS - 1 });
  });

  it("denies the 11th operation in the first minute with a readable retry time; another inn is unaffected", async () => {
    const t = makeTest();
    const a = await innWithVerifyingDraft(t, "A");
    const b = await innWithVerifyingDraft(t, "B");
    await exhaustBurst(t, a.draftId, a.messageId);
    const denied = await reserveDraft(t, a.draftId, a.messageId);
    expect(denied).toMatchObject({ ok: false, kind: "throttled" });
    if (denied.ok || denied.kind !== "throttled") throw new Error("expected throttle");
    // Token bucket at 10/min: one token returns after 6 s.
    expect(denied.retryAt).toBe(BASE + 6 * 1000);
    expect(denied.reason).toMatch(/model budget is used up \(10 per minute, 60 per hour\); try again after 9:00:06 AM UTC$/);
    // The hourly window was not charged for the denied operation.
    expect(await peek(t, a.innId)).toEqual({ modelBurst: 0, modelHourly: HOURLY_OPERATIONS - BURST_OPERATIONS });
    // Budgets are per inn.
    expect(await reserveDraft(t, b.draftId, b.messageId)).toEqual({ ok: true });
    expect(await peek(t, b.innId)).toEqual({ modelBurst: BURST_OPERATIONS - 1, modelHourly: HOURLY_OPERATIONS - 1 });
  });

  it("a denial at a non-zero second shows a retry time with seconds, in the inn's timezone", async () => {
    const t = makeTest();
    const s = await innWithVerifyingDraft(t);
    await t.run((ctx) => ctx.db.patch(s.innId, { timezone: "America/New_York" }));
    // 09:34:53 UTC = 5:34:53 AM EDT. The last token is taken here; the next
    // returns 6 s later, still inside the same minute.
    vi.setSystemTime(BASE + 34 * MINUTE + 53 * 1000);
    await exhaustBurst(t, s.draftId, s.messageId);
    const denied = await reserveDraft(t, s.draftId, s.messageId);
    if (denied.ok || denied.kind !== "throttled") throw new Error("expected throttle");
    expect(denied.retryAt).toBe(BASE + 34 * MINUTE + 59 * 1000);
    // Minute-only ("5:34 AM") would already be in the past for the reader.
    expect(denied.reason).toMatch(/try again after 5:34:59 AM EDT$/);
  });

  it("refills with the clock", async () => {
    const t = makeTest();
    const s = await innWithVerifyingDraft(t);
    await exhaustBurst(t, s.draftId, s.messageId);
    expect(await reserveDraft(t, s.draftId, s.messageId)).toMatchObject({ ok: false, kind: "throttled" });
    vi.setSystemTime(BASE + 5 * 1000);
    expect(await reserveDraft(t, s.draftId, s.messageId)).toMatchObject({ ok: false, kind: "throttled" });
    vi.setSystemTime(BASE + 6 * 1000);
    expect(await reserveDraft(t, s.draftId, s.messageId)).toEqual({ ok: true });
    expect(await reserveDraft(t, s.draftId, s.messageId)).toMatchObject({ ok: false, kind: "throttled" });
    vi.setSystemTime(BASE + 1 * MINUTE + 6 * 1000);
    expect(await peek(t, s.innId)).toEqual({ modelBurst: BURST_OPERATIONS, modelHourly: HOURLY_OPERATIONS - BURST_OPERATIONS - 1 });
  });

  it("enforces the hourly window and a denial by one limit leaves the other uncharged", async () => {
    const t = makeTest();
    const s = await innWithVerifyingDraft(t);
    // 10 per minute for six minutes: exactly the hour's allowance.
    for (let minute = 0; minute < HOURLY_OPERATIONS / BURST_OPERATIONS; minute++) {
      vi.setSystemTime(BASE + minute * MINUTE);
      await exhaustBurst(t, s.draftId, s.messageId);
    }
    vi.setSystemTime(BASE + 6 * MINUTE);
    expect(await peek(t, s.innId)).toEqual({ modelBurst: BURST_OPERATIONS, modelHourly: 0 });
    const denied = await reserveDraft(t, s.draftId, s.messageId);
    expect(denied).toMatchObject({ ok: false, kind: "throttled", retryAt: BASE + HOUR });
    if (denied.ok || denied.kind !== "throttled") throw new Error("expected throttle");
    expect(denied.reason).toMatch(/try again after 10:00:00 AM UTC$/);
    // The burst bucket still holds every token: nothing was consumed on denial.
    expect(await peek(t, s.innId)).toEqual({ modelBurst: BURST_OPERATIONS, modelHourly: 0 });
    vi.setSystemTime(BASE + HOUR);
    expect(await reserveDraft(t, s.draftId, s.messageId)).toEqual({ ok: true });
    expect(await peek(t, s.innId)).toEqual({ modelBurst: BURST_OPERATIONS - 1, modelHourly: HOURLY_OPERATIONS - 1 });
  });

  it("stale, demo and staff-edited scopes are refused without charging", async () => {
    const t = makeTest();
    const s = await innWithVerifyingDraft(t);
    const before = await peek(t, s.innId);
    // A newer guest message makes the open draft obsolete.
    const later = await seedInboundThread(t, s.innId, { providerMessageId: "<msg2@example.com>" });
    expect(await reserveDraft(t, s.draftId, later.messageId)).toEqual({ ok: false, kind: "stale" });
    // Unknown / wrong records.
    expect(await t.mutation(internal.modelBudget.reserve, { scope: { kind: "reverify", draftId: s.draftId, answer: "not the text" } })).toEqual({ ok: false, kind: "stale" });
    // A draft that is no longer verifying.
    await t.run((ctx) => ctx.db.patch(s.draftId, { status: "superseded" }));
    expect(await reserveDraft(t, s.draftId, s.messageId)).toEqual({ ok: false, kind: "stale" });
    expect(await peek(t, s.innId)).toEqual(before);

    // Demo inns never consume model budget.
    const demoOwner = await signedInUser(t, { name: "Demo" });
    const demoInnId = await t.run((ctx) =>
      ctx.db.insert("inns", { name: "Demo Inn", siteUrl: "https://demo.example", timezone: "UTC", isDemo: true, createdBy: demoOwner.userId }),
    );
    const demo = await seedInboundThread(t, demoInnId);
    const demoDraft = await t.mutation(internal.generation.begin, { threadId: demo.threadId, inboundMessageId: demo.messageId, model: "test" });
    expect(await reserveDraft(t, demoDraft!, demo.messageId)).toEqual({ ok: false, kind: "stale" });
    expect(await peek(t, demoInnId)).toEqual({ modelBurst: BURST_OPERATIONS, modelHourly: HOURLY_OPERATIONS });
    // The demo pipeline itself never reaches the budget or the provider.
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const { calls } = stubFetch([]);
    await t.action(internal.generation.generateForThread, { threadId: demo.threadId, inboundMessageId: demo.messageId });
    expect(calls).toHaveLength(0);
    expect(await peek(t, demoInnId)).toEqual({ modelBurst: BURST_OPERATIONS, modelHourly: HOURLY_OPERATIONS });
  });

  it("a missing key fails the draft before the budget is touched", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    const { calls } = stubFetch([]);
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    const detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft).toMatchObject({ status: "needs_edit", abstain: true, gapQuestion: null });
    expect(detail.draft?.statusReason).toMatch(/OPENAI_API_KEY is not configured/);
    expect(calls).toHaveLength(0);
    expect(await peek(t, innId)).toEqual({ modelBurst: BURST_OPERATIONS, modelHourly: HOURLY_OPERATIONS });
  });

  it("an inn with no pages and no staff facts fails the draft visibly before the budget is touched", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    // A real inn with a bound inbox but nothing scraped and no facts yet.
    const innId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("inns", {
        name: "Empty Inn",
        siteUrl: "https://empty.example",
        timezone: "UTC",
        isDemo: false,
        createdBy: owner.userId,
        inboxId: "empty@agentmail.to",
        inboxAddress: "empty@agentmail.to",
      });
      await ctx.db.insert("memberships", { innId: id, userId: owner.userId, role: "owner", name: "Owner" });
      return id;
    });
    const { threadId, messageId } = await seedInboundThread(t, innId);
    const { calls } = stubFetch([]);
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    await settle(t);
    const detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.thread.status).toBe("needs_staff");
    expect(detail.draft).toMatchObject({ status: "needs_edit", abstain: true, answer: "", gapQuestion: null, verifiedText: null });
    expect(detail.draft?.statusReason).toMatch(/^nothing to draft from: this inn has no website pages or staff facts yet$/);
    expect(calls).toHaveLength(0);
    expect(await peek(t, innId)).toEqual({ modelBurst: BURST_OPERATIONS, modelHourly: HOURLY_OPERATIONS });
  });

  it("re-judging a draft bound to an inbound older than the thread's latest is refused without charging", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, versionId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    const answer = "Dogs are welcome for a $25 per night pet fee.";
    const seedDraft = (replyToMessageId: Id<"messages"> | undefined) =>
      t.run(async (ctx) => {
        const draftId = await ctx.db.insert("drafts", { threadId, replyToMessageId, class: "answerable", answer, abstain: false, status: "needs_edit", model: "m", textSource: "staff" });
        await ctx.db.insert("claims", { draftId, threadId, innId, statement: "$25", url: "https://seagull.example/policies", pageVersionId: versionId, quote: "$25 per night pet fee", verified: true, status: "ok" });
        return draftId;
      });
    // Still needs_edit (nothing superseded it), but the guest has since written again.
    const stale = await seedDraft(messageId);
    await t.run(async (ctx) => {
      const newer = await ctx.db.insert("messages", { threadId, direction: "in", from: "guest@example.com", to: "x", text: "Newer follow-up message.", at: Date.now() });
      await ctx.db.patch(threadId, { lastInboundMessageId: newer });
    });
    const { calls } = stubFetch([]);
    expect(await t.mutation(internal.modelBudget.reserve, { scope: { kind: "reverify", draftId: stale, answer } })).toEqual({ ok: false, kind: "stale" });
    await t.action(internal.generation.reverify, { draftId: stale });
    expect(calls).toHaveLength(0);
    const untouched = await t.run((ctx) => ctx.db.get(stale));
    expect(untouched).toMatchObject({ status: "needs_edit", answer });
    expect(untouched?.verifiedText).toBeUndefined();
    expect(untouched?.judgeVerdict).toBeUndefined();
    expect(untouched?.statusReason).toBeUndefined();
    expect(await peek(t, innId)).toEqual({ modelBurst: BURST_OPERATIONS, modelHourly: HOURLY_OPERATIONS });

    // Legacy drafts with no binding at all keep the old behaviour: the scope is accepted.
    const unbound = await seedDraft(undefined);
    expect(await t.mutation(internal.modelBudget.reserve, { scope: { kind: "reverify", draftId: unbound, answer } })).toEqual({ ok: true });
    expect(await peek(t, innId)).toEqual({ modelBurst: BURST_OPERATIONS - 1, modelHourly: HOURLY_OPERATIONS - 1 });
  });

  it("the real pipeline parks the thread for staff with zero provider calls when the budget is empty, and does not retry by itself", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const s = await innWithVerifyingDraft(t);
    await exhaustBurst(t, s.draftId, s.messageId);
    const { calls } = stubFetch([]);
    const fresh = await seedInboundThread(t, s.innId, { providerMessageId: "<msg-fresh@example.com>" });
    await t.action(internal.generation.generateForThread, { threadId: fresh.threadId, inboundMessageId: fresh.messageId });
    await settle(t);
    const detail = await s.owner.as.query(api.threads.get, { threadId: fresh.threadId });
    expect(detail.thread.status).toBe("needs_staff");
    expect(detail.draft).toMatchObject({ status: "needs_edit", abstain: true, answer: "", gapQuestion: null, verifiedText: null });
    expect(detail.draft?.statusReason).toMatch(/^drafting paused: this inn's model budget is used up .*try again after 9:00:06 AM UTC$/);
    expect(detail.claims).toEqual([]);
    expect(calls).toHaveLength(0);
    // Nothing was charged for the denied attempt and nothing is queued.
    expect(await peek(t, s.innId)).toEqual({ modelBurst: 0, modelHourly: HOURLY_OPERATIONS - BURST_OPERATIONS });
    expect(await t.run((ctx) => ctx.db.query("drafts").filter((q) => q.eq(q.field("threadId"), fresh.threadId)).collect())).toHaveLength(1);

    // Staff retry after the cooldown goes through the ordinary regenerate flow.
    vi.setSystemTime(BASE + 2 * MINUTE);
    stubFetch(
      openaiRoutes({
        draft: () =>
          responsesOutput(
            draftOutput({
              answer: "Dogs are welcome for a $25 per night pet fee.",
              claims: [{ statement: "$25", url: "https://seagull.example/policies", quote: "$25 per night pet fee", sourceId: s.versionId }],
            }),
          ),
        judge: () => responsesOutput(judgeOutput(true, false)),
      }),
    );
    await s.owner.as.mutation(api.threads.claim, { threadId: fresh.threadId });
    await s.owner.as.mutation(api.drafts.regenerate, { threadId: fresh.threadId });
    await settle(t);
    const after = await s.owner.as.query(api.threads.get, { threadId: fresh.threadId });
    expect(after.draft?.status).toBe("ready");
    expect(after.thread.status).toBe("ready");
  });

  it("an inbound webhook is still stored and deduped when the inn's budget is empty", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const s = await innWithVerifyingDraft(t);
    await exhaustBurst(t, s.draftId, s.messageId);
    const { calls } = stubFetch([]);
    const event = {
      eventId: "evt_1",
      inboxId: "seagull@agentmail.to",
      providerMessageId: "msg_new",
      providerThreadId: "thr_new",
      from: "Guest <new@example.com>",
      to: "seagull@agentmail.to",
      subject: "Parking?",
      text: "Is there parking?",
      receivedAt: Date.now(),
    };
    const first = await t.mutation(internal.inbound.receive, event);
    expect(first.outcome).toBe("stored");
    expect(await t.mutation(internal.inbound.receive, event)).toEqual({ outcome: "duplicate" });
    await settle(t);
    const detail = await s.owner.as.query(api.threads.get, { threadId: first.threadId! });
    expect(detail.messages.map((m) => m.text)).toEqual(["Is there parking?"]);
    expect(detail.thread.status).toBe("needs_staff");
    expect(detail.draft).toMatchObject({ status: "needs_edit", abstain: true });
    expect(detail.draft?.statusReason).toMatch(/drafting paused: this inn's model budget is used up/);
    expect(calls).toHaveLength(0);
  });

  it("re-judging a staff edit shares the inn's budget and is held with the retry time when it is empty", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, versionId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    const answer = "Dogs are welcome for a $25 per night pet fee.";
    const { calls } = stubFetch(
      openaiRoutes({
        draft: () => responsesOutput(draftOutput({ answer, claims: [{ statement: "$25", url: "https://seagull.example/policies", quote: "$25 per night pet fee", sourceId: versionId }] })),
        judge: () => responsesOutput(judgeOutput(true, false)),
      }),
    );
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    let detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft?.status).toBe("ready");
    const draftId = detail.draft!._id;
    // The draft + judge pair was one operation.
    expect(await peek(t, innId)).toEqual({ modelBurst: BURST_OPERATIONS - 1, modelHourly: HOURLY_OPERATIONS - 1 });
    expect(calls).toHaveLength(2);

    // Every edit re-judge is one operation, so the burst runs out.
    await owner.as.mutation(api.threads.claim, { threadId });
    for (let i = 1; i < BURST_OPERATIONS; i++) {
      await owner.as.mutation(api.drafts.edit, { draftId, answer: `${answer} (${i})` });
      await settle(t);
    }
    expect(await peek(t, innId)).toEqual({ modelBurst: 0, modelHourly: HOURLY_OPERATIONS - BURST_OPERATIONS });
    expect(calls).toHaveLength(2 + BURST_OPERATIONS - 1);

    const edited = "Hi! Dogs are welcome for a $25 per night pet fee.";
    await owner.as.mutation(api.drafts.edit, { draftId, answer: edited });
    await settle(t);
    detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft).toMatchObject({ status: "needs_edit", answer: edited, verifiedText: null, judgeVerdict: null, textSource: "staff" });
    expect(detail.draft?.statusReason).toMatch(/^edited text not re-judged: this inn's model budget is used up .*\(or send as staff-authored\)$/);
    expect(detail.thread.status).toBe("needs_staff");
    expect(calls).toHaveLength(2 + BURST_OPERATIONS - 1);
    // The edited text is frozen for a verified send but staff-authored send stays available to the guard.
    await expect(owner.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/unverified_edit/);

    // Once a token returns, the same edit re-judged by staff retry (a fresh edit) goes through.
    vi.setSystemTime(BASE + 6 * 1000);
    await owner.as.mutation(api.drafts.edit, { draftId, answer: edited + " Thanks!" });
    await settle(t);
    detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft).toMatchObject({ status: "ready", verifiedText: edited + " Thanks!" });
    expect(calls).toHaveLength(2 + BURST_OPERATIONS);
  });

  it("a generated correction is one operation and is held with the retry time when the budget is empty", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const V1 = "# Policies\n\nDogs are welcome for a $25 per night pet fee.\n";
    const V2 = "# Policies\n\nDogs are welcome for a $40 per night pet fee.\n";
    const owner = await signedInUser(t, { name: "Owner" });
    const inn = await seedLiveInn(t, owner.userId, { markdown: V1 });
    const pet = await seedInboundThread(t, inn.innId, { text: "Dogs?", providerMessageId: "msg_pet" });
    await t.run(async (ctx) => {
      const answer = "Dogs are welcome for a $25 per night pet fee.";
      const draftId = await ctx.db.insert("drafts", {
        threadId: pet.threadId,
        replyToMessageId: pet.messageId,
        class: "answerable",
        answer,
        abstain: false,
        status: "sent",
        model: "test",
        verifiedText: answer,
        textSource: "model",
      });
      await ctx.db.insert("claims", {
        draftId,
        threadId: pet.threadId,
        innId: inn.innId,
        statement: "$25 per night pet fee",
        pageId: inn.pageId,
        pageVersionId: inn.versionId,
        url: "https://seagull.example/policies",
        quote: "$25 per night pet fee",
        verified: true,
        verifyMethod: "strict",
        status: "ok",
      });
      await ctx.db.insert("sentReplies", {
        threadId: pet.threadId,
        innId: inn.innId,
        draftId,
        sentBy: owner.userId,
        sentAt: Date.now(),
        kind: "reply",
        text: answer,
        textSource: "model",
        simulated: false,
      });
      await ctx.db.patch(pet.threadId, { status: "waiting_guest" });
    });
    // Drain the inn's burst through an unrelated open draft.
    const other = await seedInboundThread(t, inn.innId, { providerMessageId: "msg_other" });
    const otherDraft = await t.mutation(internal.generation.begin, { threadId: other.threadId, inboundMessageId: other.messageId, model: "test" });
    await exhaustBurst(t, otherDraft!, other.messageId);

    const { calls } = stubFetch([]);
    await owner.as.mutation(api.pages.submitContent, { pageId: inn.pageId, markdown: V2 });
    await settle(t);
    let [c] = await owner.as.query(api.corrections.list, { innId: inn.innId, status: "needs_review" });
    expect(c).toMatchObject({ proposedText: null, textSource: null, judgeVerdict: null });
    expect(c.statusReason).toMatch(/^drafting paused: this inn's model budget is used up .*; write the correction or regenerate later$/);
    expect(calls).toHaveLength(0);
    expect(await peek(t, inn.innId)).toEqual({ modelBurst: 0, modelHourly: HOURLY_OPERATIONS - BURST_OPERATIONS });

    // Manual regeneration after the cooldown consumes one operation for draft + judge.
    vi.setSystemTime(BASE + 6 * 1000);
    stubFetch(
      openaiRoutes({
        draft: () =>
          responsesOutput(
            draftOutput({
              answer: "Our pet fee is now $40 per night.",
              claims: [{ statement: "$40", url: "https://seagull.example/policies", quote: "$40 per night pet fee", sourceId: c.newVersionId }],
            }),
          ),
        judge: () => responsesOutput(judgeOutput(true, false)),
      }),
    );
    await owner.as.mutation(api.corrections.regenerateProposal, { correctionId: c._id });
    await settle(t);
    [c] = await owner.as.query(api.corrections.list, { innId: inn.innId, status: "needs_review" });
    expect(c).toMatchObject({ proposedText: "Our pet fee is now $40 per night.", textSource: "generated", statusReason: null });
    expect(await peek(t, inn.innId)).toEqual({ modelBurst: 0, modelHourly: HOURLY_OPERATIONS - BURST_OPERATIONS - 1 });
    // A correction whose page moved on again is stale and free.
    expect(
      await t.mutation(internal.modelBudget.reserve, { scope: { kind: "correction", correctionId: c._id, newVersionId: inn.versionId } }),
    ).toEqual({ ok: false, kind: "stale" });
  });
});
