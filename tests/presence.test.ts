import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_MS } from "../convex/lib/presenceTiming";
import { addStaff, makeTest, seedInn, seedThread, signedInUser, type T } from "./setup";

/** What the component itself holds for a room, bypassing the app's membership filter. */
const rawRoom = (t: T, roomId: string) =>
  t.run(async (ctx) => ctx.runQuery(components.presence.public.listRoom, { roomId, onlineOnly: true }));

/**
 * Advances the fake clock in small steps, letting each scheduled function the
 * component's worker queues run before the next timer fires. Stepping (rather
 * than `runAllTimers`) is deliberate: the disconnect worker reschedules itself
 * until it goes idle, so "run every timer" could spin forever.
 */
async function advanceClock(t: T, ms: number, stepMs = 500) {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, ms - elapsed));
    await t.finishInProgressScheduledFunctions();
  }
}

async function twoStaffThread(t: T) {
  const maria = await signedInUser(t, { name: "Maria" });
  const jon = await signedInUser(t, { name: "Jon" });
  const innId = await seedInn(t, maria.userId);
  await addStaff(t, innId, jon.userId, "Jon");
  const threadId = await seedThread(t, innId);
  return { maria, jon, innId, threadId };
}

const beat = (who: Awaited<ReturnType<typeof signedInUser>>, threadId: Id<"threads">, clientSessionId: string) =>
  who.as.mutation(api.presence.heartbeat, { threadId, clientSessionId });

