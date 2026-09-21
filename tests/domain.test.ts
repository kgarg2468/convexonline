import { describe, expect, it } from "vitest";
import { CLAIM_TTL_MS, evaluateClaim, evaluateRelease, isClaimActive } from "../convex/lib/claimLocks";
import { canAccessInn, canJoinInn, canUseLiveMail } from "../convex/lib/tenant";
import { findReplacementPassage, partitionClaimsBySourceChange } from "../convex/lib/sourceChange";

describe("claim locks", () => {
  const now = 1_000_000;
  it("acquires an unclaimed thread", () => {
    expect(evaluateClaim({}, "a", now)).toEqual({ ok: true, kind: "acquired" });
  });
  it("renews for the same holder and denies another staff member while active", () => {
    const state = { claimedBy: "a", claimedAt: now - 60_000 };
    expect(evaluateClaim(state, "a", now)).toEqual({ ok: true, kind: "renewed" });
    expect(evaluateClaim(state, "b", now)).toEqual({ ok: false, heldBy: "a", expiresAt: state.claimedAt + CLAIM_TTL_MS });
  });
  it("lets another staff member take over an expired claim", () => {
    const state = { claimedBy: "a", claimedAt: now - CLAIM_TTL_MS - 1 };
    expect(isClaimActive(state, now)).toBe(false);
    expect(evaluateClaim(state, "b", now)).toEqual({ ok: true, kind: "took_over_expired" });
  });
  it("only the holder may release an active claim", () => {
    const state = { claimedBy: "a", claimedAt: now };
    expect(evaluateRelease(state, "b", now)).toEqual({ ok: false, heldBy: "a" });
    expect(evaluateRelease(state, "a", now)).toEqual({ ok: true });
    expect(evaluateRelease({}, "b", now)).toEqual({ ok: true });
  });
});

describe("tenant rules", () => {
  const staff = { _id: "u1", isAnonymous: false };
  const anon = { _id: "u2", isAnonymous: true };
  const realInn = { _id: "inn1", isDemo: false };
  const demoInn = { _id: "inn2", isDemo: true };

  it("membership must match the inn", () => {
    expect(canAccessInn({ innId: "inn1", userId: "u1", role: "owner" }, "inn1")).toBe(true);
    expect(canAccessInn({ innId: "inn1", userId: "u1", role: "owner" }, "inn2")).toBe(false);
    expect(canAccessInn(null, "inn1")).toBe(false);
  });

  it("live mail requires real staff on a real inn", () => {
    expect(canUseLiveMail(staff, realInn, { innId: "inn1", userId: "u1", role: "owner" })).toEqual({ allowed: true });
    expect(canUseLiveMail(staff, realInn, { innId: "inn1", userId: "u1", role: "staff" })).toEqual({ allowed: true });
    expect(canUseLiveMail(staff, realInn, null)).toEqual({ allowed: false, reason: "no_membership" });
    expect(canUseLiveMail(anon, demoInn, { innId: "inn2", userId: "u2", role: "demo" })).toEqual({
      allowed: false,
      reason: "anonymous_user",
    });
    expect(canUseLiveMail(staff, demoInn, { innId: "inn2", userId: "u1", role: "owner" })).toEqual({
      allowed: false,
      reason: "demo_inn",
    });
    expect(canUseLiveMail(staff, realInn, { innId: "inn1", userId: "u1", role: "demo" })).toEqual({
      allowed: false,
      reason: "demo_role",
    });
    // Even an anonymous user somehow holding an owner role on a real inn is refused.
    expect(canUseLiveMail(anon, realInn, { innId: "inn1", userId: "u2", role: "owner" })).toEqual({
      allowed: false,
      reason: "anonymous_user",
    });
  });

  it("anonymous users may only join demo inns as demo", () => {
    expect(canJoinInn(anon, demoInn, "demo")).toBe(true);
    expect(canJoinInn(anon, realInn, "demo")).toBe(false);
    expect(canJoinInn(anon, demoInn, "staff")).toBe(false);
    expect(canJoinInn(staff, realInn, "staff")).toBe(true);
  });
});

describe("source change partition", () => {
  const oldQuote = "dogs are welcome for a $25 per night pet fee";
  const newPage = "## Pets\n\nDogs are welcome for a $40 per night pet fee.\n\n## Cancellation\n\nFull refund 7 days out.";
  const claims = [
    { id: 1, pageId: "policies", quote: oldQuote },
    { id: 2, pageId: "policies", quote: "Full refund 7 days out." },
    { id: 3, pageId: "rooms", quote: "queen bed" },
    { id: 4, pageId: "policies", quote: "" },
  ];

  it("flags vanished quotes, keeps surviving quotes and other pages as controls", () => {
    const { affected, unaffected } = partitionClaimsBySourceChange(claims, "policies", newPage);
    expect(affected.map((c) => c.id)).toEqual([1, 4]);
    expect(unaffected.map((c) => c.id)).toEqual([2, 3]);
    expect(unaffected.find((c) => c.id === 3)?.verification).toBeNull();
    expect(unaffected.find((c) => c.id === 2)?.verification).toMatchObject({ verified: true });
    expect(affected.find((c) => c.id === 4)?.verification).toEqual({ verified: false, reason: "empty" });
  });

  it("finds the closest replacement passage for review", () => {
    expect(findReplacementPassage(newPage, oldQuote)).toBe("Dogs are welcome for a $40 per night pet fee.");
    expect(findReplacementPassage(newPage, "")).toBeUndefined();
  });
});
