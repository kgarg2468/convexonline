/**
 * The Overview dashboard: one query, one plain object, every read bounded to
 * the inn the caller proved access to.
 *
 * Counts that the stats aggregates (convex/aggregates.ts) can answer are read
 * from the component once `aggregatesReady`; until then, and for everything
 * the aggregates cannot window by time, the tables are read through an index
 * with a hard `take` cap. The caps below are the only way one call can ever
 * be truncated; an inn with more rows than a cap inside a window gets a
 * count that stops at the cap rather than a scan of its whole history.
 *
 * Field → column map (also noted inline where the proxy matters):
 *  - needsAction.needsStaff / ready   threads.status via `by_inn_status` (aggregate: threadStatusCounts)
 *  - needsAction.policyChangesToReview corrections.status = needs_review (aggregate: correctionStatusCounts)
 *  - needsAction.followUpsDue         followUps rows of kind reminder in status `due` on needs_staff threads
 *  - kpis.repliesSent7d, series       sentReplies.sentAt (aggregate: sentRepliesBySentAt); every kind, like threads.stats
 *  - kpis.medianFirstResponseMs7d     threads.firstResponseMs, windowed by threads.lastInboundAt
 *  - kpis.verifiedBeforeSendPct7d     drafts.verifiedText === the text that went out (see `wasVerified`)
 *  - kpis.correctionsSent30d          sentReplies.kind = correction, by sentAt
 *  - breakdown.inquiryMix30d          threads.stay.status ("inquiry" | "booked"); a thread without `stay` counts as inquiry
 *  - comparisons.latestPageChange     newest pageVersions row with changeStatus "changed" across the inn's pages
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireInnAccess } from "./access";
import { aggregatesReady, correctionStatusCounts, sentRepliesBySentAt, threadStatusCounts } from "./aggregates";
import { localDayOf } from "./lib/localDay";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

/** Most rows one index walk reads. */
const THREAD_SCAN = 200;
const REPLY_SCAN = 200;
const CORRECTION_SCAN = 200;
const CORRECTION_STATUSES = ["needs_review", "approved", "sent", "dismissed", "superseded"] as const satisfies readonly Doc<"corrections">["status"][];
const CLAIM_SCAN = 200;
const FACT_SCAN = 200;
const PAGE_SCAN = 60;
/** Most needs_staff threads whose reminder rows are checked for `followUpsDue`. */
const FOLLOW_UP_THREADS = 100;
const DUE_ROWS_PER_THREAD = 5;

const UP_NEXT = 5;
const DRAFTED_VS_SENT = 5;
const SERIES_DAYS = 14;

type Pair<T> = { a: T; b: T };
type Kpi<T> = { value: T; previous: T };
/** Inclusive start, exclusive end, except that the live window includes `now` itself. */
type Window = { start: number; end: number; endInclusive: boolean };

const inWindow = (t: number, w: Window) => t >= w.start && (w.endInclusive ? t <= w.end : t < w.end);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const mid = xs.length / 2;
  return xs.length % 2 === 1 ? xs[Math.floor(mid)] : (xs[mid - 1] + xs[mid]) / 2;
}

function medianFirstResponse(threads: Doc<"threads">[], w: Window): number | null {
  return median(
    threads
      .filter((t) => inWindow(t.lastInboundAt, w) && typeof t.firstResponseMs === "number")
      .map((t) => Math.max(0, t.firstResponseMs as number)),
  );
}

/** The exact text the guest received for a reply-kind send. */
const sentTextOf = (reply: Doc<"sentReplies">, draft: Doc<"drafts">) => reply.text ?? draft.answer;

/**
 * "Verified before send": the text that went out is byte-identical to the
 * draft's `verifiedText`, which is only ever set to text that passed the
 * judge (or a fixture / staff-fact verification) and is cleared by every
 * staff edit. A staff-authored send of an edited, un-rejudged draft has no
 * `verifiedText` and therefore counts as unverified.
 */
const wasVerified = (reply: Doc<"sentReplies">, draft: Doc<"drafts">) =>
  draft.verifiedText !== undefined && draft.verifiedText === sentTextOf(reply, draft);

const judgeRejected = (draft: Doc<"drafts">) =>
  draft.judgeVerdict !== undefined && (!draft.judgeVerdict.entailed || draft.judgeVerdict.promisedOutsideQuotes);

const staffAuthored = (reply: Doc<"sentReplies">, draft: Doc<"drafts">) => (reply.textSource ?? draft.textSource) === "staff";

const isReplySend = (r: Doc<"sentReplies">) => (r.kind ?? "reply") === "reply";

async function threadsByStatus(ctx: QueryCtx, innId: Id<"inns">, status: Doc<"threads">["status"]) {
  return await ctx.db
    .query("threads")
    .withIndex("by_inn_status", (q) => q.eq("innId", innId).eq("status", status))
    .take(THREAD_SCAN);
}

