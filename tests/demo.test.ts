import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeTest, seedInn, signedInUser } from "./setup";

describe("demo isolation", () => {
  it("seeds one private demo inn per anonymous user, idempotently", async () => {
    const t = makeTest();
    const v1 = await signedInUser(t, { name: "Visitor 1", isAnonymous: true });
    const v2 = await signedInUser(t, { name: "Visitor 2", isAnonymous: true });

    const inn1 = await v1.as.mutation(api.demo.enter, {});
    const inn1Again = await v1.as.mutation(api.demo.enter, {});
    const inn2 = await v2.as.mutation(api.demo.enter, {});
    expect(inn1Again).toBe(inn1);
    expect(inn2).not.toBe(inn1);

    expect((await v1.as.query(api.inns.mine, {})).map((i) => i.innId)).toEqual([inn1]);
    expect((await v2.as.query(api.inns.mine, {})).map((i) => i.innId)).toEqual([inn2]);
    await expect(v2.as.query(api.threads.queue, { innId: inn1 })).rejects.toThrow(/forbidden/);
    await expect(v1.as.mutation(api.demo.changePolicyPage, { innId: inn2 })).rejects.toThrow(/forbidden/);

    const queue = await v1.as.query(api.threads.queue, { innId: inn1 });
    expect(queue.length).toBeGreaterThanOrEqual(6);
    const pages = await v1.as.query(api.pages.list, { innId: inn1 });
    expect(pages.map((p) => p.kind).sort()).toEqual(["policies", "rates", "rooms"]);
    for (const page of pages) expect(page.lastVersion?.changeStatus).toBe("new");
  });

  it("demo data never confers live mail privileges", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    const view = await visitor.as.query(api.inns.get, { innId });
    expect(view.inn.isDemo).toBe(true);
    expect(view.role).toBe("demo");
    expect(view.liveMail).toEqual({ allowed: false, reason: "anonymous_user" });

    // Even a real staff account added to a demo inn has no live mail.
    const staff = await signedInUser(t, { name: "Staff" });
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", { innId, userId: staff.userId, role: "owner", name: "Staff" });
    });
    const staffView = await staff.as.query(api.inns.get, { innId });
    expect(staffView.liveMail).toEqual({ allowed: false, reason: "demo_inn" });
  });

  it("refuses the demo for real staff accounts and the scripted change for real inns", async () => {
    const t = makeTest();
    const staff = await signedInUser(t, { name: "Staff", email: "s@example.com" });
    await expect(staff.as.mutation(api.demo.enter, {})).rejects.toThrow(/forbidden/);
    const innId = await seedInn(t, staff.userId);
    await expect(staff.as.mutation(api.demo.changePolicyPage, { innId })).rejects.toThrow(/forbidden/);
    expect(await staff.as.query(api.demo.status, { innId })).toBeNull();
  });
});
