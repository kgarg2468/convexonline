/**
 * Thread claim locks. A claim is held by one staff member for CLAIM_TTL_MS;
 * another staff member may only take a thread once the lock has expired. The
 * decision is pure so the mutation applying it stays a single read-then-write,
 * which Convex executes serializably, so two racing claims cannot both win.
 */

export const CLAIM_TTL_MS = 10 * 60 * 1000;

export type ClaimState = { claimedBy?: string; claimedAt?: number };

export type ClaimDecision =
  | { ok: true; kind: "acquired" | "renewed" | "took_over_expired" }
  | { ok: false; heldBy: string; expiresAt: number };

export function isClaimActive(state: ClaimState, now: number, ttlMs = CLAIM_TTL_MS): boolean {
  return state.claimedBy != null && state.claimedAt != null && now - state.claimedAt < ttlMs;
}

export function evaluateClaim(
  state: ClaimState,
  actor: string,
  now: number,
  ttlMs = CLAIM_TTL_MS,
): ClaimDecision {
  if (state.claimedBy == null || state.claimedAt == null) {
    return { ok: true, kind: "acquired" };
  }
  if (state.claimedBy === actor) {
    return { ok: true, kind: "renewed" };
  }
  if (isClaimActive(state, now, ttlMs)) {
    return { ok: false, heldBy: state.claimedBy, expiresAt: state.claimedAt + ttlMs };
  }
  return { ok: true, kind: "took_over_expired" };
}

export type ReleaseDecision = { ok: true } | { ok: false; heldBy: string };

export function evaluateRelease(
  state: ClaimState,
  actor: string,
  now: number,
  ttlMs = CLAIM_TTL_MS,
): ReleaseDecision {
  if (state.claimedBy == null) return { ok: true };
  if (state.claimedBy === actor) return { ok: true };
  if (!isClaimActive(state, now, ttlMs)) return { ok: true };
  return { ok: false, heldBy: state.claimedBy };
}
