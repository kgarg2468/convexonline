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
import { cancelRemovedApproverBatch } from "./followUps";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OUTSTANDING_INVITES = 20;
/** How much invitation history `listInvites` shows besides everything still pending. */
export const RECENT_INVITES_SHOWN = 50;
/** Claim locks released per transaction when a member is removed. */
export const CLAIM_RELEASE_BATCH = 100;
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

/**
 * Invitations that can still be accepted right now. Reads only open, unexpired
 * rows and at most one past the cap: `storeInvite` enforces the cap in the same
 * transaction, so more than `MAX_OUTSTANDING_INVITES` can never accumulate and
 * the read stays bounded no matter how long the inn's history grows.
 */
async function outstandingInvites(ctx: Ctx, innId: Id<"inns">, now: number): Promise<Doc<"teamInvites">[]> {
  const open = await ctx.db
    .query("teamInvites")
    .withIndex("by_inn_open_expiresAt", (q) => q.eq("innId", innId).eq("isOpen", true).gt("expiresAt", now))
    .take(MAX_OUTSTANDING_INVITES + 1);
  return open.filter((invite) => inviteState(invite, now) === "pending");
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
      isOpen: true,
    });
    return { inviteId, expiresAt };
  },
});

/**
 * Owner-only list of invitation metadata. Never includes hashes or tokens.
 * Bounded: every invitation still pending (so an old unexpired link is never
 * hidden behind newer history) plus the most recent `RECENT_INVITES_SHOWN`
 * rows of any state, newest first.
 */
export const listInvites = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    await requireOwner(ctx, innId);
    const now = Date.now();
    const pending = await outstandingInvites(ctx, innId, now);
    // expiresAt is createdAt + a constant TTL, so descending expiry is descending creation.
    const recent = await ctx.db
      .query("teamInvites")
      .withIndex("by_inn_expiresAt", (q) => q.eq("innId", innId))
      .order("desc")
      .take(RECENT_INVITES_SHOWN);
    const byId = new Map<Id<"teamInvites">, Doc<"teamInvites">>();
    for (const invite of [...pending, ...recent]) byId.set(invite._id, invite);
    const invites = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
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
    await ctx.db.patch(inviteId, { revokedAt: now, isOpen: false });
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
    await ctx.db.patch(invite._id, { usedBy: user._id, usedAt: now, isOpen: false });
    return { innId: inn._id, joined: !existing };
  },
});

/**
 * Releases up to one batch of the claim locks `userId` holds on `innId`'s
 * threads. Returns how many were released and whether any remain, so the
 * caller can schedule the next batch instead of growing the transaction.
 */
async function releaseClaimBatch(ctx: MutationCtx, innId: Id<"inns">, userId: Id<"users">): Promise<{ released: number; more: boolean }> {
  const held = await ctx.db
    .query("threads")
    .withIndex("by_inn_claimedBy", (q) => q.eq("innId", innId).eq("claimedBy", userId))
    .take(CLAIM_RELEASE_BATCH + 1);
  const batch = held.slice(0, CLAIM_RELEASE_BATCH);
  for (const thread of batch) {
    await ctx.db.patch(thread._id, { claimedBy: undefined, claimedAt: undefined });
  }
  return { released: batch.length, more: held.length > CLAIM_RELEASE_BATCH };
}

/**
 * Removes a staff member from the owner's inn. Owners (including the caller)
 * can never be removed here. Claim locks the leaver still holds on this inn's
 * threads are released so the rest of the team is not locked out until the
 * claim TTL passes; outbox rows they reserved are refused at dispatch by the
 * existing authority recheck.
 *
 * Only one bounded batch of claims is released here so that a long claim
 * history can never make the removal itself fail and roll back the access
 * revocation. Anything beyond that is cleared by `releaseRemovedMemberClaims`
 * in the background; `released` counts only what this transaction freed.
 *
 * Follow-up emails the leaver approved and that are still pending are
 * withdrawn the same way: one bounded batch keyed on the deleted membership
 * row, the rest in the background. Every approval names the membership row it
 * was made under, so the moment that row is deleted the due worker and the
 * dispatch preflight refuse all of them (pending or reserved) without any
 * scan, and a later re-invitation (a new row) never brings them back.
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
    const membershipId = target._id;
    await ctx.db.delete(membershipId);
    const { released, more } = await releaseClaimBatch(ctx, innId, userId);
    const approvals = await cancelRemovedApproverBatch(ctx, membershipId);
    if (!more && !approvals.more) return { released };
    await ctx.scheduler.runAfter(0, internal.teams.releaseRemovedMemberClaims, { innId, userId, membershipId });
    return { released, cleanupScheduled: true as const };
  },
});

/**
 * Background continuation of `removeStaff`, one batch per transaction, for
 * exactly the inn and user the removal named.
 *
 * Claim locks: stops the moment the user is a member again (re-invited before
 * the backlog drained) so it never erases claims they took legitimately.
 *
 * Follow-up approvals: keyed on the deleted membership row (`membershipId`),
 * so the batch keeps going after a rejoin. The old approvals are already dead
 * at dispatch; this only marks them cancelled for staff to see. Approvals made
 * after rejoining belong to the new row and are never touched.
 */
export const releaseRemovedMemberClaims = internalMutation({
  args: { innId: v.id("inns"), userId: v.id("users"), membershipId: v.optional(v.id("memberships")) },
  handler: async (ctx, { innId, userId, membershipId }) => {
    const rejoined = (await membershipFor(ctx, innId, userId)) !== null;
    let more = false;
    if (!rejoined) more = (await releaseClaimBatch(ctx, innId, userId)).more;
    if (membershipId !== undefined) more = (await cancelRemovedApproverBatch(ctx, membershipId)).more || more;
    if (more) await ctx.scheduler.runAfter(0, internal.teams.releaseRemovedMemberClaims, { innId, userId, membershipId });
  },
});
