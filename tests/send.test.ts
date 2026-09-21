import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { decideDraftSend } from "../convex/lib/sendGuards";
import { makeTest, signedInUser } from "./setup";
import { agentmailReplyRoute, json, seedInboundThread, seedLiveInn, settle, stubFetch, withEnv } from "./integrationSetup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type T = ReturnType<typeof makeTest>;

const ANSWER = "Yes! Dogs are welcome for a $25 per night pet fee.";

/** A verified, ready draft citing the inn's policies page, exactly as generation would leave it. */
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

async function liveSetup(t: T, opts: { inboxId?: string } = {}) {
  const owner = await signedInUser(t, { name: "Owner" });
  const inn = await seedLiveInn(t, owner.userId, opts);
  const { threadId, messageId } = await seedInboundThread(t, inn.innId, { providerMessageId: "msg_in_1" });
  const draftId = await seedReadyDraft(t, threadId, messageId, inn.pageId, inn.versionId);
  return { owner, ...inn, threadId, messageId, draftId };
}

const outboxRows = (t: T) => t.run((ctx) => ctx.db.query("outbox").collect());

/**
 * Move the seeded inbound turn into the past so a follow-up inbound stamped with
 * Date.now() is strictly newer. Thread and message timestamps stay in sync.
 */
async function backdateInbound(t: T, threadId: Id<"threads">, messageId: Id<"messages">, ms = 60_000) {
  const at = Date.now() - ms;
  await t.run(async (ctx) => {
    await ctx.db.patch(threadId, { lastInboundAt: at });
    await ctx.db.patch(messageId, { at });
  });
}

describe("send guards (pure)", () => {
  const base = {
    actor: "u1" as Id<"users">,
    now: 1_000_000,
    thread: { claimedBy: "u1" as Id<"users">, claimedAt: 900_000, lastInboundMessageId: "m1" as Id<"messages"> },
    draft: { status: "ready" as const, answer: "a", verifiedText: "a", textSource: "model" as const, replyToMessageId: "m1" as Id<"messages"> },
    staffAuthored: false,
    sourcesCurrent: true,
    priorSent: false,
    outboxStatuses: [] as ("reserved" | "sending" | "sent" | "failed" | "unknown")[],
  };
  it("orders the refusals: claim, already sent, in flight, stale inbound, stale source, verification", () => {
    expect(decideDraftSend(base)).toEqual({ ok: true, textSource: "model" });
    expect(decideDraftSend({ ...base, thread: { ...base.thread, claimedBy: "u2" as Id<"users"> } })).toEqual({ ok: false, reason: "claimed" });
    expect(decideDraftSend({ ...base, thread: { ...base.thread, claimedAt: 0 } })).toEqual({ ok: false, reason: "claimed" });
    expect(decideDraftSend({ ...base, priorSent: true })).toEqual({ ok: false, reason: "already_sent" });
    expect(decideDraftSend({ ...base, draft: { ...base.draft, status: "sent" } })).toEqual({ ok: false, reason: "already_sent" });
    expect(decideDraftSend({ ...base, outboxStatuses: ["failed"] })).toEqual({ ok: true, textSource: "model" });
    expect(decideDraftSend({ ...base, outboxStatuses: ["failed", "unknown"] })).toEqual({ ok: false, reason: "in_flight" });
    expect(decideDraftSend({ ...base, outboxStatuses: ["reserved"] })).toEqual({ ok: false, reason: "in_flight" });
    expect(decideDraftSend({ ...base, thread: { ...base.thread, lastInboundMessageId: "m2" as Id<"messages"> } })).toEqual({ ok: false, reason: "stale_inbound" });
    expect(decideDraftSend({ ...base, draft: { ...base.draft, replyToMessageId: undefined } })).toEqual({ ok: false, reason: "no_reply_target" });
    expect(decideDraftSend({ ...base, sourcesCurrent: false })).toEqual({ ok: false, reason: "stale_source" });
    expect(decideDraftSend({ ...base, draft: { ...base.draft, verifiedText: "b" } })).toEqual({ ok: false, reason: "unverified_edit" });
    expect(decideDraftSend({ ...base, draft: { ...base.draft, status: "needs_edit", verifiedText: undefined, textSource: "staff" } })).toEqual({ ok: false, reason: "unverified_edit" });
    expect(decideDraftSend({ ...base, staffAuthored: true, draft: { ...base.draft, status: "needs_edit", verifiedText: undefined, textSource: "staff" } })).toEqual({ ok: true, textSource: "staff" });
    expect(decideDraftSend({ ...base, staffAuthored: true, draft: { ...base.draft, status: "needs_edit", verifiedText: undefined, textSource: "model" } })).toEqual({ ok: false, reason: "not_ready" });
    expect(decideDraftSend({ ...base, draft: { ...base.draft, status: "verifying" } })).toEqual({ ok: false, reason: "not_ready" });
  });
});

