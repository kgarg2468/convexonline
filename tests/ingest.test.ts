import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { classifyPage, selectPages, MAX_PAGES } from "../convex/lib/siteSelection";
import { makeTest, seedInn, signedInUser } from "./setup";
import { json, seedLiveInn, settle, stubFetch, withEnv, type Route } from "./integrationSetup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SITE = "https://seagull.example";

/** A page body, optionally with the status code the *target* site answered (Firecrawl still reports success). */
type ScrapedPage = string | { markdown: string; statusCode: number };

function firecrawlRoutes(pages: Record<string, ScrapedPage>, links: string[]): Route[] {
  return [
    { match: (url) => url.endsWith("/v2/map"), respond: () => json(200, { success: true, links }) },
    {
      match: (url) => url.endsWith("/v2/scrape"),
      respond: (_url, init) => {
        const body = JSON.parse(String(init.body)) as { url: string };
        const page = pages[body.url];
        if (!page) return json(500, {});
        const markdown = typeof page === "string" ? page : page.markdown;
        const metadata = typeof page === "string" ? { title: "t" } : { title: "t", statusCode: page.statusCode };
        return json(200, { success: true, data: { markdown, changeTracking: { changeStatus: "new" }, metadata } });
      },
    },
  ];
}

describe("site selection (pure)", () => {
  it("keeps same-origin https pages, home first, policy pages ahead of others, capped", () => {
    const picked = selectPages(SITE + "/", [
      `${SITE}/about`,
      `${SITE}/policies/`,
      `${SITE}/rooms#top`,
      `${SITE}/menu.pdf`,
      "http://seagull.example/insecure",
      "https://evil.example/policies",
      `${SITE}/rates?x=1`,
      ...Array.from({ length: 20 }, (_, i) => `${SITE}/blog/post-${i}`),
    ]);
    expect(picked[0]).toBe(SITE + "/");
    expect(picked.slice(1, 4)).toEqual([`${SITE}/policies`, `${SITE}/rooms`, `${SITE}/rates`]);
    expect(picked).toHaveLength(MAX_PAGES);
    expect(picked.every((u) => u.startsWith(SITE))).toBe(true);
    expect(picked).not.toContain(`${SITE}/menu.pdf`);
    expect(selectPages(SITE, [], 50)).toEqual([SITE + "/"]);
    expect(classifyPage(`${SITE}/house-rules`)).toBe("policies");
    expect(classifyPage(`${SITE}/contact`)).toBe("other");
  });
});

