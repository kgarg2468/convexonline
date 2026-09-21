import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  aggregateThreadStats,
  aggregatesReady,
  scannedThreadStats,
  sentRepliesBySentAt,
  threadFirstResponseTimes,
  threadStatusCounts,
  type ThreadStats,
} from "../convex/aggregates";
import { makeTest, seedInn, signedInUser, type T } from "./setup";
import { seedInboundThread, seedLiveInn, settle, stubFetch, withEnv } from "./integrationSetup";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const utc = (iso: string) => Date.parse(iso);
const STATUSES = ["new", "drafting", "needs_staff", "ready", "sent", "waiting_guest", "closed"] as const;

/** Runs the migrator batch by batch until every source table is done; returns the steps. */
async function backfill(t: T, restart = false) {
  const steps = [];
  let step = await t.mutation(internal.migrations.backfillAggregates, { restart });
  steps.push(step);
  while (!step.done) {
    step = await t.mutation(internal.migrations.backfillAggregates, {});
    steps.push(step);
  }
  return steps;
}

/** The stats contract counted straight from the tables: the authority the component is checked against. */
const authority = (t: T, innId: Id<"inns">) =>
  t.run(async (ctx) => scannedThreadStats(ctx, (await ctx.db.get(innId))!, Date.now()));

/** The stats contract read from the component itself, regardless of the ready marker. */
const fromComponent = (t: T, innId: Id<"inns">) =>
  t.run(async (ctx) => aggregateThreadStats(ctx, (await ctx.db.get(innId))!, Date.now()));

const ready = (t: T) => t.run((ctx) => aggregatesReady(ctx));

/** Asserts the public query, the component and the tables all agree, and that the component is what is served. */
async function expectConsistent(t: T, owner: Awaited<ReturnType<typeof signedInUser>>, innId: Id<"inns">) {
  expect(await ready(t)).toBe(true);
  const [served, component, tables] = await Promise.all([
    owner.as.query(api.threads.stats, { innId }) as Promise<ThreadStats>,
    fromComponent(t, innId),
    authority(t, innId),
  ]);
  expect(component).toEqual(tables);
  expect(served).toEqual(tables);
  return served;
}

async function seedThread(t: T, innId: Id<"inns">, fields: Partial<Doc<"threads">> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("threads", {
      innId,
      guestEmail: "guest@example.com",
      subject: "Q",
      snippet: "q",
      status: "new",
      lastInboundAt: Date.now(),
      ...fields,
    }),
  );
}

async function seedSentReply(t: T, innId: Id<"inns">, threadId: Id<"threads">, sentBy: Id<"users">, sentAt: number) {
  return await t.run(async (ctx) => {
    const draftId = await ctx.db.insert("drafts", {
      threadId,
      class: "answerable",
      answer: "a",
      abstain: false,
      status: "sent",
      model: "test",
    });
    return await ctx.db.insert("sentReplies", { threadId, innId, draftId, sentBy, sentAt, kind: "reply" });
  });
}

/** A page, version, draft and claim so corrections rows can be seeded with real references. */
async function seedCorrectionContext(t: T, innId: Id<"inns">, ownerId: Id<"users">) {
  const threadId = await seedThread(t, innId, { status: "sent" });
  const sentReplyId = await seedSentReply(t, innId, threadId, ownerId, Date.now());
  return await t.run(async (ctx) => {
    const reply = (await ctx.db.get(sentReplyId))!;
    const pageId = await ctx.db.insert("pages", { innId, url: "https://inn.example/p", title: "P", kind: "policies", watched: true });
    const oldVersionId = await ctx.db.insert("pageVersions", { pageId, markdown: "old", hash: "1", scrapedAt: 1, changeStatus: "new" });
    const newVersionId = await ctx.db.insert("pageVersions", { pageId, markdown: "new", hash: "2", scrapedAt: 2, changeStatus: "changed" });
    await ctx.db.patch(pageId, { lastVersionId: newVersionId });
    const claimId = await ctx.db.insert("claims", {
      draftId: reply.draftId,
      threadId,
      innId,
      statement: "s",
      url: "https://inn.example/p",
      pageId,
      pageVersionId: oldVersionId,
      quote: "old",
      verified: true,
      status: "needs_review",
    });
    return { threadId, sentReplyId, pageId, oldVersionId, newVersionId, claimId };
  });
}

