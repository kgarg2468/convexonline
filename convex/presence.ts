/**
 * Thread presence: which staff members currently have a thread open.
 *
 * Backed by @convex-dev/presence with one room per thread. The component's
 * own functions are never exposed: heartbeats derive the user from the auth
 * session, and reads re-check the caller's membership on every run and only
 * ever return users who are members of the inn right now. Room bearer tokens
 * stay inside the component, so a removed member holds nothing that reads
 * presence after their membership is gone.
 *
 * There is no disconnect endpoint. A session that stops heartbeating is timed
 * out by the component's worker `PRESENCE_TTL_MS` after its last heartbeat,
 * which is the whole "leave" story for closed tabs and navigated-away threads.
 */
import { ConvexError, v } from "convex/values";
import { Presence } from "@convex-dev/presence";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { membershipFor, requireThreadAccess } from "./access";
import { HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_MS } from "./lib/presenceTiming";

// Re-exported so server-side callers and tests keep a single import site.
export { HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_MS };
/** Random, URL-safe, bounded. Anything else is refused before touching the component. */
const CLIENT_SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const presence = new Presence(components.presence);

/**
 * Component session ids are global, and the component refuses a session id
 * that already exists under another room or user. Namespacing the client's
 * random id under the server-derived thread and user means a stolen or
 * guessed client id can never collide with, or take over, someone else's
 * session.
 */
export function sessionKey(threadId: Id<"threads">, userId: Id<"users">, clientSessionId: string): string {
  return `${threadId}:${userId}:${clientSessionId}`;
}

export const heartbeat = mutation({
  args: { threadId: v.id("threads"), clientSessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId, clientSessionId }) => {
    if (!CLIENT_SESSION_ID.test(clientSessionId)) {
      throw new ConvexError({ code: "invalid", message: "Malformed presence session id" });
    }
    const { user } = await requireThreadAccess(ctx, threadId);
    await presence.heartbeat(ctx, threadId, user._id, sessionKey(threadId, user._id, clientSessionId), HEARTBEAT_INTERVAL_MS);
    // The component's room and session tokens are deliberately not returned.
    return null;
  },
});

export const list = query({
  args: { threadId: v.id("threads") },
  returns: v.array(v.object({ userId: v.id("users"), name: v.string(), isYou: v.boolean() })),
  handler: async (ctx, { threadId }) => {
    const { user, thread } = await requireThreadAccess(ctx, threadId);
    const online = await presence.listRoom(ctx, threadId, true);
    const viewers = [];
    for (const row of online) {
      // Only the component ever wrote these user ids, but the membership
      // lookup below is what decides who is shown: a user removed from the
      // inn disappears here immediately, however long their session lingers.
      const userId = ctx.db.normalizeId("users", row.userId);
      if (userId === null) continue;
      const membership = await membershipFor(ctx, thread.innId, userId);
      if (membership === null) continue;
      viewers.push({ userId, name: membership.name, isYou: userId === user._id });
    }
    viewers.sort((a, b) => Number(b.isYou) - Number(a.isYou) || a.name.localeCompare(b.name));
    return viewers;
  },
});
