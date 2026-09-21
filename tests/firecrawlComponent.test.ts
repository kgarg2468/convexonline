import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import http from "../convex/http";
import { RETRY } from "../node_modules/@firecrawl/firecrawl-convex/src/component/api";
import { makeTest, seedInn, signedInUser } from "./setup";
import { json, seedLiveInn, settle, stubFetch, withEnv, type Route } from "./integrationSetup";

/**
 * The published @firecrawl/firecrawl-convex component is registered in
 * tests/setup.ts exactly as convex.config.ts mounts it, so every crawl here
 * runs through the component's own actions and request code. Only the
 * outgoing HTTP fetch is stubbed; nothing reaches the provider.
 */

const SITE = "https://seagull.example";
const OTHER_SITE = "https://harbor.example";
const HOST = "https://some.convex.site";

const originalRetry = { ...RETRY };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Object.assign(RETRY, originalRetry);
});

type ScrapedPage = string | { markdown: string; statusCode?: number; error?: string; changeStatus?: string; diff?: string };

function firecrawlRoutes(pages: Record<string, ScrapedPage>, links: unknown[]): Route[] {
  return [
    { match: (url) => url.endsWith("/v2/map"), respond: () => json(200, { success: true, links }) },
    {
      match: (url) => url.endsWith("/v2/scrape"),
      respond: (_url, init) => {
        const { url } = JSON.parse(String(init.body)) as { url: string };
        const page = pages[url];
        if (page === undefined) return json(404, { success: false, error: "Not found" });
        const p = typeof page === "string" ? { markdown: page } : page;
        const metadata: Record<string, unknown> = { title: "t", sourceURL: url };
        if (p.statusCode !== undefined) metadata.statusCode = p.statusCode;
        if (p.error !== undefined) metadata.error = p.error;
        const changeTracking: Record<string, unknown> = { changeStatus: p.changeStatus ?? "new" };
        if (p.diff !== undefined) changeTracking.diff = { text: p.diff };
        return json(200, { success: true, data: { markdown: p.markdown, changeTracking, metadata } });
      },
    },
  ];
}

const scrapeCalls = (calls: Array<{ url: string; body: unknown }>) => calls.filter((c) => c.url.endsWith("/v2/scrape"));
const bodyOf = (c: { body: unknown }) => c.body as Record<string, unknown>;

