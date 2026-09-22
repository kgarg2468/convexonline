import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { aggregatesReady } from "../convex/aggregates";
import { overviewSummary } from "../convex/overview";
import { makeTest, seedInn, signedInUser, type T } from "./setup";

const utc = (iso: string) => Date.parse(iso);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Noon UTC, so "today" in the UTC test inn is unambiguous. */
const NOW = utc("2026-06-15T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Runs the migrator batch by batch until every source table is done. */
async function backfill(t: T) {
  let step = await t.mutation(internal.migrations.backfillAggregates, {});
  while (!step.done) step = await t.mutation(internal.migrations.backfillAggregates, {});
}

async function seedThread(t: T, innId: Id<"inns">, fields: Partial<Doc<"threads">> & { subject?: string } = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("threads", {
      innId,
      guestEmail: "guest@example.com",
      subject: "Q",
      snippet: "q",
      status: "new",
      lastInboundAt: NOW,
      ...fields,
    }),
  );
}

type ReplySpec = {
  sentAt: number;
  /** Text the guest received; omitted to seed a legacy row without text. */
  text?: string | null;
  /** The draft's answer; defaults to the sent text. */
  draftAnswer?: string;
  kind?: "reply" | "correction";
  /** "model" (verified) | "staff" (edited, unverified) | "rejected" (judge said no, sent by staff). */
  provenance?: "model" | "staff" | "rejected";
};

async function seedSentReply(t: T, innId: Id<"inns">, threadId: Id<"threads">, sentBy: Id<"users">, spec: ReplySpec) {
  const text = spec.text === undefined ? "Hello guest" : spec.text;
  const answer = spec.draftAnswer ?? text ?? "Hello guest";
  const provenance = spec.provenance ?? "model";
  return await t.run(async (ctx) => {
    const draftId = await ctx.db.insert("drafts", {
      threadId,
      class: "answerable",
      answer,
      abstain: false,
      status: "sent",
      model: "test",
      textSource: provenance === "model" ? "model" : "staff",
      verifiedText: provenance === "model" ? answer : undefined,
      judgeVerdict:
        provenance === "model"
          ? { entailed: true, promisedOutsideQuotes: false, notes: "ok" }
          : provenance === "rejected"
            ? { entailed: false, promisedOutsideQuotes: false, notes: "not entailed" }
            : undefined,
    });
    const sentReplyId = await ctx.db.insert("sentReplies", {
      threadId,
      innId,
      draftId,
      sentBy,
      sentAt: spec.sentAt,
      kind: spec.kind ?? "reply",
      text: text ?? undefined,
      textSource: provenance === "model" ? "model" : "staff",
    });
    return { draftId, sentReplyId };
  });
}

/**
 * An inn with every kind of row the dashboard reads. Timestamps are relative
 * to NOW; the comments give the window each row lands in.
 */
