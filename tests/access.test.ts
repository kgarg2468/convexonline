import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { addStaff, makeTest, seedInn, seedThread, signedInUser } from "./setup";

describe("authentication", () => {
  it("rejects unauthenticated access to every staff query and mutation", async () => {
    const t = makeTest();
    const { userId } = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, userId);
    const threadId = await seedThread(t, innId);

    await expect(t.query(api.inns.mine, {})).rejects.toThrow(/unauthenticated/);
    await expect(t.query(api.inns.get, { innId })).rejects.toThrow(/unauthenticated/);
    await expect(t.query(api.threads.queue, { innId })).rejects.toThrow(/unauthenticated/);
    await expect(t.query(api.threads.get, { threadId })).rejects.toThrow(/unauthenticated/);
    await expect(t.mutation(api.threads.claim, { threadId })).rejects.toThrow(/unauthenticated/);
    await expect(
      t.mutation(api.facts.add, { innId, question: "q", answer: "a", scope: "general" }),
    ).rejects.toThrow(/unauthenticated/);
    await expect(t.mutation(api.inns.create, { name: "x", siteUrl: "https://x.example" })).rejects.toThrow(
      /unauthenticated/,
    );
    await expect(t.mutation(api.demo.enter, {})).rejects.toThrow(/unauthenticated/);
    expect(await t.query(api.users.viewer, {})).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("staff of one inn cannot read or write another inn's data", async () => {
    const t = makeTest();
    const a = await signedInUser(t, { name: "A" });
    const b = await signedInUser(t, { name: "B" });
    const innA = await seedInn(t, a.userId, "Inn A");
    const innB = await seedInn(t, b.userId, "Inn B");
    const threadA = await seedThread(t, innA, "Dog policy");
    await seedThread(t, innB, "Parking");

    // Each sees exactly their own inn.
    expect((await a.as.query(api.inns.mine, {})).map((i) => i.innId)).toEqual([innA]);
    expect((await b.as.query(api.inns.mine, {})).map((i) => i.innId)).toEqual([innB]);
    expect((await a.as.query(api.threads.queue, { innId: innA })).map((x) => x.subject)).toEqual(["Dog policy"]);

    // Cross-tenant reads and writes are refused with a non-revealing error.
    await expect(b.as.query(api.inns.get, { innId: innA })).rejects.toThrow(/forbidden/);
    await expect(b.as.query(api.threads.queue, { innId: innA })).rejects.toThrow(/forbidden/);
    await expect(b.as.query(api.threads.get, { threadId: threadA })).rejects.toThrow(/forbidden/);
    await expect(b.as.query(api.threads.search, { innId: innA, text: "dog" })).rejects.toThrow(/forbidden/);
    await expect(b.as.query(api.pages.list, { innId: innA })).rejects.toThrow(/forbidden/);
    await expect(b.as.query(api.corrections.list, { innId: innA })).rejects.toThrow(/forbidden/);
    await expect(b.as.mutation(api.threads.claim, { threadId: threadA })).rejects.toThrow(/forbidden/);
    await expect(
      b.as.mutation(api.facts.add, { innId: innA, question: "q", answer: "a", scope: "general" }),
    ).rejects.toThrow(/forbidden/);
    // A fact for B's inn cannot point at A's thread.
    await expect(
      b.as.mutation(api.facts.add, { innId: innB, question: "q", answer: "a", scope: "thread", threadId: threadA }),
    ).rejects.toThrow(/forbidden/);

    // Nothing leaked into A's inn.
    const factsA = await a.as.query(api.facts.list, { innId: innA });
    expect(factsA).toEqual([]);
  });

  it("a second staff member of the same inn shares access", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const helper = await signedInUser(t, { name: "Helper" });
    const innId = await seedInn(t, owner.userId);
    await addStaff(t, innId, helper.userId, "Helper");
    const threadId = await seedThread(t, innId);
    const detail = await helper.as.query(api.threads.get, { threadId });
    expect(detail.thread._id).toBe(threadId);
  });
});

