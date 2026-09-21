import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { INVITE_TTL_MS, MAX_OUTSTANDING_INVITES } from "../convex/teams";
import { addStaff, makeTest, seedInn, seedThread, signedInUser } from "./setup";
import { agentmailReplyRoute, json, seedInboundThread, seedLiveInn, settle, stubFetch, withEnv } from "./integrationSetup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type T = ReturnType<typeof makeTest>;

const HEX64 = /^[0-9a-f]{64}$/;

const invites = (t: T) => t.run((ctx) => ctx.db.query("teamInvites").collect());
const memberships = (t: T, innId: Id<"inns">) =>
  t.run((ctx) => ctx.db.query("memberships").withIndex("by_inn", (q) => q.eq("innId", innId)).collect());
const membershipOf = (t: T, innId: Id<"inns">, userId: Id<"users">) =>
  t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_inn_user", (q) => q.eq("innId", innId).eq("userId", userId))
      .unique(),
  );

async function ownerWithInn(t: T, name = "Test Inn") {
  const owner = await signedInUser(t, { name: "Owner", email: "owner@example.com" });
  const innId = await seedInn(t, owner.userId, name);
  return { owner, innId };
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function failure(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

describe("creating invitations", () => {
  it("owner mints a 64-hex token; only its SHA-256 is stored and nothing else leaks the token", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId, label: "  Night desk  " });
    expect(created.token).toMatch(HEX64);
    expect(created.expiresAt).toBeGreaterThan(Date.now() + INVITE_TTL_MS - 5_000);
    expect(created.expiresAt).toBeLessThanOrEqual(Date.now() + INVITE_TTL_MS);

    const rows = await invites(t);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.tokenHash).toBe(await sha256Hex(created.token));
    expect(row.tokenHash).not.toBe(created.token);
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(row).toMatchObject({ innId, createdBy: owner.userId, label: "Night desk", expiresAt: created.expiresAt });
    expect(row.usedBy).toBeUndefined();
    expect(row.revokedAt).toBeUndefined();

    const listed = await owner.as.query(api.teams.listInvites, { innId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ _id: created.inviteId, label: "Night desk", state: "pending", expiresAt: created.expiresAt, usedByName: null });
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(JSON.stringify(listed)).not.toContain(row.tokenHash);
  });

  it("every mint is a distinct token", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) tokens.add((await owner.as.action(api.teams.createInvite, { innId })).token);
    expect(tokens.size).toBe(5);
  });

  it("refuses staff, cross-tenant members, anonymous visitors, unauthenticated callers, and demo inns", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const staff = await signedInUser(t, { name: "Staff" });
    await addStaff(t, innId, staff.userId);
    const stranger = await signedInUser(t, { name: "Stranger" });
    await seedInn(t, stranger.userId, "Other Inn");
    const anon = await signedInUser(t, { name: "Visitor", isAnonymous: true });

    expect(await failure(staff.as.action(api.teams.createInvite, { innId }))).toMatch(/forbidden/);
    expect(await failure(stranger.as.action(api.teams.createInvite, { innId }))).toMatch(/forbidden/);
    expect(await failure(anon.as.action(api.teams.createInvite, { innId }))).toMatch(/unauthenticated|forbidden|live_mail_forbidden/);
    expect(await failure(t.action(api.teams.createInvite, { innId }))).toMatch(/unauthenticated/);

    // Demo inn owned (as demo role) by a real account, and a demo inn whose creator holds an owner row.
    const demoInn = await t.run(async (ctx) => {
      const id = await ctx.db.insert("inns", { name: "Demo", siteUrl: "https://demo.example", timezone: "UTC", isDemo: true, createdBy: owner.userId });
      await ctx.db.insert("memberships", { innId: id, userId: owner.userId, role: "owner", name: "Owner" });
      return id;
    });
    expect(await failure(owner.as.action(api.teams.createInvite, { innId: demoInn }))).toMatch(/live_mail_forbidden/);
    const demoRoleInn = await t.run(async (ctx) => {
      const id = await ctx.db.insert("inns", { name: "Live", siteUrl: "https://live.example", timezone: "UTC", isDemo: false, createdBy: owner.userId });
      await ctx.db.insert("memberships", { innId: id, userId: owner.userId, role: "demo", name: "Owner" });
      return id;
    });
    expect(await failure(owner.as.action(api.teams.createInvite, { innId: demoRoleInn }))).toMatch(/live_mail_forbidden/);

    expect(await invites(t)).toEqual([]);
  });

  it("the storing mutation re-checks ownership itself, so a hash cannot be planted without authority", async () => {
    const t = makeTest();
    const { innId } = await ownerWithInn(t);
    const staff = await signedInUser(t, { name: "Staff" });
    await addStaff(t, innId, staff.userId);
    const hash = await sha256Hex("a".repeat(64));
    expect(await failure(staff.as.mutation(internal.teams.storeInvite, { innId, tokenHash: hash }))).toMatch(/forbidden/);
    expect(await failure(t.mutation(internal.teams.storeInvite, { innId, tokenHash: hash }))).toMatch(/unauthenticated/);
    expect(await invites(t)).toEqual([]);
  });

  it("validates the label", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    expect(await failure(owner.as.action(api.teams.createInvite, { innId, label: "x".repeat(121) }))).toMatch(/invalid/);
    const blank = await owner.as.action(api.teams.createInvite, { innId, label: "   " });
    expect((await t.run((ctx) => ctx.db.get(blank.inviteId)))?.label).toBeUndefined();
    const max = await owner.as.action(api.teams.createInvite, { innId, label: " " + "y".repeat(120) + " " });
    expect((await t.run((ctx) => ctx.db.get(max.inviteId)))?.label).toBe("y".repeat(120));
  });

  it("caps outstanding invitations at 20, not counting used, revoked or expired ones", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const other = await ownerWithInn(t, "Other");
    const minted = [];
    for (let i = 0; i < MAX_OUTSTANDING_INVITES; i++) minted.push(await owner.as.action(api.teams.createInvite, { innId }));
    expect(await failure(owner.as.action(api.teams.createInvite, { innId }))).toMatch(/invite_limit/);
    // The cap is per inn.
    await other.owner.as.action(api.teams.createInvite, { innId: other.innId });

    // Revoking one frees a slot.
    await owner.as.mutation(api.teams.revokeInvite, { inviteId: minted[0].inviteId });
    const replacement = await owner.as.action(api.teams.createInvite, { innId });
    expect(await failure(owner.as.action(api.teams.createInvite, { innId }))).toMatch(/invite_limit/);

    // Using one frees a slot.
    const joiner = await signedInUser(t, { name: "Joiner" });
    await joiner.as.mutation(api.teams.acceptInvite, { token: minted[1].token });
    await owner.as.action(api.teams.createInvite, { innId });
    expect(await failure(owner.as.action(api.teams.createInvite, { innId }))).toMatch(/invite_limit/);

    // An expired one frees a slot.
    await t.run((ctx) => ctx.db.patch(replacement.inviteId, { expiresAt: Date.now() - 1 }));
    await owner.as.action(api.teams.createInvite, { innId });
    expect(await failure(owner.as.action(api.teams.createInvite, { innId }))).toMatch(/invite_limit/);
  });
});