async function seedCorrection(
  t: T,
  innId: Id<"inns">,
  c: Awaited<ReturnType<typeof seedCorrectionContext>>,
  status: Doc<"corrections">["status"],
) {
  return await t.run((ctx) =>
    ctx.db.insert("corrections", {
      innId,
      sentReplyId: c.sentReplyId,
      threadId: c.threadId,
      claimId: c.claimId,
      pageId: c.pageId,
      oldVersionId: c.oldVersionId,
      newVersionId: c.newVersionId,
      oldQuote: "old",
      status,
    }),
  );
}

describe("stats aggregates: counts", () => {
  it("counts every thread status, pending corrections and sent replies per inn from the component", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    const perStatus = { new: 3, drafting: 1, needs_staff: 4, ready: 2, sent: 1, waiting_guest: 5, closed: 6 };
    const threadIds: Id<"threads">[] = [];
    for (const status of STATUSES) {
      for (let i = 0; i < perStatus[status]; i++) threadIds.push(await seedThread(t, innId, { status }));
    }
    for (let i = 0; i < 4; i++) await seedSentReply(t, innId, threadIds[i], owner.userId, Date.now() - i);
    const c = await seedCorrectionContext(t, innId, owner.userId);
    for (const status of ["needs_review", "needs_review", "approved", "sent", "dismissed", "superseded"] as const) {
      await seedCorrection(t, innId, c, status);
    }

    // Rows seeded through ctx.db bypass the triggers: nothing is in the component yet.
    expect(await ready(t)).toBe(false);
    expect(await t.run((ctx) => threadStatusCounts.count(ctx, { namespace: innId }))).toBe(0);
    // Until the backfill is done the query serves the table counts, never a partial aggregate.
    expect(await owner.as.query(api.threads.stats, { innId })).toEqual(await authority(t, innId));

    await backfill(t);
    const stats = await expectConsistent(t, owner, innId);
    expect(stats).toEqual({
      open: 3 + 1 + 4 + 2,
      needsStaff: 4,
      ready: 2,
      waitingGuest: 5,
      sentToday: 5,
      sentTotal: 5, // 4 seeded here + the one under the correction context
      pendingCorrections: 2,
      medianFirstResponseMs: null,
    });
    // Per-status counts are exact, including statuses the contract folds together.
    for (const status of STATUSES) {
      const expected = perStatus[status] + (status === "sent" ? 1 : 0);
      expect(await t.run((ctx) => threadStatusCounts.count(ctx, { namespace: innId, bounds: { prefix: [status] } }))).toBe(expected);
    }
  });

  it("median first response: odd, even, none, and threads without a response never count", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    await backfill(t);
    // Empty inn: no median.
    expect((await expectConsistent(t, owner, innId)).medianFirstResponseMs).toBeNull();

    // Only unanswered threads: still no median (they sort at the -1 key and are excluded).
    await seedThread(t, innId, { status: "new" });
    await seedThread(t, innId, { status: "needs_staff" });
    await backfill(t, true);
    expect((await expectConsistent(t, owner, innId)).medianFirstResponseMs).toBeNull();

    // Odd count.
    for (const ms of [300_000, 100_000, 200_000]) await seedThread(t, innId, { status: "waiting_guest", firstResponseMs: ms });
    await backfill(t, true);
    expect((await expectConsistent(t, owner, innId)).medianFirstResponseMs).toBe(200_000);

    // Even count averages the middle pair; a 0 ms response is a real value.
    await seedThread(t, innId, { status: "closed", firstResponseMs: 0 });
    await backfill(t, true);
    expect((await expectConsistent(t, owner, innId)).medianFirstResponseMs).toBe((100_000 + 200_000) / 2);

    // A live status change through the app keeps the answered thread in the median.
    const [answered] = await t.run((ctx) =>
      ctx.db
        .query("threads")
        .withIndex("by_inn_status", (q) => q.eq("innId", innId).eq("status", "closed"))
        .collect(),
    );
    await owner.as.mutation(api.threads.claim, { threadId: answered._id });
    await owner.as.mutation(api.threads.setStatus, { threadId: answered._id, status: "waiting_guest" });
    expect((await expectConsistent(t, owner, innId)).medianFirstResponseMs).toBe((100_000 + 200_000) / 2);
  });

  it("sentToday is the inn's local calendar day, not a rolling 24 hours, and follows the server clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-06-15T03:30:00Z")); // 23:30 on June 14 in New York
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    await t.run((ctx) => ctx.db.patch(innId, { timezone: "America/New_York" }));
    const threadId = await seedThread(t, innId, { status: "waiting_guest" });
    // 00:00 EDT June 14 (today), 23:59 EDT June 13 (yesterday, but inside a rolling 24h window),
    // 00:00 EDT June 15 (tomorrow), and one 20 hours ago (today).
    await seedSentReply(t, innId, threadId, owner.userId, utc("2026-06-14T04:00:00Z"));
    await seedSentReply(t, innId, threadId, owner.userId, utc("2026-06-14T03:59:00Z"));
    await seedSentReply(t, innId, threadId, owner.userId, utc("2026-06-15T04:00:00Z"));
    await seedSentReply(t, innId, threadId, owner.userId, utc("2026-06-14T07:30:00Z"));
    await backfill(t);
    let stats = await expectConsistent(t, owner, innId);
    expect(stats).toMatchObject({ sentTotal: 4, sentToday: 2 });

    // Same data, later clock: the local day rolled over without any write.
    vi.setSystemTime(utc("2026-06-15T04:00:01Z")); // 00:00:01 EDT June 15
    stats = await expectConsistent(t, owner, innId);
    expect(stats).toMatchObject({ sentTotal: 4, sentToday: 1 });
    // The clock argument is reactivity only: any value gives the same server-decided answer.
    expect(await owner.as.query(api.threads.stats, { innId, clock: 0 })).toEqual(stats);
    expect(await owner.as.query(api.threads.stats, { innId, clock: Number.MAX_SAFE_INTEGER })).toEqual(stats);

    // UTC inn at the UTC boundary.
    const utcInn = await seedInn(t, owner.userId, "UTC Inn");
    const utcThread = await seedThread(t, utcInn, { status: "waiting_guest" });
    await seedSentReply(t, utcInn, utcThread, owner.userId, utc("2026-06-14T23:59:59Z"));
    await seedSentReply(t, utcInn, utcThread, owner.userId, utc("2026-06-15T00:00:00Z"));
    await backfill(t, true);
    vi.setSystemTime(utc("2026-06-15T00:00:30Z"));
    expect(await expectConsistent(t, owner, utcInn)).toMatchObject({ sentTotal: 2, sentToday: 1 });
    vi.setSystemTime(utc("2026-06-14T23:59:59.500Z"));
    expect(await expectConsistent(t, owner, utcInn)).toMatchObject({ sentTotal: 2, sentToday: 1 });

    // DST: the 23-hour spring-forward day in New York counts a reply at 01:30 EST and one at 03:30 EDT.
    const dst = await seedInn(t, owner.userId, "DST Inn");
    await t.run((ctx) => ctx.db.patch(dst, { timezone: "America/New_York" }));
    const dstThread = await seedThread(t, dst, { status: "waiting_guest" });
    await seedSentReply(t, dst, dstThread, owner.userId, utc("2026-03-08T06:30:00Z")); // 01:30 EST
    await seedSentReply(t, dst, dstThread, owner.userId, utc("2026-03-08T07:30:00Z")); // 03:30 EDT
    await seedSentReply(t, dst, dstThread, owner.userId, utc("2026-03-08T04:30:00Z")); // 23:30 EST March 7
    await seedSentReply(t, dst, dstThread, owner.userId, utc("2026-03-09T04:00:00Z")); // 00:00 EDT March 9
    await backfill(t, true);
    vi.setSystemTime(utc("2026-03-09T03:59:00Z")); // 23:59 EDT March 8
    expect(await expectConsistent(t, owner, dst)).toMatchObject({ sentTotal: 4, sentToday: 2 });
    // The 25-hour fall-back day.
    await seedSentReply(t, dst, dstThread, owner.userId, utc("2026-11-01T05:30:00Z")); // first 01:30 (EDT)
    await seedSentReply(t, dst, dstThread, owner.userId, utc("2026-11-01T06:30:00Z")); // second 01:30 (EST)
    await seedSentReply(t, dst, dstThread, owner.userId, utc("2026-11-02T04:59:00Z")); // 23:59 EST Nov 1
    await seedSentReply(t, dst, dstThread, owner.userId, utc("2026-11-02T05:00:00Z")); // 00:00 EST Nov 2
    await backfill(t, true);
    vi.setSystemTime(utc("2026-11-02T04:59:30Z"));
    expect(await expectConsistent(t, owner, dst)).toMatchObject({ sentTotal: 8, sentToday: 3 });
  });

  it("namespaces isolate inns and access is enforced before any aggregate is read", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const other = await signedInUser(t, { name: "Other" });
    const innA = await seedInn(t, owner.userId, "A");
    const innB = await seedInn(t, other.userId, "B");
    for (let i = 0; i < 3; i++) await seedThread(t, innA, { status: "ready" });
    for (let i = 0; i < 2; i++) await seedThread(t, innB, { status: "needs_staff", firstResponseMs: 5 });
    const ta = await seedThread(t, innA, { status: "waiting_guest" });
    await seedSentReply(t, innA, ta, owner.userId, Date.now());
    await backfill(t);

    expect(await expectConsistent(t, owner, innA)).toMatchObject({ open: 3, ready: 3, waitingGuest: 1, needsStaff: 0, sentTotal: 1, medianFirstResponseMs: null });
    expect(await expectConsistent(t, other, innB)).toMatchObject({ open: 2, ready: 0, needsStaff: 2, sentTotal: 0, medianFirstResponseMs: 5 });
    await expect(owner.as.query(api.threads.stats, { innId: innB })).rejects.toThrow(/forbidden/);
    await expect(other.as.query(api.threads.stats, { innId: innA })).rejects.toThrow(/forbidden/);
    await expect(t.query(api.threads.stats, { innId: innA })).rejects.toThrow(/unauthenticated/);
    // The component holds each inn's rows under its own namespace only.
    expect(await t.run((ctx) => threadStatusCounts.count(ctx, { namespace: innA }))).toBe(4);
    expect(await t.run((ctx) => threadStatusCounts.count(ctx, { namespace: innB }))).toBe(2);
    expect(await t.run((ctx) => sentRepliesBySentAt.count(ctx, { namespace: innB }))).toBe(0);
  });
});

