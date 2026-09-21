import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { signWebhook } from "../convex/lib/webhookSignature";
import { makeTest, signedInUser } from "./setup";
import { seedLiveInn, TEST_SECRET, withEnv } from "./integrationSetup";

const PATH = "/api/agentmail/webhook";
const AT = Date.parse("2026-09-21T10:00:00.000Z");

type Ctx = Parameters<Parameters<ReturnType<typeof makeTest>["run"]>[0]>[0];

async function insertThread(ctx: Ctx, innId: Id<"inns">, tag: string) {
  return await ctx.db.insert("threads", {
    innId,
    agentmailThreadId: `thr_${tag}`,
    guestEmail: "guest@example.com",
    subject: "Q",
    snippet: "q",
    status: "new",
    lastInboundAt: AT,
  });
}

/** A row as written before `innId` existed (or with an explicit wrong/right value). */
async function insertLegacyMessage(ctx: Ctx, threadId: Id<"threads">, tag: string, innId?: Id<"inns">) {
  return await ctx.db.insert("messages", {
    threadId,
    innId,
    direction: "in",
    rfcMessageId: `<${tag}@mail.example>`,
    from: "guest@example.com",
    to: "inbox",
    text: "q",
    at: AT,
  });
}

async function runToCompletion(t: ReturnType<typeof makeTest>) {
  type Result = { done: boolean; cursor: string | null; scanned: number; updated: number; skipped: number; missingThread: number };
  const results: Result[] = [];
  let cursor: string | undefined = undefined;
  for (let i = 0; i < 50; i++) {
    const r: Result = await t.mutation(internal.migrations.backfillMessageInnIds, { cursor });
    results.push(r);
    if (r.done) return results;
    cursor = r.cursor ?? undefined;
  }
  throw new Error("backfill did not finish");
}