describe("live send authority", () => {
  it("denies anonymous visitors, non-members, and demo inns", async () => {
    const t = makeTest();
    const { owner, draftId, threadId } = await liveSetup(t);
    await owner.as.mutation(api.threads.claim, { threadId });

    await expect(t.mutation(api.drafts.send, { draftId })).rejects.toThrow(/unauthenticated/);
    const stranger = await signedInUser(t, { name: "Stranger" });
    await expect(stranger.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/forbidden/);
    expect(await outboxRows(t)).toEqual([]);

    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    const demoInn = await visitor.as.mutation(api.demo.enter, {});
    const [ready] = await visitor.as.query(api.threads.queue, { innId: demoInn, status: "ready" });
    await visitor.as.mutation(api.threads.claim, { threadId: ready._id });
    const detail = await visitor.as.query(api.threads.get, { threadId: ready._id });
    await expect(visitor.as.mutation(api.drafts.send, { draftId: detail.draft!._id })).rejects.toThrow(/live_mail_forbidden/);
    expect(await outboxRows(t)).toEqual([]);
  });

  it("an anonymous member of a real inn cannot send live mail", async () => {
    const t = makeTest();
    const { innId, draftId, threadId } = await liveSetup(t);
    const anon = await signedInUser(t, { name: "Anon", isAnonymous: true });
    await t.run((ctx) => ctx.db.insert("memberships", { innId, userId: anon.userId, role: "staff", name: "Anon" }));
    await anon.as.mutation(api.threads.claim, { threadId });
    await expect(anon.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/live_mail_forbidden/);
    expect(await outboxRows(t)).toEqual([]);
  });

  it("requires an active claim by the sender and a bound inbox", async () => {
    const t = makeTest();
    const { owner, draftId, threadId, innId } = await liveSetup(t);
    await expect(owner.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/claimed/);
    const staff = await signedInUser(t, { name: "Staff" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId, userId: staff.userId, role: "staff", name: "Staff" }));
    await staff.as.mutation(api.threads.claim, { threadId });
    await expect(owner.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/claimed/);

    const t2 = makeTest();
    const s2 = await liveSetup(t2);
    await t2.run((ctx) => ctx.db.patch(s2.innId, { inboxId: undefined, inboxAddress: undefined }));
    await s2.owner.as.mutation(api.threads.claim, { threadId: s2.threadId });
    await expect(s2.owner.as.mutation(api.drafts.send, { draftId: s2.draftId })).rejects.toThrow(/inbox_not_configured/);
    expect(await outboxRows(t2)).toEqual([]);
  });
});

