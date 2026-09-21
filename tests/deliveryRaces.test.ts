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

const V1 = "# Policies\n\nDogs are welcome for a $25 per night pet fee.\n\nCheck-in is from 3:00 PM.\n";
const V2 = "# Policies\n\nDogs are welcome for a $40 per night pet fee, limited to one dog per room.\n\nCheck-in is from 3:00 PM.\n";
const V2_PLUS = V2 + "\nQuiet hours start at 10:00 PM.\n";
const V3 = "# Policies\n\nSorry, no pets at all.\n\nCheck-in is from 3:00 PM.\n";
const ANSWER = "Yes! Dogs are welcome for a $25 per night pet fee.";

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
    const claimId = await ctx.db.insert("claims", {
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
    return { draftId, claimId };
  });
}

async function liveSetup(t: T) {
  const owner = await signedInUser(t, { name: "Owner" });
  const inn = await seedLiveInn(t, owner.userId, { markdown: V1 });
  const { threadId, messageId } = await seedInboundThread(t, inn.innId, { providerMessageId: "msg_in_1" });
  const { draftId, claimId } = await seedReadyDraft(t, threadId, messageId, inn.pageId, inn.versionId);
  await owner.as.mutation(api.threads.claim, { threadId });
  return { owner, ...inn, threadId, messageId, draftId, claimId };
}

const outboxRows = (t: T) => t.run((ctx) => ctx.db.query("outbox").collect());
const sentReplies = (t: T) => t.run((ctx) => ctx.db.query("sentReplies").collect());
const corrections = (t: T) => t.run((ctx) => ctx.db.query("corrections").collect());

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

describe("provider accepted, local commit failed", () => {
  it("leaves the row unknown with the provider id and never resends", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    // While the provider call is in flight the draft row disappears, so the
    // commit mutation throws after AgentMail has already accepted the message.
    const { calls } = stubFetch([
      agentmailReplyRoute(async () => {
        await t.run((ctx) => ctx.db.delete(s.draftId));
        return json(200, { message_id: "msg_out_1", thread_id: "thr_1" });
      }),
    ]);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    await settle(t);
    expect(calls).toHaveLength(1);
    const [row] = await outboxRows(t);
    expect(row).toMatchObject({ _id: outboxId, status: "unknown", errorKind: "commit_failed", sentProviderMessageId: "msg_out_1" });
    expect(row.errorMessage).toMatch(/not retried/);
    // Nothing of the failed commit persisted, and the thread was not advanced.
    expect(await sentReplies(t)).toEqual([]);
    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages.filter((m) => m.direction === "out")).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(s.threadId)))?.status).toBe("ready");
    // A second delivery attempt on the same reservation never reaches the provider.
    await t.action(internal.outbox.deliver, { outboxId });
    expect(calls).toHaveLength(1);
    expect((await outboxRows(t))[0].status).toBe("unknown");
  });

  it("a provider rejection is still a definite failure that allows a retry", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(422, { error: "bad" }))]);
    await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    await settle(t);
    expect(calls).toHaveLength(1);
    const [row] = await outboxRows(t);
    expect(row).toMatchObject({ status: "failed", errorKind: "agentmail_http" });
    expect(row.sentProviderMessageId).toBeUndefined();
  });
});

