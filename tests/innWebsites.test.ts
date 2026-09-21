import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import http from "../convex/http";
import {
  defaultWebsiteContent,
  deploymentOriginOf,
  escapeHtml,
  hostedPageUrls,
  hostedSiteScope,
  isOnDeploymentOrigin,
  isOwnHostedSite,
  isWithinHostedSite,
  normalizeWebsiteContent,
  parseHostedPath,
  parseHostedSiteUrl,
  renderHostedPage,
} from "../convex/lib/innWebsiteHtml";
import { makeTest, seedInn, signedInUser } from "./setup";
import { settle, withEnv } from "./integrationSetup";

const SITE_URL = "https://some.convex.site";

beforeEach(() => {
  withEnv({ CONVEX_SITE_URL: SITE_URL });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Every table that the crawl pipeline owns; editing the website must leave them byte-identical. */
async function sourceSnapshot(t: ReturnType<typeof makeTest>) {
  return await t.run(async (ctx) => ({
    pages: await ctx.db.query("pages").collect(),
    versions: await ctx.db.query("pageVersions").collect(),
    claims: await ctx.db.query("claims").collect(),
    corrections: await ctx.db.query("corrections").collect(),
  }));
}

describe("innWebsiteHtml (pure)", () => {
  it("normalises and bounds content, rejecting bad types and out-of-range numbers", () => {
    const base = defaultWebsiteContent("Harbor Light Inn");
    const ok = normalizeWebsiteContent({ ...base, publicName: "  Harbor   Light\tInn ", intro: "a\r\n\r\n\r\nb  c\u0000", maxDogs: 3 });
    expect(ok.publicName).toBe("Harbor Light Inn");
    expect(ok.intro).toBe("a\n\nb c");
    expect(ok.maxDogs).toBe(3);
    expect(() => normalizeWebsiteContent({ ...base, publicName: "" })).toThrow(/publicName is required/);
    expect(() => normalizeWebsiteContent({ ...base, publicName: "x".repeat(81) })).toThrow(/at most 80/);
    expect(() => normalizeWebsiteContent({ ...base, petFeePerDogPerNight: 25.5 })).toThrow(/whole number/);
    expect(() => normalizeWebsiteContent({ ...base, petFeePerDogPerNight: 501 })).toThrow(/between 0 and 500/);
    expect(() => normalizeWebsiteContent({ ...base, maxDogs: -1 })).toThrow(/between 0 and 6/);
    expect(() => normalizeWebsiteContent({ ...base, checkIn: 3 })).toThrow(/must be text/);
    // Unknown keys are dropped, not stored.
    expect(Object.keys(normalizeWebsiteContent({ ...base, html: "<b>x</b>" }))).not.toContain("html");
  });

  it("parses hosted paths with an optional trailing slash and rejects everything else", () => {
    const id = "jd7abc123def456";
    expect(parseHostedPath(`/inn/${id}`)).toEqual({ innId: id, page: "home" });
    expect(parseHostedPath(`/inn/${id}/`)).toEqual({ innId: id, page: "home" });
    expect(parseHostedPath(`/inn/${id}/policies`)).toEqual({ innId: id, page: "policies" });
    expect(parseHostedPath(`/inn/${id}/rooms/`)).toEqual({ innId: id, page: "rooms" });
    expect(parseHostedPath(`/inn/${id}/notices`)).toEqual({ innId: id, page: "notices" });
    for (const bad of ["/inn/", "/inn", `/inn/${id}/x`, `/inn/${id}/policies/extra`, `/inn/${id}//`, "/inn/<script>/", `/inn/${id}%2Fpolicies`, "/inns/x"]) {
      expect(parseHostedPath(bad), bad).toBeNull();
    }
  });

  it("recognises only its own hosted subtree, by path segments not string prefix", () => {
    const id = "jd7abc123def456";
    const site = `${SITE_URL}/inn/${id}/`;
    expect(parseHostedSiteUrl(site)).toEqual({ origin: SITE_URL, innId: id });
    expect(parseHostedSiteUrl(`${SITE_URL}/inn/${id}`)).toEqual({ origin: SITE_URL, innId: id });
    expect(parseHostedSiteUrl("https://seagull.example/")).toBeNull();
    expect(parseHostedSiteUrl(`${SITE_URL}/inn/${id}/policies`)).toBeNull();
    expect(isOwnHostedSite(site, id)).toBe(true);
    expect(isOwnHostedSite(site, "jd7other")).toBe(false);
    expect(isOwnHostedSite("https://seagull.example/", id)).toBe(false);
    expect(hostedPageUrls(site)).toEqual([`${SITE_URL}/inn/${id}/`, `${SITE_URL}/inn/${id}/policies`, `${SITE_URL}/inn/${id}/rooms`, `${SITE_URL}/inn/${id}/notices`]);

    expect(isWithinHostedSite(`${SITE_URL}/inn/${id}`, site)).toBe(true);
    expect(isWithinHostedSite(`${SITE_URL}/inn/${id}/policies?x=1#top`, site)).toBe(true);
    expect(isWithinHostedSite(`${SITE_URL}/inn/${id}/deep/er`, site)).toBe(true);
    expect(isWithinHostedSite(`${SITE_URL}/inn/${id}x/policies`, site)).toBe(false);
    expect(isWithinHostedSite(`${SITE_URL}/inn/${id}%2Fpolicies`, site)).toBe(false);
    expect(isWithinHostedSite(`${SITE_URL}/inn/${id}/%2e%2e/other`, site)).toBe(false);
    expect(isWithinHostedSite(`${SITE_URL}/inn/${id}/../other/policies`, site)).toBe(false);
    expect(isWithinHostedSite(`${SITE_URL}/inn/other/policies`, site)).toBe(false);
    expect(isWithinHostedSite(`${SITE_URL}/`, site)).toBe(false);
    expect(isWithinHostedSite(`${SITE_URL}/inns/${id}/threads`, site)).toBe(false);
    expect(isWithinHostedSite(`https://evil.example/inn/${id}/`, site)).toBe(false);
    expect(isWithinHostedSite(`${SITE_URL}/inn/${id}/`, "https://seagull.example/")).toBe(false);
  });

  it("classifies a site url against the deployment origin by parsed origin, never by string prefix", () => {
    const id = "jd7abc123def456";
    const origin = deploymentOriginOf(SITE_URL);
    expect(origin).toBe(SITE_URL);
    expect(deploymentOriginOf(`${SITE_URL}/some/path?x=1#y`)).toBe(SITE_URL);
    expect(deploymentOriginOf(undefined)).toBeNull();
    expect(deploymentOriginOf("")).toBeNull();
    expect(deploymentOriginOf("not a url")).toBeNull();
    // Scheme and host case, default port, query, hash and encoded paths all resolve to the same origin.
    for (const url of [`${SITE_URL}/`, "HTTPS://SOME.CONVEX.SITE:443/inn/x", `${SITE_URL}/inn/${id}/?q=1#f`, `${SITE_URL}/inn%2F${id}/`]) {
      expect(isOnDeploymentOrigin(url, origin), url).toBe(true);
    }
    for (const url of ["https://some.convex.site.example/", "https://evil.example/some.convex.site/", "http://some.convex.site/", "nope"]) {
      expect(isOnDeploymentOrigin(url, origin), url).toBe(false);
    }
    expect(isOnDeploymentOrigin(`${SITE_URL}/`, null)).toBe(false);

    expect(hostedSiteScope(`${SITE_URL}/inn/${id}/`, id, origin)).toBe("own");
    expect(hostedSiteScope(`${SITE_URL}/inn/${id}`, id, origin)).toBe("own");
    for (const bad of [`${SITE_URL}/`, `${SITE_URL}/inn/other123/`, `${SITE_URL}/inn/${id}/policies`, `${SITE_URL}/inn/${id}/?q=1`, `${SITE_URL}/inn/${id}/#top`, `${SITE_URL}/inn/${id}x/`, `${SITE_URL}/inns/${id}/threads`]) {
      expect(hostedSiteScope(bad, id, origin), bad).toBe("invalid");
    }
    expect(hostedSiteScope("https://seagull.example/", id, origin)).toBe("external");
    expect(hostedSiteScope(`https://some.convex.site.example/inn/${id}/`, "other", origin)).toBe("external");
    // Without a configured origin nothing is recognised as hosted, except this inn's own id-matching site.
    expect(hostedSiteScope(`${SITE_URL}/inn/other123/`, id, null)).toBe("external");
    expect(hostedSiteScope(`${SITE_URL}/inn/${id}/`, id, null)).toBe("own");
  });

  it("escapes every dynamic value and links only inside the inn prefix", () => {
    const id = "jd7abc123def456";
    const content = {
      ...defaultWebsiteContent(`Sea & "Sky" <script>alert(1)</script>`),
      intro: `<img src=x onerror=alert('x')> it's`,
      notice: "javascript:alert(1)\" onclick=\"x",
      checkIn: "3 PM <b>bold</b>",
    };
    for (const page of ["home", "policies", "rooms", "notices"] as const) {
      const html = renderHostedPage({ innId: id, page, content });
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<b>bold");
      expect(html).not.toContain('onclick="x');
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("Sea &amp; &quot;Sky&quot;");
      expect(html).toMatch(/<title>[^<]*Sea &amp; &quot;Sky&quot;[^<]*\(fictional inn\)<\/title>/);
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs.length).toBeGreaterThan(0);
      expect(hrefs).toEqual([`/inn/${id}/`, `/inn/${id}/policies`, `/inn/${id}/rooms`, `/inn/${id}/notices`]);
      expect(html).toContain('aria-current="page"');
      expect(html).toContain("Fictional inn");
      expect(html).toContain("does not describe a real business");
    }
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("innWebsites.createFictional", () => {
  it("creates an inn owned by the caller with a server-derived site url and default illustrative policies", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner", email: "o@x.com" });
    const { innId, siteUrl } = await owner.as.mutation(api.innWebsites.createFictional, { name: "  Harbor Light Inn ", timezone: "America/New_York" });
    expect(siteUrl).toBe(`${SITE_URL}/inn/${innId}/`);
    const inn = await t.run((ctx) => ctx.db.get(innId));
    expect(inn).toMatchObject({ name: "Harbor Light Inn", siteUrl, timezone: "America/New_York", isDemo: false, createdBy: owner.userId });
    const mine = await owner.as.query(api.inns.mine, {});
    expect(mine).toEqual([{ innId, name: "Harbor Light Inn", siteUrl, isDemo: false, role: "owner" }]);
    const editor = await owner.as.query(api.innWebsites.editor, { innId });
    expect(editor?.content).toMatchObject({ publicName: "Harbor Light Inn", checkIn: "3:00 PM", checkOut: "11:00 AM", petFeePerDogPerNight: 25, maxDogs: 2, breakfastHours: "7:00 AM to 9:00 AM" });
    expect(editor?.content.wifi).toMatch(/Free Wi-Fi/);
    expect(editor?.content.petPolicy).toMatch(/designated pet-friendly rooms/);
    expect(editor?.pages).toEqual(hostedPageUrls(siteUrl));
    // Website creation stores no source pages: those come only from a crawl.
    expect(await sourceSnapshot(t)).toEqual({ pages: [], versions: [], claims: [], corrections: [] });
  });

  it("validates name and timezone like inns.create and never accepts a caller-supplied url", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    await expect(owner.as.mutation(api.innWebsites.createFictional, { name: "   " })).rejects.toThrow(/Inn name is required/);
    await expect(owner.as.mutation(api.innWebsites.createFictional, { name: "x".repeat(121) })).rejects.toThrow(/Inn name is required/);
    await expect(owner.as.mutation(api.innWebsites.createFictional, { name: "Inn", timezone: "Mars/Olympus" })).rejects.toThrow(/not recognized/);
    const { siteUrl } = await owner.as.mutation(api.innWebsites.createFictional, { name: "Inn", timezone: "" });
    expect(siteUrl.startsWith(`${SITE_URL}/inn/`)).toBe(true);
    expect((await t.run((ctx) => ctx.db.query("inns").collect()))[0].timezone).toBe("America/Los_Angeles");
  });

  it("refuses anonymous, unauthenticated, and deployments without a public https site url", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    await expect(visitor.as.mutation(api.innWebsites.createFictional, { name: "Inn" })).rejects.toThrow(/forbidden/);
    await expect(t.mutation(api.innWebsites.createFictional, { name: "Inn" })).rejects.toThrow(/unauthenticated/);
    const owner = await signedInUser(t, { name: "Owner" });
    withEnv({ CONVEX_SITE_URL: undefined });
    await expect(owner.as.mutation(api.innWebsites.createFictional, { name: "Inn" })).rejects.toThrow(/site_url_unavailable/);
    withEnv({ CONVEX_SITE_URL: "http://127.0.0.1:3210" });
    await expect(owner.as.mutation(api.innWebsites.createFictional, { name: "Inn" })).rejects.toThrow(/site_url_unavailable/);
    expect(await t.run((ctx) => ctx.db.query("inns").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("innWebsites").collect())).toEqual([]);
  });
});

describe("innWebsites editing authority", () => {
  it("only the owner reads the editor and saves; staff read the public view; strangers, demo and anonymous are refused", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await owner.as.mutation(api.innWebsites.createFictional, { name: "Harbor Light Inn" });
    const staff = await signedInUser(t, { name: "Staff" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId, userId: staff.userId, role: "staff", name: "Staff" }));
    const stranger = await signedInUser(t, { name: "Stranger" });
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    const demoInn = await visitor.as.mutation(api.demo.enter, {});
    const base = (await owner.as.query(api.innWebsites.editor, { innId }))!.content;
    const edited = { ...base, petFeePerDogPerNight: 40 };

    await expect(staff.as.query(api.innWebsites.editor, { innId })).rejects.toThrow(/owner_only/);
    await expect(staff.as.mutation(api.innWebsites.update, { innId, content: edited })).rejects.toThrow(/owner_only/);
    expect((await staff.as.query(api.innWebsites.publicView, { innId }))?.content).toEqual(base);
    await expect(stranger.as.query(api.innWebsites.editor, { innId })).rejects.toThrow(/forbidden/);
    await expect(stranger.as.query(api.innWebsites.publicView, { innId })).rejects.toThrow(/forbidden/);
    await expect(stranger.as.mutation(api.innWebsites.update, { innId, content: edited })).rejects.toThrow(/forbidden/);
    await expect(visitor.as.mutation(api.innWebsites.update, { innId, content: edited })).rejects.toThrow(/forbidden/);
    await expect(t.mutation(api.innWebsites.update, { innId, content: edited })).rejects.toThrow(/unauthenticated/);
    // The anonymous demo inn has no website document and cannot get one through the editor.
    expect(await visitor.as.query(api.innWebsites.publicView, { innId: demoInn })).toBeNull();
    await expect(visitor.as.query(api.innWebsites.editor, { innId: demoInn })).rejects.toThrow(/owner_only/);
    await expect(visitor.as.mutation(api.innWebsites.update, { innId: demoInn, content: edited })).rejects.toThrow(/owner_only/);
    // A regular inn without a site document is not editable either.
    const plain = await seedInn(t, owner.userId);
    expect(await owner.as.query(api.innWebsites.editor, { innId: plain })).toBeNull();
    await expect(owner.as.mutation(api.innWebsites.update, { innId: plain, content: edited })).rejects.toThrow(/no_website/);
    // Nothing above changed the document.
    expect((await owner.as.query(api.innWebsites.editor, { innId }))!.content).toEqual(base);

    const saved = await owner.as.mutation(api.innWebsites.update, { innId, content: edited });
    const afterSave = (await owner.as.query(api.innWebsites.editor, { innId }))!;
    expect(afterSave.content.petFeePerDogPerNight).toBe(40);
    // The returned timestamp is the one stored, not a second clock read.
    expect(saved.updatedAt).toBe(afterSave.updatedAt);
    const rows = await t.run((ctx) => ctx.db.query("innWebsites").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].updatedAt).toBe(saved.updatedAt);
  });

  it("rejects invalid content and never writes a partial save", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await owner.as.mutation(api.innWebsites.createFictional, { name: "Harbor Light Inn" });
    const base = (await owner.as.query(api.innWebsites.editor, { innId }))!.content;
    await expect(owner.as.mutation(api.innWebsites.update, { innId, content: { ...base, publicName: "" } })).rejects.toThrow(/publicName is required/);
    await expect(owner.as.mutation(api.innWebsites.update, { innId, content: { ...base, maxDogs: 7 } })).rejects.toThrow(/between 0 and 6/);
    await expect(owner.as.mutation(api.innWebsites.update, { innId, content: { ...base, notice: "n".repeat(601) } })).rejects.toThrow(/at most 600/);
    expect((await owner.as.query(api.innWebsites.editor, { innId }))!.content).toEqual(base);
  });

  it("editing the website leaves pages, versions, claims and corrections untouched", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, siteUrl } = await owner.as.mutation(api.innWebsites.createFictional, { name: "Harbor Light Inn" });
    // A previously crawled policies page with a sent claim resting on it.
    await t.run(async (ctx) => {
      const pageId = await ctx.db.insert("pages", { innId, url: `${siteUrl}policies`, title: "Policies", kind: "policies", watched: true });
      const versionId = await ctx.db.insert("pageVersions", { pageId, markdown: "Dogs are welcome for a fee of $25 per dog per night", hash: "h", scrapedAt: 1, changeStatus: "new" });
      await ctx.db.patch(pageId, { lastVersionId: versionId });
      const threadId = await ctx.db.insert("threads", { innId, guestEmail: "g@x.com", subject: "Dog", snippet: "Dog", status: "waiting_guest", lastInboundAt: 1 });
      const draftId = await ctx.db.insert("drafts", { threadId, class: "answerable", answer: "$25", abstain: false, status: "sent", model: "m" });
      await ctx.db.insert("claims", { draftId, threadId, innId, statement: "s", pageId, pageVersionId: versionId, url: `${siteUrl}policies`, quote: "$25 per dog per night", verified: true, status: "ok" });
    });
    const before = await sourceSnapshot(t);
    const base = (await owner.as.query(api.innWebsites.editor, { innId }))!.content;
    await owner.as.mutation(api.innWebsites.update, { innId, content: { ...base, petFeePerDogPerNight: 40, notice: "Pet fee changes next month." } });
    await settle(t);
    expect(await sourceSnapshot(t)).toEqual(before);
    expect(await owner.as.query(api.corrections.list, { innId, status: "needs_review" })).toEqual([]);
  });
});