describe("listing and revoking", () => {
  it("only the owner lists; states reflect used, revoked, expired and pending", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const staff = await signedInUser(t, { name: "Staff" });
    await addStaff(t, innId, staff.userId);
    const stranger = await signedInUser(t, { name: "Stranger" });

    const pending = await owner.as.action(api.teams.createInvite, { innId, label: "pending" });
    const used = await owner.as.action(api.teams.createInvite, { innId, label: "used" });
    const revoked = await owner.as.action(api.teams.createInvite, { innId, label: "revoked" });
    const expired = await owner.as.action(api.teams.createInvite, { innId, label: "expired" });
    const joiner = await signedInUser(t, { name: "Joiner Jones" });
    await joiner.as.mutation(api.teams.acceptInvite, { token: used.token });
    await owner.as.mutation(api.teams.revokeInvite, { inviteId: revoked.inviteId });
    await t.run((ctx) => ctx.db.patch(expired.inviteId, { expiresAt: Date.now() - 1 }));

    const listed = await owner.as.query(api.teams.listInvites, { innId });
    const byLabel = Object.fromEntries(listed.map((i) => [i.label, i]));
    expect(byLabel.pending).toMatchObject({ _id: pending.inviteId, state: "pending", usedByName: null, revokedAt: null });
    expect(byLabel.used).toMatchObject({ state: "used", usedByName: "Joiner Jones" });
    expect(byLabel.used.usedAt).toBeTypeOf("number");
    expect(byLabel.revoked).toMatchObject({ state: "revoked" });
    expect(byLabel.revoked.revokedAt).toBeTypeOf("number");
    expect(byLabel.expired).toMatchObject({ state: "expired" });
    for (const row of listed) expect(Object.keys(row).sort()).toEqual(["_id", "createdAt", "expiresAt", "label", "revokedAt", "state", "usedAt", "usedByName"]);

    await expect(staff.as.query(api.teams.listInvites, { innId })).rejects.toThrow(/forbidden/);
    await expect(stranger.as.query(api.teams.listInvites, { innId })).rejects.toThrow(/forbidden/);
    await expect(t.query(api.teams.listInvites, { innId })).rejects.toThrow(/unauthenticated/);
  });

  it("revoke is owner-only, idempotent, and blocks acceptance", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const staff = await signedInUser(t, { name: "Staff" });
    await addStaff(t, innId, staff.userId);
    const otherOwner = await ownerWithInn(t, "Other");
    const created = await owner.as.action(api.teams.createInvite, { innId });

    await expect(staff.as.mutation(api.teams.revokeInvite, { inviteId: created.inviteId })).rejects.toThrow(/forbidden/);
    await expect(otherOwner.owner.as.mutation(api.teams.revokeInvite, { inviteId: created.inviteId })).rejects.toThrow(/forbidden/);
    await expect(t.mutation(api.teams.revokeInvite, { inviteId: created.inviteId })).rejects.toThrow(/unauthenticated/);
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))?.revokedAt).toBeUndefined();

    expect(await owner.as.mutation(api.teams.revokeInvite, { inviteId: created.inviteId })).toEqual({ state: "revoked" });
    const revokedAt = (await t.run((ctx) => ctx.db.get(created.inviteId)))!.revokedAt;
    expect(revokedAt).toBeTypeOf("number");
    expect(await owner.as.mutation(api.teams.revokeInvite, { inviteId: created.inviteId })).toEqual({ state: "revoked" });
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))!.revokedAt).toBe(revokedAt);

    const joiner = await signedInUser(t, { name: "Joiner" });
    expect(await failure(joiner.as.mutation(api.teams.acceptInvite, { token: created.token }))).toMatch(/revoked/);
    expect(await membershipOf(t, innId, joiner.userId)).toBeNull();

    // Revoking a used invite leaves it used.
    const consumed = await owner.as.action(api.teams.createInvite, { innId });
    await joiner.as.mutation(api.teams.acceptInvite, { token: consumed.token });
    expect(await owner.as.mutation(api.teams.revokeInvite, { inviteId: consumed.inviteId })).toEqual({ state: "used" });
    expect((await t.run((ctx) => ctx.db.get(consumed.inviteId)))!.revokedAt).toBeUndefined();
  });
});