describe("thread presence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows every current member with a session on the thread, the caller first", async () => {
    const t = makeTest();
    const { maria, jon, threadId } = await twoStaffThread(t);

    await expect(beat(maria, threadId, "maria-tab-1")).resolves.toBeNull();
    await expect(beat(jon, threadId, "jon-tab-1")).resolves.toBeNull();

    expect(await maria.as.query(api.presence.list, { threadId })).toEqual([
      { userId: maria.userId, name: "Owner", isYou: true },
      { userId: jon.userId, name: "Jon", isYou: false },
    ]);
    expect(await jon.as.query(api.presence.list, { threadId })).toEqual([
      { userId: jon.userId, name: "Jon", isYou: true },
      { userId: maria.userId, name: "Owner", isYou: false },
    ]);
  });

  it("one user with several tabs is listed once", async () => {
    const t = makeTest();
    const { maria, threadId } = await twoStaffThread(t);
    await beat(maria, threadId, "maria-tab-one");
    await beat(maria, threadId, "maria-tab-two");
    await beat(maria, threadId, "maria-tab-one");

    expect(await maria.as.query(api.presence.list, { threadId })).toEqual([{ userId: maria.userId, name: "Owner", isYou: true }]);
    expect(await rawRoom(t, threadId)).toHaveLength(1);
  });

  it("presence is per thread and per inn", async () => {
    const t = makeTest();
    const { maria, jon, innId, threadId } = await twoStaffThread(t);
    const otherThread = await seedThread(t, innId, "Other");
    const otherInn = await seedInn(t, jon.userId, "Jon's Inn");
    const foreignThread = await seedThread(t, otherInn, "Elsewhere");

    await beat(maria, threadId, "maria-tab-a");
    await beat(jon, otherThread, "jon-tab-b");
    await beat(jon, foreignThread, "jon-tab-c");

    expect((await maria.as.query(api.presence.list, { threadId })).map((r) => r.userId)).toEqual([maria.userId]);
    expect((await maria.as.query(api.presence.list, { threadId: otherThread })).map((r) => r.userId)).toEqual([jon.userId]);
    expect((await jon.as.query(api.presence.list, { threadId: foreignThread })).map((r) => r.userId)).toEqual([jon.userId]);
    // Maria is not on Jon's inn at all.
    await expect(maria.as.query(api.presence.list, { threadId: foreignThread })).rejects.toThrow(/forbidden/);
    await expect(beat(maria, foreignThread, "maria-tab-x")).rejects.toThrow(/forbidden/);
  });

  it("anonymous demo visitors only ever see their own demo inn", async () => {
    const t = makeTest();
    const v1 = await signedInUser(t, { name: "Visitor 1", isAnonymous: true });
    const v2 = await signedInUser(t, { name: "Visitor 2", isAnonymous: true });
    const inn1 = await v1.as.mutation(api.demo.enter, {});
    const inn2 = await v2.as.mutation(api.demo.enter, {});
    const thread1 = (await v1.as.query(api.threads.queue, { innId: inn1 }))[0]._id;
    const thread2 = (await v2.as.query(api.threads.queue, { innId: inn2 }))[0]._id;

    await beat(v1, thread1, "visitor-one");
    await beat(v2, thread2, "visitor-two");
    await expect(beat(v2, thread1, "visitor-two")).rejects.toThrow(/forbidden/);
    await expect(v2.as.query(api.presence.list, { threadId: thread1 })).rejects.toThrow(/forbidden/);

    expect((await v1.as.query(api.presence.list, { threadId: thread1 })).map((r) => r.userId)).toEqual([v1.userId]);
    expect((await v2.as.query(api.presence.list, { threadId: thread2 })).map((r) => r.userId)).toEqual([v2.userId]);
  });

  it("refuses unauthenticated and non-member callers for both reads and heartbeats", async () => {
    const t = makeTest();
    const { maria, threadId } = await twoStaffThread(t);
    const stranger = await signedInUser(t, { name: "Stranger" });
    await beat(maria, threadId, "maria-tab-a");

    await expect(t.query(api.presence.list, { threadId })).rejects.toThrow(/unauthenticated/);
    await expect(t.mutation(api.presence.heartbeat, { threadId, clientSessionId: "anon-tab-1" })).rejects.toThrow(/unauthenticated/);
    await expect(stranger.as.query(api.presence.list, { threadId })).rejects.toThrow(/forbidden/);
    await expect(beat(stranger, threadId, "stranger-tab")).rejects.toThrow(/forbidden/);
    // Nothing leaked into the room from the refused calls.
    expect((await rawRoom(t, threadId)).map((r) => r.userId)).toEqual([maria.userId]);
  });

  it("a removed member is filtered out immediately and can neither read nor heartbeat", async () => {
    const t = makeTest();
    const { maria, jon, innId, threadId } = await twoStaffThread(t);
    await beat(maria, threadId, "maria-tab-a");
    await beat(jon, threadId, "jon-tab-a");
    expect(await maria.as.query(api.presence.list, { threadId })).toHaveLength(2);

    await maria.as.mutation(api.teams.removeStaff, { innId, userId: jon.userId });

    // The component still has Jon's session until it times out...
    expect((await rawRoom(t, threadId)).map((r) => r.userId).sort()).toEqual([maria.userId, jon.userId].sort());
    // ...but the app never shows it, and Jon has no way to read or extend it.
    expect(await maria.as.query(api.presence.list, { threadId })).toEqual([{ userId: maria.userId, name: "Owner", isYou: true }]);
    await expect(jon.as.query(api.presence.list, { threadId })).rejects.toThrow(/forbidden/);
    await expect(beat(jon, threadId, "jon-tab-a")).rejects.toThrow(/forbidden/);
  });

  it("the user behind a session is always the caller: ids cannot be chosen or collided", async () => {
    const t = makeTest();
    const { maria, jon, threadId } = await twoStaffThread(t);

    // Any attempt to name a user is rejected by the argument validator.
    await expect(
      jon.as.mutation(api.presence.heartbeat, { threadId, clientSessionId: "jon-tab-a", userId: maria.userId } as never),
    ).rejects.toThrow(/userId/);
    // Client ids that could reach into the server namespace are refused outright.
    for (const bad of ["", "short", `${threadId}:${maria.userId}:x`, "a".repeat(65), "has space", "semi;colon"]) {
      await expect(beat(jon, threadId, bad)).rejects.toThrow(/session id/);
    }
    expect(await rawRoom(t, threadId)).toEqual([]);

    // Reusing someone else's client id is harmless: each caller gets their own session.
    await beat(maria, threadId, "shared-id");
    await beat(jon, threadId, "shared-id");
    expect((await rawRoom(t, threadId)).map((r) => r.userId).sort()).toEqual([maria.userId, jon.userId].sort());
    expect(await jon.as.query(api.presence.list, { threadId })).toEqual([
      { userId: jon.userId, name: "Jon", isYou: true },
      { userId: maria.userId, name: "Owner", isYou: false },
    ]);
  });

  it("a session that stops heartbeating expires after the component TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-21T12:00:00Z"));
    const t = makeTest();
    const { maria, jon, threadId } = await twoStaffThread(t);
    expect(PRESENCE_TTL_MS).toBe(25_000);

    await beat(maria, threadId, "maria-tab-a");
    await beat(jon, threadId, "jon-tab-a");

    // Jon keeps heartbeating on schedule; Maria's tab goes silent.
    await advanceClock(t, HEARTBEAT_INTERVAL_MS);
    await beat(jon, threadId, "jon-tab-a");
    await advanceClock(t, HEARTBEAT_INTERVAL_MS);
    await beat(jon, threadId, "jon-tab-a");
    expect((await jon.as.query(api.presence.list, { threadId })).map((r) => r.userId).sort()).toEqual([maria.userId, jon.userId].sort());

    // Just past Maria's deadline only Jon is left; Jon's own deadline is still ahead.
    await advanceClock(t, PRESENCE_TTL_MS - 2 * HEARTBEAT_INTERVAL_MS + 1_000);
    expect(await jon.as.query(api.presence.list, { threadId })).toEqual([{ userId: jon.userId, name: "Jon", isYou: true }]);

    // Jon closes the tab too: the room empties and the worker settles down.
    await advanceClock(t, PRESENCE_TTL_MS + 1_000);
    expect(await maria.as.query(api.presence.list, { threadId })).toEqual([]);
    expect(await rawRoom(t, threadId)).toEqual([]);
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.state.kind === "pending"),
    );
    expect(pending).toEqual([]);

    // Coming back starts a fresh session without any trace of the old one.
    await beat(maria, threadId, "maria-tab-b");
    expect(await maria.as.query(api.presence.list, { threadId })).toEqual([{ userId: maria.userId, name: "Owner", isYou: true }]);
  });
});
