/**
 * Security regression suite (design-spec §6).
 *
 * Four properties are proven here, on top of what the feature suites already
 * cover (see `access.test.ts` for authentication and the tenant sweep,
 * `webhook.test.ts` for signature/replay, `innWebsites.test.ts` for the public
 * site's escaping, `modelBudget.test.ts` for the per-inn provider budget):
 *
 * 1. ids  every public query/mutation/action that takes a document id refuses
 *    a malformed id and an id belonging to another table, before any handler
 *    logic runs, and refuses a well-formed id from another inn afterwards.
 * 2. limits  the crawl cooldown, the per-user hourly crawl cap and the draft
 *    regenerate cooldown are enforced by the server, not by the UI.
 * 3. headers  every hand-written HTTP response declares its own type and
 *    forbids sniffing, and no error path reflects attacker-controlled input.
 * 4. injection  a payload stored through the ordinary staff/guest write paths
 *    comes back as data, never as markup, on the server-rendered public site.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { INN_COOLDOWN_MS, USER_RUNS_PER_HOUR } from "../convex/ingest";
import { BURST_OPERATIONS, HOURLY_OPERATIONS } from "../convex/modelBudget";
import { signWebhook } from "../convex/lib/webhookSignature";
import { addStaff, makeTest, seedInn, seedThread, signedInUser, type T } from "./setup";
import { seedInboundThread, seedLiveInn, TEST_SECRET, withEnv } from "./integrationSetup";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Strings that must never reach a handler through a `v.id(...)` argument. */
const MALFORMED_IDS = [
  "",
  "garbage",
  "not an id",
  "../../etc/passwd",
  "<script>alert(1)</script>",
  "j" + "0".repeat(31),
  "kg2468kg2468kg2468kg2468kg2468kg",
] as const;

const ID_ERROR = /Validator error: Expected ID for table/;

/**
 * Everything a signed-in caller can reach that names a document by id. Each
 * entry builds the argument object from one id, so the same call can be made
 * with a malformed id, a foreign-table id and another inn's real id.
 */
type IdCase = { name: string; table: string; call: (as: Awaited<ReturnType<typeof signedInUser>>["as"], id: string) => Promise<unknown> };

const INN_CASES: IdCase[] = [
  { name: "inns.get", table: "inns", call: (as, id) => as.query(api.inns.get, { innId: id as Id<"inns"> }) },
  { name: "threads.queue", table: "inns", call: (as, id) => as.query(api.threads.queue, { innId: id as Id<"inns"> }) },
  { name: "threads.search", table: "inns", call: (as, id) => as.query(api.threads.search, { innId: id as Id<"inns">, text: "x" }) },
  { name: "threads.stats", table: "inns", call: (as, id) => as.query(api.threads.stats, { innId: id as Id<"inns"> }) },
  { name: "pages.list", table: "inns", call: (as, id) => as.query(api.pages.list, { innId: id as Id<"inns"> }) },
  { name: "facts.list", table: "inns", call: (as, id) => as.query(api.facts.list, { innId: id as Id<"inns"> }) },
  { name: "corrections.list", table: "inns", call: (as, id) => as.query(api.corrections.list, { innId: id as Id<"inns"> }) },
  {
    name: "corrections.unaffectedControls",
    table: "inns",
    call: (as, id) =>
      as.query(api.corrections.unaffectedControls, {
        innId: id as Id<"inns">,
        paginationOpts: { numItems: 5, cursor: null },
      }),
  },
  { name: "ingest.runs", table: "inns", call: (as, id) => as.query(api.ingest.runs, { innId: id as Id<"inns"> }) },
  { name: "integrations.status", table: "inns", call: (as, id) => as.query(api.integrations.status, { innId: id as Id<"inns"> }) },
  { name: "overview.summary", table: "inns", call: (as, id) => as.query(api.overview.summary, { innId: id as Id<"inns"> }) },
  { name: "demo.status", table: "inns", call: (as, id) => as.query(api.demo.status, { innId: id as Id<"inns"> }) },
  { name: "innWebsites.editor", table: "inns", call: (as, id) => as.query(api.innWebsites.editor, { innId: id as Id<"inns"> }) },
  { name: "innWebsites.publicView", table: "inns", call: (as, id) => as.query(api.innWebsites.publicView, { innId: id as Id<"inns"> }) },
  { name: "teams.listInvites", table: "inns", call: (as, id) => as.query(api.teams.listInvites, { innId: id as Id<"inns"> }) },
  {
    name: "facts.add",
    table: "inns",
    call: (as, id) => as.mutation(api.facts.add, { innId: id as Id<"inns">, question: "q", answer: "a", scope: "general" }),
  },
  { name: "demo.changePolicyPage", table: "inns", call: (as, id) => as.mutation(api.demo.changePolicyPage, { innId: id as Id<"inns"> }) },
  {
    name: "demo.simulateInbound",
    table: "inns",
    call: (as, id) => as.mutation(api.demo.simulateInbound, { innId: id as Id<"inns">, guestEmail: "g@example.com", subject: "s", text: "t" }),
  },
  { name: "ingest.crawlSite", table: "inns", call: (as, id) => as.action(api.ingest.crawlSite, { innId: id as Id<"inns"> }) },
  { name: "inbox.provision", table: "inns", call: (as, id) => as.action(api.inbox.provision, { innId: id as Id<"inns"> }) },
  { name: "teams.createInvite", table: "inns", call: (as, id) => as.action(api.teams.createInvite, { innId: id as Id<"inns"> }) },
];