describe("hosted inn HTTP routes", () => {
  it("registers /inn/ as a prefix route without disturbing the root auth, api and catch-all routes", () => {
    expect(http.lookup("/inn/abc12345/policies", "GET")?.[2]).toBe("/inn/*");
    expect(http.lookup("/.well-known/openid-configuration", "GET")?.[2]).toBe("/.well-known/openid-configuration");
    expect(http.lookup("/.well-known/jwks.json", "GET")?.[2]).toBe("/.well-known/jwks.json");
    expect(http.lookup("/api/health", "GET")?.[2]).toBe("/api/health");
    expect(http.lookup("/api/agentmail/webhook", "POST")?.[2]).toBe("/api/agentmail/webhook");
    expect(http.lookup("/inns/abc/threads", "GET")?.[2]).toBe("/*");
    expect(http.lookup("/inn", "GET")?.[2]).toBe("/*");
    // Only GET is served under the prefix; other methods never reach the inn handler.
    expect(http.lookup("/inn/abc12345/policies", "POST")?.[2]).not.toBe("/inn/*");
  });

  it("renders the four public pages with escaping, no-store and utf-8 html, before and after an edit", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner", email: "owner@x.com" });
    const { innId } = await owner.as.mutation(api.innWebsites.createFictional, { name: `Harbor & "Light" <Inn>` });
    const staff = await signedInUser(t, { name: "Staffer Secret", email: "staff@x.com" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId, userId: staff.userId, role: "staff", name: "Staffer Secret" }));

    for (const path of [`/inn/${innId}`, `/inn/${innId}/`, `/inn/${innId}/policies`, `/inn/${innId}/policies/`, `/inn/${innId}/rooms`, `/inn/${innId}/notices/`]) {
      const res = await t.fetch(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("Harbor &amp; &quot;Light&quot; &lt;Inn&gt;");
      expect(html).not.toContain("<Inn>");
      expect(html).toContain("Fictional inn");
      expect(html).toContain(`href="/inn/${innId}/policies"`);
      // No private data leaks: no ids other than the inn's in links, no staff or user details.
      expect(html).not.toContain("owner@x.com");
      expect(html).not.toContain("Staffer");
      expect(html).not.toContain(String(owner.userId));
      expect(html).not.toContain(String(staff.userId));
    }
    const policiesBefore = await (await t.fetch(`/inn/${innId}/policies`)).text();
    expect(policiesBefore).toContain("Dogs are welcome for a fee of $25 per dog per night, with up to 2 dogs per room");
    expect(policiesBefore).toContain("Check-in begins at 3:00 PM.");
    expect(policiesBefore).toContain("Breakfast is served from 7:00 AM to 9:00 AM.");
    expect(await (await t.fetch(`/inn/${innId}/notices`)).text()).toContain("There are no current notices.");

    const base = (await owner.as.query(api.innWebsites.editor, { innId }))!.content;
    await owner.as.mutation(api.innWebsites.update, {
      innId,
      content: { ...base, petFeePerDogPerNight: 40, maxDogs: 1, checkIn: "4:00 PM", notice: "The <garden> closes early.\n\nSecond paragraph." },
    });
    const policiesAfter = await (await t.fetch(`/inn/${innId}/policies`)).text();
    expect(policiesAfter).toContain("Dogs are welcome for a fee of $40 per dog per night, with one dog per room");
    expect(policiesAfter).toContain("Check-in begins at 4:00 PM.");
    expect(policiesAfter).not.toContain("$25 per dog");
    const notices = await (await t.fetch(`/inn/${innId}/notices`)).text();
    expect(notices).toContain("<p>The &lt;garden&gt; closes early.</p>");
    expect(notices).toContain("<p>Second paragraph.</p>");
    expect(notices).not.toContain("<garden>");
  });

  it("returns 404 with no-store for unknown inns, inns without a site document, demo inns, and unknown pages", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const plain = await seedInn(t, owner.userId, "Real Inn Without Site");
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    const demoInn = await visitor.as.mutation(api.demo.enter, {});
    const { innId } = await owner.as.mutation(api.innWebsites.createFictional, { name: "Hosted" });
    const paths = [
      `/inn/${plain}/`,
      `/inn/${plain}/policies`,
      `/inn/${demoInn}/`,
      `/inn/${innId}/nope`,
      `/inn/${innId}/policies/extra`,
      `/inn/${innId}/policies%2F`,
      "/inn/",
      "/inn/not-an-id/",
      `/inn/${innId}<script>/`,
    ];
    for (const path of paths) {
      const res = await t.fetch(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      const body = await res.text();
      expect(body).toBe("Not found\n");
      expect(body).not.toContain("Real Inn Without Site");
    }
    // The internal query is the only data source and returns content only, never inn metadata.
    const content = await t.query(internal.innWebsites.publicContent, { innId: String(innId) });
    expect(Object.keys(content!).sort()).toEqual(
      ["breakfastHours", "checkIn", "checkOut", "intro", "maxDogs", "notice", "petFeePerDogPerNight", "petPolicy", "publicName", "roomsDescription", "wifi"],
    );
    expect(await t.query(internal.innWebsites.publicContent, { innId: String(plain) })).toBeNull();
    expect(await t.query(internal.innWebsites.publicContent, { innId: "garbage" })).toBeNull();
  });

  it("keeps the root auth discovery and health routes unchanged", async () => {
    vi.stubEnv("JWKS", JSON.stringify({ keys: [{ kty: "RSA", n: "test", e: "AQAB" }] }));
    const t = makeTest();
    const res = await t.fetch("/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { jwks_uri: string }).jwks_uri).toBe(`${SITE_URL}/.well-known/jwks.json`);
    const health = await t.fetch("/api/health");
    expect(await health.json()).toMatchObject({ ok: true, service: "front-desk" });
  });
});