describe("stats aggregates: backfill", () => {
  it("walks 250+ rows in 100-row batches with persistent cursors, survives writes between batches, and is repeatable", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const inn = await seedLiveInn(t, owner.userId);
    const innId = inn.innId;
    const threadIds: Id<"threads">[] = [];
    for (let i = 0; i < 260; i++) {
      threadIds.push(await seedThread(t, innId, { status: STATUSES[i % STATUSES.length], firstResponseMs: i % 3 === 0 ? i * 1000 : undefined }));
    }
    for (let i = 0; i < 120; i++) await seedSentReply(t, innId, threadIds[i], owner.userId, Date.now() - i * 1000);
    const c = await seedCorrectionContext(t, innId, owner.userId);
    for (let i = 0; i < 30; i++) await seedCorrection(t, innId, c, i % 2 === 0 ? "needs_review" : "dismissed");
    const before = await authority(t, innId);
    expect(before.open).toBeGreaterThan(100);

    // Batch 1 of threads.
    let step = await t.mutation(internal.migrations.backfillAggregates, {});
    expect(step).toMatchObject({ done: false, table: "threads", scanned: 100, processed: 100 });
    let state = await t.run((ctx) => ctx.db.query("aggregateBackfills").collect());
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ table: "threads", done: false, processed: 100 });
    expect(typeof state[0].cursor).toBe("string");
    // Not ready: the query still serves the tables, and never the half-built component.
    expect(await ready(t)).toBe(false);
    expect(await owner.as.query(api.threads.stats, { innId })).toEqual(await authority(t, innId));
    expect((await fromComponent(t, innId)).open).toBeLessThan(before.open);

    // Live writes between batches go through the triggers: a status change on an
    // already-walked row and on a not-yet-walked row, plus a brand new inbound thread.
    await owner.as.mutation(api.threads.claim, { threadId: threadIds[0] });
    await owner.as.mutation(api.threads.setStatus, { threadId: threadIds[0], status: "closed" });
    await owner.as.mutation(api.threads.claim, { threadId: threadIds[259] });
    await owner.as.mutation(api.threads.setStatus, { threadId: threadIds[259], status: "needs_staff" });
    withEnv({ OPENAI_API_KEY: undefined });
    const received = await t.mutation(internal.inbound.receive, {
      eventId: "evt_mid",
      inboxId: "seagull@agentmail.to",
      providerMessageId: "msg_mid",
      providerThreadId: "thr_mid",
      from: "new@example.com",
      to: "seagull@agentmail.to",
      subject: "Mid-backfill",
      text: "Arrived while the backfill was running",
      receivedAt: Date.now(),
    });
    expect(received.outcome).toBe("stored");
    await settle(t);

    step = await t.mutation(internal.migrations.backfillAggregates, {});
    expect(step).toMatchObject({ done: false, table: "threads", scanned: 100, processed: 200 });
    step = await t.mutation(internal.migrations.backfillAggregates, {});
    expect(step).toMatchObject({ done: false, table: "threads" });
    expect(step.processed).toBeGreaterThanOrEqual(261);
    expect(await ready(t)).toBe(false);
    expect(await owner.as.query(api.threads.stats, { innId })).toEqual(await authority(t, innId));

    // Another write while sentReplies are being walked.
    step = await t.mutation(internal.migrations.backfillAggregates, {});
    expect(step).toMatchObject({ done: false, table: "sentReplies", scanned: 100, processed: 100 });
    await owner.as.mutation(api.threads.claim, { threadId: threadIds[5] });
    await owner.as.mutation(api.threads.setStatus, { threadId: threadIds[5], status: "waiting_guest" });
    step = await t.mutation(internal.migrations.backfillAggregates, {});
    expect(step).toMatchObject({ done: false, table: "sentReplies", scanned: 21, processed: 121 });
    expect(await ready(t)).toBe(false);
    step = await t.mutation(internal.migrations.backfillAggregates, {});
    expect(step).toMatchObject({ done: true, table: "corrections", scanned: 30, processed: 30 });

    // Ready: served from the component and identical to the tables.
    const after = await expectConsistent(t, owner, innId);
    expect(after.open).toBe(before.open); // +1 inbound (drafting→needs_staff), -1 closed thread, ... net checked against tables anyway
    state = await t.run((ctx) => ctx.db.query("aggregateBackfills").collect());
    expect(state.map((s) => [s.table, s.done, s.cursor])).toEqual(
      expect.arrayContaining([
        ["threads", true, undefined],
        ["sentReplies", true, undefined],
        ["corrections", true, undefined],
      ]),
    );

    // A finished migrator is a no-op; a restart re-walks everything without double counting.
    expect(await t.mutation(internal.migrations.backfillAggregates, {})).toMatchObject({ done: true, table: null, scanned: 0 });
    const steps = await backfill(t, true);
    expect(steps.map((s) => s.table)).toEqual(["threads", "threads", "threads", "sentReplies", "sentReplies", "corrections"]);
    expect(await expectConsistent(t, owner, innId)).toEqual(after);

    // The self-driving runner also reaches the end.
    const run = await t.mutation(internal.migrations.runAggregateBackfill, { restart: true });
    expect(run).toMatchObject({ done: false, table: "threads" });
    for (let hops = 0; hops < 20 && !(await ready(t)); hops++) await settle(t);
    expect(await ready(t)).toBe(true);
    expect(await expectConsistent(t, owner, innId)).toEqual(after);
    // Seeds 260 threads plus replies/corrections, walks them three times (batches, restart,
    // self-driving runner) and interleaves live writes. ~3s locally, ~6s on GitHub runners,
    // so it needs more than Vitest's 5s default.
  }, 20_000);
});