describe("preview", () => {
  it("returns only inn name, expiry and state to a signed-in staff account", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t, "Seagull Inn");
    const created = await owner.as.action(api.teams.createInvite, { innId, label: "secret label" });
    const viewer = await signedInUser(t, { name: "Viewer" });
    const preview = await viewer.as.query(api.teams.previewInvite, { token: created.token });
    expect(preview).toEqual({ state: "pending", innName: "Seagull Inn", expiresAt: created.expiresAt, acceptedByYou: false });
    expect(JSON.stringify(preview)).not.toContain(innId);
    expect(JSON.stringify(preview)).not.toContain(created.inviteId);
    expect(JSON.stringify(preview)).not.toContain("secret label");
  });

  it("anonymous and unauthenticated callers cannot preview", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    const anon = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    await expect(anon.as.query(api.teams.previewInvite, { token: created.token })).rejects.toThrow(/forbidden/);
    await expect(t.query(api.teams.previewInvite, { token: created.token })).rejects.toThrow(/unauthenticated/);
  });

  it("malformed, unknown and demo-inn tokens all look the same; state tracks the lifecycle", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const viewer = await signedInUser(t, { name: "Viewer" });
    const created = await owner.as.action(api.teams.createInvite, { innId });
    for (const token of ["", "nope", created.token.toUpperCase(), created.token.slice(1), created.token + "0", " " + created.token, "f".repeat(64)]) {
      expect(await viewer.as.query(api.teams.previewInvite, { token }), token).toEqual({ state: "invalid" });
    }
    // A hash planted on a demo inn is never previewable.
    await t.run(async (ctx) => {
      const demo = await ctx.db.insert("inns", { name: "Demo", siteUrl: "https://demo.example", timezone: "UTC", isDemo: true, createdBy: owner.userId });
      await ctx.db.insert("teamInvites", { innId: demo, tokenHash: await sha256Hex("d".repeat(64)), createdBy: owner.userId, createdAt: Date.now(), expiresAt: Date.now() + 1000 });
    });
    expect(await viewer.as.query(api.teams.previewInvite, { token: "d".repeat(64) })).toEqual({ state: "invalid" });

    await owner.as.mutation(api.teams.revokeInvite, { inviteId: created.inviteId });
    expect((await viewer.as.query(api.teams.previewInvite, { token: created.token })).state).toBe("revoked");

    const second = await owner.as.action(api.teams.createInvite, { innId });
    await t.run((ctx) => ctx.db.patch(second.inviteId, { expiresAt: Date.now() - 1 }));
    expect((await viewer.as.query(api.teams.previewInvite, { token: second.token })).state).toBe("expired");

    const third = await owner.as.action(api.teams.createInvite, { innId });
    await viewer.as.mutation(api.teams.acceptInvite, { token: third.token });
    expect(await viewer.as.query(api.teams.previewInvite, { token: third.token })).toMatchObject({ state: "used", acceptedByYou: true });
    const other = await signedInUser(t, { name: "Other" });
    expect(await other.as.query(api.teams.previewInvite, { token: third.token })).toMatchObject({ state: "used", acceptedByYou: false });
  });
});