async function seedRichInn(t: T) {
  const owner = await signedInUser(t, { name: "Owner" });
  const innId = await seedInn(t, owner.userId);
  const u = owner.userId;

  // Threads needing action: two needs_staff (B newer than A) and two ready (C older than both).
  const a = await seedThread(t, innId, { subject: "A", status: "needs_staff", lastInboundAt: NOW - 3 * DAY });
  const b = await seedThread(t, innId, { subject: "B", status: "needs_staff", lastInboundAt: NOW - 1 * DAY });
  const c = await seedThread(t, innId, { subject: "C", status: "ready", lastInboundAt: NOW - 5 * DAY });
  const d = await seedThread(t, innId, { subject: "D", status: "ready", lastInboundAt: NOW - 2 * HOUR });
  // Answered threads: E booked, this week; G an inquiry answered last week; F closed long ago.
  const e = await seedThread(t, innId, {
    subject: "E",
    status: "waiting_guest",
    lastInboundAt: NOW - 4 * DAY,
    firstResponseMs: 600_000,
    stay: { status: "booked", checkIn: "2026-07-01", checkOut: "2026-07-03" },
  });
  const g = await seedThread(t, innId, {
    subject: "G",
    status: "waiting_guest",
    lastInboundAt: NOW - 9 * DAY,
    firstResponseMs: 300_000,
    stay: { status: "inquiry" },
  });
  await seedThread(t, innId, { subject: "F", status: "closed", lastInboundAt: NOW - 45 * DAY, firstResponseMs: 100 });

  await t.run(async (ctx) => {
    // A due reminder on A, a cancelled one on B, and an email approval (never "due") on D.
    await ctx.db.insert("followUps", { threadId: a, dueAt: NOW - HOUR, status: "due", kind: "reminder" });
    await ctx.db.insert("followUps", { threadId: b, dueAt: NOW - HOUR, status: "cancelled", kind: "reminder" });
    await ctx.db.insert("followUps", { threadId: d, dueAt: NOW + DAY, status: "scheduled", kind: "email", innId });
    // Staff answered a knowledge gap on G last week.
    await ctx.db.insert("staffFacts", {
      innId,
      question: "Cots?",
      answer: "Yes, on request.",
      scope: "thread",
      threadId: g,
      author: u,
      authorName: "Owner",
      createdAt: NOW - 9 * DAY,
    });
  });

  // Sent replies. This week: 1d, 2d (verified), 6d (staff edit); a correction send at 3d.
  const r1 = await seedSentReply(t, innId, e, u, { sentAt: NOW - 1 * DAY, text: "One" });
  const r2 = await seedSentReply(t, innId, e, u, { sentAt: NOW - 2 * DAY, text: "Two" });
  const r6 = await seedSentReply(t, innId, e, u, { sentAt: NOW - 6 * DAY, text: "Six staff", draftAnswer: "Six model", provenance: "staff" });
  await seedSentReply(t, innId, e, u, { sentAt: NOW - 3 * DAY, text: "Fix", kind: "correction" });
  // Last week: 8d (verified), 10d (verified, on the thread that needed a staff fact).
  const r8 = await seedSentReply(t, innId, e, u, { sentAt: NOW - 8 * DAY, text: "Eight" });
  const r10 = await seedSentReply(t, innId, g, u, { sentAt: NOW - 10 * DAY, text: "Ten" });
  // Inside 30 days but outside the series: a judge-rejected text staff sent anyway.
  const r20 = await seedSentReply(t, innId, e, u, { sentAt: NOW - 20 * DAY, text: "Twenty", provenance: "rejected" });
  // Previous 30-day window: a correction send.
  await seedSentReply(t, innId, e, u, { sentAt: NOW - 40 * DAY, text: "Old fix", kind: "correction" });

  // A policy page that changed once. r20 quoted a passage that vanished (one
  // pending and one sent correction); r8 quoted one that still holds.
  const page = await t.run(async (ctx) => {
    const pageId = await ctx.db.insert("pages", { innId, url: "https://inn.example/policies", title: "Policies", kind: "policies", watched: true });
    const oldVersionId = await ctx.db.insert("pageVersions", { pageId, markdown: "old", hash: "1", scrapedAt: NOW - 30 * DAY, changeStatus: "new" });
    const newVersionId = await ctx.db.insert("pageVersions", { pageId, markdown: "new", hash: "2", scrapedAt: NOW - 2 * DAY, changeStatus: "changed" });
    await ctx.db.patch(pageId, { lastVersionId: newVersionId });
    const claimId = await ctx.db.insert("claims", {
      draftId: r20.draftId,
      threadId: e,
      innId,
      statement: "s",
      url: "https://inn.example/policies",
      pageId,
      pageVersionId: oldVersionId,
      quote: "old",
      verified: true,
      status: "needs_review",
      checkedAgainstVersionId: newVersionId,
    });
    await ctx.db.insert("claims", {
      draftId: r8.draftId,
      threadId: e,
      innId,
      statement: "still true",
      url: "https://inn.example/policies",
      pageId,
      pageVersionId: oldVersionId,
      quote: "kept",
      verified: true,
      status: "ok",
      checkedAgainstVersionId: newVersionId,
    });
    // An unsent draft's claim is never stamped and must not count as a quoting reply.
    await ctx.db.insert("claims", {
      draftId: r1.draftId,
      threadId: e,
      innId,
      statement: "unsent",
      url: "https://inn.example/policies",
      pageId,
      pageVersionId: newVersionId,
      quote: "new",
      verified: true,
      status: "ok",
    });
    const base = { innId, sentReplyId: r20.sentReplyId, threadId: e, claimId, pageId, oldVersionId, newVersionId, oldQuote: "old" };
    await ctx.db.insert("corrections", { ...base, status: "needs_review" });
    await ctx.db.insert("corrections", { ...base, status: "sent" });
    return { pageId, newVersionId };
  });

  return { owner, innId, threads: { a, b, c, d, e, g }, replies: { r1, r2, r6, r8, r10, r20 }, page };
}