describe("inn creation", () => {
  it("creates an inn owned by the signed-in staff user", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner", email: "o@example.com" });
    const innId = await owner.as.mutation(api.inns.create, { name: " Sea Inn ", siteUrl: "https://sea.example/" });
    const view = await owner.as.query(api.inns.get, { innId });
    expect(view.inn.name).toBe("Sea Inn");
    expect(view.role).toBe("owner");
    expect(view.liveMail).toEqual({ allowed: true });
  });

  it("validates input and refuses anonymous users", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    await expect(owner.as.mutation(api.inns.create, { name: "", siteUrl: "https://x.example" })).rejects.toThrow(
      /invalid/,
    );
    await expect(owner.as.mutation(api.inns.create, { name: "X", siteUrl: "not a url" })).rejects.toThrow(/invalid/);
    await expect(owner.as.mutation(api.inns.create, { name: "X", siteUrl: "ftp://x.example" })).rejects.toThrow(
      /invalid/,
    );
    const anon = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    await expect(anon.as.mutation(api.inns.create, { name: "X", siteUrl: "https://x.example" })).rejects.toThrow(
      /forbidden/,
    );
  });

  it("refuses sites that ingestion could never crawl, without inserting anything", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const rejected: Array<[string, RegExp]> = [
      ["http://plain.example", /https:\/\//],
      ["ftp://x.example", /https:\/\//],
      ["https://user:pw@x.example", /username or password/],
      ["https://localhost", /public https/],
      ["https://intranet.local", /public https/],
      ["https://127.0.0.1", /public https/],
      ["https://10.0.0.5", /public https/],
      ["https://192.168.1.1", /public https/],
      ["https://[::1]", /public https/],
      ["https://inn", /public https/],
      ["   ", /required/],
    ];
    for (const [siteUrl, message] of rejected) {
      const err = await owner.as.mutation(api.inns.create, { name: "X", siteUrl }).catch((e: unknown) => e);
      expect(err, siteUrl).toBeInstanceOf(Error);
      expect((err as Error).message, siteUrl).toMatch(/invalid/);
      expect((err as Error).message, siteUrl).toMatch(message);
    }
    const inns = await t.run((ctx) => ctx.db.query("inns").collect());
    const memberships = await t.run((ctx) => ctx.db.query("memberships").collect());
    expect(inns).toEqual([]);
    expect(memberships).toEqual([]);
  });

  it("refuses time zones that generation cannot format, without inserting anything", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    for (const timezone of ["Mars/Olympus_Mons", "PST8PDT-ish", "not a zone", "America/Los Angeles"]) {
      await expect(
        owner.as.mutation(api.inns.create, { name: "X", siteUrl: "https://x.example", timezone }),
      ).rejects.toThrow(/invalid.*not recognized/);
    }
    expect(await t.run((ctx) => ctx.db.query("inns").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("memberships").collect())).toEqual([]);
  });

  it("keeps a valid IANA time zone and defaults a blank one", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const explicit = await owner.as.mutation(api.inns.create, {
      name: "East",
      siteUrl: "https://east.example/",
      timezone: " Europe/Lisbon ",
    });
    expect((await owner.as.query(api.inns.get, { innId: explicit })).inn.timezone).toBe("Europe/Lisbon");

    const blank = await owner.as.mutation(api.inns.create, { name: "Blank", siteUrl: "https://blank.example", timezone: "  " });
    expect((await owner.as.query(api.inns.get, { innId: blank })).inn.timezone).toBe("America/Los_Angeles");

    const omitted = await owner.as.mutation(api.inns.create, { name: "Omitted", siteUrl: "https://omitted.example" });
    expect((await owner.as.query(api.inns.get, { innId: omitted })).inn.timezone).toBe("America/Los_Angeles");

    // Legitimate public https URLs with paths and ports survive unchanged in substance.
    const withPath = await owner.as.mutation(api.inns.create, {
      name: "Path",
      siteUrl: "https://www.harbor-inn.example:8443/rooms?season=summer",
    });
    expect((await owner.as.query(api.inns.get, { innId: withPath })).inn.siteUrl).toBe(
      "https://www.harbor-inn.example:8443/rooms?season=summer",
    );
    expect(await t.run((ctx) => ctx.db.query("memberships").collect())).toHaveLength(4);
  });
});
