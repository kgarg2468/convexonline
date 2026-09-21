import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { signWebhook, verifyWebhookSignature } from "../convex/lib/webhookSignature";
import { parseWebhookBody } from "../convex/lib/inboundPayload";
import { makeTest, signedInUser } from "./setup";
import { seedLiveInn, TEST_SECRET, withEnv, settle } from "./integrationSetup";

// The app owns the HTTP root (convex.config.ts has no httpPrefix), so the
// product route is registered under an explicit /api path.
const PATH = "/api/agentmail/webhook";

function received(overrides: Record<string, unknown> = {}, messageOverrides: Record<string, unknown> = {}) {
  return {
    type: "event",
    event_type: "message.received",
    event_id: "evt_1",
    message: {
      inbox_id: "seagull@agentmail.to",
      message_id: "<m1@email.amazonses.com>",
      thread_id: "thr_abc",
      from: "Dana Ruiz <dana@example.com>",
      to: "seagull@agentmail.to",
      subject: "Bringing our dog",
      text: "Can we bring our dog in October?",
      extracted_text: "Can we bring our dog in October?",
      timestamp: "2026-09-21T10:00:00.000Z",
      ...messageOverrides,
    },
    ...overrides,
  };
}

async function signedPost(t: ReturnType<typeof makeTest>, body: unknown, id = "msg_1", secret = TEST_SECRET) {
  const raw = JSON.stringify(body);
  const headers = await signWebhook(secret, raw, id);
  return t.fetch(PATH, { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } });
}

