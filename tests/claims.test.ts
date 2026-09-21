import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { CLAIM_TTL_MS } from "../convex/lib/claimLocks";
import { addStaff, makeTest, seedInn, seedThread, signedInUser } from "./setup";

describe("thread claim locks", () => {
  it("exactly one of two racing staff members wins the claim", async () => {
    const t = makeTest();
    const maria = await signedInUser(t, { name: "Maria" });
    const jon = await signedInUser(t, { name: "Jon" });
    const innId = await seedInn(t, maria.userId);
    await addStaff(t, innId, jon.userId, "Jon");
    const threadId = await seedThread(t, innId);

    const results = await Promise.allSettled([
      maria.as.mutation(api.threads.claim, { threadId }),
      jon.as.mutation(api.threads.claim, { threadId }),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(String((losers[0] as PromiseRejectedResult).reason)).toMatch(/claimed/);

    const detail = await maria.as.query(api.threads.get, { threadId });
    const holder = detail.thread.claim?.userId;
    expect([maria.userId, jon.userId]).toContain(holder);

    // The loser still cannot take or release it, the winner can renew.
    const loser = holder === maria.userId ? jon : maria;
    const winner = holder === maria.userId ? maria : jon;
    await expect(loser.as.mutation(api.threads.claim, { threadId })).rejects.toThrow(/claimed/);
    await expect(loser.as.mutation(api.threads.release, { threadId })).rejects.toThrow(/claimed/);
    await expect(winner.as.mutation(api.threads.claim, { threadId })).resolves.toMatchObject({ kind: "renewed" });
    await expect(loser.as.mutation(api.drafts.edit, { draftId: await t.run((ctx) =>
      ctx.db.insert("drafts", {
        threadId,
        class: "answerable",
        answer: "x",
        abstain: false,
        status: "ready",
        model: "test",
      }),
    ), answer: "hijack" })).rejects.toThrow(/claimed/);
  });

  it("an expired claim can be taken over", async () => {
    const t = makeTest();
    const maria = await signedInUser(t, { name: "Maria" });
    const jon = await signedInUser(t, { name: "Jon" });
    const innId = await seedInn(t, maria.userId);
    await addStaff(t, innId, jon.userId, "Jon");
    const threadId = await seedThread(t, innId);
    await t.run(async (ctx) => {
      await ctx.db.patch(threadId, { claimedBy: maria.userId, claimedAt: Date.now() - CLAIM_TTL_MS - 1000 });
    });
    await expect(jon.as.mutation(api.threads.claim, { threadId })).resolves.toMatchObject({
      kind: "took_over_expired",
    });
    const queue = await jon.as.query(api.threads.queue, { innId });
    expect(queue[0].claim?.userId).toBe(jon.userId);
    expect(queue[0].claim?.name).toBe("Jon");
  });

  it("release clears the lock for the holder", async () => {
    const t = makeTest();
    const maria = await signedInUser(t, { name: "Maria" });
    const innId = await seedInn(t, maria.userId);
    const threadId = await seedThread(t, innId);
    await maria.as.mutation(api.threads.claim, { threadId });
    await maria.as.mutation(api.threads.release, { threadId });
    const queue = await maria.as.query(api.threads.queue, { innId });
    expect(queue[0].claim).toBeNull();
  });
});