describe("firecrawl component transport", () => {
  it("sends every map and scrape through the component with its origin attribution, the deployment key, maxAge 0, the inn's changeTracking tag and a bounded timeout", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-component-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    await t.run((ctx) => ctx.db.patch(innId, { siteUrl: SITE }));
    const { calls } = stubFetch(
      firecrawlRoutes(
        { [SITE + "/"]: "# Seagull Inn\n\nWelcome.", [`${SITE}/policies`]: "# Policies\n\nNo smoking." },
        // The component normalises string links to { url }; both forms must survive the app's filter.
        [`${SITE}/policies`, { url: `${SITE}/policies#top`, title: "Policies" }, "https://evil.example/policies", `${SITE}/rooms.pdf`],
      ),
    );

    const result = await owner.as.action(api.ingest.crawlSite, { innId });
    expect(result).toMatchObject({ pagesStored: 2, pagesSkipped: 0 });

    const maps = calls.filter((c) => c.url.endsWith("/v2/map"));
    expect(maps).toHaveLength(1);
    expect(maps[0].url).toBe("https://api.firecrawl.dev/v2/map");
    expect(bodyOf(maps[0])).toEqual({ origin: "firecrawl-convex", url: SITE + "/", limit: 50, timeout: 60_000 });

    const scrapes = scrapeCalls(calls);
    expect(scrapes.map((c) => bodyOf(c).url).sort()).toEqual([SITE + "/", `${SITE}/policies`]);
    for (const c of scrapes) {
      expect(c.url).toBe("https://api.firecrawl.dev/v2/scrape");
      expect(bodyOf(c)).toMatchObject({
        origin: "firecrawl-convex",
        formats: ["markdown", { type: "changeTracking", modes: ["git-diff"], tag: `inn-${innId}` }],
        onlyMainContent: true,
        maxAge: 0,
        timeout: 60_000,
      });
    }
    for (const c of calls) {
      expect(c.headers?.Authorization).toBe("Bearer fc-component-test");
      expect(c.headers?.["Content-Type"]).toBe("application/json");
    }
    // The key never crosses a function boundary: it is only in the header.
    for (const c of calls) expect(JSON.stringify(c.body)).not.toContain("fc-component-test");
    expect((await owner.as.query(api.ingest.runs, { innId }))[0]).toMatchObject({ status: "done", pagesStored: 2 });
  });

  it("rejects a component-delivered target 403, an explicit scrape error and empty markdown without storing a version", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-component-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, pageId, versionId } = await seedLiveInn(t, owner.userId);
    const cases: ScrapedPage[] = [
      { markdown: "Forbidden\n\nYou don't have permission to access this resource.", statusCode: 403 },
      { markdown: "# Home", statusCode: 200, error: "blocked by bot protection" },
      { markdown: "   " },
    ];
    for (const page of cases) {
      await t.run((ctx) => ctx.db.patch(pageId, { lastCheckedAt: 0 }));
      const { calls } = stubFetch(firecrawlRoutes({ [`${SITE}/policies`]: page }, []));
      const r = await t.action(internal.ingest.rescrapeDue, {});
      expect(r.scraped).toBe(1);
      expect(scrapeCalls(calls)).toHaveLength(1);
      const [run] = await owner.as.query(api.ingest.runs, { innId });
      expect(run).toMatchObject({ trigger: "cron", status: "failed", pagesStored: 0, pagesSkipped: 1 });
      expect(run.reason).not.toMatch(/permission|bot protection/);
      const stored = await owner.as.query(api.pages.list, { innId });
      expect(stored).toHaveLength(1);
      expect(stored[0].lastVersion?._id).toBe(versionId);
      expect((await t.run((ctx) => ctx.db.get(pageId)))?.lastCheckedAt).toBe(0);
    }
    const reasons = (await owner.as.query(api.ingest.runs, { innId })).map((r) => r.reason ?? "");
    expect(reasons.some((r) => /HTTP 403/.test(r))).toBe(true);
    expect(reasons.some((r) => /empty markdown/.test(r))).toBe(true);
    expect(reasons.some((r) => /scrape error/.test(r))).toBe(true);
    const versions = await t.run((ctx) => ctx.db.query("pageVersions").collect());
    expect(versions).toHaveLength(1);
    expect(versions[0].markdown).not.toContain("Forbidden");
  });

  it("reports a component request failure by status only and gives up after the component's bounded retries", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-component-test" });
    RETRY.baseDelayMs = 0;
    RETRY.maxDelayMs = 0;
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    await t.run((ctx) => ctx.db.patch(innId, { siteUrl: SITE }));

    // A non-retryable provider error: one request, the body text never reaches the run.
    let { calls } = stubFetch([{ match: () => true, respond: () => json(402, { success: false, error: "PAYMENT_REQUIRED: top up at https://firecrawl.dev/billing?token=SECRET" }) }]);
    await expect(owner.as.action(api.ingest.crawlSite, { innId })).rejects.toThrow(/crawl_failed/);
    expect(calls).toHaveLength(1);
    let [run] = await owner.as.query(api.ingest.runs, { innId });
    expect(run).toMatchObject({ status: "failed", pagesStored: 0 });
    expect(run.reason).toBe("map failed: firecrawl: provider responded with HTTP 402");

    // A transient 503 is retried by the component (3 retries) and then reported by status.
    await t.run((ctx) => ctx.db.patch(innId, { lastCrawlStartedAt: undefined }));
    ({ calls } = stubFetch([{ match: () => true, respond: () => json(503, { error: "upstream unavailable" }) }]));
    await expect(owner.as.action(api.ingest.crawlSite, { innId })).rejects.toThrow(/crawl_failed/);
    expect(calls).toHaveLength(4);
    [run] = await owner.as.query(api.ingest.runs, { innId });
    expect(run.reason).toBe("map failed: firecrawl: provider responded with HTTP 503");

    // A network failure is retried the same bounded number of times, then reported without the error text.
    await t.run((ctx) => ctx.db.patch(innId, { lastCrawlStartedAt: undefined }));
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      throw new Error("ECONNRESET to 10.0.0.9 with Bearer leak");
    });
    await expect(owner.as.action(api.ingest.crawlSite, { innId })).rejects.toThrow(/crawl_failed/);
    expect(attempts).toBe(4);
    [run] = await owner.as.query(api.ingest.runs, { innId });
    expect(run.reason).toBe("map failed: firecrawl: network request failed");

    // A scrape failure is per page: the run records the page and status, and nothing is stored.
    await t.run((ctx) => ctx.db.patch(innId, { lastCrawlStartedAt: undefined }));
    ({ calls } = stubFetch([
      { match: (url) => url.endsWith("/v2/map"), respond: () => json(200, { success: true, links: [] }) },
      { match: (url) => url.endsWith("/v2/scrape"), respond: () => json(429, { error: "rate limited SECRET" }) },
    ]));
    const result = await owner.as.action(api.ingest.crawlSite, { innId });
    expect(result).toMatchObject({ pagesStored: 0, pagesSkipped: 1 });
    [run] = await owner.as.query(api.ingest.runs, { innId });
    expect(run.reason).toBe(`${SITE}/: firecrawl: provider responded with HTTP 429`);
    expect(await owner.as.query(api.pages.list, { innId })).toEqual([]);
  });

  it("never sends an unsafe or foreign url to the component", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-component-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, pageId } = await seedLiveInn(t, owner.userId);
    // A watched page row pointing at a private address never becomes a request.
    await t.run((ctx) => ctx.db.patch(pageId, { url: "https://10.0.0.1/policies", lastCheckedAt: 0 }));
    const { calls } = stubFetch([]);
    expect(await t.action(internal.ingest.rescrapeDue, {})).toMatchObject({ scraped: 0 });
    expect(calls).toEqual([]);
    expect(await owner.as.query(api.ingest.runs, { innId })).toEqual([]);
  });

  it("keeps root auth routing and the static catch-all unchanged: the component mounts no HTTP route", async () => {
    withEnv({ CONVEX_SITE_URL: HOST, JWKS: JSON.stringify({ keys: [{ kty: "RSA", n: "test", e: "AQAB" }] }) });
    const t = makeTest();
    const res = await t.fetch("/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { jwks_uri: string }).jwks_uri).toBe(`${HOST}/.well-known/jwks.json`);
    expect((await t.fetch("/.well-known/jwks.json")).status).toBe(200);
    const exact = (path: string, method: "GET" | "POST" = "GET") => http.lookup(path, method)?.[2];
    expect(exact("/.well-known/openid-configuration")).toBe("/.well-known/openid-configuration");
    expect(exact("/api/agentmail/webhook", "POST")).toBe("/api/agentmail/webhook");
    // No /firecrawl/webhook (or any other component prefix) is registered; GETs fall to the SPA.
    expect(exact("/firecrawl/webhook")).toBe("/*");
    expect(exact("/firecrawl/webhook", "POST")).toBeUndefined();
  });

  it("crawls two inns in isolation: each scrape carries its own tag and pages land only under their inn", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-component-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const a = await seedInn(t, owner.userId, "Seagull");
    const b = await seedInn(t, owner.userId, "Harbor");
    await t.run(async (ctx) => {
      await ctx.db.patch(a, { siteUrl: SITE });
      await ctx.db.patch(b, { siteUrl: OTHER_SITE });
    });
    const { calls } = stubFetch([
      { match: (url) => url.endsWith("/v2/map"), respond: (_u, init) => json(200, { success: true, links: [`${(JSON.parse(String(init.body)) as { url: string }).url}policies`, `${SITE}/rooms`, `${OTHER_SITE}/rooms`] }) },
      ...firecrawlRoutes(
        {
          [SITE + "/"]: "# Seagull\n\nWelcome.",
          [`${SITE}/policies`]: "# Seagull policies\n\nDogs $25.",
          [`${SITE}/rooms`]: "# Seagull rooms\n\nSea view.",
          [OTHER_SITE + "/"]: "# Harbor\n\nWelcome.",
          [`${OTHER_SITE}/policies`]: "# Harbor policies\n\nDogs $99.",
          [`${OTHER_SITE}/rooms`]: "# Harbor rooms\n\nDock view.",
        },
        [],
      ).slice(1),
    ]);
    expect(await owner.as.action(api.ingest.crawlSite, { innId: a })).toMatchObject({ pagesStored: 3, pagesSkipped: 0 });
    expect(await owner.as.action(api.ingest.crawlSite, { innId: b })).toMatchObject({ pagesStored: 3, pagesSkipped: 0 });

    const tagOf = (c: { body: unknown }) => (bodyOf(c).formats as Array<{ tag?: string }>).find((f) => typeof f === "object")!.tag;
    for (const c of scrapeCalls(calls)) {
      const url = String(bodyOf(c).url);
      expect(tagOf(c)).toBe(url.startsWith(SITE) ? `inn-${a}` : `inn-${b}`);
    }
    // Each inn's map lists the other's pages; the same-origin filter keeps them apart.
    const pagesA = await owner.as.query(api.pages.list, { innId: a });
    const pagesB = await owner.as.query(api.pages.list, { innId: b });
    expect(pagesA.map((p) => p.url).sort()).toEqual([SITE + "/", `${SITE}/policies`, `${SITE}/rooms`]);
    expect(pagesB.map((p) => p.url).sort()).toEqual([OTHER_SITE + "/", `${OTHER_SITE}/policies`, `${OTHER_SITE}/rooms`]);
    const version = await owner.as.query(api.pages.getVersion, { pageVersionId: pagesB.find((p) => p.url.endsWith("/policies"))!.lastVersion!._id });
    expect(version.markdown).toContain("$99");
    expect(version.markdown).not.toContain("$25");
  });

  it("runs the full pipeline through the component: a changed source page records a new version and opens the affected correction", async () => {
    withEnv({ FIRECRAWL_API_KEY: "fc-component-test", OPENAI_API_KEY: undefined });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, pageId, versionId } = await seedLiveInn(t, owner.userId);
    const { affectedThread, controlThread } = await t.run(async (ctx) => {
      const mk = async (quote: string, subject: string) => {
        const threadId = await ctx.db.insert("threads", { innId, guestEmail: "g@x.com", subject, snippet: subject, status: "waiting_guest", lastInboundAt: Date.now() });
        const draftId = await ctx.db.insert("drafts", { threadId, class: "answerable", answer: quote, abstain: false, status: "sent", model: "m" });
        await ctx.db.insert("claims", { draftId, threadId, innId, statement: quote, pageId, pageVersionId: versionId, url: `${SITE}/policies`, quote, verified: true, status: "ok" });
        await ctx.db.insert("sentReplies", { threadId, innId, draftId, sentBy: owner.userId, sentAt: Date.now(), kind: "reply", text: quote });
        return threadId;
      };
      return { affectedThread: await mk("$25 per night pet fee", "Dog"), controlThread: await mk("Check-in is from 3:00 PM.", "Arrival") };
    });
    stubFetch(
      firecrawlRoutes(
        {
          [SITE + "/"]: "# Seagull Inn\n\nWelcome.",
          [`${SITE}/policies`]: {
            markdown: "# Policies\n\nDogs are welcome for a $40 per night pet fee.\n\nCheck-in is from 3:00 PM.\n",
            statusCode: 200,
            changeStatus: "changed",
            diff: "-Dogs are welcome for a $25 per night pet fee.\n+Dogs are welcome for a $40 per night pet fee.",
          },
        },
        [`${SITE}/policies`],
      ),
    );
    const result = await owner.as.action(api.ingest.crawlSite, { innId });
    expect(result).toMatchObject({ pagesStored: 2, pagesSkipped: 0, affectedClaims: 1 });
    await settle(t);

    const policies = (await owner.as.query(api.pages.list, { innId })).find((p) => p.url.endsWith("/policies"))!;
    expect(policies.lastVersion!._id).not.toBe(versionId);
    expect(policies.lastVersion).toMatchObject({ changeStatus: "changed" });
    const version = await owner.as.query(api.pages.getVersion, { pageVersionId: policies.lastVersion!._id });
    expect(version.markdown).toContain("$40 per night pet fee");
    const versions = await t.run((ctx) => ctx.db.query("pageVersions").withIndex("by_page_scrapedAt", (q) => q.eq("pageId", pageId)).collect());
    expect(versions).toHaveLength(2);
    expect(versions.find((v) => v._id !== versionId)?.diffText).toContain("+Dogs are welcome for a $40");

    const corrections = await owner.as.query(api.corrections.list, { innId, status: "needs_review" });
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ threadId: affectedThread, oldQuote: "$25 per night pet fee", isCurrent: true });
    const claims = await t.run((ctx) => ctx.db.query("claims").collect());
    expect(claims.map((c) => [c.threadId, c.status]).sort()).toEqual([[affectedThread, "needs_review"], [controlThread, "ok"]].sort());
    expect((await owner.as.query(api.ingest.runs, { innId }))[0]).toMatchObject({ trigger: "staff", status: "done", pagesStored: 2 });
  });
});
