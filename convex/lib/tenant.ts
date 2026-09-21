/**
 * Tenant rules. Every staff-facing query and mutation resolves the caller's
 * membership in the inn that owns the record, and nothing else is visible.
 * Live mail (creating inboxes, sending replies) additionally requires a real
 * staff account on a non-demo inn: demo data can never confer mail authority.
 */

export type MembershipRole = "owner" | "staff" | "demo";

export type MembershipLike = { innId: string; userId: string; role: MembershipRole };
export type UserLike = { _id: string; isAnonymous?: boolean };
export type InnLike = { _id: string; isDemo: boolean };

export function canAccessInn(membership: MembershipLike | null | undefined, innId: string): boolean {
  return membership != null && membership.innId === innId;
}

export type LiveMailDecision =
  | { allowed: true }
  | { allowed: false; reason: "no_membership" | "anonymous_user" | "demo_inn" | "demo_role" };

export function canUseLiveMail(
  user: UserLike,
  inn: InnLike,
  membership: MembershipLike | null | undefined,
): LiveMailDecision {
  if (!canAccessInn(membership, inn._id)) return { allowed: false, reason: "no_membership" };
  if (user.isAnonymous === true) return { allowed: false, reason: "anonymous_user" };
  if (inn.isDemo) return { allowed: false, reason: "demo_inn" };
  if (membership!.role === "demo") return { allowed: false, reason: "demo_role" };
  return { allowed: true };
}

/** Anonymous users may only ever hold demo memberships on demo inns. */
export function canJoinInn(user: UserLike, inn: InnLike, role: MembershipRole): boolean {
  if (user.isAnonymous === true) return inn.isDemo && role === "demo";
  return !inn.isDemo || role === "demo";
}