describe("migrations.backfillMessageInnIds", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("paginates in batches of at most 100 and fills innId from each message's thread across inns", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innA = await seedLiveInn(t, owner.userId, { inboxId: "a@agentmail.to" });
    const innB = await seedLiveInn(t, owner.userId, { inboxId: "b@agentmail.to" });
    const TOTAL = 230;
    const expectedPairs = await t.run(async (ctx) => {
      const pairs: Array<[Id<"messages">, Id<"inns">]> = [];
      const threadA = await insertThread(ctx, innA.innId, "a");
      const threadB = await insertThread(ctx, innB.innId, "b");
      for (let i = 0; i < TOTAL; i++) {
        const inB = i % 3 === 0;
        const id = await insertLegacyMessage(ctx, inB ? threadB : threadA, `m${i}`);
        pairs.push([id, inB ? innB.innId : innA.innId]);
      }
      return pairs;
    });
    const expected = new Map<string, Id<"inns">>(expectedPairs);

    const results = await runToCompletion(t);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results) expect(r.scanned).toBeLessThanOrEqual(100);
    expect(results.slice(0, -1).every((r) => !r.done && typeof r.cursor === "string")).toBe(true);
    expect(results[results.length - 1]).toMatchObject({ done: true, cursor: null });
    expect(results.reduce((n, r) => n + r.updated, 0)).toBe(TOTAL);
    expect(results.reduce((n, r) => n + r.scanned, 0)).toBe(TOTAL);
    expect(results.reduce((n, r) => n + r.missingThread, 0)).toBe(0);

    const all = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(all).toHaveLength(TOTAL);
    for (const m of all) expect(m.innId).toBe(expected.get(m._id));
  });

  it("is idempotent: a second full pass updates nothing, and mismatched innIds are corrected from the thread", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innA = await seedLiveInn(t, owner.userId, { inboxId: "a@agentmail.to" });
    const innB = await seedLiveInn(t, owner.userId, { inboxId: "b@agentmail.to" });
    const { threadA, correct, wrong, missing } = await t.run(async (ctx) => {
      const threadA = await insertThread(ctx, innA.innId, "a");
      return {
        threadA,
        correct: await insertLegacyMessage(ctx, threadA, "correct", innA.innId),
        wrong: await insertLegacyMessage(ctx, threadA, "wrong", innB.innId),
        missing: await insertLegacyMessage(ctx, threadA, "missing"),
      };
    });

    const first = await runToCompletion(t);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ done: true, scanned: 3, updated: 2, skipped: 1, missingThread: 0 });
    const after = await t.run(async (ctx) => ({
      correct: await ctx.db.get(correct),
      wrong: await ctx.db.get(wrong),
      missing: await ctx.db.get(missing),
    }));
    expect(after.correct?.innId).toBe(innA.innId);
    expect(after.wrong?.innId).toBe(innA.innId);
    expect(after.missing?.innId).toBe(innA.innId);
    expect(after.wrong?.threadId).toBe(threadA);

    const second = await runToCompletion(t);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ done: true, scanned: 3, updated: 0, skipped: 3, missingThread: 0 });
  });

  it("counts and leaves alone messages whose thread is gone, and finishes", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innA = await seedLiveInn(t, owner.userId, { inboxId: "a@agentmail.to" });
    const { orphan, kept } = await t.run(async (ctx) => {
      const live = await insertThread(ctx, innA.innId, "live");
      const dead = await insertThread(ctx, innA.innId, "dead");
      const orphan = await insertLegacyMessage(ctx, dead, "orphan");
      const kept = await insertLegacyMessage(ctx, live, "kept");
      await ctx.db.delete(dead);
      return { orphan, kept };
    });

    const results = await runToCompletion(t);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ done: true, scanned: 2, updated: 1, skipped: 0, missingThread: 1 });
    const rows = await t.run(async (ctx) => ({ orphan: await ctx.db.get(orphan), kept: await ctx.db.get(kept) }));
    expect(rows.orphan?.innId).toBeUndefined();
    expect(rows.kept?.innId).toBe(innA.innId);
  });

  it("an empty table completes in one call", async () => {
    const t = makeTest();
    const r = await t.mutation(internal.migrations.backfillMessageInnIds, {});
    expect(r).toEqual({ done: true, cursor: null, scanned: 0, updated: 0, skipped: 0, missingThread: 0 });
  });

  it("after the backfill a reply to a legacy parent attaches to the same-inn thread and not to a foreign copy", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const a = await signedInUser(t, { name: "A" });
    const b = await signedInUser(t, { name: "B" });
    const innA = await seedLiveInn(t, a.userId, { inboxId: "a@agentmail.to" });
    const innB = await seedLiveInn(t, b.userId, { inboxId: "b@agentmail.to" });
    const SHARED_RFC = "<shared-legacy@mail.example>";
    // Legacy rows (no innId): A's copy first, then B's copy, same RFC id.
    const { threadA, threadB } = await t.run(async (ctx) => {
      const threadA = await insertThread(ctx, innA.innId, "legacy_a");
      const threadB = await insertThread(ctx, innB.innId, "legacy_b");
      for (const [threadId, inbox] of [[threadA, "a@agentmail.to"], [threadB, "b@agentmail.to"]] as const) {
        const messageId = await ctx.db.insert("messages", {
          threadId,
          direction: "in",
          agentmailMessageId: `<m_${inbox}>`,
          rfcMessageId: SHARED_RFC,
          from: "guest@example.com",
          to: inbox,
          text: "q",
          at: AT,
          inboxId: inbox,
        });
        await ctx.db.patch(threadId, { lastInboundMessageId: messageId });
      }
      return { threadA, threadB };
    });
    const reply = {
      type: "event",
      event_type: "message.received",
      event_id: "evt_reply",
      message: {
        inbox_id: "b@agentmail.to",
        message_id: "<reply@x>",
        thread_id: "thr_reply_unknown",
        from: "guest@example.com",
        to: "b@agentmail.to",
        subject: "Re: Q",
        text: "and one more thing",
        extracted_text: "and one more thing",
        in_reply_to: SHARED_RFC,
        headers: { "message-id": "<reply@mail.example>" },
        timestamp: "2026-09-21T10:05:00.000Z",
      },
    };
    const post = async (id: string, eventId: string) => {
      const raw = JSON.stringify({ ...reply, event_id: eventId });
      const headers = await signWebhook(TEST_SECRET, raw, id);
      return t.fetch(PATH, { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } });
    };

    // Before the backfill the legacy parent is invisible to the inn-scoped index: a new thread opens.
    expect(await (await post("w1", "evt_before")).json()).toEqual({ ok: true, outcome: "stored" });
    expect(await b.as.query(api.threads.queue, { innId: innB.innId })).toHaveLength(2);

    const results = await runToCompletion(t);
    // The two legacy parents and the stray reply (already carries innId) were scanned.
    expect(results.reduce((n, r) => n + r.updated, 0)).toBe(2);
    expect(results.reduce((n, r) => n + r.skipped, 0)).toBe(1);

    // After the backfill the same reply (new provider message and thread ids, so
    // the primary provider-thread match cannot hit the stray thread above)
    // attaches to B's legacy thread.
    const raw = JSON.stringify({
      ...reply,
      event_id: "evt_after",
      message: { ...reply.message, message_id: "<reply2@x>", thread_id: "thr_reply_unknown_2", headers: { "message-id": "<reply2@mail.example>" } },
    });
    const headers = await signWebhook(TEST_SECRET, raw, "w2");
    const res = await t.fetch(PATH, { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } });
    expect(await res.json()).toEqual({ ok: true, outcome: "stored" });
    const messagesB = await t.run((ctx) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", threadB)).collect());
    expect(messagesB.map((m) => m.rfcMessageId).sort()).toEqual([SHARED_RFC, "<reply2@mail.example>"].sort());
    expect(messagesB.every((m) => m.innId === innB.innId)).toBe(true);
    // A's legacy copy never gained the reply.
    const messagesA = await t.run((ctx) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", threadA)).collect());
    expect(messagesA).toHaveLength(1);
    expect(messagesA[0].innId).toBe(innA.innId);
    expect(await b.as.query(api.threads.queue, { innId: innB.innId })).toHaveLength(2);
  });
});