/**
 * Only reminders ever reach `due` (emails go scheduled → reserved → sent),
 * so the indexed lookup reads at most the few due rows a thread can hold.
 */
async function hasDueReminder(ctx: QueryCtx, threadId: Id<"threads">) {
  const due = await ctx.db
    .query("followUps")
    .withIndex("by_thread_status", (q) => q.eq("threadId", threadId).eq("status", "due"))
    .take(DUE_ROWS_PER_THREAD);
  return due.some((r) => r.kind !== "email");
}

/**
 * Corrections for the latest page change are the newest rows the inn has, but
 * `by_inn_status` groups by status first, so one descending walk would read
 * whichever status sorts last. Walk each status newest-first instead; the cap
 * is per status, so a single busy group can never push another out.
 */
async function correctionsNewestPerStatus(ctx: QueryCtx, innId: Id<"inns">) {
  const perStatus = await Promise.all(
    CORRECTION_STATUSES.map((status) =>
      ctx.db
        .query("corrections")
        .withIndex("by_inn_status", (q) => q.eq("innId", innId).eq("status", status))
        .order("desc")
        .take(CORRECTION_SCAN),
    ),
  );
  return perStatus.flat();
}

/** The most recent "changed" page version across the inn's pages, with its page. */
async function latestChangedVersion(ctx: QueryCtx, innId: Id<"inns">) {
  const pages = await ctx.db
    .query("pages")
    .withIndex("by_inn", (q) => q.eq("innId", innId))
    .take(PAGE_SCAN);
  let best: { page: Doc<"pages">; version: Doc<"pageVersions"> } | null = null;
  for (const page of pages) {
    if (!page.lastVersionId) continue;
    // Versions are only ever "new" (first) or "changed": identical scrapes are never stored.
    const version = await ctx.db.get(page.lastVersionId);
    if (!version || version.changeStatus !== "changed") continue;
    if (!best || version.scrapedAt > best.version.scrapedAt) best = { page, version };
  }
  return best;
}

/**
 * The dashboard contract. `useAggregates` selects the component for the
 * counts it can answer; everything else is computed the same way on both
 * paths, so the two agree whenever no scan cap was hit.
 */