describe("stats aggregates: app flows keep the component in step with the tables", () => {
  it("demo enter, policy change, review, corrected send, inbound and reply send", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test", AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const { calls } = stubFetch([]);
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    // Nothing exists yet, so the backfill is trivially complete and every write from here on is live.
    await backfill(t);
    const innId = await visitor.as.mutation(api.demo.enter, {});
    let stats = await expectConsistent(t, visitor, innId);
    expect(stats).toMatchObject({ sentTotal: 6, pendingCorrections: 0, medianFirstResponseMs: 14 * 60 * 1000 });
    expect(stats.open).toBeGreaterThan(0);

    await visitor.as.mutation(api.demo.changePolicyPage, { innId });
    stats = await expectConsistent(t, visitor, innId);
    expect(stats.pendingCorrections).toBe(3);
    const [first, second] = await visitor.as.query(api.corrections.list, { innId, status: "needs_review" });

    await visitor.as.mutation(api.corrections.review, { correctionId: first._id, decision: "approve" });
    expect((await expectConsistent(t, visitor, innId)).pendingCorrections).toBe(2);
    await visitor.as.mutation(api.demo.simulateCorrectionSend, { correctionId: first._id });
    stats = await expectConsistent(t, visitor, innId);
    expect(stats).toMatchObject({ pendingCorrections: 2, sentTotal: 7 });
    expect(stats.sentToday).toBeGreaterThanOrEqual(1);

    await visitor.as.mutation(api.corrections.review, { correctionId: second._id, decision: "dismiss" });
    expect((await expectConsistent(t, visitor, innId)).pendingCorrections).toBe(1);
    // Toggling the page back supersedes the remaining proposal and re-opens the
    // corrected claim (its $40 evidence is gone again): the count follows the table.
    await visitor.as.mutation(api.demo.changePolicyPage, { innId });
    stats = await expectConsistent(t, visitor, innId);
    expect(stats.pendingCorrections).toBe((await visitor.as.query(api.corrections.list, { innId, status: "needs_review" })).length);
    expect(stats.pendingCorrections).toBe(1);

    // A visitor-typed inquiry opens a thread; answering it moves it to waiting_guest and adds a reply.
    const openBefore = stats.open;
    const { threadId } = await visitor.as.mutation(api.demo.simulateInbound, {
      innId,
      guestEmail: "new@example.com",
      subject: "Dogs",
      text: "Can we bring our dog?",
    });
    stats = await expectConsistent(t, visitor, innId);
    expect(stats.open).toBe(openBefore + 1);
    const detail = await visitor.as.query(api.threads.get, { threadId });
    expect(detail.draft?.status).toBe("ready");
    await visitor.as.mutation(api.threads.claim, { threadId });
    await visitor.as.mutation(api.demo.simulateSend, { draftId: detail.draft!._id });
    const afterSend = await expectConsistent(t, visitor, innId);
    expect(afterSend).toMatchObject({ open: openBefore, sentTotal: 8, waitingGuest: stats.waitingGuest + 1 });
    // The new first response (near 0 ms) joins the six seeded 14-minute ones: seven answered, median still 14 minutes.
    expect(await t.run((ctx) => threadFirstResponseTimes.count(ctx, { namespace: innId, bounds: { lower: { key: 0, inclusive: true } } }))).toBe(7);
    expect(afterSend.medianFirstResponseMs).toBe(14 * 60 * 1000);

    // Manual status changes.
    await visitor.as.mutation(api.threads.setStatus, { threadId, status: "closed" });
    expect((await expectConsistent(t, visitor, innId)).waitingGuest).toBe(stats.waitingGuest);
    await visitor.as.mutation(api.threads.setStatus, { threadId, status: "needs_staff" });
    expect((await expectConsistent(t, visitor, innId))).toMatchObject({ open: openBefore + 1, needsStaff: afterSend.needsStaff + 1 });
    expect(calls).toEqual([]);
  });

  it("live inbound: a new thread counts once, a duplicate webhook adds nothing, drafting moves the status", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const inn = await seedLiveInn(t, owner.userId);
    await seedInboundThread(t, inn.innId, { providerMessageId: "msg_seed" });
    await backfill(t);
    const before = await expectConsistent(t, owner, inn.innId);
    expect(before.open).toBe(1);

    const args = {
      eventId: "evt_1",
      inboxId: "seagull@agentmail.to",
      providerMessageId: "msg_1",
      providerThreadId: "thr_new",
      from: "guest2@example.com",
      to: "seagull@agentmail.to",
      subject: "Rooms",
      text: "Do you have a family room?",
      receivedAt: Date.now(),
    };
    expect((await t.mutation(internal.inbound.receive, args)).outcome).toBe("stored");
    expect((await expectConsistent(t, owner, inn.innId)).open).toBe(2);
    expect((await t.mutation(internal.inbound.receive, args)).outcome).toBe("duplicate");
    expect((await t.mutation(internal.inbound.receive, { ...args, eventId: "evt_2" })).outcome).toBe("duplicate");
    expect((await expectConsistent(t, owner, inn.innId)).open).toBe(2);
    // Without a drafter key generation fails over to staff; still open, now needs_staff.
    await settle(t);
    const after = await expectConsistent(t, owner, inn.innId);
    expect(after.open).toBe(2);
    expect(after.needsStaff).toBeGreaterThanOrEqual(1);
  });
});

describe("stats aggregates: maintenance guard", () => {
  it("every Convex module defines mutations with the trigger-wrapped builders", () => {
    const sources = import.meta.glob("../convex/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith("/functions.ts")) continue;
      const imports = source.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/_generated\/server"/g) ?? [];
      for (const line of imports) {
        if (line.startsWith("import type")) continue;
        if (/\b(mutation|internalMutation)\b/.test(line)) offenders.push(path);
      }
    }
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
