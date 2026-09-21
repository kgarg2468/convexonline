import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { makeTest, signedInUser } from "./setup";
import { agentmailReplyRoute, json, seedInboundThread, seedLiveInn, settle, stubFetch, withEnv } from "./integrationSetup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type T = ReturnType<typeof makeTest>;

const V25 = "# Policies\n\nDogs are welcome for a $25 per night pet fee.\n\nCheck-in is from 3:00 PM.\n";
const V40 = "# Policies\n\nDogs are welcome for a $40 per night pet fee, limited to one dog per room.\n\nCheck-in is from 3:00 PM.\n";
const ANSWER = "Yes! Dogs are welcome for a $25 per night pet fee.";
const CORRECTION_TEXT = "Our pet fee is now $40 per night.";

/** A verified, ready draft citing the inn's policies page. */
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
    await ctx.db.patch(threadId, { status: "ready" });
    return draftId;
  });
}

/** A live inn whose owner holds the claim on a thread with one ready draft. */
async function liveSetup(t: T) {
  const owner = await signedInUser(t, { name: "Owner" });
  const inn = await seedLiveInn(t, owner.userId, { markdown: V25 });
  const { threadId, messageId } = await seedInboundThread(t, inn.innId, { providerMessageId: "msg_in_1" });
  const draftId = await seedReadyDraft(t, threadId, messageId, inn.pageId, inn.versionId);
  await owner.as.mutation(api.threads.claim, { threadId });
  return { owner, ...inn, threadId, messageId, draftId };
}

const outboxRows = (t: T) => t.run((ctx) => ctx.db.query("outbox").collect());
const sentReplies = (t: T) => t.run((ctx) => ctx.db.query("sentReplies").collect());
const corrections = (t: T) => t.run((ctx) => ctx.db.query("corrections").collect());

const membershipOf = (t: T, innId: Id<"inns">, userId: Id<"users">) =>
  t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_inn_user", (q) => q.eq("innId", innId).eq("userId", userId))
      .unique(),
  );

async function removeMembership(t: T, innId: Id<"inns">, userId: Id<"users">) {
  const m = (await membershipOf(t, innId, userId))!;
  await t.run((ctx) => ctx.db.delete(m._id));
}

async function setRole(t: T, innId: Id<"inns">, userId: Id<"users">, role: "owner" | "staff" | "demo") {
  const m = (await membershipOf(t, innId, userId))!;
  await t.run((ctx) => ctx.db.patch(m._id, { role }));
}

/**
 * Reserves the seeded draft through the public API, applies `between` before
 * the scheduled delivery starts, then runs delivery and lets the scheduler drain.
 */
async function reserveThen(t: T, s: Awaited<ReturnType<typeof liveSetup>>, between: () => Promise<void>) {
  const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
  await between();
  await t.action(internal.outbox.deliver, { outboxId });
  await settle(t);
  return (await outboxRows(t)).find((r) => r._id === outboxId)!;
}

async function expectRefused(t: T, row: Awaited<ReturnType<typeof reserveThen>>, calls: unknown[], message: RegExp) {
  expect(row).toMatchObject({ status: "failed", errorKind: "precondition" });
  expect(row.errorMessage).toMatch(message);
  expect(calls).toEqual([]);
  expect(await sentReplies(t)).toEqual([]);
  expect((await t.run((ctx) => ctx.db.get(row.draftId!)))?.status).toBe("ready");
}