describe("crawlSite", () => {
  it("maps, scrapes at most 10 same-origin pages, stores versions and watches the relevant ones", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    await t.run((ctx) => ctx.db.patch(innId, { siteUrl: SITE }));
    const pages: Record<string, string> = { [SITE + "/"]: "# Seagull Inn\n\nWelcome." };
    const links: string[] = [];
    for (const p of ["policies", "rooms", "rates", "news", "about", "contact", "gallery", "history", "map", "press", "jobs"]) {
      pages[`${SITE}/${p}`] = `# ${p}\n\nContent of ${p}.`;
      links.push(`${SITE}/${p}`);
    }
    links.push("https://other.example/policies");
    const { calls } = stubFetch(firecrawlRoutes(pages, links));

    const result = await owner.as.action(api.ingest.crawlSite, { innId });
    expect(result).toMatchObject({ pagesStored: 10, pagesSkipped: 0, affectedClaims: 0 });
    const scrapes = calls.filter((c) => c.url.endsWith("/v2/scrape"));
    expect(scrapes).toHaveLength(10);
    expect(scrapes.every((c) => String((c.body as { url: string }).url).startsWith(SITE))).toBe(true);
    expect(scrapes.every((c) => (c.body as { formats: unknown[] }).formats.some((f) => typeof f === "object" && (f as { tag?: string }).tag === `inn-${innId}`))).toBe(true);
    expect(calls[0].headers?.Authorization).toBe("Bearer fc-test");

    const stored = await owner.as.query(api.pages.list, { innId });
    expect(stored).toHaveLength(10);
    const byUrl = Object.fromEntries(stored.map((p) => [p.url, p]));
    expect(byUrl[`${SITE}/policies`]).toMatchObject({ kind: "policies", watched: true, title: "policies" });
    expect(byUrl[`${SITE}/`]).toMatchObject({ watched: true });
    expect(byUrl[`${SITE}/about`]).toMatchObject({ kind: "other", watched: false });
    expect(stored.every((p) => p.lastVersion !== null)).toBe(true);
    const runs = await owner.as.query(api.ingest.runs, { innId });
    expect(runs[0]).toMatchObject({ trigger: "staff", status: "done", pagesStored: 10 });

    // Cooldown: a second crawl within 10 minutes is refused before any provider call.
    const before = calls.length;
    await expect(owner.as.action(api.ingest.crawlSite, { innId })).rejects.toThrow(/cooldown/);
    expect(calls).toHaveLength(before);
    expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ firecrawl: true, inboxConfigured: false });
  });

  it("refuses demo inns, anonymous users, unsafe site urls, and reports a missing key without spending", async () => {
    const t = makeTest();
    const { calls } = stubFetch([]);
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    const demoInn = await visitor.as.mutation(api.demo.enter, {});
    await expect(visitor.as.action(api.ingest.crawlSite, { innId: demoInn })).rejects.toThrow(/demo_inn/);

    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    await t.run((ctx) => ctx.db.patch(innId, { siteUrl: "http://10.0.0.1/" }));
    await expect(owner.as.action(api.ingest.crawlSite, { innId })).rejects.toThrow(/invalid_site_url/);
    await t.run((ctx) => ctx.db.patch(innId, { siteUrl: SITE, lastCrawlStartedAt: undefined }));
    withEnv({ FIRECRAWL_API_KEY: undefined });
    await expect(owner.as.action(api.ingest.crawlSite, { innId })).rejects.toThrow(/firecrawl_unavailable/);
    expect((await owner.as.query(api.ingest.runs, { innId }))[0]).toMatchObject({ status: "failed" });
    const stranger = await signedInUser(t, { name: "S" });
    await expect(stranger.as.action(api.ingest.crawlSite, { innId })).rejects.toThrow(/forbidden/);
    expect(calls).toEqual([]);
  });

  it("a target page that answers 403 is not stored: the run fails and the previous valid version survives", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, pageId, versionId } = await seedLiveInn(t, owner.userId);
    const forbidden = { markdown: "Forbidden\n\nYou don't have permission to access this resource.", statusCode: 403 };
    stubFetch(firecrawlRoutes({ [SITE + "/"]: forbidden, [`${SITE}/policies`]: forbidden }, [`${SITE}/policies`]));

    const result = await owner.as.action(api.ingest.crawlSite, { innId });
    expect(result).toMatchObject({ pagesStored: 0, pagesSkipped: 2, affectedClaims: 0 });
    const [run] = await owner.as.query(api.ingest.runs, { innId });
    expect(run).toMatchObject({ status: "failed", pagesStored: 0, pagesSkipped: 2 });
    expect(run.reason).toMatch(/403/);
    expect(run.reason).not.toMatch(/permission/);

    // No homepage row was created from the error body; the policies page still points at its earlier version.
    const stored = await owner.as.query(api.pages.list, { innId });
    expect(stored.map((p) => p.url)).toEqual([`${SITE}/policies`]);
    expect(stored[0].lastVersion?._id).toBe(versionId);
    const versions = await t.run((ctx) => ctx.db.query("pageVersions").collect());
    expect(versions).toHaveLength(1);
    expect(versions[0].pageId).toBe(pageId);
    expect(versions[0].markdown).not.toContain("Forbidden");

    // A mixed crawl keeps the good page and reports only the blocked one.
    await t.run((ctx) => ctx.db.patch(innId, { lastCrawlStartedAt: undefined }));
    stubFetch(firecrawlRoutes({ [SITE + "/"]: "# Seagull Inn\n\nWelcome.", [`${SITE}/policies`]: forbidden }, [`${SITE}/policies`]));
    const mixed = await owner.as.action(api.ingest.crawlSite, { innId });
    expect(mixed).toMatchObject({ pagesStored: 1, pagesSkipped: 1 });
    const [mixedRun] = await owner.as.query(api.ingest.runs, { innId });
    expect(mixedRun).toMatchObject({ status: "done", pagesStored: 1, pagesSkipped: 1 });
    expect(mixedRun.reason).toMatch(/policies: .*403/);
    const after = await owner.as.query(api.pages.list, { innId });
    expect(Object.fromEntries(after.map((p) => [p.url, p.lastVersion?._id]))).toEqual({
      [`${SITE}/policies`]: versionId,
      [SITE + "/"]: expect.any(String),
    });
  });

  it("a re-crawl that changes a cited passage opens a correction and schedules a proposal", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, pageId, versionId } = await seedLiveInn(t, owner.userId);
    const thread = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("threads", { innId, guestEmail: "g@x.com", subject: "Dog", snippet: "Dog", status: "waiting_guest", lastInboundAt: Date.now() });
      const draftId = await ctx.db.insert("drafts", { threadId, class: "answerable", answer: "$25 per night pet fee", abstain: false, status: "sent", model: "m" });
      await ctx.db.insert("claims", { draftId, threadId, innId, statement: "s", pageId, pageVersionId: versionId, url: `${SITE}/policies`, quote: "$25 per night pet fee", verified: true, status: "ok" });
      await ctx.db.insert("sentReplies", { threadId, innId, draftId, sentBy: owner.userId, sentAt: Date.now(), kind: "reply", text: "$25 per night pet fee" });
      return threadId;
    });
    stubFetch(firecrawlRoutes({ [SITE + "/"]: "# Home", [`${SITE}/policies`]: "# Policies\n\nDogs are welcome for a $40 per night pet fee.\n" }, [`${SITE}/policies`]));
    const result = await owner.as.action(api.ingest.crawlSite, { innId });
    expect(result).toMatchObject({ pagesStored: 2, affectedClaims: 1 });
    await settle(t);
    const [c] = await owner.as.query(api.corrections.list, { innId, status: "needs_review" });
    expect(c).toMatchObject({ threadId: thread, oldQuote: "$25 per night pet fee", isCurrent: true });
    expect(c.statusReason).toMatch(/OPENAI_API_KEY/);
  });
});