describe("accepting", () => {
  it("grants staff membership once, returns the inn id, and is idempotent for the same recipient", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    const joiner = await signedInUser(t, { name: "Joiner", email: "j@example.com" });

    expect(await joiner.as.mutation(api.teams.acceptInvite, { token: created.token })).toEqual({ innId, joined: true });
    expect(await membershipOf(t, innId, joiner.userId)).toMatchObject({ role: "staff", name: "Joiner" });
    const row = (await t.run((ctx) => ctx.db.get(created.inviteId)))!;
    expect(row.usedBy).toBe(joiner.userId);
    expect(row.usedAt).toBeTypeOf("number");

    expect(await joiner.as.mutation(api.teams.acceptInvite, { token: created.token })).toEqual({ innId, joined: false });
    expect(await memberships(t, innId)).toHaveLength(2);
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))!.usedAt).toBe(row.usedAt);

    // The joiner now has ordinary staff access, and the inn shows up in their list.
    expect((await joiner.as.query(api.inns.mine, {})).map((i) => i.innId)).toEqual([innId]);
    expect((await joiner.as.query(api.inns.get, { innId })).role).toBe("staff");
  });

  it("a used token cannot be replayed by another user", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    const first = await signedInUser(t, { name: "First" });
    const second = await signedInUser(t, { name: "Second" });
    await first.as.mutation(api.teams.acceptInvite, { token: created.token });
    const message = await failure(second.as.mutation(api.teams.acceptInvite, { token: created.token }));
    expect(message).toMatch(/used/);
    expect(message).not.toContain(created.token);
    expect(await membershipOf(t, innId, second.userId)).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))!.usedBy).toBe(first.userId);
  });

  it("two recipients racing for the same token: exactly one joins", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    const racers = await Promise.all([1, 2, 3, 4].map((n) => signedInUser(t, { name: `Racer ${n}` })));
    const results = await Promise.allSettled(racers.map((r) => r.as.mutation(api.teams.acceptInvite, { token: created.token })));
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const lost of results.filter((r) => r.status === "rejected")) {
      expect((lost as PromiseRejectedResult).reason.message).toMatch(/used/);
    }
    const rows = await memberships(t, innId);
    expect(rows.filter((m) => m.role === "staff")).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))!.usedBy).toBe(rows.find((m) => m.role === "staff")!.userId);
  });

  it("refuses expired, malformed and unknown tokens without revealing which", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    const joiner = await signedInUser(t, { name: "Joiner" });

    for (const token of ["", "nope", created.token.toUpperCase(), created.token.slice(0, 63), created.token + "0", "f".repeat(64)]) {
      const message = await failure(joiner.as.mutation(api.teams.acceptInvite, { token }));
      expect(message, token).toMatch(/invite_refused/);
      expect(message, token).toMatch(/unknown/);
    }
    await t.run((ctx) => ctx.db.patch(created.inviteId, { expiresAt: Date.now() - 1 }));
    expect(await failure(joiner.as.mutation(api.teams.acceptInvite, { token: created.token }))).toMatch(/expired/);
    expect(await membershipOf(t, innId, joiner.userId)).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))!.usedBy).toBeUndefined();

    // Boundary: an invitation is still valid up to its expiry instant.
    vi.useFakeTimers();
    const fresh = await owner.as.action(api.teams.createInvite, { innId });
    vi.setSystemTime(fresh.expiresAt - 1);
    expect((await joiner.as.mutation(api.teams.acceptInvite, { token: fresh.token })).joined).toBe(true);
  });

  it("anonymous visitors and unauthenticated callers cannot accept", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    const anon = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    await expect(anon.as.mutation(api.teams.acceptInvite, { token: created.token })).rejects.toThrow(/forbidden/);
    await expect(t.mutation(api.teams.acceptInvite, { token: created.token })).rejects.toThrow(/unauthenticated/);
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))!.usedBy).toBeUndefined();
    expect(await memberships(t, innId)).toHaveLength(1);
  });

  it("an invite whose inn turned demo, or vanished, is refused", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    const joiner = await signedInUser(t, { name: "Joiner" });
    await t.run((ctx) => ctx.db.patch(innId, { isDemo: true }));
    expect(await failure(joiner.as.mutation(api.teams.acceptInvite, { token: created.token }))).toMatch(/unknown/);
    await t.run((ctx) => ctx.db.delete(innId));
    expect(await failure(joiner.as.mutation(api.teams.acceptInvite, { token: created.token }))).toMatch(/unknown/);
    expect(await membershipOf(t, innId, joiner.userId)).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))!.usedBy).toBeUndefined();
  });

  it("existing members keep their role: an owner accepting their own invite is never downgraded", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    expect(await owner.as.mutation(api.teams.acceptInvite, { token: created.token })).toEqual({ innId, joined: false });
    expect(await membershipOf(t, innId, owner.userId)).toMatchObject({ role: "owner", name: "Owner" });
    expect(await memberships(t, innId)).toHaveLength(1);
    // The token is spent all the same and cannot be forwarded afterwards.
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))!.usedBy).toBe(owner.userId);
    const later = await signedInUser(t, { name: "Later" });
    expect(await failure(later.as.mutation(api.teams.acceptInvite, { token: created.token }))).toMatch(/used/);

    const staff = await signedInUser(t, { name: "Staff" });
    await addStaff(t, innId, staff.userId, "Existing Staff");
    const again = await owner.as.action(api.teams.createInvite, { innId });
    expect(await staff.as.mutation(api.teams.acceptInvite, { token: again.token })).toEqual({ innId, joined: false });
    expect(await membershipOf(t, innId, staff.userId)).toMatchObject({ role: "staff", name: "Existing Staff" });
    expect(await memberships(t, innId)).toHaveLength(2);
  });

  it("a removed member retrying their spent invite is refused and never regains membership", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    const joiner = await signedInUser(t, { name: "Joiner" });
    expect(await joiner.as.mutation(api.teams.acceptInvite, { token: created.token })).toEqual({ innId, joined: true });
    expect(await joiner.as.query(api.teams.previewInvite, { token: created.token })).toMatchObject({ state: "used", acceptedByYou: true });

    await owner.as.mutation(api.teams.removeStaff, { innId, userId: joiner.userId });

    // The preview no longer suggests a join that would be refused.
    expect(await joiner.as.query(api.teams.previewInvite, { token: created.token })).toMatchObject({ state: "used", acceptedByYou: false });
    const message = await failure(joiner.as.mutation(api.teams.acceptInvite, { token: created.token }));
    expect(message).toMatch(/invite_refused/);
    expect(message).toMatch(/already been used/);
    expect(message).not.toContain(created.token);
    // Nothing was recreated and the token stays consumed by the original recipient.
    expect(await membershipOf(t, innId, joiner.userId)).toBeNull();
    expect(await memberships(t, innId)).toHaveLength(1);
    const row = (await t.run((ctx) => ctx.db.get(created.inviteId)))!;
    expect(row.usedBy).toBe(joiner.userId);
    expect(row.usedAt).toBeTypeOf("number");
    await expect(joiner.as.query(api.inns.get, { innId })).rejects.toThrow(/forbidden/);

    // A demo-role row is not staff access either.
    await t.run((ctx) => ctx.db.insert("memberships", { innId, userId: joiner.userId, role: "demo", name: "Joiner" }));
    expect((await joiner.as.query(api.teams.previewInvite, { token: created.token })).acceptedByYou).toBe(false);
    expect(await failure(joiner.as.mutation(api.teams.acceptInvite, { token: created.token }))).toMatch(/already been used/);
    expect(await membershipOf(t, innId, joiner.userId)).toMatchObject({ role: "demo" });
  });

  it("a still-member recipient's retry stays idempotent even after the invite expires", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const created = await owner.as.action(api.teams.createInvite, { innId });
    const joiner = await signedInUser(t, { name: "Joiner" });
    await joiner.as.mutation(api.teams.acceptInvite, { token: created.token });
    await t.run((ctx) => ctx.db.patch(created.inviteId, { expiresAt: Date.now() - 1 }));
    expect(await joiner.as.query(api.teams.previewInvite, { token: created.token })).toMatchObject({ state: "used", acceptedByYou: true });
    expect(await joiner.as.mutation(api.teams.acceptInvite, { token: created.token })).toEqual({ innId, joined: false });
    expect(await memberships(t, innId)).toHaveLength(2);
  });

  it("accepting never touches other inns", async () => {
    const t = makeTest();
    const a = await ownerWithInn(t, "Inn A");
    const b = await ownerWithInn(t, "Inn B");
    const created = await a.owner.as.action(api.teams.createInvite, { innId: a.innId });
    const joiner = await signedInUser(t, { name: "Joiner" });
    expect((await joiner.as.mutation(api.teams.acceptInvite, { token: created.token })).innId).toBe(a.innId);
    expect(await membershipOf(t, b.innId, joiner.userId)).toBeNull();
    expect((await joiner.as.query(api.inns.mine, {})).map((i) => i.innId)).toEqual([a.innId]);
    await expect(joiner.as.query(api.inns.get, { innId: b.innId })).rejects.toThrow(/forbidden/);
  });
});

