/**
 * Per-inn aggregates behind `threads.stats`, kept in the Aggregate component
 * so the inbox header never scans an inn's threads, replies or corrections.
 *
 * Every instance is namespaced by inn id: an inn's counts live in their own
 * B-tree, tenants never share internal nodes, and every read here is bounded
 * to the inn the caller already proved access to.
 *
 * Writes reach the component through the triggers below, which
 * `convex/functions.ts` wraps into the app's `mutation` / `internalMutation`
 * builders. The idempotent trigger variants are used on purpose: rows that
 * existed before the component did are added by `migrations.backfillAggregates`,
 * and a live write to such a row inserts it instead of failing.
 */
import { TableAggregate } from "@convex-dev/aggregate";
import { Triggers } from "convex-helpers/server/triggers";
import { components } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { localDayOf } from "./lib/localDay";

/** Sort key of a thread without a first response; every real value is >= 0. */
export const NO_RESPONSE_KEY = -1;

const threadStatusKey = (doc: Doc<"threads">): [Doc<"threads">["status"]] => [doc.status];
const threadFirstResponseKey = (doc: Doc<"threads">): number =>
  typeof doc.firstResponseMs === "number" ? Math.max(0, doc.firstResponseMs) : NO_RESPONSE_KEY;
const sentReplyKey = (doc: Doc<"sentReplies">): number => doc.sentAt;
const correctionStatusKey = (doc: Doc<"corrections">): [Doc<"corrections">["status"]] => [doc.status];

/** Thread counts by status: key `[status]`, so one status is a prefix bound. */
export const threadStatusCounts = new TableAggregate<{
  Namespace: Id<"inns">;
  Key: [Doc<"threads">["status"]];
  DataModel: DataModel;
  TableName: "threads";
}>(components.threadStatusCounts, {
  namespace: (doc) => doc.innId,
  sortKey: threadStatusKey,
});

/**
 * First-response times ordered ascending, for the median. Threads that have
 * not been answered sort at `NO_RESPONSE_KEY`; readers bound at 0 to skip them.
 */
export const threadFirstResponseTimes = new TableAggregate<{
  Namespace: Id<"inns">;
  Key: number;
  DataModel: DataModel;
  TableName: "threads";
}>(components.threadFirstResponseTimes, {
  namespace: (doc) => doc.innId,
  sortKey: threadFirstResponseKey,
});

/** Sent replies (normal and correction sends) by send time, for today/total counts. */
export const sentRepliesBySentAt = new TableAggregate<{
  Namespace: Id<"inns">;
  Key: number;
  DataModel: DataModel;
  TableName: "sentReplies";
}>(components.sentRepliesBySentAt, {
  namespace: (doc) => doc.innId,
  sortKey: sentReplyKey,
});

/** Correction counts by status: key `[status]`. */
export const correctionStatusCounts = new TableAggregate<{
  Namespace: Id<"inns">;
  Key: [Doc<"corrections">["status"]];
  DataModel: DataModel;
  TableName: "corrections";
}>(components.correctionStatusCounts, {
  namespace: (doc) => doc.innId,
  sortKey: correctionStatusKey,
});

/** Table triggers that keep every aggregate in the same transaction as the row. */
export const triggers = new Triggers<DataModel>();
triggers.register("threads", threadStatusCounts.idempotentTrigger());
triggers.register("threads", threadFirstResponseTimes.idempotentTrigger());
triggers.register("sentReplies", sentRepliesBySentAt.idempotentTrigger());
triggers.register("corrections", correctionStatusCounts.idempotentTrigger());

export const BACKFILL_TABLES = ["threads", "sentReplies", "corrections"] as const;
export type BackfillTable = (typeof BACKFILL_TABLES)[number];

/** True once every source table has been walked into the component. */
export async function aggregatesReady(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  for (const table of BACKFILL_TABLES) {
    const state = await ctx.db
      .query("aggregateBackfills")
      .withIndex("by_table", (q) => q.eq("table", table))
      .unique();
    if (!state?.done) return false;
  }
  return true;
}

/** Adds one existing row to its aggregates; a no-op for rows already present. */
export async function backfillRow(ctx: MutationCtx, table: BackfillTable, doc: Doc<"threads"> | Doc<"sentReplies"> | Doc<"corrections">) {
  switch (table) {
    case "threads":
      await threadStatusCounts.insertIfDoesNotExist(ctx, doc as Doc<"threads">);
      await threadFirstResponseTimes.insertIfDoesNotExist(ctx, doc as Doc<"threads">);
      return;
    case "sentReplies":
      await sentRepliesBySentAt.insertIfDoesNotExist(ctx, doc as Doc<"sentReplies">);
      return;
    case "corrections":
      await correctionStatusCounts.insertIfDoesNotExist(ctx, doc as Doc<"corrections">);
      return;
  }
}

