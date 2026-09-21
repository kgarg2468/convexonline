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
const ANSWER_1 = "Yes! Dogs are welcome for a $25 per night pet fee.";
const ANSWER_2 = "Of course, dogs are welcome; the pet fee is $25 per night.";

/** A verified, ready draft answering `messageId`; several may exist for one inbound after regeneration. */
async function seedReadyDraft(t: T, threadId: Id<"threads">, messageId: Id<"messages">, pageId: Id<"pages">, versionId: Id<"pageVersions">, answer: string) {
  return await t.run(async (ctx) => {
    const draftId = await ctx.db.insert("drafts", {
      threadId,
      replyToMessageId: messageId,
      class: "answerable",
      answer,
      abstain: false,
      status: "ready",
      model: "test",
      verifiedText: answer,
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

/** Two ready drafts (D1, D2) for the same guest inbound, as after a regeneration. */
async function twoDraftSetup(t: T) {
  const owner = await signedInUser(t, { name: "Owner" });
  const inn = await seedLiveInn(t, owner.userId, { markdown: V1 });
  const { threadId, messageId } = await seedInboundThread(t, inn.innId, { providerMessageId: "msg_in_1" });
  const d1 = await seedReadyDraft(t, threadId, messageId, inn.pageId, inn.versionId, ANSWER_1);
  const d2 = await seedReadyDraft(t, threadId, messageId, inn.pageId, inn.versionId, ANSWER_2);
  await owner.as.mutation(api.threads.claim, { threadId });
  return { owner, ...inn, threadId, messageId, d1, d2 };
}

const outboxRows = (t: T) => t.run((ctx) => ctx.db.query("outbox").collect());
const sentReplies = (t: T) => t.run((ctx) => ctx.db.query("sentReplies").collect());

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

describe("one guest turn, one reply: the barrier spans regenerated drafts", () => {
  it("D1 unknown (provider outcome ambiguous) → D2 for the same inbound is refused and never dispatches", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await twoDraftSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(503, { error: "upstream" }))]);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.d1 });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect((await outboxRows(t))[0]).toMatchObject({ _id: outboxId, status: "unknown" });

    await expect(s.owner.as.mutation(api.drafts.send, { draftId: s.d2 })).rejects.toThrow(/in_flight/);
    await expect(s.owner.as.mutation(api.drafts.regenerate, { threadId: s.threadId })).rejects.toThrow(/in_flight/);
    expect(await outboxRows(t)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("D1 sending → D2 for the same inbound is refused at reservation and at preflight", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await twoDraftSetup(t);
    const { calls } = stubFetch([]);
    const { outboxId: r1 } = await s.owner.as.mutation(api.drafts.send, { draftId: s.d1 });
    expect((await t.mutation(internal.outbox.beginSend, { outboxId: r1 })).ok).toBe(true);
    expect((await outboxRows(t))[0].status).toBe("sending");

    await expect(s.owner.as.mutation(api.drafts.send, { draftId: s.d2 })).rejects.toThrow(/in_flight/);
    expect(await outboxRows(t)).toHaveLength(1);

    // Preflight is independent of the reservation guard: a D2 reservation that
    // exists alongside an in-flight D1 row still fails before the provider.
    const r2 = await t.run((ctx) =>
      ctx.db.insert("outbox", {
        innId: s.innId,
        threadId: s.threadId,
        kind: "reply",
        draftId: s.d2,
        replyToMessageId: s.messageId,
        providerInboxId: "seagull@agentmail.to",
        providerMessageId: "msg_in_1",
        text: ANSWER_2,
        textSource: "model",
        reservedBy: s.owner.userId,
        reservedAt: Date.now(),
        status: "reserved",
        simulated: false,
      }),
    );
    const begin = await t.mutation(internal.outbox.beginSend, { outboxId: r2 });
    expect(begin.ok).toBe(false);
    const row2 = (await outboxRows(t)).find((r) => r._id === r2)!;
    expect(row2).toMatchObject({ status: "failed", errorKind: "precondition" });
    expect(row2.errorMessage).toMatch(/in flight/);
    // D1 is untouched by D2's failure and still commits normally.
    expect((await outboxRows(t)).find((r) => r._id === r1)?.status).toBe("sending");
    await t.mutation(internal.outbox.commit, { outboxId: r1, providerMessageId: "msg_out_1" });
    expect((await outboxRows(t)).find((r) => r._id === r1)?.status).toBe("sent");
    expect(calls).toEqual([]);
  });

  it("concurrent reservations across D1 and D2 for the same inbound yield exactly one", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await twoDraftSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    const results = await Promise.allSettled([
      s.owner.as.mutation(api.drafts.send, { draftId: s.d1 }),
      s.owner.as.mutation(api.drafts.send, { draftId: s.d2 }),
      s.owner.as.mutation(api.drafts.send, { draftId: s.d1 }),
      s.owner.as.mutation(api.drafts.send, { draftId: s.d2 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toMatch(/in_flight|already_sent/);
    await settle(t);
    expect(await outboxRows(t)).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(await sentReplies(t)).toHaveLength(1);
    // The one that won is now delivered; the other still cannot go.
    const loser = (await outboxRows(t))[0].draftId === s.d1 ? s.d2 : s.d1;
    await expect(s.owner.as.mutation(api.drafts.send, { draftId: loser })).rejects.toThrow(/already_sent/);
  });

  it("a delivered normal reply blocks every later draft for that inbound, with or without an outbox row", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await twoDraftSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    await s.owner.as.mutation(api.drafts.send, { draftId: s.d1 });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect(await sentReplies(t)).toHaveLength(1);

    await expect(s.owner.as.mutation(api.drafts.send, { draftId: s.d2 })).rejects.toThrow(/already_sent/);
    await expect(s.owner.as.mutation(api.drafts.regenerate, { threadId: s.threadId })).rejects.toThrow(/already_sent/);
    // Legacy history: a sent reply recorded without its outbox row is still a delivered turn.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("outbox").collect()) await ctx.db.delete(row._id);
    });
    await expect(s.owner.as.mutation(api.drafts.send, { draftId: s.d2 })).rejects.toThrow(/already_sent/);
    // Preflight refuses too, should a reservation somehow exist.
    const r2 = await t.run((ctx) =>
      ctx.db.insert("outbox", {
        innId: s.innId,
        threadId: s.threadId,
        kind: "reply",
        draftId: s.d2,
        replyToMessageId: s.messageId,
        providerInboxId: "seagull@agentmail.to",
        providerMessageId: "msg_in_1",
        text: ANSWER_2,
        textSource: "model",
        reservedBy: s.owner.userId,
        reservedAt: Date.now(),
        status: "reserved",
        simulated: false,
      }),
    );
    await t.action(internal.outbox.deliver, { outboxId: r2 });
    const row2 = (await outboxRows(t)).find((r) => r._id === r2)!;
    expect(row2).toMatchObject({ status: "failed", errorKind: "precondition" });
    expect(row2.errorMessage).toMatch(/already answered/);
    expect(calls).toHaveLength(1);
    expect(await sentReplies(t)).toHaveLength(1);
  });

  it("a truly newer guest inbound is eligible even though the prior turn has a historical reply", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await twoDraftSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: `msg_out_${Date.now()}` }))]);
    await s.owner.as.mutation(api.drafts.send, { draftId: s.d1 });
    await settle(t);
    expect(calls).toHaveLength(1);

    await t.mutation(internal.inbound.receive, receiveArgs("msg_in_2", "And a second dog?"));
    await settle(t);
    const thread = (await t.run((ctx) => ctx.db.get(s.threadId)))!;
    expect(thread.lastInboundMessageId).not.toBe(s.messageId);
    const d3 = await seedReadyDraft(t, s.threadId, thread.lastInboundMessageId!, s.pageId, s.versionId, "Two dogs are fine; the pet fee is $25 per night.");
    await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });

    // The old turn's drafts stay closed; the new turn sends.
    await expect(s.owner.as.mutation(api.drafts.send, { draftId: s.d2 })).rejects.toThrow(/already_sent|stale_inbound/);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: d3 });
    await settle(t);
    expect(calls).toHaveLength(2);
    expect((await outboxRows(t)).find((r) => r._id === outboxId)).toMatchObject({ status: "sent", replyToMessageId: thread.lastInboundMessageId });
    expect((await sentReplies(t)).map((r) => r.draftId)).toEqual([s.d1, d3]);
  });

  it("a definite failure on D1 leaves the turn open: D1 or D2 may retry, and regenerate is allowed", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await twoDraftSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(422, { error: "bad" }))]);
    await s.owner.as.mutation(api.drafts.send, { draftId: s.d1 });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect((await outboxRows(t))[0]).toMatchObject({ status: "failed", errorKind: "agentmail_http" });

    // Regeneration is allowed for an unanswered turn; the keyless drafter supersedes the
    // old drafts and leaves an honest needs_edit draft, so a fresh verified draft stands in.
    await s.owner.as.mutation(api.drafts.regenerate, { threadId: s.threadId });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(s.d2)))?.status).toBe("superseded");
    const d2b = await seedReadyDraft(t, s.threadId, s.messageId, s.pageId, s.versionId, ANSWER_2);
    vi.unstubAllGlobals();
    const { calls: retry } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_2" }))]);
    const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: d2b });
    await settle(t);
    expect(retry).toHaveLength(1);
    expect((await outboxRows(t)).find((r) => r._id === outboxId)).toMatchObject({ status: "sent", draftId: d2b });
    expect(await sentReplies(t)).toHaveLength(1);
    // And now the turn is closed for every other draft as well.
    await t.run((ctx) => ctx.db.patch(s.d1, { status: "ready" }));
    await expect(s.owner.as.mutation(api.drafts.send, { draftId: s.d1 })).rejects.toThrow(/already_sent/);
    await expect(s.owner.as.mutation(api.drafts.regenerate, { threadId: s.threadId })).rejects.toThrow(/already_sent/);
  });
});