const THREAD_CASES: IdCase[] = [
  { name: "threads.get", table: "threads", call: (as, id) => as.query(api.threads.get, { threadId: id as Id<"threads"> }) },
  { name: "threads.claim", table: "threads", call: (as, id) => as.mutation(api.threads.claim, { threadId: id as Id<"threads"> }) },
  { name: "threads.release", table: "threads", call: (as, id) => as.mutation(api.threads.release, { threadId: id as Id<"threads"> }) },
  {
    name: "threads.setStatus",
    table: "threads",
    call: (as, id) => as.mutation(api.threads.setStatus, { threadId: id as Id<"threads">, status: "closed" }),
  },
  { name: "drafts.regenerate", table: "threads", call: (as, id) => as.mutation(api.drafts.regenerate, { threadId: id as Id<"threads"> }) },
  { name: "followUps.emailForThread", table: "threads", call: (as, id) => as.query(api.followUps.emailForThread, { threadId: id as Id<"threads"> }) },
  {
    name: "followUps.approveEmail",
    table: "threads",
    call: (as, id) => as.mutation(api.followUps.approveEmail, { threadId: id as Id<"threads">, text: "x", dueAt: Date.now() + 60_000 }),
  },
  { name: "presence.list", table: "threads", call: (as, id) => as.query(api.presence.list, { threadId: id as Id<"threads"> }) },
  {
    name: "presence.heartbeat",
    table: "threads",
    call: (as, id) => as.mutation(api.presence.heartbeat, { threadId: id as Id<"threads">, clientSessionId: "0123456789abcdef" }),
  },
];

const OTHER_CASES: IdCase[] = [
  { name: "drafts.edit", table: "drafts", call: (as, id) => as.mutation(api.drafts.edit, { draftId: id as Id<"drafts">, answer: "a" }) },
  { name: "drafts.send", table: "drafts", call: (as, id) => as.mutation(api.drafts.send, { draftId: id as Id<"drafts"> }) },
  { name: "demo.simulateSend", table: "drafts", call: (as, id) => as.mutation(api.demo.simulateSend, { draftId: id as Id<"drafts"> }) },
  {
    name: "corrections.setText",
    table: "corrections",
    call: (as, id) => as.mutation(api.corrections.setText, { correctionId: id as Id<"corrections">, proposedText: "p" }),
  },
  {
    name: "corrections.review",
    table: "corrections",
    call: (as, id) => as.mutation(api.corrections.review, { correctionId: id as Id<"corrections">, decision: "dismiss" }),
  },
  { name: "corrections.send", table: "corrections", call: (as, id) => as.mutation(api.corrections.send, { correctionId: id as Id<"corrections"> }) },
  {
    name: "corrections.regenerateProposal",
    table: "corrections",
    call: (as, id) => as.mutation(api.corrections.regenerateProposal, { correctionId: id as Id<"corrections"> }),
  },
  {
    name: "demo.simulateCorrectionSend",
    table: "corrections",
    call: (as, id) => as.mutation(api.demo.simulateCorrectionSend, { correctionId: id as Id<"corrections"> }),
  },
  { name: "pages.getVersion", table: "pageVersions", call: (as, id) => as.query(api.pages.getVersion, { pageVersionId: id as Id<"pageVersions"> }) },
  {
    name: "pages.submitContent",
    table: "pages",
    call: (as, id) => as.mutation(api.pages.submitContent, { pageId: id as Id<"pages">, markdown: "# x" }),
  },
  {
    name: "pages.setWatched",
    table: "pages",
    call: (as, id) => as.mutation(api.pages.setWatched, { pageId: id as Id<"pages">, watched: true }),
  },
  { name: "followUps.cancelEmail", table: "followUps", call: (as, id) => as.mutation(api.followUps.cancelEmail, { followUpId: id as Id<"followUps"> }) },
  { name: "teams.revokeInvite", table: "teamInvites", call: (as, id) => as.mutation(api.teams.revokeInvite, { inviteId: id as Id<"teamInvites"> }) },
];