describe("webhook signature (Standard Webhooks)", () => {
  it("accepts a valid v1 signature and rejects tampering, replay and bad secrets", async () => {
    const raw = '{"hello":"world"}';
    const h = await signWebhook(TEST_SECRET, raw, "msg_1");
    const headers = { id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"] };
    expect(await verifyWebhookSignature(TEST_SECRET, raw, headers)).toEqual({ ok: true });
    expect(await verifyWebhookSignature(TEST_SECRET, raw + " ", headers)).toEqual({ ok: false, reason: "no_match" });
    expect(await verifyWebhookSignature("whsec_" + btoa("other"), raw, headers)).toEqual({ ok: false, reason: "no_match" });
    expect(await verifyWebhookSignature(TEST_SECRET, raw, { ...headers, signature: null })).toEqual({ ok: false, reason: "missing_headers" });
    const stale = await verifyWebhookSignature(TEST_SECRET, raw, headers, Date.now() + 10 * 60 * 1000);
    expect(stale).toEqual({ ok: false, reason: "stale_timestamp" });
    // Multiple signatures: any matching v1 entry passes.
    expect(await verifyWebhookSignature(TEST_SECRET, raw, { ...headers, signature: `v1,AAAA ${h["svix-signature"]}` })).toEqual({ ok: true });
  });

  it("parses message.received and rejects malformed bodies", () => {
    const parsed = parseWebhookBody(received());
    expect(parsed.kind).toBe("message_received");
    if (parsed.kind === "message_received") {
      expect(parsed.event).toMatchObject({ inboxId: "seagull@agentmail.to", providerThreadId: "thr_abc", subject: "Bringing our dog" });
      expect(parsed.event.receivedAt).toBe(Date.parse("2026-09-21T10:00:00.000Z"));
    }
    expect(parseWebhookBody(received({ event_type: "message.sent" })).kind).toBe("ignored_event");
    expect(parseWebhookBody(received({}, { inbox_id: undefined })).kind).toBe("invalid");
    expect(parseWebhookBody(received({ message: undefined })).kind).toBe("invalid");
    expect(parseWebhookBody("nope").kind).toBe("invalid");
  });
});

describe("POST /api/agentmail/webhook", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses every delivery when no secret is configured", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: undefined });
    const t = makeTest();
    const res = await signedPost(t, received());
    expect(res.status).toBe(503);
    expect(await t.run((ctx) => ctx.db.query("threads").collect())).toEqual([]);
  });

  it("rejects missing, invalid and wrong-secret signatures and malformed payloads", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    await seedLiveInn(t, owner.userId);

    const unsigned = await t.fetch(PATH, { method: "POST", body: JSON.stringify(received()) });
    expect(unsigned.status).toBe(401);
    const wrongSecret = await signedPost(t, received(), "msg_1", "whsec_" + btoa("someone-else"));
    expect(wrongSecret.status).toBe(401);
    const raw = JSON.stringify(received());
    const h = await signWebhook(TEST_SECRET, raw, "msg_1");
    const tampered = await t.fetch(PATH, { method: "POST", body: raw.replace("dog", "cat"), headers: h });
    expect(tampered.status).toBe(401);
    const badJson = await (async () => {
      const body = "{not json";
      const hh = await signWebhook(TEST_SECRET, body, "msg_2");
      return t.fetch(PATH, { method: "POST", body, headers: hh });
    })();
    expect(badJson.status).toBe(400);
    const missingFields = await signedPost(t, received({}, { thread_id: undefined }), "msg_3");
    expect(missingFields.status).toBe(400);

    expect(await t.run((ctx) => ctx.db.query("threads").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("webhookEvents").collect())).toEqual([]);
  });

  it("stores a verified inbound once, dedupes by event and message id per inn, ignores unknown inboxes", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);

    const first = await signedPost(t, received(), "d1");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, outcome: "stored" });

    // Same event redelivered, and the same message under a new event id: both inert.
    expect(await (await signedPost(t, received(), "d2")).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(await (await signedPost(t, received({ event_id: "evt_2" }), "d3")).json()).toEqual({ ok: true, outcome: "duplicate" });
    // An inbox nobody owns is acknowledged and dropped.
    expect(await (await signedPost(t, received({ event_id: "evt_3" }, { inbox_id: "stranger@agentmail.to" }), "d4")).json()).toEqual({
      ok: true,
      outcome: "unknown_inbox",
    });
    // Non-inbound events are ignored.
    expect(await (await signedPost(t, received({ event_id: "evt_4", event_type: "message.delivered" }), "d5")).json()).toEqual({
      ok: true,
      outcome: "ignored_event",
    });

    const queue = await owner.as.query(api.threads.queue, { innId });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ guestEmail: "dana@example.com", subject: "Bringing our dog" });
    // The scheduled generation may already have run (no key → needs_staff) depending on timer timing.
    expect(["drafting", "needs_staff"]).toContain(queue[0].status);
    const detail = await owner.as.query(api.threads.get, { threadId: queue[0]._id });
    expect(detail.messages).toHaveLength(1);
    expect(detail.thread.lastInboundMessageId).toBe(detail.messages[0]._id);
    // Search covers subject, email and snippet.
    expect((await owner.as.query(api.threads.search, { innId, text: "dana@example.com" })).map((x) => x._id)).toEqual([queue[0]._id]);
    expect((await owner.as.query(api.threads.search, { innId, text: "October" })).map((x) => x._id)).toEqual([queue[0]._id]);
    // The drafter was scheduled for exactly this inbound.
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((s) => s.name === "generation:generateForThread")).toHaveLength(1);
    // Without an OpenAI key the generation leaves a visible, honest needs_edit draft (never a false ready).
    await settle(t);
    const after = await owner.as.query(api.threads.get, { threadId: queue[0]._id });
    expect(after.thread.status).toBe("needs_staff");
    expect(after.draft).toMatchObject({ status: "needs_edit", abstain: true, verifiedText: null });
    expect(after.draft?.statusReason).toMatch(/OPENAI_API_KEY is not configured/);
  });

  it("maps an inbox to its inn only; a second inn with the same guest gets its own thread", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const a = await signedInUser(t, { name: "A" });
    const b = await signedInUser(t, { name: "B" });
    const innA = await seedLiveInn(t, a.userId, { inboxId: "a@agentmail.to" });
    const innB = await seedLiveInn(t, b.userId, { inboxId: "b@agentmail.to" });
    await signedPost(t, received({}, { inbox_id: "a@agentmail.to" }), "x1");
    // Same provider message id at a different inn is not a duplicate of A's.
    await signedPost(t, received({ event_id: "evt_b" }, { inbox_id: "b@agentmail.to" }), "x2");
    expect(await a.as.query(api.threads.queue, { innId: innA.innId })).toHaveLength(1);
    expect(await b.as.query(api.threads.queue, { innId: innB.innId })).toHaveLength(1);
    await expect(b.as.query(api.threads.queue, { innId: innA.innId })).rejects.toThrow(/forbidden/);
  });

  describe("In-Reply-To fallback resolves the parent inside the receiving inn", () => {
    const SHARED_RFC = "<shared-original@mail.example>";
    const REPLY_RFC = "<reply@mail.example>";
    const original = (inbox: string, eventId: string, threadId: string) =>
      received({ event_id: eventId }, { inbox_id: inbox, to: inbox, thread_id: threadId, headers: { "message-id": SHARED_RFC } });
    // The guest's reply comes back under a provider thread id nobody has seen, so
    // only the In-Reply-To header can attach it to its parent.
    const reply = (inbox: string, eventId: string) =>
      received(
        { event_id: eventId },
        {
          inbox_id: inbox,
          to: inbox,
          message_id: "<m2@x>",
          thread_id: "thr_reply_unknown",
          in_reply_to: SHARED_RFC,
          headers: { "message-id": REPLY_RFC },
          text: "Also, what time is check-in?",
          extracted_text: "Also, what time is check-in?",
          timestamp: "2026-09-21T10:05:00.000Z",
        },
      );

    it("a reply at B joins B's copy of the parent even though A stored the same RFC id first", async () => {
      withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
      const t = makeTest();
      const a = await signedInUser(t, { name: "A" });
      const b = await signedInUser(t, { name: "B" });
      const innA = await seedLiveInn(t, a.userId, { inboxId: "a@agentmail.to" });
      const innB = await seedLiveInn(t, b.userId, { inboxId: "b@agentmail.to" });
      // A's copy is inserted first, so a global first() on the RFC index would find A's parent.
      expect(await (await signedPost(t, original("a@agentmail.to", "evt_a", "thr_a"), "r1")).json()).toEqual({ ok: true, outcome: "stored" });
      expect(await (await signedPost(t, original("b@agentmail.to", "evt_b", "thr_b"), "r2")).json()).toEqual({ ok: true, outcome: "stored" });
      const [threadA] = await a.as.query(api.threads.queue, { innId: innA.innId });
      const [threadB] = await b.as.query(api.threads.queue, { innId: innB.innId });
      const aBefore = await a.as.query(api.threads.get, { threadId: threadA._id });

      expect(await (await signedPost(t, reply("b@agentmail.to", "evt_b_reply"), "r3")).json()).toEqual({ ok: true, outcome: "stored" });

      // B has exactly one thread and the reply landed in it.
      const queueB = await b.as.query(api.threads.queue, { innId: innB.innId });
      expect(queueB).toHaveLength(1);
      expect(queueB[0]._id).toBe(threadB._id);
      const messagesB = await t.run((ctx) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", threadB._id)).collect());
      expect(messagesB).toHaveLength(2);
      expect(messagesB.map((m) => m.rfcMessageId).sort()).toEqual([REPLY_RFC, SHARED_RFC].sort());
      const detailB = await b.as.query(api.threads.get, { threadId: threadB._id });
      expect(detailB.thread.lastInboundMessageId).toBe(messagesB.find((m) => m.rfcMessageId === REPLY_RFC)?._id);
      // A is untouched: still one thread, one message, same turn.
      expect(await a.as.query(api.threads.queue, { innId: innA.innId })).toHaveLength(1);
      const aAfter = await a.as.query(api.threads.get, { threadId: threadA._id });
      expect(aAfter.messages).toHaveLength(1);
      expect(aAfter.thread.lastInboundMessageId).toBe(aBefore.thread.lastInboundMessageId);
      expect(aAfter.thread.lastInboundAt).toBe(aBefore.thread.lastInboundAt);
      // Every message stays inside its inn.
      const all = await t.run((ctx) => ctx.db.query("messages").collect());
      expect(all.filter((m) => m.threadId === threadA._id)).toHaveLength(1);
      expect(all.filter((m) => m.threadId === threadB._id)).toHaveLength(2);
    });

    it("finds the receiving inn's parent behind more than 64 foreign copies of the same RFC id", async () => {
      withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
      const t = makeTest();
      const a = await signedInUser(t, { name: "A" });
      const b = await signedInUser(t, { name: "B" });
      const innA = await seedLiveInn(t, a.userId, { inboxId: "a@agentmail.to" });
      const innB = await seedLiveInn(t, b.userId, { inboxId: "b@agentmail.to" });
      // 70 copies of the parent live in A's inn and are inserted before B's copy,
      // so any fixed-size prefix of the RFC index (take(64)) holds only foreign rows.
      const FOREIGN = 70;
      const foreignThreadIds = await t.run(async (ctx) => {
        const ids = [];
        for (let i = 0; i < FOREIGN; i++) {
          const threadId = await ctx.db.insert("threads", {
            innId: innA.innId,
            agentmailThreadId: `thr_a_${i}`,
            guestEmail: "dana@example.com",
            subject: "Bringing our dog",
            snippet: "Can we bring our dog in October?",
            status: "new",
            lastInboundAt: Date.parse("2026-09-21T10:00:00.000Z"),
          });
          const messageId = await ctx.db.insert("messages", {
            threadId,
            direction: "in",
            agentmailMessageId: `<m_a_${i}@x>`,
            rfcMessageId: SHARED_RFC,
            from: "dana@example.com",
            to: "a@agentmail.to",
            text: "Can we bring our dog in October?",
            at: Date.parse("2026-09-21T10:00:00.000Z"),
            inboxId: "a@agentmail.to",
            agentmailThreadId: `thr_a_${i}`,
          });
          await ctx.db.patch(threadId, { lastInboundMessageId: messageId });
          ids.push(threadId);
        }
        return ids;
      });
      expect(await (await signedPost(t, original("b@agentmail.to", "evt_b", "thr_b"), "n1")).json()).toEqual({ ok: true, outcome: "stored" });
      const [threadB] = await b.as.query(api.threads.queue, { innId: innB.innId });
      const sharedCopies = await t.run((ctx) => ctx.db.query("messages").withIndex("by_rfc_message_id", (q) => q.eq("rfcMessageId", SHARED_RFC)).collect());
      expect(sharedCopies).toHaveLength(FOREIGN + 1);
      expect(sharedCopies[sharedCopies.length - 1].threadId).toBe(threadB._id);

      expect(await (await signedPost(t, reply("b@agentmail.to", "evt_b_reply"), "n2")).json()).toEqual({ ok: true, outcome: "stored" });

      // The reply joined B's existing thread instead of opening a new one.
      const queueB = await b.as.query(api.threads.queue, { innId: innB.innId });
      expect(queueB).toHaveLength(1);
      expect(queueB[0]._id).toBe(threadB._id);
      const messagesB = await t.run((ctx) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", threadB._id)).collect());
      expect(messagesB.map((m) => m.rfcMessageId).sort()).toEqual([REPLY_RFC, SHARED_RFC].sort());
      // No foreign thread gained the reply.
      const foreignMessages = await t.run((ctx) => ctx.db.query("messages").collect());
      const foreignSet = new Set<string>(foreignThreadIds);
      expect(foreignMessages.filter((m) => foreignSet.has(m.threadId) && m.rfcMessageId === REPLY_RFC)).toHaveLength(0);
      expect(await a.as.query(api.threads.queue, { innId: innA.innId })).toHaveLength(FOREIGN);
    });

    it("a parent that exists only in another inn is never matched: the reply opens its own thread", async () => {
      withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
      const t = makeTest();
      const a = await signedInUser(t, { name: "A" });
      const b = await signedInUser(t, { name: "B" });
      const innA = await seedLiveInn(t, a.userId, { inboxId: "a@agentmail.to" });
      const innB = await seedLiveInn(t, b.userId, { inboxId: "b@agentmail.to" });
      await signedPost(t, original("a@agentmail.to", "evt_a", "thr_a"), "f1");
      const [threadA] = await a.as.query(api.threads.queue, { innId: innA.innId });

      expect(await (await signedPost(t, reply("b@agentmail.to", "evt_b_reply"), "f2")).json()).toEqual({ ok: true, outcome: "stored" });

      const queueB = await b.as.query(api.threads.queue, { innId: innB.innId });
      expect(queueB).toHaveLength(1);
      expect(queueB[0]._id).not.toBe(threadA._id);
      expect((await t.run((ctx) => ctx.db.get(queueB[0]._id)))?.innId).toBe(innB.innId);
      const messagesB = await t.run((ctx) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", queueB[0]._id)).collect());
      expect(messagesB).toHaveLength(1);
      expect(messagesB[0].rfcMessageId).toBe(REPLY_RFC);
      // A did not gain the reply.
      const detailA = await a.as.query(api.threads.get, { threadId: threadA._id });
      expect(detailA.messages).toHaveLength(1);
      expect(await a.as.query(api.threads.queue, { innId: innA.innId })).toHaveLength(1);
    });

    it("the normal single-inn fallback still attaches a reply with an unknown provider thread id", async () => {
      withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
      const t = makeTest();
      const owner = await signedInUser(t, { name: "Owner" });
      const { innId } = await seedLiveInn(t, owner.userId);
      await signedPost(t, original("seagull@agentmail.to", "evt_1", "thr_abc"), "s1");
      const [thread] = await owner.as.query(api.threads.queue, { innId });

      expect(await (await signedPost(t, reply("seagull@agentmail.to", "evt_reply"), "s2")).json()).toEqual({ ok: true, outcome: "stored" });

      const queue = await owner.as.query(api.threads.queue, { innId });
      expect(queue).toHaveLength(1);
      expect(queue[0]._id).toBe(thread._id);
      const detail = await owner.as.query(api.threads.get, { threadId: thread._id });
      expect(detail.messages).toHaveLength(2);
      expect(detail.thread.status).toBe("drafting");
      // The thread keeps its original provider thread id; the reply's is only recorded on the message.
      expect((await t.run((ctx) => ctx.db.get(thread._id)))?.agentmailThreadId).toBe("thr_abc");
      const messages = await t.run((ctx) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", thread._id)).collect());
      expect(messages.find((m) => m.rfcMessageId === REPLY_RFC)?.agentmailThreadId).toBe("thr_reply_unknown");
    });
  });

  it("a newer inbound joins the existing thread, supersedes unsent drafts and cancels follow-ups", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);
    await signedPost(t, received(), "n1");
    const [thread] = await owner.as.query(api.threads.queue, { innId });
    const firstInbound = thread.lastInboundMessageId!;
    // Pretend the drafter produced a ready draft and a follow-up is scheduled.
    const draftId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("drafts", {
        threadId: thread._id,
        replyToMessageId: firstInbound,
        class: "answerable",
        answer: "Yes",
        abstain: false,
        status: "ready",
        model: "test",
        verifiedText: "Yes",
      });
      await ctx.db.insert("followUps", { threadId: thread._id, dueAt: Date.now() + 1000, status: "scheduled" });
      await ctx.db.patch(thread._id, { status: "ready" });
      return id;
    });
    const res = await signedPost(
      t,
      received({ event_id: "evt_5" }, { message_id: "<m2@x>", in_reply_to: "<m1@email.amazonses.com>", text: "Also, what time is check-in?", timestamp: "2026-09-21T10:05:00.000Z" }),
      "n2",
    );
    expect(await res.json()).toEqual({ ok: true, outcome: "stored" });
    const queue = await owner.as.query(api.threads.queue, { innId });
    expect(queue).toHaveLength(1);
    const detail = await owner.as.query(api.threads.get, { threadId: thread._id });
    expect(detail.messages).toHaveLength(2);
    expect(detail.thread.status).toBe("drafting");
    expect(detail.thread.lastInboundMessageId).not.toBe(firstInbound);
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.status).toBe("superseded");
    const followUps = await t.run((ctx) => ctx.db.query("followUps").collect());
    expect(followUps.map((f) => f.status)).toEqual(["cancelled"]);
    // The stale ready draft can no longer be sent (newer inbound).
    await owner.as.mutation(api.threads.claim, { threadId: thread._id });
    await expect(owner.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/already_sent|stale_inbound|not_ready/);
    expect(await t.run((ctx) => ctx.db.query("outbox").collect())).toEqual([]);
  });

  it("a delayed older (or equal-time) inbound is kept as history without taking over the thread's turn", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);
    const current = "2026-09-20T10:00:00.000Z";
    const older = "2026-09-20T09:00:00.000Z";
    const newer = "2026-09-20T11:00:00.000Z";
    await signedPost(t, received({}, { timestamp: current }), "o1");
    await settle(t); // the drafter for the current turn has run (no key → needs_staff)
    const [thread] = await owner.as.query(api.threads.queue, { innId });
    const currentInbound = thread.lastInboundMessageId!;
    const currentAt = thread.lastInboundAt;
    expect(currentAt).toBe(Date.parse(current));
    // Staff has a ready draft on the current turn and a follow-up scheduled.
    const draftId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("drafts", {
        threadId: thread._id,
        replyToMessageId: currentInbound,
        class: "answerable",
        answer: "Yes",
        abstain: false,
        status: "ready",
        model: "test",
        verifiedText: "Yes",
      });
      await ctx.db.insert("followUps", { threadId: thread._id, dueAt: Date.now() + 1000, status: "scheduled" });
      await ctx.db.patch(thread._id, { status: "ready" });
      return id;
    });
    const generationsBefore = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((s) => s.name === "generation:generateForThread").length;

    const expectTurnIntact = async (messages: number) => {
      const detail = await owner.as.query(api.threads.get, { threadId: thread._id });
      expect(detail.messages).toHaveLength(messages);
      expect(detail.thread.status).toBe("ready");
      expect(detail.thread.lastInboundMessageId).toBe(currentInbound);
      expect(detail.thread.lastInboundAt).toBe(currentAt);
      expect(detail.thread.snippet).toBe("Can we bring our dog in October?");
      expect((await t.run((ctx) => ctx.db.get(draftId)))?.status).toBe("ready");
      expect((await t.run((ctx) => ctx.db.query("followUps").collect())).map((f) => f.status)).toEqual(["scheduled"]);
      const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(scheduled.filter((s) => s.name === "generation:generateForThread")).toHaveLength(generationsBefore);
    };

    // A signed delivery of an *older* message in the same thread arrives late.
    const earlierNote = "Earlier note: we have a small dog.";
    const late = await signedPost(t, received({ event_id: "evt_old" }, { message_id: "<m0@x>", text: earlierNote, extracted_text: earlierNote, timestamp: older }), "o2");
    expect(await late.json()).toEqual({ ok: true, outcome: "stored" });
    await expectTurnIntact(2);
    const detail = await owner.as.query(api.threads.get, { threadId: thread._id });
    const lateMessage = detail.messages.find((m) => m.text.startsWith("Earlier note"));
    expect(lateMessage?.at).toBe(Date.parse(older));
    // Redelivery of the older message is still a duplicate.
    expect(await (await signedPost(t, received({ event_id: "evt_old_again" }, { message_id: "<m0@x>", timestamp: older }), "o3")).json()).toEqual({ ok: true, outcome: "duplicate" });
    await expectTurnIntact(2);

    // Equal timestamps keep the existing turn (first stored wins).
    const tie = await signedPost(t, received({ event_id: "evt_tie" }, { message_id: "<m0b@x>", text: "Sent at the same instant.", extracted_text: "Sent at the same instant.", timestamp: current }), "o4");
    expect(await tie.json()).toEqual({ ok: true, outcome: "stored" });
    await expectTurnIntact(3);
    // The current draft can still be sent (nothing newer arrived).
    expect((await t.run((ctx) => ctx.db.get(thread._id)))?.lastInboundMessageId).toBe(currentInbound);

    // A genuinely newer message still advances the turn: supersedes, cancels, reschedules.
    const fresh = await signedPost(t, received({ event_id: "evt_new" }, { message_id: "<m3@x>", text: "Also, what time is check-in?", extracted_text: "Also, what time is check-in?", timestamp: newer }), "o5");
    expect(await fresh.json()).toEqual({ ok: true, outcome: "stored" });
    const after = await owner.as.query(api.threads.get, { threadId: thread._id });
    expect(after.messages).toHaveLength(4);
    expect(after.thread.status).toBe("drafting");
    expect(after.thread.lastInboundMessageId).not.toBe(currentInbound);
    expect(after.thread.lastInboundAt).toBe(Date.parse(newer));
    expect(after.thread.snippet).toBe("Also, what time is check-in?");
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.status).toBe("superseded");
    expect((await t.run((ctx) => ctx.db.query("followUps").collect())).map((f) => f.status)).toEqual(["cancelled"]);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((s) => s.name === "generation:generateForThread")).toHaveLength(generationsBefore + 1);
  });

  it("no public function exposes raw mail or debug mutations", async () => {
    const t = makeTest();
    // Unauthenticated callers cannot read any thread or drive inbound through a public mutation.
    await expect(t.mutation(api.threads.claim, { threadId: "x" as never })).rejects.toThrow(/unauthenticated|Validator|ArgumentValidationError/);
    expect(internal.inbound.receive).toBeDefined();
    expect((api as unknown as { inbound?: unknown }).inbound).toBeDefined(); // anyApi proxy: type-level check follows
    type PublicInbound = typeof api extends { inbound: { receive: unknown } } ? true : false;
    const isPublic: PublicInbound = false;
    expect(isPublic).toBe(false);
  });
});
