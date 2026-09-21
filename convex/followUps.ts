import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const FOLLOW_UP_DELAY_MS = 48 * 60 * 60 * 1000;

/**
 * Follow-ups are reminders, never outbound mail: when a reply to a booking
 * inquiry goes unanswered for FOLLOW_UP_DELAY_MS the thread surfaces as
 * `needs_staff` with the reminder marked due. A guest reply cancels it.
 */
export async function scheduleFollowUp(ctx: MutationCtx, threadId: Id<"threads">, now: number) {
  await cancelFollowUps(ctx, threadId);
  const dueAt = now + FOLLOW_UP_DELAY_MS;
  const followUpId = await ctx.db.insert("followUps", { threadId, dueAt, status: "scheduled" });
  const scheduledId = await ctx.scheduler.runAt(dueAt, internal.followUps.fire, { followUpId });
  await ctx.db.patch(followUpId, { scheduledId });
  return followUpId;
}

export async function cancelFollowUps(ctx: MutationCtx, threadId: Id<"threads">) {
  const rows = await ctx.db
    .query("followUps")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  for (const row of rows) {
    if (row.status !== "scheduled" && row.status !== "due") continue;
    if (row.scheduledId) {
      const scheduled = await ctx.db.system.get(row.scheduledId);
      if (scheduled && (scheduled.state.kind === "pending" || scheduled.state.kind === "inProgress")) {
        await ctx.scheduler.cancel(row.scheduledId);
      }
    }
    await ctx.db.patch(row._id, { status: "cancelled" });
  }
}

export const fire = internalMutation({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    const row = await ctx.db.get(followUpId);
    if (!row || row.status !== "scheduled") return null;
    const thread = await ctx.db.get(row.threadId);
    if (!thread) return null;
    // Anything the guest sent after the reply already cancelled us; be defensive.
    if (thread.lastInboundAt > row._creationTime) {
      await ctx.db.patch(followUpId, { status: "cancelled" });
      return null;
    }
    await ctx.db.patch(followUpId, { status: "due" });
    if (thread.status === "waiting_guest" || thread.status === "sent") {
      await ctx.db.patch(thread._id, { status: "needs_staff" });
    }
    return null;
  },
});