export type ThreadStats = {
  open: number;
  needsStaff: number;
  ready: number;
  waitingGuest: number;
  sentToday: number;
  sentTotal: number;
  pendingCorrections: number;
  medianFirstResponseMs: number | null;
};

type Ctx = QueryCtx | MutationCtx;

async function countThreads(ctx: Ctx, innId: Id<"inns">, status: Doc<"threads">["status"]) {
  return await threadStatusCounts.count(ctx, { namespace: innId, bounds: { prefix: [status] } });
}

/** Median of recorded first-response times; unanswered threads are excluded. */
async function medianFirstResponse(ctx: Ctx, innId: Id<"inns">): Promise<number | null> {
  const bounds = { lower: { key: 0, inclusive: true } };
  const n = await threadFirstResponseTimes.count(ctx, { namespace: innId, bounds });
  if (n === 0) return null;
  if (n % 2 === 1) {
    return (await threadFirstResponseTimes.at(ctx, (n - 1) / 2, { namespace: innId, bounds })).key;
  }
  const [lo, hi] = await threadFirstResponseTimes.atBatch(ctx, [
    { offset: n / 2 - 1, namespace: innId, bounds },
    { offset: n / 2, namespace: innId, bounds },
  ]);
  return (lo.key + hi.key) / 2;
}

/**
 * The stats contract read from the component. Callers check
 * `aggregatesReady` first; the counts are only meaningful once the backfill
 * has finished.
 */
export async function aggregateThreadStats(ctx: Ctx, inn: Doc<"inns">, nowMs: number): Promise<ThreadStats> {
  const day = localDayOf(inn.timezone, nowMs);
  const innId = inn._id;
  const [open, needsStaff, ready, waitingGuest] = await Promise.all([
    Promise.all([
      countThreads(ctx, innId, "new"),
      countThreads(ctx, innId, "drafting"),
      countThreads(ctx, innId, "needs_staff"),
      countThreads(ctx, innId, "ready"),
    ]).then((xs) => xs.reduce((a, b) => a + b, 0)),
    countThreads(ctx, innId, "needs_staff"),
    countThreads(ctx, innId, "ready"),
    countThreads(ctx, innId, "waiting_guest"),
  ]);
  const [sentTotal, sentToday] = await Promise.all([
    sentRepliesBySentAt.count(ctx, { namespace: innId }),
    sentRepliesBySentAt.count(ctx, {
      namespace: innId,
      bounds: { lower: { key: day.startMs, inclusive: true }, upper: { key: day.endMs, inclusive: false } },
    }),
  ]);
  const pendingCorrections = await correctionStatusCounts.count(ctx, {
    namespace: innId,
    bounds: { prefix: ["needs_review"] },
  });
  return {
    open,
    needsStaff,
    ready,
    waitingGuest,
    sentToday,
    sentTotal,
    pendingCorrections,
    medianFirstResponseMs: await medianFirstResponse(ctx, innId),
  };
}

/**
 * The same contract computed straight from the tables. Used while the
 * backfill is incomplete, and by tests as the authority the component is
 * compared against.
 */
export async function scannedThreadStats(ctx: Ctx, inn: Doc<"inns">, nowMs: number): Promise<ThreadStats> {
  const innId = inn._id;
  const threads = await ctx.db
    .query("threads")
    .withIndex("by_inn_lastInbound", (q) => q.eq("innId", innId))
    .collect();
  const count = (s: Doc<"threads">["status"]) => threads.filter((t) => t.status === s).length;
  const day = localDayOf(inn.timezone, nowMs);
  let sentTotal = 0;
  let sentToday = 0;
  for (const t of threads) {
    const replies = await ctx.db
      .query("sentReplies")
      .withIndex("by_thread", (q) => q.eq("threadId", t._id))
      .collect();
    for (const r of replies) {
      sentTotal += 1;
      if (r.sentAt >= day.startMs && r.sentAt < day.endMs) sentToday += 1;
    }
  }
  const pending = await ctx.db
    .query("corrections")
    .withIndex("by_inn_status", (q) => q.eq("innId", innId).eq("status", "needs_review"))
    .collect();
  const responseTimes = threads
    .map((t) => t.firstResponseMs)
    .filter((x): x is number => typeof x === "number")
    .map((x) => Math.max(0, x))
    .sort((a, b) => a - b);
  const median =
    responseTimes.length === 0
      ? null
      : responseTimes.length % 2 === 1
        ? responseTimes[(responseTimes.length - 1) / 2]
        : (responseTimes[responseTimes.length / 2 - 1] + responseTimes[responseTimes.length / 2]) / 2;
  return {
    open: count("new") + count("drafting") + count("needs_staff") + count("ready"),
    needsStaff: count("needs_staff"),
    ready: count("ready"),
    waitingGuest: count("waiting_guest"),
    sentToday,
    sentTotal,
    pendingCorrections: pending.length,
    medianFirstResponseMs: median,
  };
}
