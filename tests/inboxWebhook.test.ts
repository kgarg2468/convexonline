import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import {
  checkProductWebhook,
  MAX_INBOXES_PER_WEBHOOK,
  planSubscription,
  requestJson,
  WEBHOOK_PATH,
  webhookTargetFor,
} from "../convex/lib/inboxWebhook";
import { makeTest, seedInn, signedInUser } from "./setup";
import { json, stubFetch, withEnv, type Route } from "./integrationSetup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SITE_URL = "https://happy-otter-123.convex.site";
const HOOK_ID = "wh_product";
const HOOK_SECRET = "whsec_" + btoa("never-leaves-the-server");
const TESTER = "convex-allgas-tester@agentmail.to";

function hookRecord(overrides: Record<string, unknown> = {}) {
  return {
    webhook_id: HOOK_ID,
    url: `${SITE_URL}${WEBHOOK_PATH}`,
    secret: HOOK_SECRET,
    enabled: true,
    event_types: ["message.received"],
    inbox_ids: [TESTER],
    client_id: "frontdesk-happy-otter-123",
    ...overrides,
  };
}

/**
 * In-memory provider: one webhook whose inbox list is appended atomically by
 * PATCH { add_inbox_ids }, plus inbox creation keyed by client_id (idempotent).
 */
function fakeProvider(opts: { hook?: Record<string, unknown> | null; hookStatus?: number; patchStatus?: number; inboxStatus?: number } = {}) {
  const state = {
    hook: opts.hook === undefined ? hookRecord() : opts.hook,
    inboxesByClientId: new Map<string, string>(),
    created: 0,
    patches: 0,
  };
  const routes: Route[] = [
    {
      match: (url, init) => url.endsWith(`/v0/webhooks/${HOOK_ID}`) && init.method === "GET",
      respond: () => (opts.hookStatus ? json(opts.hookStatus, {}) : state.hook ? json(200, state.hook) : json(404, {})),
    },
    {
      match: (url, init) => url.endsWith(`/v0/webhooks/${HOOK_ID}`) && init.method === "PATCH",
      respond: (_url, init) => {
        state.patches += 1;
        if (opts.patchStatus) return json(opts.patchStatus, {});
        const body = JSON.parse(String(init.body)) as { add_inbox_ids?: string[]; inbox_ids?: string[] };
        if (!Array.isArray(body.add_inbox_ids) || body.inbox_ids) return json(400, {});
        const current = state.hook!.inbox_ids as string[];
        if (current.length + body.add_inbox_ids.length > MAX_INBOXES_PER_WEBHOOK) return json(400, {});
        state.hook = { ...state.hook!, inbox_ids: [...current, ...body.add_inbox_ids.filter((x) => !current.includes(x))] };
        return json(200, state.hook);
      },
    },
    {
      match: (url, init) => url.endsWith("/v0/inboxes") && init.method === "POST",
      respond: (_url, init) => {
        if (opts.inboxStatus) return json(opts.inboxStatus, {});
        const body = JSON.parse(String(init.body)) as { username: string; client_id: string };
        let inbox = state.inboxesByClientId.get(body.client_id);
        if (!inbox) {
          state.created += 1;
          // convex-test ids share a long prefix, so usernames derived from them can collide here; keep addresses unique.
          const taken = [...state.inboxesByClientId.values()].includes(`${body.username}@agentmail.to`);
          inbox = `${body.username}${taken ? `-${state.created}` : ""}@agentmail.to`;
          state.inboxesByClientId.set(body.client_id, inbox);
        }
        return json(200, { inbox_id: inbox });
      },
    },
  ];
  return { state, routes };
}

function liveEnv(extra: Record<string, string | undefined> = {}) {
  withEnv({ AGENTMAIL_API_KEY: "am-test", AGENTMAIL_WEBHOOK_ID: HOOK_ID, AGENTMAIL_WEBHOOK_SECRET: HOOK_SECRET, CONVEX_SITE_URL: SITE_URL, ...extra });
}

