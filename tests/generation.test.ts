import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { decideDraft, groundClaims } from "../convex/lib/grounding";
import { makeTest, signedInUser } from "./setup";
import { draftOutput, judgeOutput, openaiRoutes, responsesOutput, seedInboundThread, seedLiveInn, settle, stubFetch, withEnv } from "./integrationSetup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("grounding (pure)", () => {
  it("verifies page and fact quotes against their own source only", () => {
    const sources = [
      { kind: "page" as const, id: "v1", url: "https://inn.example/p", markdown: "Dogs are welcome for a $25 fee.", pageId: "p1" },
      { kind: "fact" as const, id: "f1", answer: "The hot tub is open year-round." },
    ];
    const grounded = groundClaims(
      [
        { statement: "Dogs ok", url: "https://inn.example/p", quote: "Dogs are welcome for a $25 fee.", sourceId: "v1" },
        { statement: "Hot tub", url: "staff:f1", quote: "open year-round", sourceId: "f1" },
        { statement: "Cross", url: "https://inn.example/p", quote: "open year-round", sourceId: "v1" },
        { statement: "Ghost", url: "https://inn.example/p", quote: "Dogs", sourceId: "nope" },
        { statement: "Empty", url: "staff:f1", quote: "  ", sourceId: "f1" },
      ],
      sources,
    );
    expect(grounded.map((g) => g.status)).toEqual(["ok", "ok", "stripped", "stripped", "stripped"]);
    expect(decideDraft({ class: "answerable", abstain: false, answer: "x", claims: grounded, judge: { entailed: true, promised: false } }).status).toBe("needs_edit");
    const good = grounded.slice(0, 2);
    expect(decideDraft({ class: "answerable", abstain: false, answer: "x", claims: good, judge: { entailed: true, promised: false } }).status).toBe("ready");
    expect(decideDraft({ class: "answerable", abstain: false, answer: "x", claims: good, judge: { entailed: true, promised: true } }).status).toBe("needs_edit");
    expect(decideDraft({ class: "answerable", abstain: false, answer: "x", claims: good, judge: { error: "down" } }).status).toBe("needs_edit");
    expect(decideDraft({ class: "answerable", abstain: false, answer: "x", claims: good, judge: null }).status).toBe("needs_edit");
    expect(decideDraft({ class: "needs_staff_fact", abstain: true, answer: "", claims: [], judge: null })).toMatchObject({ status: "needs_edit", threadStatus: "needs_staff" });
  });
});