describe("removing staff", () => {
  it("owner removes a staff member and releases only that member's claims on this inn", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const other = await ownerWithInn(t, "Other");
    const staff = await signedInUser(t, { name: "Staff" });
    await addStaff(t, innId, staff.userId);
    await addStaff(t, other.innId, staff.userId);
    const helper = await signedInUser(t, { name: "Helper" });
    await addStaff(t, innId, helper.userId);

    const mine1 = await seedThread(t, innId, "one");
    const mine2 = await seedThread(t, innId, "two");
    const helpers = await seedThread(t, innId, "three");
    const unclaimed = await seedThread(t, innId, "four");
    const elsewhere = await seedThread(t, other.innId, "five");
    await staff.as.mutation(api.threads.claim, { threadId: mine1 });
    await staff.as.mutation(api.threads.claim, { threadId: mine2 });
    await helper.as.mutation(api.threads.claim, { threadId: helpers });
    await staff.as.mutation(api.threads.claim, { threadId: elsewhere });

    expect(await owner.as.mutation(api.teams.removeStaff, { innId, userId: staff.userId })).toEqual({ released: 2 });
    expect(await membershipOf(t, innId, staff.userId)).toBeNull();
    expect(await membershipOf(t, other.innId, staff.userId)).toMatchObject({ role: "staff" });
    const get = (id: Id<"threads">) => t.run((ctx) => ctx.db.get(id));
    for (const freed of [await get(mine1), await get(mine2)]) {
      expect(freed!.claimedBy).toBeUndefined();
      expect(freed!.claimedAt).toBeUndefined();
    }
    expect((await get(helpers))!.claimedBy).toBe(helper.userId);
    expect((await get(unclaimed))!.claimedBy).toBeUndefined();
    expect((await get(elsewhere))!.claimedBy).toBe(staff.userId);

    // The freed threads can be claimed at once by the remaining team.
    expect((await helper.as.mutation(api.threads.claim, { threadId: mine1 })).kind).toBe("acquired");
    // The removed member has lost access.
    await expect(staff.as.query(api.inns.get, { innId })).rejects.toThrow(/forbidden/);
    await expect(staff.as.mutation(api.threads.claim, { threadId: mine2 })).rejects.toThrow(/forbidden/);
    expect((await staff.as.query(api.inns.mine, {})).map((i) => i.innId)).toEqual([other.innId]);
  });

  it("never removes owners, the caller, non-members, or anyone from a foreign inn; non-owners cannot remove", async () => {
    const t = makeTest();
    const { owner, innId } = await ownerWithInn(t);
    const coOwner = await signedInUser(t, { name: "Co-owner" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId, userId: coOwner.userId, role: "owner", name: "Co-owner" }));
    const staff = await signedInUser(t, { name: "Staff" });
    await addStaff(t, innId, staff.userId);
    const helper = await signedInUser(t, { name: "Helper" });
    await addStaff(t, innId, helper.userId);
    const outsider = await signedInUser(t, { name: "Outsider" });
    const other = await ownerWithInn(t, "Other");
    await addStaff(t, other.innId, outsider.userId);

    await expect(owner.as.mutation(api.teams.removeStaff, { innId, userId: coOwner.userId })).rejects.toThrow(/forbidden/);
    await expect(owner.as.mutation(api.teams.removeStaff, { innId, userId: owner.userId })).rejects.toThrow(/forbidden/);
    await expect(owner.as.mutation(api.teams.removeStaff, { innId, userId: outsider.userId })).rejects.toThrow(/forbidden/);
    await expect(owner.as.mutation(api.teams.removeStaff, { innId: other.innId, userId: outsider.userId })).rejects.toThrow(/forbidden/);
    await expect(staff.as.mutation(api.teams.removeStaff, { innId, userId: helper.userId })).rejects.toThrow(/forbidden/);
    await expect(outsider.as.mutation(api.teams.removeStaff, { innId, userId: helper.userId })).rejects.toThrow(/forbidden/);
    await expect(t.mutation(api.teams.removeStaff, { innId, userId: helper.userId })).rejects.toThrow(/unauthenticated/);

    expect((await memberships(t, innId)).map((m) => m.role).sort()).toEqual(["owner", "owner", "staff", "staff"]);
    expect(await membershipOf(t, other.innId, outsider.userId)).not.toBeNull();
  });

  it("a reply reserved by staff who were then removed is refused at dispatch", async () => {
    withEnv({ AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const inn = await seedLiveInn(t, owner.userId);
    const staff = await signedInUser(t, { name: "Staff" });
    await addStaff(t, inn.innId, staff.userId);
    const { threadId, messageId } = await seedInboundThread(t, inn.innId);
    const draftId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("drafts", {
        threadId,
        replyToMessageId: messageId,
        class: "answerable",
        answer: "Yes! Dogs are welcome for a $25 per night pet fee.",
        abstain: false,
        status: "ready",
        model: "test",
        verifiedText: "Yes! Dogs are welcome for a $25 per night pet fee.",
        textSource: "model",
        judgeVerdict: { entailed: true, promisedOutsideQuotes: false, notes: "ok" },
      });
      await ctx.db.patch(threadId, { status: "ready" });
      return id;
    });
    await staff.as.mutation(api.threads.claim, { threadId });
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const { outboxId } = await staff.as.mutation(api.drafts.send, { draftId });
    await owner.as.mutation(api.teams.removeStaff, { innId: inn.innId, userId: staff.userId });
    await t.action(internal.outbox.deliver, { outboxId });
    await settle(t);
    const row = (await t.run((ctx) => ctx.db.get(outboxId)))!;
    expect(row).toMatchObject({ status: "failed", errorKind: "precondition" });
    expect(calls).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("sentReplies").collect())).toEqual([]);
  });
});