describe("outbox delivery", () => {
  it("reserves, delivers through AgentMail with the immutable text, and records the sent reply", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const { owner, draftId, threadId, messageId, innId } = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1", thread_id: "thr_1" }))]);
    await owner.as.mutation(api.threads.claim, { threadId });
    const { outboxId } = await owner.as.mutation(api.drafts.send, { draftId });
    const [row] = await outboxRows(t);
    expect(row).toMatchObject({ _id: outboxId, status: "reserved", text: ANSWER, textSource: "model", simulated: false, providerMessageId: "msg_in_1", replyToMessageId: messageId });

    await settle(t);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.agentmail.to/v0/inboxes/seagull%40agentmail.to/messages/msg_in_1/reply");
    expect(calls[0].body).toEqual({ text: ANSWER });
    expect(calls[0].headers?.Authorization).toBe("Bearer am-test");

    const detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.thread.status).toBe("waiting_guest");
    expect((await t.run((ctx) => ctx.db.get(threadId)))?.firstResponseMs).toBeTypeOf("number");
    expect(detail.draft?.status).toBe("sent");
    expect(detail.outbox[0]).toMatchObject({ status: "sent", simulated: false });
    expect((await outboxRows(t))[0]).toMatchObject({ status: "sent", sentProviderMessageId: "msg_out_1" });
    expect(detail.sentReplies).toHaveLength(1);
    expect(detail.sentReplies[0]).toMatchObject({ text: ANSWER, textSource: "model", simulated: false, outboxId, kind: "reply" });
    expect(detail.messages.filter((m) => m.direction === "out")).toHaveLength(1);
    expect(detail.messages.find((m) => m.direction === "out")?.text).toBe(ANSWER);
    const stats = await owner.as.query(api.threads.stats, { innId });
    expect(stats).toMatchObject({ sentTotal: 1, sentToday: 1, waitingGuest: 1 });
    expect(stats.medianFirstResponseMs).toBeTypeOf("number");

    // A second send of the same draft is refused and nothing else reaches the provider.
    await expect(owner.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/already_sent/);
    await expect(owner.as.mutation(api.drafts.edit, { draftId, answer: "x" })).rejects.toThrow(/invalid/);
    expect(calls).toHaveLength(1);
  });

  it("schedules a follow-up only for stay inquiries and cancels it on the next inbound", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const { owner, draftId, threadId, messageId } = await liveSetup(t);
    await backdateInbound(t, threadId, messageId);
    await t.run((ctx) => ctx.db.patch(threadId, { stay: { checkIn: "2026-10-09", checkOut: "2026-10-11", party: 2, status: "inquiry" } }));
    stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    await owner.as.mutation(api.threads.claim, { threadId });
    await owner.as.mutation(api.drafts.send, { draftId });
    await settle(t);
    let detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.followUp).toMatchObject({ status: "scheduled" });
    expect(detail.followUp!.dueAt).toBeGreaterThan(Date.now() + 47 * 3600 * 1000);

    await t.mutation(internal.inbound.receive, {
      inboxId: "seagull@agentmail.to",
      eventId: "evt_2",
      providerMessageId: "msg_in_2",
      providerThreadId: "thr_1",
      from: "guest@example.com",
      to: "seagull@agentmail.to",
      subject: "Re: Dog?",
      text: "Great, booking now.",
      receivedAt: Date.now(),
    });
    detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.followUp).toBeNull();
    expect((await t.run((ctx) => ctx.db.query("followUps").collect()))[0].status).toBe("cancelled");
  });

  it("concurrent duplicate sends produce exactly one reservation and one provider call", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const { owner, draftId, threadId } = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    await owner.as.mutation(api.threads.claim, { threadId });
    const results = await Promise.allSettled([
      owner.as.mutation(api.drafts.send, { draftId }),
      owner.as.mutation(api.drafts.send, { draftId }),
      owner.as.mutation(api.drafts.send, { draftId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toMatch(/in_flight|already_sent/);
    await settle(t);
    expect(await outboxRows(t)).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("sentReplies").collect())).toHaveLength(1);
  });

  it("delivering the same reservation twice never sends twice", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const { owner, draftId, threadId } = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    await owner.as.mutation(api.threads.claim, { threadId });
    const { outboxId } = await owner.as.mutation(api.drafts.send, { draftId });
    await Promise.all([t.action(internal.outbox.deliver, { outboxId }), t.action(internal.outbox.deliver, { outboxId })]);
    await settle(t);
    expect(calls).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("sentReplies").collect())).toHaveLength(1);
  });

  it("ambiguous provider failures (5xx, timeout, bodyless 2xx) leave the row unknown and are never retried", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    for (const respond of [
      () => json(503, { error: "down" }),
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    ]) {
      const t = makeTest();
      const { owner, draftId, threadId } = await liveSetup(t);
      const { calls } = stubFetch([agentmailReplyRoute(respond)]);
      await owner.as.mutation(api.threads.claim, { threadId });
      const { outboxId } = await owner.as.mutation(api.drafts.send, { draftId });
      await settle(t);
      await t.action(internal.outbox.deliver, { outboxId });
      const [row] = await outboxRows(t);
      expect(row.status).toBe("unknown");
      expect(row.errorMessage).toMatch(/not retried/);
      expect(calls).toHaveLength(1);
      const detail = await owner.as.query(api.threads.get, { threadId });
      expect(detail.draft?.status).toBe("ready");
      expect(detail.sentReplies).toEqual([]);
      // Staff cannot fire a second send while delivery is unknown.
      await expect(owner.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/in_flight/);
      expect(calls).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it("a definite 4xx marks the reservation failed and allows a deliberate retry", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const { owner, draftId, threadId } = await liveSetup(t);
    let attempts = 0;
    const { calls } = stubFetch([
      agentmailReplyRoute(() => {
        attempts += 1;
        return attempts === 1 ? json(422, { error: "bad" }) : json(200, { message_id: "msg_out_2" });
      }),
    ]);
    await owner.as.mutation(api.threads.claim, { threadId });
    await owner.as.mutation(api.drafts.send, { draftId });
    await settle(t);
    let rows = await outboxRows(t);
    expect(rows[0]).toMatchObject({ status: "failed", errorKind: "agentmail_http" });
    expect(rows[0].errorMessage).not.toContain("bad");
    await owner.as.mutation(api.drafts.send, { draftId });
    await settle(t);
    rows = await outboxRows(t);
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "sent"]);
    expect(calls).toHaveLength(2);
    expect((await owner.as.query(api.threads.get, { threadId })).sentReplies).toHaveLength(1);
  });

  it("fails cleanly with nothing sent when AGENTMAIL_API_KEY is missing", async () => {
    withEnv({ AGENTMAIL_API_KEY: undefined });
    const t = makeTest();
    const { owner, draftId, threadId } = await liveSetup(t);
    const { calls } = stubFetch([]);
    await owner.as.mutation(api.threads.claim, { threadId });
    await owner.as.mutation(api.drafts.send, { draftId });
    await settle(t);
    const [row] = await outboxRows(t);
    expect(row).toMatchObject({ status: "failed", errorKind: "agentmail_unavailable" });
    expect(calls).toEqual([]);
  });
});