describe("live authority is rechecked at dispatch (reply)", () => {
  it("membership removed after reservation: nothing is sent and the row fails cleanly", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const row = await reserveThen(t, s, () => removeMembership(t, s.innId, s.owner.userId));
    await expectRefused(t, row, calls, /no_membership/);
  });

  it("membership downgraded to demo role after reservation is refused", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const row = await reserveThen(t, s, () => setRole(t, s.innId, s.owner.userId, "demo"));
    await expectRefused(t, row, calls, /demo_role/);
  });

  it("the reserving user deleted after reservation is refused", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const row = await reserveThen(t, s, () => t.run((ctx) => ctx.db.delete(s.owner.userId)));
    await expectRefused(t, row, calls, /no longer exists/);
  });

  it("the reserving user turned anonymous after reservation is refused", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const row = await reserveThen(t, s, () => t.run((ctx) => ctx.db.patch(s.owner.userId, { isAnonymous: true })));
    await expectRefused(t, row, calls, /anonymous_user/);
  });

  it("the inn becoming demo after reservation is refused", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const row = await reserveThen(t, s, () => t.run((ctx) => ctx.db.patch(s.innId, { isDemo: true })));
    await expectRefused(t, row, calls, /demo_inn/);
  });

  it("the inn's inbox rebound after reservation is refused: the captured inbox no longer belongs to the inn", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const row = await reserveThen(t, s, () =>
      t.run((ctx) => ctx.db.patch(s.innId, { inboxId: "other@agentmail.to", inboxAddress: "other@agentmail.to" })),
    );
    expect(row.providerInboxId).toBe("seagull@agentmail.to");
    await expectRefused(t, row, calls, /inbox changed/);
  });

  it("the thread moved to another inn after reservation is refused", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const other = await seedLiveInn(t, s.owner.userId, { inboxId: "other@agentmail.to" });
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const row = await reserveThen(t, s, () => t.run((ctx) => ctx.db.patch(s.threadId, { innId: other.innId })));
    await expectRefused(t, row, calls, /no longer belongs/);
  });

  it("owner demoted to staff keeps live authority: the provider is called exactly once", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    const row = await reserveThen(t, s, () => setRole(t, s.innId, s.owner.userId, "staff"));
    expect(row).toMatchObject({ status: "sent", sentProviderMessageId: "msg_out_1" });
    expect(calls).toHaveLength(1);
    expect(await sentReplies(t)).toHaveLength(1);
    expect((await sentReplies(t))[0]).toMatchObject({ sentBy: s.owner.userId, outboxId: row._id });
  });

  it("a refused reservation leaves the turn open: a re-admitted member can send it later", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    const row = await reserveThen(t, s, () => removeMembership(t, s.innId, s.owner.userId));
    expect(row.status).toBe("failed");
    expect(calls).toEqual([]);
    await t.run((ctx) => ctx.db.insert("memberships", { innId: s.innId, userId: s.owner.userId, role: "staff", name: "Owner" }));
    await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
    await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect((await outboxRows(t)).map((r) => r.status).sort()).toEqual(["failed", "sent"]);
    expect(await sentReplies(t)).toHaveLength(1);
  });
});

