import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canAccessInn, canUseLiveMail, type LiveMailDecision } from "./lib/tenant";

type Ctx = QueryCtx | MutationCtx;

export type InnAccess = {
  user: Doc<"users">;
  inn: Doc<"inns">;
  membership: Doc<"memberships">;
};

export async function currentUser(ctx: Ctx): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  return await ctx.db.get(userId);
}

export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const user = await currentUser(ctx);
  if (user === null) {
    throw new ConvexError({ code: "unauthenticated", message: "Sign in required" });
  }
  return user;
}

export async function membershipFor(
  ctx: Ctx,
  innId: Id<"inns">,
  userId: Id<"users">,
): Promise<Doc<"memberships"> | null> {
  return await ctx.db
    .query("memberships")
    .withIndex("by_inn_user", (q) => q.eq("innId", innId).eq("userId", userId))
    .unique();
}

/** Resolves the caller's membership in `innId` or throws `forbidden`. */
export async function requireInnAccess(ctx: Ctx, innId: Id<"inns">): Promise<InnAccess> {
  const user = await requireUser(ctx);
  const inn = await ctx.db.get(innId);
  const membership = inn ? await membershipFor(ctx, innId, user._id) : null;
  if (!inn || !canAccessInn(membership, innId)) {
    // Same error for "does not exist" and "not yours" so ids cannot be probed.
    throw new ConvexError({ code: "forbidden", message: "No access to this inn" });
  }
  return { user, inn, membership: membership! };
}

export async function requireThreadAccess(
  ctx: Ctx,
  threadId: Id<"threads">,
): Promise<InnAccess & { thread: Doc<"threads"> }> {
  const user = await requireUser(ctx);
  const thread = await ctx.db.get(threadId);
  if (!thread) throw new ConvexError({ code: "forbidden", message: "No access to this thread" });
  const access = await requireInnAccess(ctx, thread.innId);
  return { ...access, user, thread };
}

export function liveMailDecision(access: InnAccess): LiveMailDecision {
  return canUseLiveMail(access.user, access.inn, access.membership);
}

/** Live mail authority: real staff on a non-demo inn. Demo data never qualifies. */
export async function requireLiveMailAccess(ctx: Ctx, innId: Id<"inns">): Promise<InnAccess> {
  const access = await requireInnAccess(ctx, innId);
  const decision = liveMailDecision(access);
  if (!decision.allowed) {
    throw new ConvexError({ code: "live_mail_forbidden", reason: decision.reason });
  }
  return access;
}