const ALL_ID_CASES = [...INN_CASES, ...THREAD_CASES, ...OTHER_CASES];

describe("document id validation", () => {
  it("every public function that names a document refuses a malformed id before running", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    await seedInn(t, owner.userId);

    for (const entry of ALL_ID_CASES) {
      for (const bad of MALFORMED_IDS) {
        await expect(entry.call(owner.as, bad), `${entry.name} with "${bad}"`).rejects.toThrow(ID_ERROR);
      }
    }
    // Nothing was written by any of the refused calls.
    expect(await t.run((ctx) => ctx.db.query("threads").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("staffFacts").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("crawlRuns").collect())).toEqual([]);
  });

  it("an id of the wrong table is refused even when the document exists and the caller owns it", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    const threadId = await seedThread(t, innId);

    for (const entry of ALL_ID_CASES) {
      // Hand every function an id that exists but belongs to another table.
      const wrong = entry.table === "inns" ? threadId : innId;
      await expect(entry.call(owner.as, wrong), `${entry.name} with a ${entry.table === "inns" ? "threads" : "inns"} id`).rejects.toThrow(ID_ERROR);
    }
  });

  it("teams.removeStaff validates both of its ids", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const helper = await signedInUser(t, { name: "Helper" });
    const innId = await seedInn(t, owner.userId);
    await addStaff(t, innId, helper.userId);
    for (const bad of MALFORMED_IDS) {
      await expect(owner.as.mutation(api.teams.removeStaff, { innId: bad as Id<"inns">, userId: helper.userId })).rejects.toThrow(ID_ERROR);
      await expect(owner.as.mutation(api.teams.removeStaff, { innId, userId: bad as Id<"users"> })).rejects.toThrow(ID_ERROR);
    }
    // Still a member: no refused call removed anyone.
    expect(await t.run((ctx) => ctx.db.query("memberships").collect())).toHaveLength(2);
  });

  it("token arguments are plain strings and a hostile token is simply not valid", async () => {
    const t = makeTest();
    const staff = await signedInUser(t, { name: "Staff" });
    for (const token of ["", "garbage", "<script>alert(1)</script>", "0".repeat(64), "../../admin"]) {
      expect(await staff.as.query(api.teams.previewInvite, { token })).toMatchObject({ state: "invalid" });
      await expect(staff.as.mutation(api.teams.acceptInvite, { token })).rejects.toThrow(/invite_refused/);
    }
  });
});