describe("what the recheck must not touch", () => {
  it("membership removed once the row is already sending cannot undo the external send", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([]);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    expect((await t.mutation(internal.outbox.beginSend, { outboxId })).ok).toBe(true);
    await removeMembership(t, s.innId, s.owner.userId);
    // The provider accepted the message while the membership vanished; history is recorded as usual.
    await t.mutation(internal.outbox.commit, { outboxId, providerMessageId: "msg_out_1" });
    expect((await outboxRows(t))[0]).toMatchObject({ status: "sent", sentProviderMessageId: "msg_out_1" });
    expect(await sentReplies(t)).toHaveLength(1);
    // A later delivery attempt never re-enters the recheck for a sent row.
    await t.action(internal.outbox.deliver, { outboxId });
    expect((await outboxRows(t))[0].status).toBe("sent");
    expect(calls).toEqual([]);
  });

  it("inbox rebound while the provider call is in flight: history names the inbox that actually sent", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([
      agentmailReplyRoute(async () => {
        // The provider has the message; the inn is rebound before it answers.
        await t.run((ctx) => ctx.db.patch(s.innId, { inboxId: "other@agentmail.to", inboxAddress: "other@agentmail.to" }));
        return json(200, { message_id: "msg_out_1" });
      }),
    ]);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/inboxes/seagull%40agentmail.to/");
    const row = (await outboxRows(t)).find((r) => r._id === outboxId)!;
    expect(row).toMatchObject({ status: "sent", sentProviderMessageId: "msg_out_1", providerInboxId: "seagull@agentmail.to" });
    const replies = await sentReplies(t);
    expect(replies).toHaveLength(1);
    const sent = (await t.run((ctx) => ctx.db.get(replies[0].messageId!)))!;
    expect(sent).toMatchObject({ direction: "out", from: "seagull@agentmail.to", inboxId: "seagull@agentmail.to" });
    // The new binding is untouched: no resend, no rollback.
    expect(await t.run((ctx) => ctx.db.get(s.innId))).toMatchObject({ inboxId: "other@agentmail.to", inboxAddress: "other@agentmail.to" });
    await t.action(internal.outbox.deliver, { outboxId });
    expect(calls).toHaveLength(1);
    expect((await outboxRows(t)).map((r) => r.status)).toEqual(["sent"]);
  });

  it("an unknown row stays unknown even when authority is gone", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(503, { error: "upstream" }))]);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect((await outboxRows(t))[0].status).toBe("unknown");
    await removeMembership(t, s.innId, s.owner.userId);
    await t.action(internal.outbox.deliver, { outboxId });
    expect((await outboxRows(t))[0]).toMatchObject({ status: "unknown", errorKind: "agentmail_http" });
    expect(calls).toHaveLength(1);
  });

  it("a simulated reservation is still turned away before the authority check and left untouched", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([]);
    const outboxId = await t.run((ctx) =>
      ctx.db.insert("outbox", {
        innId: s.innId,
        threadId: s.threadId,
        kind: "reply",
        draftId: s.draftId,
        replyToMessageId: s.messageId,
        text: ANSWER,
        textSource: "model",
        reservedBy: s.owner.userId,
        reservedAt: Date.now(),
        status: "reserved",
        simulated: true,
      }),
    );
    await removeMembership(t, s.innId, s.owner.userId);
    const begin = await t.mutation(internal.outbox.beginSend, { outboxId });
    expect(begin).toEqual({ ok: false, reason: "simulated rows never dispatch" });
    expect((await outboxRows(t))[0]).toMatchObject({ status: "reserved", simulated: true });
    expect((await outboxRows(t))[0].errorKind).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("live authority is rechecked at dispatch (correction)", () => {
  /** A delivered $25 reply, then a $40 page change with a staff-written, approved correction. */
  async function approvedCorrection(t: T) {
    const s = await liveSetup(t);
    stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    await settle(t);
    vi.unstubAllGlobals();
    expect(await sentReplies(t)).toHaveLength(1);
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V40 });
    const [c] = await corrections(t);
    await s.owner.as.mutation(api.corrections.setText, { correctionId: c._id, proposedText: CORRECTION_TEXT, evidenceQuote: "$40 per night pet fee" });
    await s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve" });
    expect((await corrections(t))[0].status).toBe("approved");
    return { ...s, correctionId: c._id };
  }

  it("membership removed after reserving a correction: nothing is sent, the correction stays approved", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await approvedCorrection(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const { outboxId } = await s.owner.as.mutation(api.corrections.send, { correctionId: s.correctionId });
    await removeMembership(t, s.innId, s.owner.userId);
    await t.action(internal.outbox.deliver, { outboxId });
    await settle(t);
    const row = (await outboxRows(t)).find((r) => r._id === outboxId)!;
    expect(row).toMatchObject({ kind: "correction", status: "failed", errorKind: "precondition" });
    expect(row.errorMessage).toMatch(/no_membership/);
    expect(calls).toEqual([]);
    expect((await sentReplies(t)).map((r) => r.kind)).toEqual(["reply"]);
    expect((await corrections(t))[0].status).toBe("approved");
  });

  it("inbox rebound after reserving a correction is refused", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await approvedCorrection(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const { outboxId } = await s.owner.as.mutation(api.corrections.send, { correctionId: s.correctionId });
    await t.run((ctx) => ctx.db.patch(s.innId, { inboxId: "other@agentmail.to", inboxAddress: "other@agentmail.to" }));
    await t.action(internal.outbox.deliver, { outboxId });
    await settle(t);
    const row = (await outboxRows(t)).find((r) => r._id === outboxId)!;
    expect(row).toMatchObject({ status: "failed", errorKind: "precondition" });
    expect(row.errorMessage).toMatch(/inbox changed/);
    expect(calls).toEqual([]);
    expect((await sentReplies(t)).map((r) => r.kind)).toEqual(["reply"]);
  });

  it("owner demoted to staff after reserving a correction still sends it exactly once", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await approvedCorrection(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_corr_out" }))]);
    const { outboxId } = await s.owner.as.mutation(api.corrections.send, { correctionId: s.correctionId });
    await setRole(t, s.innId, s.owner.userId, "staff");
    await t.action(internal.outbox.deliver, { outboxId });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ text: CORRECTION_TEXT });
    expect((await outboxRows(t)).find((r) => r._id === outboxId)).toMatchObject({ status: "sent", sentProviderMessageId: "msg_corr_out" });
    expect((await sentReplies(t)).map((r) => r.kind)).toEqual(["reply", "correction"]);
    expect((await corrections(t))[0].status).toBe("sent");
  });
});
