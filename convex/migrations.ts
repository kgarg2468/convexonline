import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./functions";
import { BACKFILL_TABLES, backfillRow, type BackfillTable } from "./aggregates";

const BATCH = 100;

/**
 * Backfills `messages.innId` from each message's thread so the
 * `by_inn_rfc_message_id` index covers rows written before the field existed.
 *
 * One call handles at most `BATCH` messages and returns the cursor to continue
 * from; the operator repeats the call with the returned cursor until `done` is
 * true. Only rows whose `innId` is missing or disagrees with the thread's inn
 * are patched, so re-running over already-backfilled rows is a no-op. Messages
 * whose thread no longer exists are counted and left untouched.
 *
 * Run from the dashboard or CLI:
 *   npx convex run migrations:backfillMessageInnIds '{}'
 *   npx convex run migrations:backfillMessageInnIds '{"cursor":"<cursor from the previous result>"}'
 */
export const backfillMessageInnIds = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("messages").paginate({ cursor: args.cursor ?? null, numItems: BATCH });
    let updated = 0;
    let skipped = 0;
    let missingThread = 0;
    for (const message of page.page) {
      const thread = await ctx.db.get(message.threadId);
      if (!thread) {
        missingThread += 1;
        continue;
      }
      if (message.innId === thread.innId) {
        skipped += 1;
        continue;
      }
      await ctx.db.patch(message._id, { innId: thread.innId });
      updated += 1;
    }
    return {
      done: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
      scanned: page.page.length,
      updated,
      skipped,
      missingThread,
    };
  },
});

/**
 * Walks `threads`, `sentReplies` and `corrections` into the stats aggregates
 * (convex/aggregates.ts) after the trigger-wrapped writers are deployed.
 *
 * One call handles at most `BATCH` rows of the first unfinished table and
 * persists its cursor in `aggregateBackfills`, so a run can stop and resume
 * at any point and re-running over finished rows is a no-op
 * (`insertIfDoesNotExist`). Rows written or changed while the walk is in
 * progress are kept current by the idempotent triggers, and nothing is ever
 * cleared, so live writes never race a wipe. `threads.stats` switches to the
 * component only once every table row here is `done`.
 *
 * Run from the dashboard or CLI, repeating until `done` is true:
 *   npx convex run migrations:backfillAggregates '{}'
 * or let it drive itself to completion:
 *   npx convex run migrations:runAggregateBackfill '{}'
 * Pass `{"restart": true}` to walk every table again from the start (safe;
 * the aggregates are not cleared and existing entries are skipped).
 */
export const backfillAggregates = internalMutation({
  args: { restart: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.restart) {
      for (const table of BACKFILL_TABLES) {
        const state = await ctx.db
          .query("aggregateBackfills")
          .withIndex("by_table", (q) => q.eq("table", table))
          .unique();
        if (state) await ctx.db.patch(state._id, { cursor: undefined, done: false, processed: 0, startedAt: now, updatedAt: now });
      }
    }
    let table: BackfillTable | null = null;
    let state: Doc<"aggregateBackfills"> | null = null;
    for (const candidate of BACKFILL_TABLES) {
      const row = await ctx.db
        .query("aggregateBackfills")
        .withIndex("by_table", (q) => q.eq("table", candidate))
        .unique();
      if (row?.done) continue;
      table = candidate;
      state = row;
      break;
    }
    if (table === null) return { done: true, table: null, scanned: 0, processed: 0 };
    if (!state) {
      const id = await ctx.db.insert("aggregateBackfills", { table, done: false, processed: 0, startedAt: now, updatedAt: now });
      state = (await ctx.db.get(id))!;
    }
    const page = await ctx.db.query(table).paginate({ cursor: state.cursor ?? null, numItems: BATCH });
    for (const doc of page.page) await backfillRow(ctx, table, doc);
    const processed = state.processed + page.page.length;
    await ctx.db.patch(state._id, {
      cursor: page.isDone ? undefined : page.continueCursor,
      done: page.isDone,
      processed,
      updatedAt: now,
    });
    // Done only when this batch finished the last table.
    let done = page.isDone;
    if (done) {
      for (const other of BACKFILL_TABLES) {
        if (other === table) continue;
        const row = await ctx.db
          .query("aggregateBackfills")
          .withIndex("by_table", (q) => q.eq("table", other))
          .unique();
        if (!row?.done) done = false;
      }
    }
    return { done, table, scanned: page.page.length, processed };
  },
});

type BackfillStep = { done: boolean; table: BackfillTable | null; scanned: number; processed: number };

/** Runs `backfillAggregates` batch after batch until every table is done. */
export const runAggregateBackfill = internalMutation({
  args: { restart: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<BackfillStep> => {
    const step: BackfillStep = await ctx.runMutation(internal.migrations.backfillAggregates, { restart: args.restart });
    if (!step.done) await ctx.scheduler.runAfter(0, internal.migrations.runAggregateBackfill, {});
    return step;
  },
});