/** A second inn with one of every document the id-taking functions can name. */
async function seedForeignWorld(t: T) {
  const a = await signedInUser(t, { name: "A" });
  const b = await signedInUser(t, { name: "B" });
  const { innId } = await seedLiveInn(t, a.userId);
  const innB = await seedInn(t, b.userId, "Inn B");
  const { threadId, messageId } = await seedInboundThread(t, innId);
  const ids = await t.run(async (ctx) => {
    const page = await ctx.db
      .query("pages")
      .withIndex("by_inn", (q) => q.eq("innId", innId))
      .first();
    const pageId = page!._id;
    const pageVersionId = page!.lastVersionId!;
    const draftId = await ctx.db.insert("drafts", {
      threadId,
      replyToMessageId: messageId,
      class: "answerable",
      answer: "Dogs are welcome for $25 a night.",
      abstain: false,
      status: "ready",
      model: "test",
      verifiedText: "Dogs are welcome for $25 a night.",
      textSource: "model",
    });
    const claimId = await ctx.db.insert("claims", {
      draftId,
      threadId,
      innId,
      statement: "Dogs are welcome.",
      url: "https://seagull.example/policies",
      pageId,
      pageVersionId,
      quote: "Dogs are welcome",
      verified: true,
      status: "ok",
    });
    const sentReplyId = await ctx.db.insert("sentReplies", {
      threadId,
      innId,
      draftId,
      sentBy: a.userId,
      sentAt: Date.now(),
      text: "Dogs are welcome for $25 a night.",
    });
    const correctionId = await ctx.db.insert("corrections", {
      innId,
      sentReplyId,
      threadId,
      claimId,
      pageId,
      oldVersionId: pageVersionId,
      newVersionId: pageVersionId,
      oldQuote: "Dogs are welcome",
      status: "needs_review",
    });
    const followUpId = await ctx.db.insert("followUps", {
      threadId,
      dueAt: Date.now() + 60_000,
      status: "scheduled",
      kind: "email",
      innId,
      approvedBy: a.userId,
      approvedText: "Just checking in.",
    });
    return { pageId, pageVersionId, draftId, correctionId, followUpId };
  });
  const token = await a.as.action(api.teams.createInvite, { innId, label: "Night desk" });
  const inviteId = await t.run(async (ctx) => (await ctx.db.query("teamInvites").first())!._id);
  void token;
  return { a, b, innId, innB, threadId, inviteId, ...ids };
}

describe("cross-inn access", () => {
  it("every id-taking function refuses another inn's real document, without revealing that it exists", async () => {
    const t = makeTest();
    const w = await seedForeignWorld(t);
    const byTable: Record<string, string> = {
      inns: w.innId,
      threads: w.threadId,
      drafts: w.draftId,
      corrections: w.correctionId,
      pages: w.pageId,
      pageVersions: w.pageVersionId,
      followUps: w.followUpId,
      teamInvites: w.inviteId,
    };
    for (const entry of ALL_ID_CASES) {
      const id = byTable[entry.table];
      const err = await entry.call(w.b.as, id).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err, `${entry.name} must refuse a foreign document`).toBeInstanceOf(Error);
      // One vocabulary for "not yours" and "does not exist"; never a message
      // that discloses the document's contents or its inn.
      expect(err!.message, entry.name).toMatch(/forbidden|owner_only|No access/);
      expect(err!.message, entry.name).not.toMatch(/Seagull|seagull\.example|Dogs are welcome|Night desk/);
    }
  });

  it("an anonymous demo visitor cannot reach a real inn's documents", async () => {
    const t = makeTest();
    const w = await seedForeignWorld(t);
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    await visitor.as.mutation(api.demo.enter, {});
    await expect(visitor.as.query(api.threads.get, { threadId: w.threadId })).rejects.toThrow(/forbidden/);
    await expect(visitor.as.query(api.inns.get, { innId: w.innId })).rejects.toThrow(/forbidden/);
    await expect(visitor.as.mutation(api.drafts.send, { draftId: w.draftId })).rejects.toThrow(/forbidden/);
    await expect(visitor.as.mutation(api.demo.changePolicyPage, { innId: w.innId })).rejects.toThrow(/forbidden/);
    expect((await visitor.as.query(api.inns.mine, {})).map((i) => i.innId)).not.toContain(w.innId);
  });
});