describe("cron rescrape", () => {
  it("re-reads only watched pages of real inns that are stale, and marks unchanged pages checked", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, pageId, markdown } = await seedLiveInn(t, owner.userId);
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    await visitor.as.mutation(api.demo.enter, {});
    const unwatched = await t.run(async (ctx) => {
      const id = await ctx.db.insert("pages", { innId, url: `${SITE}/about`, title: "About", kind: "other", watched: false });
      const v = await ctx.db.insert("pageVersions", { pageId: id, markdown: "about", hash: "a", scrapedAt: 0, changeStatus: "new" });
      await ctx.db.patch(id, { lastVersionId: v });
      return id;
    });
    const { calls } = stubFetch(firecrawlRoutes({ [`${SITE}/policies`]: markdown, [`${SITE}/about`]: "about" }, []));
    const r = await t.action(internal.ingest.rescrapeDue, {});
    expect(r.scraped).toBe(1);
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { url: string }).url).toBe(`${SITE}/policies`);
    const page = await t.run((ctx) => ctx.db.get(pageId));
    expect(page?.lastCheckedAt).toBeGreaterThan(Date.now() - 5000);
    expect(await t.run((ctx) => ctx.db.query("pageVersions").collect())).toHaveLength(1 + 1 + (await t.run((ctx) => ctx.db.query("pageVersions").collect())).length - 2);
    expect((await t.run((ctx) => ctx.db.get(unwatched)))?.lastCheckedAt).toBeUndefined();
    const runs = await owner.as.query(api.ingest.runs, { innId });
    expect(runs[0]).toMatchObject({ trigger: "cron", status: "done", pagesStored: 1 });

    // Freshly checked pages are not due again; a missing key spends nothing.
    const again = await t.action(internal.ingest.rescrapeDue, {});
    expect(again.scraped).toBe(0);
    withEnv({ FIRECRAWL_API_KEY: undefined });
    await t.run((ctx) => ctx.db.patch(pageId, { lastCheckedAt: 0 }));
    expect(await t.action(internal.ingest.rescrapeDue, {})).toMatchObject({ scraped: 0, reason: expect.stringMatching(/FIRECRAWL_API_KEY/) });
    expect(calls).toHaveLength(1);
  });
});