describe("inbound arrives while the reply is in flight", () => {
  it("records the delivery but leaves the newer turn's thread state and follow-ups alone", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    await t.run((ctx) => ctx.db.patch(s.threadId, { stay: { checkIn: "2026-10-09", checkOut: "2026-10-11", party: 2, status: "inquiry" } }));
    const answeredAt = (await t.run((ctx) => ctx.db.get(s.messageId)))!.at;
    stubFetch([]);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    const begin = await t.mutation(internal.outbox.beginSend, { outboxId });
    expect(begin.ok).toBe(true);

    // The guest writes again while AgentMail is still working on the reply.
    await new Promise((r) => setTimeout(r, 5));
    await t.mutation(internal.inbound.receive, receiveArgs("msg_in_2", "Actually two dogs."));
    const mid = (await t.run((ctx) => ctx.db.get(s.threadId)))!;
    expect(mid.status).toBe("drafting");
    expect(mid.lastInboundMessageId).not.toBe(s.messageId);

    await t.mutation(internal.outbox.commit, { outboxId, providerMessageId: "msg_out_1", providerThreadId: "thr_1" });
    const after = (await t.run((ctx) => ctx.db.get(s.threadId)))!;
    // Historical record of the send is complete...
    expect((await outboxRows(t))[0]).toMatchObject({ status: "sent", sentProviderMessageId: "msg_out_1" });
    const replies = await sentReplies(t);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: ANSWER, kind: "reply", outboxId });
    expect((await t.run((ctx) => ctx.db.get(s.draftId)))?.status).toBe("sent");
    // ...but the thread still belongs to the newer inbound and no reminder was recreated.
    expect(after.status).toBe("drafting");
    expect(after.lastInboundMessageId).toBe(mid.lastInboundMessageId);
    expect(await t.run((ctx) => ctx.db.query("followUps").collect())).toEqual([]);
    // First-response time is measured against the inbound that was answered.
    expect(after.firstResponseMs).toBeTypeOf("number");
    expect(after.firstResponseMs!).toBeGreaterThanOrEqual(after.lastInboundAt - answeredAt);
  });

  it("without a newer inbound the thread advances and the inquiry follow-up is scheduled", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await liveSetup(t);
    await t.run((ctx) => ctx.db.patch(s.threadId, { stay: { checkIn: "2026-10-09", checkOut: "2026-10-11", party: 2, status: "inquiry" } }));
    stubFetch([]);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    await t.mutation(internal.outbox.beginSend, { outboxId });
    await t.mutation(internal.outbox.commit, { outboxId, providerMessageId: "msg_out_1" });
    expect((await t.run((ctx) => ctx.db.get(s.threadId)))?.status).toBe("waiting_guest");
    expect((await t.run((ctx) => ctx.db.query("followUps").collect())).map((f) => f.status)).toEqual(["scheduled"]);
  });
});

