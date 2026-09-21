import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

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