describe("inbox provisioning", () => {
  it("only an owner with live authority provisions, once, with server-controlled ids", async () => {
    // Provisioning contract: a registered, product-scoped webhook is a precondition (see tests/inboxWebhook.test.ts).
    withEnv({ AGENTMAIL_API_KEY: "am-test", AGENTMAIL_WEBHOOK_ID: "wh_1", CONVEX_SITE_URL: "https://some.convex.site" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId, "Seagull & Co <script>");
    const hook = { webhook_id: "wh_1", url: "https://some.convex.site/api/agentmail/webhook", enabled: true, event_types: ["message.received"], inbox_ids: ["tester@agentmail.to"], client_id: "frontdesk-some" };
    const { calls } = stubFetch([
      { match: (url, init) => url.endsWith("/v0/webhooks/wh_1") && init.method === "GET", respond: () => json(200, hook) },
      { match: (url, init) => url.endsWith("/v0/webhooks/wh_1") && init.method === "PATCH", respond: () => json(200, { ...hook, inbox_ids: [...hook.inbox_ids, "frontdesk-x@agentmail.to"] }) },
      { match: (url) => url.endsWith("/v0/inboxes"), respond: () => json(200, { inbox_id: `frontdesk-x@agentmail.to` }) },
    ]);
    const staff = await signedInUser(t, { name: "Staff" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId, userId: staff.userId, role: "staff", name: "Staff" }));
    await expect(staff.as.action(api.inbox.provision, { innId })).rejects.toThrow(/owner_only/);
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    const demoInn = await visitor.as.mutation(api.demo.enter, {});
    await expect(visitor.as.action(api.inbox.provision, { innId: demoInn })).rejects.toThrow(/live_mail_forbidden/);
    expect(calls).toEqual([]);

    const result = await owner.as.action(api.inbox.provision, { innId });
    expect(result).toEqual({ inboxAddress: "frontdesk-x@agentmail.to" });
    // GET hook → POST inbox → PATCH append; the inbox request is fully server-derived.
    expect(calls).toHaveLength(3);
    expect(calls[1].body).toEqual({ username: `frontdesk-${String(innId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}`, display_name: "Seagull & Co script", client_id: `frontdesk-inn-${innId}` });
    expect(calls[2].body).toEqual({ add_inbox_ids: ["frontdesk-x@agentmail.to"] });
    const inn = await t.run((ctx) => ctx.db.get(innId));
    expect(inn).toMatchObject({ inboxId: "frontdesk-x@agentmail.to", inboxClientId: `frontdesk-inn-${innId}`, inboxWebhookId: "wh_1" });
    await expect(owner.as.action(api.inbox.provision, { innId })).rejects.toThrow(/already_configured/);
    expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ agentmail: true, inboxConfigured: true, inboxWebhookReady: true, liveMail: { allowed: true } });

    // Binding the same inbox to another inn is refused; demo inns never get one.
    const other = await seedInn(t, owner.userId, "Other");
    await expect(t.mutation(internal.inbox.configureInbox, { innId: other, inboxId: "frontdesk-x@agentmail.to" })).rejects.toThrow(/already bound/);
    await expect(t.mutation(internal.inbox.configureInbox, { innId: demoInn, inboxId: "d@agentmail.to" })).rejects.toThrow(/demo_inn/);
  });
});