describe("overview.summary", () => {
  it("an empty inn is all zeros and nulls with a 14-day series of inn-local day starts", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    const s = await owner.as.query(api.overview.summary, { innId });

    expect(s.generatedAt).toBe(NOW);
    expect(s.needsAction).toEqual({ needsStaff: 0, ready: 0, policyChangesToReview: 0, followUpsDue: 0 });
    expect(s.upNext).toEqual([]);
    expect(s.kpis).toEqual({
      repliesSent7d: { value: 0, previous: 0 },
      medianFirstResponseMs7d: { value: null, previous: null },
      verifiedBeforeSendPct7d: { value: null, previous: null },
      correctionsSent30d: { value: 0, previous: 0 },
    });
    expect(s.series.repliesPerDay14).toHaveLength(14);
    expect(s.series.repliesPerDay14.every((d) => d.count === 0)).toBe(true);
    // Oldest first, consecutive UTC midnights, ending with today.
    const starts = s.series.repliesPerDay14.map((d) => d.dayStart);
    expect(starts.at(-1)).toBe(utc("2026-06-15T00:00:00Z"));
    expect(starts[0]).toBe(utc("2026-06-02T00:00:00Z"));
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBe(DAY);
    expect(s.breakdown).toEqual({
      draftOutcomes30d: { verified: 0, editedByStaff: 0, neededStaffFact: 0, blockedByJudge: 0 },
      inquiryMix30d: { inquiry: 0, booked: 0 },
    });
    expect(s.comparisons).toEqual({
      weekOverWeek: {
        replies: { a: 0, b: 0 },
        medianFirstResponseMs: { a: null, b: null },
        needsYouCreated: { a: 0, b: 0 },
        corrections: { a: 0, b: 0 },
      },
      latestPageChange: null,
      draftedVsSent: [],
    });
  });

  it("the series follows the inn's local calendar day, not UTC", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    await t.run((ctx) => ctx.db.patch(innId, { timezone: "America/New_York" }));
    const threadId = await seedThread(t, innId, { status: "waiting_guest" });
    // 23:30 EDT June 14 and 00:30 EDT June 15: different local days, same UTC day.
    await seedSentReply(t, innId, threadId, owner.userId, { sentAt: utc("2026-06-15T03:30:00Z") });
    await seedSentReply(t, innId, threadId, owner.userId, { sentAt: utc("2026-06-15T04:30:00Z") });
    const s = await owner.as.query(api.overview.summary, { innId });
    const series = s.series.repliesPerDay14;
    expect(series.at(-1)).toEqual({ dayStart: utc("2026-06-15T04:00:00Z"), count: 1 });
    expect(series.at(-2)).toEqual({ dayStart: utc("2026-06-14T04:00:00Z"), count: 1 });
    expect(series).toHaveLength(14);
  });

  it("counts, windows, ordering and breakdowns over a seeded inn", async () => {
    const t = makeTest();
    const { owner, innId, threads } = await seedRichInn(t);
    const s = await owner.as.query(api.overview.summary, { innId });

    expect(s.needsAction).toEqual({ needsStaff: 2, ready: 2, policyChangesToReview: 1, followUpsDue: 1 });

    // needs_staff by oldest guest message first, then ready, regardless of insertion order.
    expect(s.upNext.map((r) => [r.subject, r.reason])).toEqual([
      ["A", "needs_staff"],
      ["B", "needs_staff"],
      ["C", "ready"],
      ["D", "ready"],
    ]);
    expect(s.upNext[0]).toMatchObject({
      threadId: threads.a,
      guestName: null,
      guestEmail: "guest@example.com",
      status: "needs_staff",
      lastInboundAt: NOW - 3 * DAY,
      waitingMs: 3 * DAY,
    });

    // Every kind of send counts as a reply (like the inbox header): 1d, 2d, 3d (correction), 6d vs 8d, 10d.
    expect(s.kpis.repliesSent7d).toEqual({ value: 4, previous: 2 });
    expect(s.kpis.medianFirstResponseMs7d).toEqual({ value: 600_000, previous: 300_000 });
    // This week two of three reply sends went out as verified text; last week both did.
    expect(s.kpis.verifiedBeforeSendPct7d).toEqual({ value: 66.7, previous: 100 });
    expect(s.kpis.correctionsSent30d).toEqual({ value: 1, previous: 1 });

    const series = s.series.repliesPerDay14;
    expect(series).toHaveLength(14);
    const byDay = new Map(series.map((d) => [d.dayStart, d.count]));
    const dayOf = (iso: string) => byDay.get(utc(iso));
    expect(dayOf("2026-06-15T00:00:00Z")).toBe(0);
    expect(dayOf("2026-06-14T00:00:00Z")).toBe(1);
    expect(dayOf("2026-06-13T00:00:00Z")).toBe(1);
    expect(dayOf("2026-06-12T00:00:00Z")).toBe(1); // the correction send
    expect(dayOf("2026-06-09T00:00:00Z")).toBe(1);
    expect(dayOf("2026-06-07T00:00:00Z")).toBe(1);
    expect(dayOf("2026-06-05T00:00:00Z")).toBe(1);
    expect(series.reduce((n, d) => n + d.count, 0)).toBe(6); // the 20-day-old send is outside the series

    expect(s.breakdown.draftOutcomes30d).toEqual({ verified: 3, editedByStaff: 1, neededStaffFact: 1, blockedByJudge: 1 });
    // F's last message is 45 days old; the booked stay is E.
    expect(s.breakdown.inquiryMix30d).toEqual({ inquiry: 5, booked: 1 });

    expect(s.comparisons.weekOverWeek).toEqual({
      replies: { a: 4, b: 2 },
      medianFirstResponseMs: { a: 600_000, b: 300_000 },
      // A and B wait on staff this week; G was answered with a staff fact last week.
      needsYouCreated: { a: 2, b: 1 },
      corrections: { a: 1, b: 0 },
    });
    expect(s.comparisons.latestPageChange).toEqual({
      pageTitle: "Policies",
      pageUrl: "https://inn.example/policies",
      changedAt: NOW - 2 * DAY,
      repliesQuotingBefore: 2,
      affected: 1,
      stillTrue: 1,
      correctionsSent: 1,
    });

    // The clock argument is reactivity only.
    expect(await owner.as.query(api.overview.summary, { innId, clock: 0 })).toEqual(s);
  });

  it("drafted vs sent: the five newest reply sends with text, newest first, edits flagged", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    const u = owner.userId;
    const threadId = await seedThread(t, innId, { subject: "Pool hours", status: "waiting_guest" });
    // Seven sends, seeded out of order; only reply sends with text qualify.
    await seedSentReply(t, innId, threadId, u, { sentAt: NOW - 5 * HOUR, text: "Five" });
    await seedSentReply(t, innId, threadId, u, { sentAt: NOW - 1 * HOUR, text: "One" });
    const edited = await seedSentReply(t, innId, threadId, u, { sentAt: NOW - 2 * HOUR, text: "Two, edited", draftAnswer: "Two", provenance: "staff" });
    // Same text but staff provenance: an edit overwrote the draft in place.
    await seedSentReply(t, innId, threadId, u, { sentAt: NOW - 3 * HOUR, text: "Three", provenance: "staff" });
    await seedSentReply(t, innId, threadId, u, { sentAt: NOW - 4 * HOUR, text: "Four" });
    await seedSentReply(t, innId, threadId, u, { sentAt: NOW - 30 * 60 * 1000, text: "Fix", kind: "correction" });
    await seedSentReply(t, innId, threadId, u, { sentAt: NOW - 10 * 60 * 1000, text: null }); // legacy row, no text
    await seedSentReply(t, innId, threadId, u, { sentAt: NOW - 6 * HOUR, text: "Six" });

    const s = await owner.as.query(api.overview.summary, { innId });
    expect(s.comparisons.draftedVsSent.map((r) => [r.sentText, r.edited])).toEqual([
      ["One", false],
      ["Two, edited", true],
      ["Three", true],
      ["Four", false],
      ["Five", false],
    ]);
    expect(s.comparisons.draftedVsSent[1]).toEqual({
      sentReplyId: edited.sentReplyId,
      threadId,
      subject: "Pool hours",
      sentAt: NOW - 2 * HOUR,
      draftText: "Two",
      sentText: "Two, edited",
      edited: true,
    });
    // Whitespace-only differences are not edits.
    await seedSentReply(t, innId, threadId, u, { sentAt: NOW, text: "  Zero \n", draftAnswer: "Zero" });
    const again = await owner.as.query(api.overview.summary, { innId });
    expect(again.comparisons.draftedVsSent[0]).toMatchObject({ sentText: "  Zero \n", draftText: "Zero", edited: false });
    expect(again.comparisons.draftedVsSent).toHaveLength(5);
  });

  it("rejects members of other inns and anonymous callers", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const other = await signedInUser(t, { name: "Other" });
    const innA = await seedInn(t, owner.userId, "A");
    const innB = await seedInn(t, other.userId, "B");
    await expect(other.as.query(api.overview.summary, { innId: innA })).rejects.toThrow(/forbidden/);
    await expect(owner.as.query(api.overview.summary, { innId: innB })).rejects.toThrow(/forbidden/);
    await expect(t.query(api.overview.summary, { innId: innA })).rejects.toThrow(/unauthenticated/);
    await expect(owner.as.query(api.overview.summary, { innId: innA })).resolves.toBeTruthy();
  });

  it("the aggregate path and the scanned path agree, and the query serves the tables until the backfill is done", async () => {
    const t = makeTest();
    const { owner, innId } = await seedRichInn(t);
    const forced = (useAggregates: boolean) =>
      t.run(async (ctx) => overviewSummary(ctx, (await ctx.db.get(innId))!, Date.now(), useAggregates));

    // Rows seeded through ctx.db bypass the triggers: the component is empty and not ready.
    expect(await t.run((ctx) => aggregatesReady(ctx))).toBe(false);
    const beforeBackfill = await owner.as.query(api.overview.summary, { innId });
    expect(beforeBackfill).toEqual(await forced(false));
    // A half-built aggregate would answer zeros here; the query must not serve it.
    expect((await forced(true)).needsAction.needsStaff).toBe(0);
    expect(beforeBackfill.needsAction.needsStaff).toBe(2);

    await backfill(t);
    expect(await t.run((ctx) => aggregatesReady(ctx))).toBe(true);
    const served = await owner.as.query(api.overview.summary, { innId });
    expect(served).toEqual(await forced(true));
    expect(served).toEqual(await forced(false));
    expect(served).toEqual(beforeBackfill);

    // A live write through the app keeps both paths aligned.
    const [ready] = await t.run((ctx) =>
      ctx.db
        .query("threads")
        .withIndex("by_inn_status", (q) => q.eq("innId", innId).eq("status", "ready"))
        .collect(),
    );
    await owner.as.mutation(api.threads.claim, { threadId: ready._id });
    await owner.as.mutation(api.threads.setStatus, { threadId: ready._id, status: "closed" });
    const after = await owner.as.query(api.overview.summary, { innId });
    expect(after.needsAction.ready).toBe(1);
    expect(after).toEqual(await forced(false));
  });
});
