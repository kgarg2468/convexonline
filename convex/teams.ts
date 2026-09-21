/**
 * Staff invitations and team membership.
 *
 * An invitation is a one-use capability: a 256-bit random token minted in an
 * action, whose SHA-256 is the only thing ever stored. The raw token is
 * returned once to the owner who created it and is never listed, logged, or
 * echoed in errors. Acceptance is a single mutation, so two recipients racing
 * for the same token are serialized and exactly one of them joins.
 */
import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { membershipFor, requireLiveMailAccess, requireUser, type InnAccess } from "./access";
import { sha256Hex } from "./lib/quotes";
import { canJoinInn } from "./lib/tenant";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OUTSTANDING_INVITES = 20;
const MAX_LABEL_LENGTH = 120;
/** Exactly the format `createInvite` returns: 32 random bytes as lowercase hex. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

type Ctx = QueryCtx | MutationCtx;

export type InviteState = "pending" | "used" | "revoked" | "expired";

export function inviteState(invite: Pick<Doc<"teamInvites">, "usedBy" | "revokedAt" | "expiresAt">, now: number): InviteState {
  if (invite.usedBy !== undefined) return "used";
  if (invite.revokedAt !== undefined) return "revoked";
  if (invite.expiresAt <= now) return "expired";
  return "pending";
}

/**
 * Team management authority: the inn's owner, as a real account on a live inn.
 * `requireLiveMailAccess` already refuses anonymous users, demo inns and demo
 * roles, so the same rule that gates outgoing mail gates who may hire.
 */
async function requireOwner(ctx: Ctx, innId: Id<"inns">): Promise<InnAccess> {
  const access = await requireLiveMailAccess(ctx, innId);
  if (access.membership.role !== "owner") {
    throw new ConvexError({ code: "forbidden", message: "Only the owner can manage the team" });
  }
  return access;
}

/** A signed-in real account; demo visitors can never hold staff memberships. */
async function requireStaffAccount(ctx: Ctx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.isAnonymous === true) {
    throw new ConvexError({ code: "forbidden", message: "Sign in with a staff account to join a team" });
  }
  return user;
}

function parseLabel(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new ConvexError({ code: "invalid", message: `Label must be at most ${MAX_LABEL_LENGTH} characters` });
  }
  return trimmed;
}

/** Hashes a client-supplied token, or returns null when it is not in the minted format. */
async function hashIfWellFormed(token: string): Promise<string | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  return await sha256Hex(token);
}

async function findByToken(ctx: Ctx, token: string): Promise<Doc<"teamInvites"> | null> {
  const tokenHash = await hashIfWellFormed(token);
  if (tokenHash === null) return null;
  return await ctx.db
    .query("teamInvites")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}

/** Invitations that can still be accepted right now. */
async function outstandingInvites(ctx: Ctx, innId: Id<"inns">, now: number): Promise<Doc<"teamInvites">[]> {
  const unexpired = await ctx.db
    .query("teamInvites")
    .withIndex("by_inn_expiresAt", (q) => q.eq("innId", innId).gt("expiresAt", now))
    .collect();
  return unexpired.filter((invite) => inviteState(invite, now) === "pending");
}

const inviteRefused = (reason: "unknown" | "expired" | "revoked" | "used", message: string) =>
  new ConvexError({ code: "invite_refused", reason, message });

/**
 * Whether the account that consumed an invitation still holds the access it
 * granted. Once the owner removes them (or their row is only a demo role) the
 * spent token must not read as a successful join, and it never re-grants it.
 */
async function stillHoldsAccess(ctx: Ctx, invite: Doc<"teamInvites">, userId: Id<"users">): Promise<boolean> {
  if (invite.usedBy !== userId) return false;
  const membership = await membershipFor(ctx, invite.innId, userId);
  return membership !== null && (membership.role === "owner" || membership.role === "staff");
}

/**
 * Mints an invitation. Randomness lives here, in an action, where
 * `crypto.getRandomValues` is available; the mutation only ever sees the hash
 * and re-checks the caller's ownership itself, so a stored invite always has an
 * owner behind it.
 */
export const createInvite = action({
  args: { innId: v.id("inns"), label: v.optional(v.string()) },
  handler: async (ctx, { innId, label }): Promise<{ inviteId: Id<"teamInvites">; token: string; expiresAt: number }> => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const tokenHash = await sha256Hex(token);
    const stored: { inviteId: Id<"teamInvites">; expiresAt: number } = await ctx.runMutation(internal.teams.storeInvite, {
      innId,
      tokenHash,
      label,
    });
    return { inviteId: stored.inviteId, token, expiresAt: stored.expiresAt };
  },
});

export const storeInvite = internalMutation({
  args: { innId: v.id("inns"), tokenHash: v.string(), label: v.optional(v.string()) },
  handler: async (ctx, { innId, tokenHash, label }) => {
    const access = await requireOwner(ctx, innId);
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      throw new ConvexError({ code: "invalid", message: "Malformed invitation" });
    }
    const cleanLabel = parseLabel(label);
    const now = Date.now();
    const outstanding = await outstandingInvites(ctx, innId, now);
    if (outstanding.length >= MAX_OUTSTANDING_INVITES) {
      throw new ConvexError({
        code: "invite_limit",
        message: `This inn already has ${MAX_OUTSTANDING_INVITES} open invitations; revoke one first`,
      });
    }
    const expiresAt = now + INVITE_TTL_MS;
    const inviteId = await ctx.db.insert("teamInvites", {
      innId,
      tokenHash,
      createdBy: access.user._id,
      createdAt: now,
      expiresAt,
      label: cleanLabel,
    });
    return { inviteId, expiresAt };
  },
});