describe("cited page changes while the provider call is in flight", () => {
  it("a reply is recorded as sent and its claim is reviewed against the current page at once", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await liveSetup(t);
    const { calls } = stubFetch([]);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    const begin = await t.mutation(internal.outbox.beginSend, { outboxId });
    expect(begin.ok).toBe(true);

    // The crawler stores a new version mid-flight; the claim has no sent reply yet, so it is not counted.
    const changed = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    expect(changed).toMatchObject({ changeStatus: "changed", affected: 0, unaffected: 0 });
    expect(await corrections(t)).toEqual([]);

    await t.mutation(internal.outbox.commit, { outboxId, providerMessageId: "msg_out_1" });
    expect((await outboxRows(t))[0]).toMatchObject({ status: "sent", sentProviderMessageId: "msg_out_1" });
    expect(await sentReplies(t)).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(s.threadId)))?.status).toBe("waiting_guest");
    // The sent claim is flagged against the version that is current now, without a new page version.
    const claim = (await t.run((ctx) => ctx.db.get(s.claimId)))!;
    expect(claim).toMatchObject({ status: "needs_review", checkedAgainstVersionId: changed.pageVersionId });
    expect(await t.run((ctx) => ctx.db.query("pageVersions").collect())).toHaveLength(2);
    const [c] = await corrections(t);
    expect(c).toMatchObject({
      claimId: s.claimId,
      status: "needs_review",
      oldQuote: "$25 per night pet fee",
      oldVersionId: s.versionId,
      newVersionId: changed.pageVersionId,
    });
    expect(c.newPassage).toContain("$40 per night pet fee");
    // The proposal was scheduled (no key → honest reason), and nothing else went to the provider.
    await settle(t);
    expect((await corrections(t))[0].statusReason).toMatch(/OPENAI_API_KEY/);
    await t.action(internal.outbox.deliver, { outboxId });
    expect(calls).toEqual([]);
    expect(await sentReplies(t)).toHaveLength(1);
  });

  it("a correction superseded mid-flight is still recorded as sent and the newer flag is kept", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await liveSetup(t);
    // The original reply went out against V1.
    stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    await settle(t);
    vi.unstubAllGlobals();
    // V2 flags it; staff write a correction resting on the $40 passage and approve it.
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    const [c1] = await corrections(t);
    await s.owner.as.mutation(api.corrections.setText, { correctionId: c1._id, proposedText: "Our pet fee is now $40 per night.", evidenceQuote: "$40 per night pet fee" });
    await s.owner.as.mutation(api.corrections.review, { correctionId: c1._id, decision: "approve" });
    const { calls } = stubFetch([]);
    const { outboxId } = await s.owner.as.mutation(api.corrections.send, { correctionId: c1._id });
    expect((await t.mutation(internal.outbox.beginSend, { outboxId })).ok).toBe(true);

    // The page changes again (no pets) while the correction is with the provider.
    const third = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V3 });
    expect(third.affected).toBe(1);
    let rows = await corrections(t);
    expect(rows.find((c) => c._id === c1._id)?.status).toBe("superseded");
    const cMid = rows.find((c) => c.status === "needs_review")!;
    expect(cMid.oldQuote).toBe("$25 per night pet fee");

    await t.mutation(internal.outbox.commit, { outboxId, providerMessageId: "msg_corr_out" });
    rows = await corrections(t);
    // History: the correction was sent and says so; the guest was told $40.
    const sentC1 = rows.find((c) => c._id === c1._id)!;
    expect(sentC1.status).toBe("sent");
    expect(sentC1.supersededById).toBeUndefined();
    const replies = await sentReplies(t);
    expect(replies.map((r) => r.kind)).toEqual(["reply", "correction"]);
    expect(replies[1]).toMatchObject({ correctionId: c1._id, text: "Our pet fee is now $40 per night." });
    // Current truth: $40 is gone from the page, so the claim stays under review with a
    // single open proposal that starts from what the guest last heard, not from $25.
    expect((await t.run((ctx) => ctx.db.get(s.claimId)))).toMatchObject({ status: "needs_review", checkedAgainstVersionId: third.pageVersionId });
    const open = rows.filter((c) => c.status === "needs_review");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ oldQuote: "$40 per night pet fee", newVersionId: third.pageVersionId });
    expect(rows.find((c) => c._id === cMid._id)).toMatchObject({ status: "superseded", supersededById: open[0]._id });
    expect(await t.run((ctx) => ctx.db.query("pageVersions").collect())).toHaveLength(3);
    // No further provider attempts.
    await t.action(internal.outbox.deliver, { outboxId });
    expect(calls).toEqual([]);
    expect(await sentReplies(t)).toHaveLength(2);
  });

  it("a correction whose evidence survives the mid-flight change leaves the claim corrected and current", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await liveSetup(t);
    stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
    await settle(t);
    vi.unstubAllGlobals();
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    const [c1] = await corrections(t);
    await s.owner.as.mutation(api.corrections.setText, { correctionId: c1._id, proposedText: "Our pet fee is now $40 per night.", evidenceQuote: "$40 per night pet fee" });
    await s.owner.as.mutation(api.corrections.review, { correctionId: c1._id, decision: "approve" });
    stubFetch([]);
    const { outboxId } = await s.owner.as.mutation(api.corrections.send, { correctionId: c1._id });
    await t.mutation(internal.outbox.beginSend, { outboxId });
    // An unrelated line is added: $40 still stands, but the correction was approved against V2.
    const plus = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2_PLUS });
    expect(plus.affected).toBe(1); // the sent reply's $25 is still gone; c1 (approved) is superseded by a new proposal
    await t.mutation(internal.outbox.commit, { outboxId, providerMessageId: "msg_corr_out" });
    const rows = await corrections(t);
    expect(rows.find((c) => c._id === c1._id)?.status).toBe("sent");
    expect(rows.filter((c) => c.status === "needs_review" || c.status === "approved")).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(s.claimId))).toMatchObject({ status: "corrected", checkedAgainstVersionId: plus.pageVersionId });
    // Paginated contract: one page covers this inn; only control rows may appear.
    const controls = await s.owner.as.query(api.corrections.unaffectedControls, { innId: s.innId, paginationOpts: { cursor: null, numItems: 25 } });
    expect(controls.isDone).toBe(true);
    expect(controls.page.map((c) => (c.kind === "control" ? c.quote : c.kind))).toEqual(["$40 per night pet fee"]);
  });
});