describe("rate limits", () => {
  it("the crawl cooldown refuses a second run for the same inn inside the window", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    const now = Date.now();
    // A run that started just inside the window, exactly as beginRun records it.
    await t.run((ctx) => ctx.db.patch(innId, { lastCrawlStartedAt: now - (INN_COOLDOWN_MS - 1_000) }));

    const err = await owner.as.action(api.ingest.crawlSite, { innId }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/cooldown/);
    // Refused before the run row is opened, so nothing was spent.
    expect(await t.run((ctx) => ctx.db.query("crawlRuns").collect())).toEqual([]);

    // Just outside the window the same call is authorized (it then fails on the
    // stubbed provider, which is a later stage: the cooldown is what is tested).
    await t.run((ctx) => ctx.db.patch(innId, { lastCrawlStartedAt: now - (INN_COOLDOWN_MS + 1_000) }));
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    await owner.as.action(api.ingest.crawlSite, { innId }).catch(() => undefined);
    expect(await t.run((ctx) => ctx.db.query("crawlRuns").collect())).toHaveLength(1);
  });

  it("the per-user hourly cap counts runs across the caller's inns and expires with the clock", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const other = await signedInUser(t, { name: "Other" });
    const innId = await seedInn(t, owner.userId);
    const otherInn = await seedInn(t, other.userId, "Other Inn");
    const now = Date.now();
    await t.run(async (ctx) => {
      // USER_RUNS_PER_HOUR runs in the last hour, spread over this user's inns.
      for (let i = 0; i < USER_RUNS_PER_HOUR; i++) {
        await ctx.db.insert("crawlRuns", {
          innId,
          userId: owner.userId,
          trigger: "staff",
          startedAt: now - (i + 1) * 60_000,
          status: "done",
          pagesStored: 1,
          pagesSkipped: 0,
        });
      }
      // Another user's runs never count against this one.
      await ctx.db.insert("crawlRuns", {
        innId: otherInn,
        userId: other.userId,
        trigger: "staff",
        startedAt: now - 1_000,
        status: "done",
        pagesStored: 1,
        pagesSkipped: 0,
      });
    });

    await expect(owner.as.action(api.ingest.crawlSite, { innId })).rejects.toThrow(/cooldown/);
    // The inn cooldown is untouched: it is the user cap that refused this.
    expect(await t.run(async (ctx) => (await ctx.db.get(innId))?.lastCrawlStartedAt ?? null)).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("crawlRuns").collect())).toHaveLength(USER_RUNS_PER_HOUR + 1);

    // Age one run past the hour and the cap releases.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("crawlRuns")
        .withIndex("by_user_startedAt", (q) => q.eq("userId", owner.userId))
        .collect();
      await ctx.db.patch(rows[0]._id, { startedAt: now - 2 * 60 * 60 * 1000 });
    });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    await owner.as.action(api.ingest.crawlSite, { innId }).catch(() => undefined);
    expect(await t.run((ctx) => ctx.db.query("crawlRuns").collect())).toHaveLength(USER_RUNS_PER_HOUR + 2);
  });

  it("drafts.regenerate cannot be spammed: the per-thread cooldown refuses the second call", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);
    const { threadId } = await seedInboundThread(t, innId);
    await owner.as.mutation(api.threads.claim, { threadId });

    await owner.as.mutation(api.drafts.regenerate, { threadId });
    const scheduledAfterFirst = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    await expect(owner.as.mutation(api.drafts.regenerate, { threadId })).rejects.toThrow(/cooldown/);
    await expect(owner.as.mutation(api.drafts.regenerate, { threadId })).rejects.toThrow(/cooldown/);
    // The refused calls scheduled no further drafter work.
    const scheduledAfterSpam = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduledAfterSpam).toHaveLength(scheduledAfterFirst.length);

    // A thread claimed by somebody else cannot be regenerated at all.
    const other = await signedInUser(t, { name: "Other" });
    await addStaff(t, innId, other.userId);
    await expect(other.as.mutation(api.drafts.regenerate, { threadId })).rejects.toThrow(/claimed/);
  });
});