/** Owner-only list of invitation metadata. Never includes hashes or tokens. */
export const listInvites = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    await requireOwner(ctx, innId);
    const now = Date.now();
    const invites = await ctx.db
      .query("teamInvites")
      .withIndex("by_inn_expiresAt", (q) => q.eq("innId", innId))
      .collect();
    invites.sort((a, b) => b.createdAt - a.createdAt);
    const result = [];
    for (const invite of invites) {
      const usedBy = invite.usedBy ? await membershipFor(ctx, innId, invite.usedBy) : null;
      result.push({
        _id: invite._id,
        label: invite.label ?? null,
        state: inviteState(invite, now),
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        usedAt: invite.usedAt ?? null,
        usedByName: usedBy?.name ?? null,
        revokedAt: invite.revokedAt ?? null,
      });
    }
    return result;
  },
});

/** Idempotent: revoking an already used, expired or revoked invite reports its state unchanged. */
export const revokeInvite = mutation({
  args: { inviteId: v.id("teamInvites") },
  handler: async (ctx, { inviteId }) => {
    const invite = await ctx.db.get(inviteId);
    // Same error as a foreign invite so ids cannot be probed.
    if (!invite) throw new ConvexError({ code: "forbidden", message: "No access to this invitation" });
    await requireOwner(ctx, invite.innId);
    const now = Date.now();
    const state = inviteState(invite, now);
    if (state !== "pending") return { state };
    await ctx.db.patch(inviteId, { revokedAt: now });
    return { state: "revoked" as const };
  },
});

/**
 * What a signed-in recipient may learn from a link before accepting: the inn's
 * name and whether the invitation still works. Unknown or malformed tokens look
 * exactly alike so the endpoint cannot be used to probe for valid ones.
 */
export const previewInvite = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireStaffAccount(ctx);
    const invite = await findByToken(ctx, token);
    const inn = invite ? await ctx.db.get(invite.innId) : null;
    if (!invite || !inn || inn.isDemo) return { state: "invalid" as const };
    const now = Date.now();
    const state = inviteState(invite, now);
    return {
      state,
      innName: inn.name,
      expiresAt: invite.expiresAt,
      /**
       * True when this very account consumed it and still holds the membership
       * it granted: accepting again is a no-op that succeeds. False once the
       * owner has removed them, so the UI does not offer a join that would be refused.
       */
      acceptedByYou: await stillHoldsAccess(ctx, invite, user._id),
    };
  },
});

/**
 * Consumes the invitation and grants staff membership in one transaction.
 * Existing members keep whatever role they have (an owner is never downgraded);
 * the token is still spent so it cannot be forwarded afterwards. The same
 * recipient may retry and gets the same answer for as long as they remain a
 * member; once the owner removes them the spent token is refused like any
 * other used one and never restores the membership.
 */
export const acceptInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireStaffAccount(ctx);
    const invite = await findByToken(ctx, token);
    if (!invite) throw inviteRefused("unknown", "This invitation link is not valid");
    const inn = await ctx.db.get(invite.innId);
    if (!inn || inn.isDemo) throw inviteRefused("unknown", "This invitation link is not valid");
    const now = Date.now();
    if (invite.usedBy !== undefined) {
      if (await stillHoldsAccess(ctx, invite, user._id)) {
        return { innId: inn._id, joined: false as const };
      }
      throw inviteRefused("used", "This invitation has already been used");
    }
    if (invite.revokedAt !== undefined) throw inviteRefused("revoked", "This invitation was revoked");
    if (invite.expiresAt <= now) throw inviteRefused("expired", "This invitation has expired");
    if (!canJoinInn(user, inn, "staff")) {
      throw new ConvexError({ code: "forbidden", message: "This account cannot join a team" });
    }
    const existing = await membershipFor(ctx, inn._id, user._id);
    if (!existing) {
      await ctx.db.insert("memberships", {
        innId: inn._id,
        userId: user._id,
        role: "staff",
        name: user.name ?? user.email ?? "Staff",
      });
    }
    await ctx.db.patch(invite._id, { usedBy: user._id, usedAt: now });
    return { innId: inn._id, joined: !existing };
  },
});

/**
 * Removes a staff member from the owner's inn. Owners (including the caller)
 * can never be removed here. Claim locks the leaver still holds on this inn's
 * threads are released so the rest of the team is not locked out until the
 * claim TTL passes; outbox rows they reserved are refused at dispatch by the
 * existing authority recheck.
 */
export const removeStaff = mutation({
  args: { innId: v.id("inns"), userId: v.id("users") },
  handler: async (ctx, { innId, userId }) => {
    const access = await requireOwner(ctx, innId);
    if (userId === access.user._id) {
      throw new ConvexError({ code: "forbidden", message: "You cannot remove yourself" });
    }
    const target = await membershipFor(ctx, innId, userId);
    if (!target || target.role !== "staff") {
      throw new ConvexError({ code: "forbidden", message: "Only staff members can be removed" });
    }
    await ctx.db.delete(target._id);
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_inn_lastInbound", (q) => q.eq("innId", innId))
      .collect();
    let released = 0;
    for (const thread of threads) {
      if (thread.claimedBy !== userId) continue;
      await ctx.db.patch(thread._id, { claimedBy: undefined, claimedAt: undefined });
      released += 1;
    }
    return { released };
  },
});