describe("product webhook checks (pure)", () => {
  it("derives the target url and client_id the register script uses", () => {
    expect(webhookTargetFor(SITE_URL)).toEqual({ url: `${SITE_URL}/api/agentmail/webhook`, clientId: "frontdesk-happy-otter-123" });
    expect(webhookTargetFor("https://Happy-Otter-123.convex.site/")).toEqual({ url: `${SITE_URL}/api/agentmail/webhook`, clientId: "frontdesk-happy-otter-123" });
    expect(webhookTargetFor("http://happy-otter-123.convex.site")).toBeUndefined();
    expect(webhookTargetFor("not a url")).toBeUndefined();
  });

  it("accepts only an enabled, scoped, message.received hook for this deployment", () => {
    const expected = { webhookId: HOOK_ID, ...webhookTargetFor(SITE_URL)! };
    const ok = checkProductWebhook(hookRecord(), expected);
    expect(ok).toEqual({ ok: true, webhookId: HOOK_ID, inboxIds: [TESTER] });
    expect(JSON.stringify(ok)).not.toContain(HOOK_SECRET);
    const reason = (r: Record<string, unknown>) => {
      const c = checkProductWebhook(hookRecord(r), expected);
      return c.ok ? "ok" : c.reason;
    };
    expect(reason({ url: "https://old-poc.convex.site/agentmail/webhook" })).toMatch(/does not target/);
    expect(reason({ client_id: "poc-webhook" })).toMatch(/client_id/);
    expect(reason({ enabled: false })).toMatch(/disabled/);
    expect(reason({ event_types: ["message.sent"] })).toMatch(/message\.received/);
    expect(reason({ inbox_ids: [] })).toMatch(/organization-wide/);
    expect(reason({ inbox_ids: undefined })).toMatch(/organization-wide/);
    expect(reason({ webhook_id: "wh_other" })).toMatch(/id does not match/);
    expect(checkProductWebhook(null, expected)).toMatchObject({ ok: false });
  });

  it("plans append-only subscription with the provider's per-hook limit", () => {
    expect(planSubscription([TESTER], TESTER)).toBe("subscribed");
    expect(planSubscription([TESTER], "new@agentmail.to")).toBe("add");
    const full = Array.from({ length: MAX_INBOXES_PER_WEBHOOK }, (_, i) => `i${i}@agentmail.to`);
    expect(planSubscription(full, "new@agentmail.to")).toBe("full");
    expect(planSubscription(full, full[3])).toBe("subscribed");
  });

  it("requestJson bounds the exchange and never surfaces error bodies", async () => {
    const { calls } = stubFetch([
      { match: (url) => url.endsWith("/ok"), respond: () => json(200, { webhook_id: "x", secret: "s" }) },
      { match: (url) => url.endsWith("/bad"), respond: () => json(500, { message: "leak" }) },
      {
        match: (url) => url.endsWith("/slow"),
        respond: (_url, init) =>
          new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
      },
    ]);
    const f = globalThis.fetch as Parameters<typeof requestJson>[0];
    expect(await requestJson(f, "GET", "https://p/ok", "k", undefined, 1000)).toEqual({ ok: true, status: 200, json: { webhook_id: "x", secret: "s" } });
    expect(calls[0].headers).toMatchObject({ Authorization: "Bearer k" });
    expect(calls[0].body).toBeUndefined();
    expect(await requestJson(f, "PATCH", "https://p/bad", "k", { add_inbox_ids: ["a"] }, 1000)).toEqual({ ok: false, status: 500, json: undefined });
    expect(calls[1].body).toEqual({ add_inbox_ids: ["a"] });
    await expect(requestJson(f, "GET", "https://p/slow", "k", undefined, 20)).rejects.toMatchObject({ name: "ProviderError", kind: "timeout" });
  });
});