describe("send preconditions", () => {
  it("a changed cited page blocks the send and a newer inbound makes the draft stale", async () => {
    const t = makeTest();
    const { owner, draftId, threadId, pageId } = await liveSetup(t);
    await owner.as.mutation(api.threads.claim, { threadId });
    await t.run(async (ctx) => {
      const v2 = await ctx.db.insert("pageVersions", { pageId, markdown: "# Policies\n\nNo pets.\n", hash: "h2", scrapedAt: Date.now(), changeStatus: "changed" });
      await ctx.db.patch(pageId, { lastVersionId: v2 });
    });
    await expect(owner.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/stale_source/);
    let detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.claims[0].currentSource).toBe(false);

    const t2 = makeTest();
    const s = await liveSetup(t2);
    await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
    await backdateInbound(t2, s.threadId, s.messageId);
    await t2.mutation(internal.inbound.receive, {
      inboxId: "seagull@agentmail.to",
      eventId: "evt_9",
      providerMessageId: "msg_in_9",
      providerThreadId: "thr_1",
      from: "guest@example.com",
      to: "seagull@agentmail.to",
      subject: "Re: Dog?",
      text: "Actually two dogs.",
      receivedAt: Date.now(),
    });
    await expect(s.owner.as.mutation(api.drafts.send, { draftId: s.draftId })).rejects.toThrow(/stale_inbound|already_sent|not_ready/);
    detail = await s.owner.as.query(api.threads.get, { threadId: s.threadId });
    expect((await t2.run((ctx) => ctx.db.get(s.draftId)))?.status).toBe("superseded");
    expect(await outboxRows(t2)).toEqual([]);
  });

  it("preflight refuses dispatch when the claim, inbound, or page changed after reservation", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const cases: { name: string; mutate: (t: T, s: Awaited<ReturnType<typeof liveSetup>>) => Promise<void>; expect: RegExp }[] = [
      {
        name: "claim lost",
        mutate: (t, s) => t.run((ctx) => ctx.db.patch(s.threadId, { claimedBy: undefined, claimedAt: undefined })),
        expect: /claim expired/,
      },
      {
        name: "newer inbound",
        mutate: async (t, s) => {
          await t.run(async (ctx) => {
            const m = await ctx.db.insert("messages", { threadId: s.threadId, direction: "in", from: "g", to: "i", text: "more", at: Date.now() });
            await ctx.db.patch(s.threadId, { lastInboundMessageId: m });
          });
        },
        expect: /newer guest message/,
      },
      {
        name: "page changed",
        mutate: async (t, s) => {
          await t.run(async (ctx) => {
            const v2 = await ctx.db.insert("pageVersions", { pageId: s.pageId, markdown: "changed", hash: "h2", scrapedAt: Date.now(), changeStatus: "changed" });
            await ctx.db.patch(s.pageId, { lastVersionId: v2 });
          });
        },
        expect: /cited page changed/,
      },
      {
        name: "text tampered",
        mutate: (t, s) => t.run((ctx) => ctx.db.patch(s.draftId, { answer: "tampered" })),
        expect: /text changed/,
      },
    ];
    for (const c of cases) {
      const t = makeTest();
      const s = await liveSetup(t);
      const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "x" }))]);
      await s.owner.as.mutation(api.threads.claim, { threadId: s.threadId });
      const { outboxId } = await s.owner.as.mutation(api.drafts.send, { draftId: s.draftId });
      await c.mutate(t, s);
      await t.action(internal.outbox.deliver, { outboxId });
      await settle(t);
      const [row] = await outboxRows(t);
      expect(row.status, c.name).toBe("failed");
      expect(row.errorKind, c.name).toBe("precondition");
      expect(row.errorMessage, c.name).toMatch(c.expect);
      expect(calls, c.name).toEqual([]);
      expect(await t.run((ctx) => ctx.db.query("sentReplies").collect()), c.name).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("editing is frozen once a reservation exists", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const { owner, draftId, threadId } = await liveSetup(t);
    stubFetch([agentmailReplyRoute(() => json(503, {}))]);
    await owner.as.mutation(api.threads.claim, { threadId });
    await owner.as.mutation(api.drafts.send, { draftId });
    await expect(owner.as.mutation(api.drafts.edit, { draftId, answer: "changed" })).rejects.toThrow(/in_flight/);
    await settle(t);
    expect((await outboxRows(t))[0].status).toBe("unknown");
    await expect(owner.as.mutation(api.drafts.edit, { draftId, answer: "changed" })).rejects.toThrow(/in_flight/);
  });

  it("a staff-authored send of an edited draft is labeled as staff text", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const { owner, draftId, threadId } = await liveSetup(t);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_out_1" }))]);
    await owner.as.mutation(api.threads.claim, { threadId });
    await owner.as.mutation(api.drafts.edit, { draftId, answer: "Custom staff wording." });
    await settle(t);
    await expect(owner.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/unverified_edit/);
    await owner.as.mutation(api.drafts.send, { draftId, staffAuthored: true });
    await settle(t);
    expect(calls[0].body).toEqual({ text: "Custom staff wording." });
    const detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.sentReplies[0]).toMatchObject({ textSource: "staff", text: "Custom staff wording." });
  });
});