describe("draft generation", () => {
  it("produces a ready draft only when every quote verifies and the judge accepts the exact text", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, versionId, pageId } = await seedLiveInn(t, owner.userId);
    const factId = await t.run((ctx) =>
      ctx.db.insert("staffFacts", { innId, question: "Hot tub?", answer: "The hot tub is open all year.", scope: "general", author: owner.userId, authorName: "Owner", createdAt: Date.now() }),
    );
    const { threadId, messageId } = await seedInboundThread(t, innId);
    const seenBodies: Record<string, unknown>[] = [];
    const answer = "Yes, dogs are welcome for a $25 per night pet fee, and the hot tub is open all year.";
    stubFetch(
      openaiRoutes({
        draft: (body) => {
          seenBodies.push(body);
          return responsesOutput(
            draftOutput({
              answer,
              claims: [
                { statement: "Dogs are welcome for $25/night.", url: "https://seagull.example/policies", quote: "Dogs are welcome for a $25 per night pet fee.", sourceId: versionId },
                { statement: "Hot tub open all year.", url: `staff:${factId}`, quote: "open all year", sourceId: factId },
              ],
              stay: { checkIn: "2026-10-09", checkOut: "2026-10-11", party: 2, status: "inquiry" },
            }),
          );
        },
        judge: (body) => {
          seenBodies.push(body);
          return responsesOutput(judgeOutput(true, false, "entailed"));
        },
      }),
    );
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    const detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.thread.status).toBe("ready");
    expect(detail.thread.stay).toEqual({ checkIn: "2026-10-09", checkOut: "2026-10-11", party: 2, status: "inquiry" });
    expect(detail.draft).toMatchObject({ status: "ready", answer, verifiedText: answer, textSource: "model", replyToMessageId: messageId });
    expect(detail.draft?.judgeVerdict).toEqual({ entailed: true, promisedOutsideQuotes: false, notes: "entailed" });
    expect(detail.claims).toHaveLength(2);
    expect(detail.claims[0]).toMatchObject({ source: "page", pageVersionId: versionId, verified: true, status: "ok", currentSource: true });
    expect(detail.claims[1]).toMatchObject({ source: "fact", staffFactId: factId, verified: true, status: "ok" });
    // The judge saw the exact outgoing text and only verified claims.
    const judgeBody = seenBodies[1];
    expect(JSON.stringify(judgeBody)).toContain(answer);
    expect(JSON.stringify(judgeBody)).toContain("open all year");
    // Page provenance points at the stored version of the right page.
    const stored = await t.run((ctx) => ctx.db.query("claims").collect());
    expect(stored[0].pageId).toBe(pageId);
  });

  it("rejects an unsupported quote at the adapter and never marks the draft ready; judge refusal of promises also blocks", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, versionId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    let judgeCalls = 0;
    stubFetch(
      openaiRoutes({
        draft: () =>
          responsesOutput(
            draftOutput({
              answer: "Dogs are free of charge!",
              claims: [{ statement: "Dogs are free.", url: "https://seagull.example/policies", quote: "Dogs are free of charge", sourceId: versionId }],
            }),
          ),
        judge: () => {
          judgeCalls += 1;
          return responsesOutput(judgeOutput(true, false));
        },
      }),
    );
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    let detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.thread.status).toBe("needs_staff");
    expect(detail.draft).toMatchObject({ status: "needs_edit", verifiedText: null });
    // The adapter rejects quotes that are not verbatim in their source before grounding even runs.
    expect(detail.draft?.statusReason).toMatch(/drafter failed \(openai_invalid_response\).*quote/);
    expect(detail.claims).toEqual([]);
    expect(judgeCalls).toBe(0);

    // A verified quote but a judge that sees a promise beyond the evidence.
    vi.unstubAllGlobals();
    stubFetch(
      openaiRoutes({
        draft: () =>
          responsesOutput(
            draftOutput({
              answer: "Dogs are welcome for a $25 per night pet fee, and we will waive it for you.",
              claims: [{ statement: "Dogs $25.", url: "https://seagull.example/policies", quote: "$25 per night pet fee", sourceId: versionId }],
            }),
          ),
        judge: () => responsesOutput(judgeOutput(true, true, "waiver is not on the page")),
      }),
    );
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft).toMatchObject({ status: "needs_edit", verifiedText: null });
    expect(detail.draft?.statusReason).toMatch(/promises beyond/);
    expect(detail.draft?.judgeVerdict?.promisedOutsideQuotes).toBe(true);
    expect(detail.claims[0].status).toBe("ok");
  });

  it("surfaces provider failures and refusals as needs_edit with a safe reason", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    stubFetch(openaiRoutes({ draft: () => new Response(JSON.stringify({ error: "SECRET_BODY sk-live-xyz" }), { status: 500 }) }));
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    const detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft?.status).toBe("needs_edit");
    expect(detail.draft?.statusReason).toMatch(/drafter failed \(openai_http\)/);
    expect(detail.draft?.statusReason).not.toContain("SECRET_BODY");
    expect(detail.thread.status).toBe("needs_staff");
  });

  it("discards a stale completion when the cited page changed mid-generation and re-runs once", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, versionId, pageId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    let calls = 0;
    stubFetch(
      openaiRoutes({
        draft: async () => {
          calls += 1;
          if (calls === 1) {
            // The page changes while the first draft is in flight.
            await t.run(async (ctx) => {
              const v2 = await ctx.db.insert("pageVersions", { pageId, markdown: "# Policies\n\nDogs are welcome for a $40 per night pet fee.\n", hash: "h2", scrapedAt: Date.now(), changeStatus: "changed" });
              await ctx.db.patch(pageId, { lastVersionId: v2 });
            });
            return responsesOutput(draftOutput({ answer: "Old $25.", claims: [{ statement: "$25", url: "https://seagull.example/policies", quote: "$25 per night pet fee", sourceId: versionId }] }));
          }
          const page = await t.run((ctx) => ctx.db.get(pageId));
          return responsesOutput(draftOutput({ answer: "Now $40.", claims: [{ statement: "$40", url: "https://seagull.example/policies", quote: "$40 per night pet fee", sourceId: page!.lastVersionId! }] }));
        },
      }),
    );
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    await t.finishAllScheduledFunctions(() => {});
    const drafts = await t.run((ctx) => ctx.db.query("drafts").collect());
    expect(drafts.map((d) => d.status).sort()).toEqual(["ready", "superseded"]);
    expect(drafts.find((d) => d.status === "superseded")?.statusReason).toMatch(/stale: a cited page changed/);
    expect(drafts.find((d) => d.status === "superseded")?.answer).toBe("");
    const detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft?.answer).toBe("Now $40.");
    expect(detail.claims[0].currentSource).toBe(true);
    expect(calls).toBe(2);
  });

  it("discards a completion for an inbound that is no longer the latest", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, versionId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    stubFetch(
      openaiRoutes({
        draft: async () => {
          await t.run(async (ctx) => {
            const newer = await ctx.db.insert("messages", { threadId, direction: "in", from: "guest@example.com", to: "x", text: "Never mind", at: Date.now() });
            await ctx.db.patch(threadId, { lastInboundMessageId: newer });
          });
          return responsesOutput(draftOutput({ answer: "A", claims: [{ statement: "s", url: "https://seagull.example/policies", quote: "$25 per night pet fee", sourceId: versionId }] }));
        },
      }),
    );
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    const drafts = await t.run((ctx) => ctx.db.query("drafts").collect());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "superseded", statusReason: "stale: a newer guest message arrived" });
    expect(await t.run((ctx) => ctx.db.query("claims").collect())).toEqual([]);
  });

  it("a staff edit invalidates the verdict, freezes sending, and is re-judged as the exact edited text", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId, versionId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    const judged: string[] = [];
    stubFetch(
      openaiRoutes({
        draft: () => responsesOutput(draftOutput({ answer: "Dogs are welcome for a $25 per night pet fee.", claims: [{ statement: "$25", url: "https://seagull.example/policies", quote: "$25 per night pet fee", sourceId: versionId }] })),
        judge: (body) => {
          const text = JSON.stringify(body);
          judged.push(text);
          return responsesOutput(text.includes("free of charge") ? judgeOutput(true, true, "promise") : judgeOutput(true, false));
        },
      }),
    );
    await t.action(internal.generation.generateForThread, { threadId, inboundMessageId: messageId });
    let detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft?.status).toBe("ready");
    const draftId = detail.draft!._id;
    await owner.as.mutation(api.threads.claim, { threadId });

    // Edit adds a promise: verdict cleared, then re-judged and refused.
    await owner.as.mutation(api.drafts.edit, { draftId, answer: "Dogs are welcome free of charge." });
    detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft).toMatchObject({ status: "needs_edit", verifiedText: null, judgeVerdict: null, textSource: "staff" });
    await expect(owner.as.mutation(api.drafts.send, { draftId })).rejects.toThrow(/unverified_edit/);
    await settle(t);
    detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft?.status).toBe("needs_edit");
    expect(detail.draft?.statusReason).toMatch(/promises beyond/);
    expect(judged.at(-1)).toContain("Dogs are welcome free of charge.");

    // A faithful edit is re-judged and becomes ready with verifiedText === answer.
    await owner.as.mutation(api.drafts.edit, { draftId, answer: "Hi! Dogs are welcome for a $25 per night pet fee." });
    await settle(t);
    detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail.draft).toMatchObject({ status: "ready", verifiedText: "Hi! Dogs are welcome for a $25 per night pet fee.", textSource: "staff" });
    expect(detail.thread.status).toBe("ready");
  });

  it("re-judging applies only to the text that was judged (a later edit wins)", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, innId);
    const draftId = await t.run((ctx) =>
      ctx.db.insert("drafts", { threadId, replyToMessageId: messageId, class: "answerable", answer: "first", abstain: false, status: "needs_edit", model: "m", textSource: "staff" }),
    );
    const applied = await t.mutation(internal.generation.applyReverify, {
      draftId,
      answer: "stale text",
      verdict: { entailed: true, promisedOutsideQuotes: false, notes: "" },
    });
    expect(applied).toEqual({ applied: false });
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.status).toBe("needs_edit");
  });

  it("demo inns never call a provider even when a key is present", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "V", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    const { calls } = stubFetch([]);
    const [gap] = await visitor.as.query(api.threads.queue, { innId, status: "needs_staff" });
    await t.action(internal.generation.generateForThread, { threadId: gap._id, inboundMessageId: gap.lastInboundMessageId! });
    await expect(visitor.as.mutation(api.drafts.regenerate, { threadId: gap._id })).rejects.toThrow(/demo_inn/);
    expect(calls).toEqual([]);
  });
});