describe("inbox.provision subscribes the new address to the product webhook", () => {
  it("verifies the hook, creates the inbox, appends it, and records the confirmed hook", async () => {
    liveEnv();
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId, "Seagull Inn");
    const { state, routes } = fakeProvider();
    const { calls } = stubFetch(routes);

    expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ webhookId: true, webhookSecret: true, inboxConfigured: false, inboxWebhookReady: false });
    const result = await owner.as.action(api.inbox.provision, { innId });
    const expectedAddress = `frontdesk-${String(innId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}@agentmail.to`;
    expect(result).toEqual({ inboxAddress: expectedAddress });
    // Exact provider conversation: GET hook → POST inbox → PATCH append.
    expect(calls.map((c) => c.url.replace("https://api.agentmail.to", ""))).toEqual([`/v0/webhooks/${HOOK_ID}`, "/v0/inboxes", `/v0/webhooks/${HOOK_ID}`]);
    expect(calls[2].body).toEqual({ add_inbox_ids: [expectedAddress] });
    expect(state.hook!.inbox_ids).toEqual([TESTER, expectedAddress]);

    const inn = await t.run((ctx) => ctx.db.get(innId));
    expect(inn).toMatchObject({ inboxId: expectedAddress, inboxAddress: expectedAddress, inboxClientId: `frontdesk-inn-${innId}`, inboxWebhookId: HOOK_ID });
    expect(inn?.inboxWebhookConfirmedAt).toBeGreaterThan(Date.now() - 5000);
    // The signing secret from the GET/PATCH bodies never lands anywhere.
    expect(JSON.stringify(inn)).not.toContain(HOOK_SECRET);
    expect(JSON.stringify(result)).not.toContain(HOOK_SECRET);
    expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ inboxConfigured: true, inboxWebhookReady: true });
    await expect(owner.as.action(api.inbox.provision, { innId })).rejects.toThrow(/already_configured/);
    expect(state.created).toBe(1);
  });

  it("fails with an onboarding error before any provider call when the deployment has no hook", async () => {
    liveEnv({ AGENTMAIL_WEBHOOK_ID: undefined });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    const { calls } = stubFetch(fakeProvider().routes);
    await expect(owner.as.action(api.inbox.provision, { innId })).rejects.toThrow(/webhook_not_configured/);
    expect(calls).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(innId)))?.inboxId).toBeUndefined();
    expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ webhookId: false, inboxWebhookReady: false });
  });

  it("refuses when the hook is gone, the account has no credits, or the hook is not ours", async () => {
    liveEnv();
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    const cases: Array<[Parameters<typeof fakeProvider>[0], RegExp]> = [
      [{ hookStatus: 404 }, /webhook_not_found/],
      [{ hookStatus: 402 }, /no credits/],
      [{ hook: hookRecord({ url: "https://old-poc.convex.site/agentmail/webhook" }) }, /webhook_mismatch.*does not target/],
      [{ hook: hookRecord({ client_id: "poc-hook" }) }, /webhook_mismatch.*client_id/],
      [{ hook: hookRecord({ inbox_ids: [] }) }, /webhook_mismatch.*organization-wide/],
      [{ hook: hookRecord({ enabled: false }) }, /webhook_mismatch.*disabled/],
    ];
    for (const [providerOpts, pattern] of cases) {
      const { state, routes } = fakeProvider(providerOpts);
      const { calls } = stubFetch(routes);
      await expect(owner.as.action(api.inbox.provision, { innId })).rejects.toThrow(pattern);
      // Only the GET happened: no inbox minted, no hook touched.
      expect(calls.map((c) => c.url)).toEqual([`https://api.agentmail.to/v0/webhooks/${HOOK_ID}`]);
      expect(state.created).toBe(0);
      expect(state.patches).toBe(0);
      vi.unstubAllGlobals();
    }
    expect((await t.run((ctx) => ctx.db.get(innId)))?.inboxId).toBeUndefined();
    // Error messages never carry the provider secret.
    const { routes } = fakeProvider({ hook: hookRecord({ enabled: false }) });
    stubFetch(routes);
    const err = await owner.as.action(api.inbox.provision, { innId }).catch((e: unknown) => e);
    expect(String(err) + JSON.stringify(err)).not.toContain(HOOK_SECRET);
  });

  it("reports a full hook clearly and mints no inbox", async () => {
    liveEnv();
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    const full = Array.from({ length: MAX_INBOXES_PER_WEBHOOK }, (_, i) => `inn-${i}@agentmail.to`);
    const { state, routes } = fakeProvider({ hook: hookRecord({ inbox_ids: full }) });
    const { calls } = stubFetch(routes);
    await expect(owner.as.action(api.inbox.provision, { innId })).rejects.toThrow(/webhook_full/);
    expect(calls).toHaveLength(1);
    expect(state.created).toBe(0);
    expect(state.hook!.inbox_ids).toEqual(full);
    expect((await t.run((ctx) => ctx.db.get(innId)))?.inboxId).toBeUndefined();
  });

  it("a failed append leaves the inbox bound but not ready; the retry only completes the subscription", async () => {
    liveEnv();
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    const broken = fakeProvider({ patchStatus: 503 });
    stubFetch(broken.routes);
    await expect(owner.as.action(api.inbox.provision, { innId })).rejects.toThrow(/webhook_subscribe_failed/);
    const partial = await t.run((ctx) => ctx.db.get(innId));
    expect(partial?.inboxId).toMatch(/@agentmail\.to$/);
    expect(partial?.inboxWebhookId).toBeUndefined();
    expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ inboxConfigured: true, inboxWebhookReady: false });
    vi.unstubAllGlobals();

    // Retry: same server-derived client_id, no second inbox, append only.
    const healthy = fakeProvider();
    const { calls } = stubFetch(healthy.routes);
    const result = await owner.as.action(api.inbox.provision, { innId });
    expect(result).toEqual({ inboxAddress: partial!.inboxId });
    expect(calls.map((c) => c.url.replace("https://api.agentmail.to", ""))).toEqual([`/v0/webhooks/${HOOK_ID}`, `/v0/webhooks/${HOOK_ID}`]);
    expect(calls[1].body).toEqual({ add_inbox_ids: [partial!.inboxId] });
    expect(healthy.state.created).toBe(0);
    expect(healthy.state.hook!.inbox_ids).toEqual([TESTER, partial!.inboxId]);
    expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ inboxConfigured: true, inboxWebhookReady: true });
  });

  it("an inbox already on the hook is recorded without a PATCH; a re-registered hook re-subscribes", async () => {
    liveEnv();
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    // Bound out of band (manager CLI) and already in the hook's list.
    await t.run((ctx) => ctx.db.patch(innId, { inboxId: TESTER, inboxAddress: TESTER }));
    const p = fakeProvider();
    const { calls } = stubFetch(p.routes);
    await owner.as.action(api.inbox.provision, { innId });
    expect(calls).toHaveLength(1);
    expect(p.state.patches).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(innId)))?.inboxWebhookId).toBe(HOOK_ID);
    vi.unstubAllGlobals();

    // Deployment now points at a new hook: readiness drops, provisioning re-appends.
    withEnv({ AGENTMAIL_WEBHOOK_ID: "wh_product" }); // same id, different provider state below
    const fresh = fakeProvider({ hook: hookRecord({ inbox_ids: ["other@agentmail.to"] }) });
    stubFetch(fresh.routes);
    await t.run((ctx) => ctx.db.patch(innId, { inboxWebhookId: "wh_old" }));
    expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ inboxWebhookReady: false });
    await owner.as.action(api.inbox.provision, { innId });
    expect(fresh.state.hook!.inbox_ids).toEqual(["other@agentmail.to", TESTER]);
    expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ inboxWebhookReady: true });
  });

  it("concurrent provisions of two inns both land on the hook (atomic append, no list replacement)", async () => {
    liveEnv();
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const a = await seedInn(t, owner.userId, "A");
    const b = await seedInn(t, owner.userId, "B");
    const p = fakeProvider();
    const { calls } = stubFetch(p.routes);
    const [ra, rb] = await Promise.all([owner.as.action(api.inbox.provision, { innId: a }), owner.as.action(api.inbox.provision, { innId: b })]);
    expect(ra.inboxAddress).not.toBe(rb.inboxAddress);
    expect([...(p.state.hook!.inbox_ids as string[])].sort()).toEqual([TESTER, ra.inboxAddress, rb.inboxAddress].sort());
    expect(calls.filter((c) => c.body && typeof c.body === "object" && "inbox_ids" in (c.body as object))).toEqual([]);
    expect(p.state.created).toBe(2);
    for (const innId of [a, b]) {
      expect(await owner.as.query(api.integrations.status, { innId })).toMatchObject({ inboxWebhookReady: true });
    }
  });

  it("configureInbox with a new address clears the recorded subscription", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const innId = await seedInn(t, owner.userId);
    await t.run((ctx) => ctx.db.patch(innId, { inboxId: "old@agentmail.to", inboxAddress: "old@agentmail.to", inboxWebhookId: HOOK_ID, inboxWebhookConfirmedAt: 1 }));
    const { internal } = await import("../convex/_generated/api");
    await t.mutation(internal.inbox.configureInbox, { innId, inboxId: "old@agentmail.to" });
    expect((await t.run((ctx) => ctx.db.get(innId)))?.inboxWebhookId).toBe(HOOK_ID);
    await t.mutation(internal.inbox.configureInbox, { innId, inboxId: "new@agentmail.to" });
    const inn = (await t.run((ctx) => ctx.db.get(innId)))!;
    expect(inn).toMatchObject({ inboxId: "new@agentmail.to" });
    expect(inn.inboxWebhookId).toBeUndefined();
  });
});
