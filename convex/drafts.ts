import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireThreadAccess } from "./access";
import { evaluateClaim } from "./lib/claimLocks";

/** Staff edit of the draft answer. Sending is a separate, live-mail-gated step. */
export const edit = mutation({
  args: { draftId: v.id("drafts"), answer: v.string() },
  handler: async (ctx, { draftId, answer }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) throw new ConvexError({ code: "forbidden", message: "No access to this draft" });
    const { thread, user } = await requireThreadAccess(ctx, draft.threadId);
    if (draft.status === "sent" || draft.status === "superseded") {
      throw new ConvexError({ code: "invalid", message: "This draft can no longer be edited" });
    }
    const lock = evaluateClaim(thread, user._id, Date.now());
    if (!lock.ok) {
      throw new ConvexError({ code: "claimed", heldBy: lock.heldBy, expiresAt: lock.expiresAt });
    }
    const trimmed = answer.trim();
    if (trimmed.length === 0 || trimmed.length > 20_000) {
      throw new ConvexError({ code: "invalid", message: "Answer must be between 1 and 20000 characters" });
    }
    await ctx.db.patch(draftId, { answer: trimmed });
    return null;
  },
});