export async function overviewSummary(ctx: QueryCtx, inn: Doc<"inns">, now: number, useAggregates: boolean) {
  const innId = inn._id;
  const week: Window = { start: now - WEEK_MS, end: now, endInclusive: true };
  const prevWeek: Window = { start: now - 2 * WEEK_MS, end: now - WEEK_MS, endInclusive: false };
  const month: Window = { start: now - MONTH_MS, end: now, endInclusive: true };
  const prevMonth: Window = { start: now - 2 * MONTH_MS, end: now - MONTH_MS, endInclusive: false };

  // --- Threads needing action (both paths need the rows for upNext) ---
  const [needsStaffThreads, readyThreads] = await Promise.all([
    threadsByStatus(ctx, innId, "needs_staff"),
    threadsByStatus(ctx, innId, "ready"),
  ]);
  const byOldestInbound = (a: Doc<"threads">, b: Doc<"threads">) => a.lastInboundAt - b.lastInboundAt || (a._creationTime - b._creationTime);
  needsStaffThreads.sort(byOldestInbound);
  readyThreads.sort(byOldestInbound);

  let needsStaff = needsStaffThreads.length;
  let ready = readyThreads.length;
  let policyChangesToReview: number;
  if (useAggregates) {
    [needsStaff, ready, policyChangesToReview] = await Promise.all([
      threadStatusCounts.count(ctx, { namespace: innId, bounds: { prefix: ["needs_staff"] } }),
      threadStatusCounts.count(ctx, { namespace: innId, bounds: { prefix: ["ready"] } }),
      correctionStatusCounts.count(ctx, { namespace: innId, bounds: { prefix: ["needs_review"] } }),
    ]);
  } else {
    const pending = await ctx.db
      .query("corrections")
      .withIndex("by_inn_status", (q) => q.eq("innId", innId).eq("status", "needs_review"))
      .take(CORRECTION_SCAN);
    policyChangesToReview = pending.length;
  }

  // A due reminder flips its thread to needs_staff, so only those threads are
  // checked; there is no per-inn index on followUps to count them directly.
  let followUpsDue = 0;
  for (const thread of needsStaffThreads.slice(0, FOLLOW_UP_THREADS)) {
    if (await hasDueReminder(ctx, thread._id)) followUpsDue += 1;
  }

  const upNext = [...needsStaffThreads, ...readyThreads].slice(0, UP_NEXT).map((t) => ({
    threadId: t._id,
    subject: t.subject,
    // Threads record the guest's address only; there is no guest name column.
    guestName: null as string | null,
    guestEmail: t.guestEmail,
    status: t.status,
    lastInboundAt: t.lastInboundAt,
    waitingMs: Math.max(0, now - t.lastInboundAt),
    reason: t.status === "needs_staff" ? ("needs_staff" as const) : ("ready" as const),
  }));

  // --- Recent threads: response times, inquiry mix, needs-you (newest first, capped) ---
  const recentThreads = await ctx.db
    .query("threads")
    .withIndex("by_inn_lastInbound", (q) => q.eq("innId", innId).gte("lastInboundAt", now - MONTH_MS))
    .order("desc")
    .take(THREAD_SCAN);
  // Thread-scoped staff facts mark the threads staff had to answer a knowledge gap for.
  const threadFacts = await ctx.db
    .query("staffFacts")
    .withIndex("by_inn_scope", (q) => q.eq("innId", innId).eq("scope", "thread"))
    .order("desc")
    .take(FACT_SCAN);
  const threadsWithFact = new Set<string>();
  for (const f of threadFacts) if (f.threadId && f.createdAt >= now - MONTH_MS) threadsWithFact.add(f.threadId);
  // Proxy: nothing records when a thread entered needs_staff, so a thread
  // "needed you" in a window when its latest guest message arrived in that
  // window and it is waiting on staff now or was answered with a staff fact.
  const needsYouIn = (w: Window) =>
    recentThreads.filter((t) => inWindow(t.lastInboundAt, w) && (t.status === "needs_staff" || threadsWithFact.has(t._id))).length;
  let inquiry = 0;
  let booked = 0;
  for (const t of recentThreads) {
    if (t.stay?.status === "booked") booked += 1;
    else inquiry += 1;
  }

  // --- Sent replies: newest by creation, capped; sentAt decides every window ---
  const replies = await ctx.db
    .query("sentReplies")
    .withIndex("by_inn", (q) => q.eq("innId", innId))
    .order("desc")
    .take(REPLY_SCAN);
  const countReplies = async (w: Window) => {
    if (useAggregates) {
      return await sentRepliesBySentAt.count(ctx, {
        namespace: innId,
        bounds: { lower: { key: w.start, inclusive: true }, upper: { key: w.end, inclusive: w.endInclusive } },
      });
    }
    return replies.filter((r) => inWindow(r.sentAt, w)).length;
  };
  const [repliesThisWeek, repliesPrevWeek] = await Promise.all([countReplies(week), countReplies(prevWeek)]);

  // Inn-local calendar days, oldest first, ending with today.
  const days: Window[] = [];
  let day = localDayOf(inn.timezone, now);
  for (let i = 0; i < SERIES_DAYS; i++) {
    days.unshift({ start: day.startMs, end: day.endMs, endInclusive: false });
    day = localDayOf(inn.timezone, day.startMs - 1);
  }
  const repliesPerDay14 = [];
  for (const d of days) repliesPerDay14.push({ dayStart: d.start, count: await countReplies(d) });

  const correctionSendsIn = (w: Window) => replies.filter((r) => r.kind === "correction" && inWindow(r.sentAt, w)).length;

  // Drafts of the reply-kind sends in the last 30 days (≤ REPLY_SCAN reads) plus
  // the few newest sends shown side by side.
  const replySends = replies.filter(isReplySend);
  const newestWithText = replySends
    .filter((r) => r.text !== undefined)
    .sort((a, b) => b.sentAt - a.sentAt || b._creationTime - a._creationTime)
    .slice(0, DRAFTED_VS_SENT);
  const drafts = new Map<string, Doc<"drafts">>();
  for (const r of [...replySends.filter((r) => inWindow(r.sentAt, month)), ...newestWithText]) {
    if (drafts.has(r.draftId)) continue;
    const draft = await ctx.db.get(r.draftId);
    if (draft) drafts.set(r.draftId, draft);
  }
  const verifiedPct = (w: Window): number | null => {
    let n = 0;
    let verified = 0;
    for (const r of replySends) {
      if (!inWindow(r.sentAt, w)) continue;
      const draft = drafts.get(r.draftId);
      if (!draft) continue;
      n += 1;
      if (wasVerified(r, draft)) verified += 1;
    }
    return n === 0 ? null : Math.round((verified / n) * 1000) / 10;
  };

  // Mutually exclusive, in priority order; a legacy send without a draft or
  // provenance falls in no bucket.
  const draftOutcomes30d = { verified: 0, editedByStaff: 0, neededStaffFact: 0, blockedByJudge: 0 };
  for (const r of replySends) {
    if (!inWindow(r.sentAt, month)) continue;
    const draft = drafts.get(r.draftId);
    if (!draft) continue;
    if (judgeRejected(draft)) draftOutcomes30d.blockedByJudge += 1;
    else if (staffAuthored(r, draft)) draftOutcomes30d.editedByStaff += 1;
    else if (draft.class !== "answerable" || draft.abstain || threadsWithFact.has(r.threadId)) draftOutcomes30d.neededStaffFact += 1;
    else if (wasVerified(r, draft)) draftOutcomes30d.verified += 1;
  }

  // A staff edit overwrites `drafts.answer` in place, so for live data the two
  // texts match and the provenance flag is what marks an edited reply.
  const draftedVsSent = [];
  for (const r of newestWithText) {
    const draft = drafts.get(r.draftId);
    if (!draft) continue;
    const thread = await ctx.db.get(r.threadId);
    const sentText = r.text!;
    draftedVsSent.push({
      sentReplyId: r._id,
      threadId: r.threadId,
      subject: thread?.subject ?? "",
      sentAt: r.sentAt,
      draftText: draft.answer,
      sentText,
      edited: draft.answer.trim() !== sentText.trim() || staffAuthored(r, draft),
    });
  }

  // --- Latest page change and what it touched ---
  let latestPageChange = null;
  const changed = await latestChangedVersion(ctx, innId);
  if (changed) {
    const versionId = changed.version._id;
    const [claims, corrections] = await Promise.all([
      ctx.db
        .query("claims")
        .withIndex("by_page", (q) => q.eq("pageId", changed.page._id))
        .take(CLAIM_SCAN),
      correctionsNewestPerStatus(ctx, innId),
    ]);
    // Every sent claim citing the page is re-checked against the new version
    // and stamped with it; unsent and stripped claims are never stamped.
    const quotingDrafts = new Set<string>();
    for (const c of claims) if (c.checkedAgainstVersionId === versionId) quotingDrafts.add(c.draftId);
    const forVersion = corrections.filter((c) => c.newVersionId === versionId);
    const affectedReplies = new Set<string>();
    let correctionsSent = 0;
    for (const c of forVersion) {
      affectedReplies.add(c.sentReplyId);
      if (c.status === "sent") correctionsSent += 1;
    }
    const repliesQuotingBefore = quotingDrafts.size;
    const affected = affectedReplies.size;
    latestPageChange = {
      pageTitle: changed.page.title,
      pageUrl: changed.page.url,
      changedAt: changed.version.scrapedAt,
      repliesQuotingBefore,
      affected,
      stillTrue: Math.max(0, repliesQuotingBefore - affected),
      correctionsSent,
    };
  }

  const medianThisWeek = medianFirstResponse(recentThreads, week);
  const medianPrevWeek = medianFirstResponse(recentThreads, prevWeek);

  return {
    generatedAt: now,
    needsAction: { needsStaff, ready, policyChangesToReview, followUpsDue },
    upNext,
    kpis: {
      repliesSent7d: { value: repliesThisWeek, previous: repliesPrevWeek } as Kpi<number>,
      medianFirstResponseMs7d: { value: medianThisWeek, previous: medianPrevWeek } as Kpi<number | null>,
      verifiedBeforeSendPct7d: { value: verifiedPct(week), previous: verifiedPct(prevWeek) } as Kpi<number | null>,
      correctionsSent30d: { value: correctionSendsIn(month), previous: correctionSendsIn(prevMonth) } as Kpi<number>,
    },
    series: { repliesPerDay14 },
    breakdown: {
      draftOutcomes30d,
      inquiryMix30d: { inquiry, booked },
    },
    comparisons: {
      weekOverWeek: {
        replies: { a: repliesThisWeek, b: repliesPrevWeek } as Pair<number>,
        medianFirstResponseMs: { a: medianThisWeek, b: medianPrevWeek } as Pair<number | null>,
        needsYouCreated: { a: needsYouIn(week), b: needsYouIn(prevWeek) } as Pair<number>,
        corrections: { a: correctionSendsIn(week), b: correctionSendsIn(prevWeek) } as Pair<number>,
      },
      latestPageChange,
      draftedVsSent,
    },
  };
}

export type OverviewSummary = Awaited<ReturnType<typeof overviewSummary>>;

/**
 * Overview dashboard data for one inn. `clock` is ignored by the handler
 * exactly as in `threads.stats`: the client passes the current minute so the
 * subscription re-runs (with a fresh server `Date.now()`) when a window or
 * the inn's local day rolls over without any row changing.
 */
export const summary = query({
  args: { innId: v.id("inns"), clock: v.optional(v.number()) },
  handler: async (ctx, { innId }): Promise<OverviewSummary> => {
    const { inn } = await requireInnAccess(ctx, innId);
    return await overviewSummary(ctx, inn, Date.now(), await aggregatesReady(ctx));
  },
});