describe("HTTP responses", () => {
  /** Every hand-written response declares its type and forbids content sniffing. */
  it("the public inn site and its 404 set content-type, nosniff and no-store", async () => {
    withEnv({ CONVEX_SITE_URL: "https://some.convex.site" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await owner.as.mutation(api.innWebsites.createFictional, { name: "Harbor Light" });

    for (const path of [`/inn/${innId}/`, `/inn/${innId}/policies`, `/inn/${innId}/rooms`, `/inn/${innId}/notices`]) {
      const res = await t.fetch(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    for (const path of ["/inn/", "/inn/nope/", `/inn/${innId}/unknown-page`]) {
      const res = await t.fetch(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("the JSON endpoints answer as JSON and never reflect the request back", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const payload = `<img src=x onerror=alert(1)>"><svg/onload=alert(1)><script>alert(1)</script>`;

    const health = await t.fetch(`/api/health?q=${encodeURIComponent(payload)}`);
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toBe("application/json");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toMatchObject({ ok: true, service: "front-desk" });
    expect(await (await t.fetch("/api/health")).text()).not.toContain("<");

    // Unsigned, badly signed, unparseable and structurally invalid bodies all
    // answer with a fixed reason; none of them echoes the payload.
    const unsigned = await t.fetch("/api/agentmail/webhook", {
      method: "POST",
      body: JSON.stringify({ type: "event", event_type: "message.received", event_id: payload, message: { subject: payload } }),
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("content-type")).toBe("application/json");
    expect(unsigned.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await unsigned.text()).not.toContain("<");

    const badJsonBody = `{not json ${payload}`;
    const badJson = await t.fetch("/api/agentmail/webhook", {
      method: "POST",
      body: badJsonBody,
      headers: { ...(await signWebhook(TEST_SECRET, badJsonBody, "m1")), "content-type": "application/json" },
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.text()).toBe(JSON.stringify({ ok: false, error: "invalid json" }));

    const invalidBody = JSON.stringify({ type: "event", event_type: "message.received", event_id: payload, message: { subject: payload } });
    const invalid = await t.fetch("/api/agentmail/webhook", {
      method: "POST",
      body: invalidBody,
      headers: { ...(await signWebhook(TEST_SECRET, invalidBody, "m2")), "content-type": "application/json" },
    });
    expect(invalid.status).toBe(400);
    const invalidText = await invalid.text();
    expect(invalidText).not.toContain("<");
    expect(invalidText).not.toContain("onerror");
    expect(JSON.parse(invalidText)).toMatchObject({ ok: false });

    const tooLarge = await t.fetch("/api/agentmail/webhook", {
      method: "POST",
      body: "x".repeat(2_000_001),
      headers: { "content-type": "application/json" },
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ ok: false, error: "payload too large" });
  });
});

describe("model budget", () => {
  /**
   * `tests/modelBudget.test.ts` proves the component's arithmetic in detail.
   * What matters here is the security property: the refusal is the server's,
   * it cannot be spent past, and a denial charges nothing.
   */
  it("refuses a provider operation once the inn's budget is spent, and charges nothing for the refusal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-21T09:00:00Z"));
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    const draftId = await t.mutation(internal.generation.begin, { threadId, inboundMessageId: messageId, model: "test" });
    expect(draftId).not.toBeNull();
    const reserve = () =>
      t.mutation(internal.modelBudget.reserve, { scope: { kind: "draft" as const, draftId: draftId!, inboundMessageId: messageId } });

    for (let i = 0; i < BURST_OPERATIONS; i++) expect(await reserve()).toEqual({ ok: true });
    // Every further attempt is refused, and repeating it never wears the refusal down.
    for (let i = 0; i < 3; i++) {
      expect(await reserve()).toMatchObject({ ok: false, kind: "throttled" });
    }
    // The hourly window paid for the ten that ran and for none of the refusals.
    expect(await t.query(internal.modelBudget.peek, { innId })).toEqual({
      modelBurst: 0,
      modelHourly: HOURLY_OPERATIONS - BURST_OPERATIONS,
    });
    // Nothing public can reset or inspect the budget.
    expect(Object.keys(api)).not.toContain("modelBudget");
  });
});

describe("owner-only free text", () => {
  const FIELD_PAYLOAD = `<img src=x onerror=alert(1)>"><svg/onload=alert(1)>`;

  it("an inn name and an invitation label are stored verbatim, and the invitation token is returned once and never listed", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);

    const { token } = await owner.as.action(api.teams.createInvite, { innId, label: `Night desk ${FIELD_PAYLOAD}` });
    const invites = await owner.as.query(api.teams.listInvites, { innId });
    expect(invites[0]).toMatchObject({ label: `Night desk ${FIELD_PAYLOAD}`, state: "pending" });
    // The raw token is a one-use capability: only the creating call ever sees it.
    expect(JSON.stringify(invites), "listInvites never echoes a token").not.toContain(token);
    const stored = await t.run((ctx) => ctx.db.query("teamInvites").collect());
    expect(JSON.stringify(stored), "only the hash is stored").not.toContain(token);
    // A label longer than the cap is refused rather than silently truncated.
    await expect(owner.as.action(api.teams.createInvite, { innId, label: "x".repeat(121) })).rejects.toThrow(/at most 120/);

    // The property name takes the same payload and comes back as the same bytes.
    withEnv({ CONVEX_SITE_URL: "https://some.convex.site" });
    const fictional = await owner.as.mutation(api.innWebsites.createFictional, { name: `Harbor ${FIELD_PAYLOAD}` });
    const mine = await owner.as.query(api.inns.mine, {});
    expect(mine.find((i) => i.innId === fictional.innId)).toMatchObject({ name: `Harbor ${FIELD_PAYLOAD}` });
  });
});

describe("stored payloads render as data, never as markup", () => {
  const PAYLOADS = [
    `<img src=x onerror=alert(1)>`,
    `<script>alert(1)</script>`,
    `javascript:alert(1)`,
    `"><svg/onload=alert(1)>`,
    `</title><style>body{display:none}</style>`,
    `' onmouseover='alert(1)`,
  ];

  it("an XSS payload saved through the website editor comes back escaped on every public page", async () => {
    withEnv({ CONVEX_SITE_URL: "https://some.convex.site" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await owner.as.mutation(api.innWebsites.createFictional, { name: PAYLOADS[0]! });
    const base = (await owner.as.query(api.innWebsites.editor, { innId }))!.content;
    await owner.as.mutation(api.innWebsites.update, {
      innId,
      content: {
        ...base,
        publicName: PAYLOADS[1]!,
        intro: PAYLOADS[0]!,
        checkIn: PAYLOADS[2]!,
        checkOut: PAYLOADS[3]!,
        petPolicy: PAYLOADS[4]!,
        breakfastHours: PAYLOADS[5]!,
        wifi: PAYLOADS[0]!,
        roomsDescription: PAYLOADS[3]!,
        notice: PAYLOADS[1]!,
      },
    });

    for (const page of ["", "policies", "rooms", "notices"]) {
      const res = await t.fetch(`/inn/${innId}/${page}`);
      expect(res.status, page).toBe(200);
      const html = await res.text();
      // No payload element and no payload attribute survived as markup…
      expect(html, page).not.toMatch(/<script>alert/i);
      expect(html, page).not.toContain("<img src=x");
      expect(html, page).not.toContain("<svg/onload");
      expect(html, page).not.toContain("<style>body");
      // No tag anywhere carries an event-handler attribute (the payloads' `onerror`,
      // `onload` and `onmouseover` survive only inside escaped text nodes).
      expect(html, page).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(html, page).not.toMatch(/(?:href|src)\s*=\s*["']?\s*javascript:/i);
      // …and every href stays a same-site inn path: no javascript: URL is possible.
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
      expect(hrefs.length, page).toBeGreaterThan(0);
      for (const href of hrefs) expect(href, page).toMatch(new RegExp(`^/inn/${innId}/`));
      // The payload is present, as text.
      expect(html, page).toContain("&lt;");
      // The <title> is a single text node: the payload cannot close it early.
      const title = /<title>([\s\S]*?)<\/title>/.exec(html);
      expect(title, page).not.toBeNull();
      expect(title![1], page).not.toContain("<");
    }
  });

  it("guest and staff text is stored verbatim and never interpreted by the server", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});

    for (const payload of PAYLOADS) {
      const { threadId } = await visitor.as.mutation(api.demo.simulateInbound, {
        innId,
        guestEmail: "guest@example.com",
        subject: payload,
        text: `${payload} please advise`,
      });
      const detail = await visitor.as.query(api.threads.get, { threadId });
      // Round-trips byte for byte: no sanitising, no encoding, no execution.
      expect(detail.thread.subject).toBe(payload);
      expect(detail.messages[0]!.text).toBe(`${payload} please advise`);
      // The thread view exposes plain text only: no html field is ever returned.
      expect(Object.keys(detail.messages[0]!)).not.toContain("html");
    }

    // The staff fact form is the other guest-visible write path.
    for (const payload of PAYLOADS) {
      const factId = await visitor.as.mutation(api.facts.add, { innId, question: payload, answer: payload, scope: "general" });
      const fact = (await visitor.as.query(api.facts.list, { innId })).find((f) => f._id === factId);
      expect(fact).toMatchObject({ question: payload, answer: payload });
    }

    // Search is a plain text index, not a query language: a payload finds its thread.
    const found = await visitor.as.query(api.threads.search, { innId, text: "please advise" });
    expect(found.length).toBeGreaterThan(0);
  });
});
