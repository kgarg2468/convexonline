import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { decideCorrectionSend, isCorrectionTextApproved } from "../convex/lib/sendGuards";
import { makeTest, signedInUser } from "./setup";
import { agentmailReplyRoute, json, seedInboundThread, seedLiveInn, settle, stubFetch, withEnv } from "./integrationSetup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type T = ReturnType<typeof makeTest>;

const V25 = "# Policies\n\nDogs are welcome for a $25 per night pet fee.\n\nCheck-in is from 3:00 PM.\n";
const V40 = "# Policies\n\nDogs are welcome for a $40 per night pet fee, limited to one dog per room.\n\nCheck-in is from 3:00 PM.\n";
const V30 = "# Policies\n\nDogs are welcome for a $30 per night pet fee.\n\nCheck-in is from 3:00 PM.\n";

/** A real inn with one sent reply citing the $25 pet fee. */
async function seedSentInn(t: T) {
  const owner = await signedInUser(t, { name: "Owner" });
  const inn = await seedLiveInn(t, owner.userId, { markdown: V25 });
  const pet = await seedInboundThread(t, inn.innId, { text: "Dogs?", providerMessageId: "msg_pet" });
  const sent = await t.run(async (ctx) => {
    const draftId = await ctx.db.insert("drafts", {
      threadId: pet.threadId,
      replyToMessageId: pet.messageId,
      class: "answerable",
      answer: "Dogs are welcome for a $25 per night pet fee.",
      abstain: false,
      status: "sent",
      model: "test",
      verifiedText: "Dogs are welcome for a $25 per night pet fee.",
      textSource: "model",
    });
    const claimId = await ctx.db.insert("claims", {
      draftId,
      threadId: pet.threadId,
      innId: inn.innId,
      statement: "$25 per night pet fee",
      pageId: inn.pageId,
      pageVersionId: inn.versionId,
      url: "https://seagull.example/policies",
      quote: "$25 per night pet fee",
      verified: true,
      verifyMethod: "strict",
      status: "ok",
    });
    const sentReplyId = await ctx.db.insert("sentReplies", {
      threadId: pet.threadId,
      innId: inn.innId,
      draftId,
      sentBy: owner.userId,
      sentAt: Date.now(),
      kind: "reply",
      text: "Dogs are welcome for a $25 per night pet fee.",
      textSource: "model",
      simulated: false,
    });
    await ctx.db.patch(pet.threadId, { status: "waiting_guest" });
    return { draftId, claimId, sentReplyId };
  });
  await owner.as.mutation(api.threads.claim, { threadId: pet.threadId });
  return { owner, ...inn, ...pet, ...sent };
}

const corrections = (t: T) => t.run((ctx) => ctx.db.query("corrections").collect());

type Owner = Awaited<ReturnType<typeof signedInUser>>;
type ControlPage = Awaited<ReturnType<typeof controlPage>>;
const controlPage = (owner: Owner, innId: Id<"inns">, cursor: string | null) =>
  owner.as.query(api.corrections.unaffectedControls, { innId, paginationOpts: { cursor, numItems: 25 } });
/** Control rows of every page (paginated contract); an `unchecked` row fails the test outright. */
async function controlsOf(owner: Owner, innId: Id<"inns">) {
  const controls = [];
  let cursor: string | null = null;
  for (;;) {
    const page: ControlPage = await controlPage(owner, innId, cursor);
    for (const row of page.page) {
      if (row.kind !== "control") throw new Error(`unexpected ${row.kind} row`);
      controls.push(row);
    }
    if (page.isDone) return controls;
    cursor = page.continueCursor;
  }
}
const claimOf = (t: T, id: Id<"claims">) => t.run((ctx) => ctx.db.get(id));
const pendingIds = async (t: T) => (await corrections(t)).filter((c) => c.status === "needs_review").map((c) => c._id);

type Verdict = { entailed: boolean; promisedOutsideQuotes: boolean; notes: string };
const GOOD: Verdict = { entailed: true, promisedOutsideQuotes: false, notes: "ok" };

/** Turns the pending proposal into what the drafter action would have stored. */
async function asGenerated(t: T, correctionId: Id<"corrections">, verdict: Verdict | undefined, opts: { noEvidence?: boolean } = {}) {
  const evidenceQuote = opts.noEvidence ? undefined : "$40 per night pet fee";
  // Let the scheduled (keyless) drafter run finish first so it cannot overwrite the row mid-test.
  await settle(t);
  await t.run((ctx) =>
    ctx.db.patch(correctionId, {
      proposedText: "Update: the pet fee is now $40 per night pet fee.",
      evidenceQuote,
      evidenceVerifyMethod: evidenceQuote ? "strict" : undefined,
      textSource: "generated",
      judgeVerdict: verdict,
      statusReason: verdict && verdict.entailed && !verdict.promisedOutsideQuotes ? undefined : "judge did not accept the generated correction; edit before approving",
    }),
  );
}

describe("correction text guard (pure)", () => {
  it("accepts staff text, evidenced fixtures, and judge-accepted generated text only", () => {
    const gen = { proposedText: "x", textSource: "generated" as const, evidenceQuote: "q", judgeVerdict: { entailed: true, promisedOutsideQuotes: false } };
    expect(isCorrectionTextApproved(gen)).toBe(true);
    expect(isCorrectionTextApproved({ ...gen, judgeVerdict: { entailed: false, promisedOutsideQuotes: false } })).toBe(false);
    expect(isCorrectionTextApproved({ ...gen, judgeVerdict: { entailed: true, promisedOutsideQuotes: true } })).toBe(false);
    expect(isCorrectionTextApproved({ ...gen, judgeVerdict: undefined })).toBe(false);
    expect(isCorrectionTextApproved({ ...gen, evidenceQuote: undefined })).toBe(false);
    expect(isCorrectionTextApproved({ ...gen, proposedText: "  " })).toBe(false);
    expect(isCorrectionTextApproved({ proposedText: "x", textSource: "staff" })).toBe(true);
    expect(isCorrectionTextApproved({ proposedText: "x", textSource: "fixture", evidenceQuote: "q" })).toBe(true);
    expect(isCorrectionTextApproved({ proposedText: "x", textSource: "fixture" })).toBe(false);
    expect(isCorrectionTextApproved({ proposedText: "x" })).toBe(false);
  });

  it("the shared send decision refuses an approved-but-unverified generated proposal", () => {
    const base = {
      actor: "u1",
      now: 1_000_000,
      thread: { claimedBy: "u1" as Id<"users">, claimedAt: 900_000, lastInboundMessageId: "m1" as Id<"messages"> },
      correction: {
        status: "approved" as const,
        newVersionId: "v2",
        proposedText: "x",
        textSource: "generated" as const,
        evidenceQuote: "q",
        judgeVerdict: { entailed: true, promisedOutsideQuotes: false },
      },
      pageLastVersionId: "v2",
      outboxStatuses: [] as ("reserved" | "sending" | "sent" | "failed" | "unknown")[],
    };
    expect(decideCorrectionSend(base)).toEqual({ ok: true });
    expect(decideCorrectionSend({ ...base, correction: { ...base.correction, judgeVerdict: { entailed: false, promisedOutsideQuotes: false } } })).toEqual({ ok: false, reason: "unverified_proposal" });
    expect(decideCorrectionSend({ ...base, correction: { ...base.correction, judgeVerdict: undefined } })).toEqual({ ok: false, reason: "unverified_proposal" });
    expect(decideCorrectionSend({ ...base, correction: { ...base.correction, evidenceQuote: undefined } })).toEqual({ ok: false, reason: "unverified_proposal" });
    expect(decideCorrectionSend({ ...base, correction: { ...base.correction, textSource: "staff", judgeVerdict: undefined, evidenceQuote: undefined } })).toEqual({ ok: true });
  });
});

describe("generated proposals the judge did not accept", () => {
  it("cannot be approved unchanged, re-submitted verbatim, or approved without a verdict; a real edit is staff text", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    for (const verdict of [
      { entailed: false, promisedOutsideQuotes: false, notes: "not entailed" },
      { entailed: true, promisedOutsideQuotes: true, notes: "promised" },
      undefined,
    ]) {
      const t = makeTest();
      const s = await seedSentInn(t);
      await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V40 });
      const [id] = await pendingIds(t);
      await asGenerated(t, id, verdict);
      const same = "Update: the pet fee is now $40 per night pet fee.";
      await expect(s.owner.as.mutation(api.corrections.review, { correctionId: id, decision: "approve" })).rejects.toThrow(/unverified_proposal/);
      await expect(s.owner.as.mutation(api.corrections.review, { correctionId: id, decision: "approve", proposedText: same })).rejects.toThrow(/unverified_proposal/);
      await expect(s.owner.as.mutation(api.corrections.review, { correctionId: id, decision: "approve", proposedText: `  ${same}  ` })).rejects.toThrow(/unverified_proposal/);
      expect((await corrections(t))[0]).toMatchObject({ status: "needs_review", textSource: "generated" });
      // Dismissal is always allowed.
      const t2 = makeTest();
      const s2 = await seedSentInn(t2);
      await s2.owner.as.mutation(api.pages.submitContent, { pageId: s2.pageId, markdown: V40 });
      const [id2] = await pendingIds(t2);
      await asGenerated(t2, id2, verdict);
      await s2.owner.as.mutation(api.corrections.review, { correctionId: id2, decision: "dismiss" });
      expect((await corrections(t2))[0].status).toBe("dismissed");

      // An actual rewrite is a human decision: approved as staff text with the verdict cleared.
      await s.owner.as.mutation(api.corrections.review, { correctionId: id, decision: "approve", proposedText: "The pet fee is now $40 per night." });
      const [approved] = await corrections(t);
      expect(approved).toMatchObject({ status: "approved", textSource: "staff", proposedText: "The pet fee is now $40 per night." });
      expect(approved.judgeVerdict).toBeUndefined();
    }
  });

  it("a generated proposal without an evidence quote is not approvable unchanged", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await seedSentInn(t);
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V40 });
    const [id] = await pendingIds(t);
    await asGenerated(t, id, GOOD, { noEvidence: true });
    await expect(s.owner.as.mutation(api.corrections.review, { correctionId: id, decision: "approve" })).rejects.toThrow(/unverified_proposal/);
  });

  it("an accepted generated proposal is approvable and sendable, and is re-checked before dispatch", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V40 });
    const [id] = await pendingIds(t);
    await asGenerated(t, id, GOOD);
    await s.owner.as.mutation(api.corrections.review, { correctionId: id, decision: "approve" });
    expect((await corrections(t))[0]).toMatchObject({ status: "approved", textSource: "generated", judgeVerdict: GOOD });

    // The verdict regresses after approval but before dispatch: preflight refuses, nothing is sent.
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const { outboxId } = await s.owner.as.mutation(api.corrections.send, { correctionId: id });
    await t.run((ctx) => ctx.db.patch(id, { judgeVerdict: { entailed: false, promisedOutsideQuotes: false, notes: "regressed" } }));
    await t.action(internal.outbox.deliver, { outboxId });
    await settle(t);
    const [row] = await t.run((ctx) => ctx.db.query("outbox").collect());
    expect(row).toMatchObject({ status: "failed", errorKind: "precondition" });
    expect(row.errorMessage).toMatch(/no longer verified/);
    expect(calls).toEqual([]);
    // The reservation path refuses it too now.
    await expect(s.owner.as.mutation(api.corrections.send, { correctionId: id })).rejects.toThrow(/unverified_proposal/);

    // With the verdict intact the same approval sends.
    await t.run((ctx) => ctx.db.patch(id, { judgeVerdict: GOOD }));
    await s.owner.as.mutation(api.corrections.send, { correctionId: id });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ text: "Update: the pet fee is now $40 per night pet fee." });
    expect((await corrections(t))[0].status).toBe("sent");
    expect((await claimOf(t, s.claimId))?.status).toBe("corrected");
  });

  it("the demo fixture proposal stays approvable and sendable as before", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    await visitor.as.mutation(api.demo.changePolicyPage, { innId });
    const [fixture] = await visitor.as.query(api.corrections.list, { innId, status: "needs_review" });
    expect(fixture).toMatchObject({ textSource: "fixture" });
    await visitor.as.mutation(api.corrections.review, { correctionId: fixture._id, decision: "approve" });
    await visitor.as.mutation(api.demo.simulateCorrectionSend, { correctionId: fixture._id });
    expect((await visitor.as.query(api.corrections.list, { innId })).find((c) => c._id === fixture._id)?.status).toBe("sent");
  });
});

describe("guest-visible truth follows the latest sent correction", () => {
  async function sendStaffCorrection(t: T, s: Awaited<ReturnType<typeof seedSentInn>>, correctionId: Id<"corrections">, evidenceQuote?: string) {
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_corr_out" }))]);
    if (evidenceQuote) {
      await s.owner.as.mutation(api.corrections.setText, { correctionId, proposedText: "Our pet fee is now $40 per night.", evidenceQuote });
      await s.owner.as.mutation(api.corrections.review, { correctionId, decision: "approve" });
    } else {
      await s.owner.as.mutation(api.corrections.review, { correctionId, decision: "approve", proposedText: "Our pet fee is now $40 per night." });
    }
    await s.owner.as.mutation(api.corrections.send, { correctionId });
    await settle(t);
    expect(calls).toHaveLength(1);
    vi.unstubAllGlobals();
  }

  it("$25 → correction sent $40 → $30 pending → back to $25 still pending → $40 restored heals", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    const to40 = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V40 });
    const [c1] = await pendingIds(t);
    await sendStaffCorrection(t, s, c1, "$40 per night pet fee");
    expect(await claimOf(t, s.claimId)).toMatchObject({ status: "corrected" });

    // $30: the $40 the guest heard is gone → review, starting from the $40 evidence.
    const to30 = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V30 });
    expect(to30).toMatchObject({ affected: 1, unaffected: 0, affectedReplies: 1, unaffectedReplies: 0 });
    let open = (await corrections(t)).filter((c) => c.status === "needs_review");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ oldQuote: "$40 per night pet fee", oldVersionId: to40.pageVersionId, newVersionId: to30.pageVersionId });
    expect(open[0].newPassage).toContain("$30 per night pet fee");
    expect(await claimOf(t, s.claimId)).toMatchObject({ status: "needs_review", checkedAgainstVersionId: to30.pageVersionId });

    // Back to $25: the original quote is on the page again, but the guest last heard $40 → still under review.
    const to25 = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V25 + "\n" });
    expect(to25).toMatchObject({ affected: 1, unaffected: 0, affectedReplies: 1, unaffectedReplies: 0 });
    expect(await claimOf(t, s.claimId)).toMatchObject({ status: "needs_review", checkedAgainstVersionId: to25.pageVersionId });
    const previousOpen = open[0]._id;
    open = (await corrections(t)).filter((c) => c.status === "needs_review");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ oldQuote: "$40 per night pet fee", newVersionId: to25.pageVersionId });
    expect((await corrections(t)).find((c) => c._id === previousOpen)).toMatchObject({ status: "superseded", supersededById: open[0]._id });
    expect(await controlsOf(s.owner, s.innId)).toEqual([]);

    // $40 restored: what the guest heard is true again → corrected and current, open proposals closed.
    const back40 = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V40 + "\n" });
    expect(back40).toMatchObject({ affected: 0, unaffected: 1, affectedReplies: 0, unaffectedReplies: 1 });
    expect(await claimOf(t, s.claimId)).toMatchObject({ status: "corrected", checkedAgainstVersionId: back40.pageVersionId });
    expect((await corrections(t)).filter((c) => c.status === "needs_review" || c.status === "approved")).toEqual([]);
    expect((await corrections(t)).find((c) => c._id === c1)?.status).toBe("sent");
    const controls = await controlsOf(s.owner, s.innId);
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ claimId: s.claimId, quote: "$40 per night pet fee" });
    expect(await s.owner.as.query(api.threads.stats, { innId: s.innId })).toMatchObject({ pendingCorrections: 0 });
  });

  it("delivery order, not proposal order, decides which sent correction is the guest-visible evidence", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    // c1 is proposed first (against $40), approved, and handed to the provider.
    const to40 = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V40 });
    const [c1] = await pendingIds(t);
    await s.owner.as.mutation(api.corrections.setText, { correctionId: c1, proposedText: "Our pet fee is now $40 per night.", evidenceQuote: "$40 per night pet fee" });
    await s.owner.as.mutation(api.corrections.review, { correctionId: c1, decision: "approve" });
    stubFetch([]);
    const { outboxId: r1 } = await s.owner.as.mutation(api.corrections.send, { correctionId: c1 });
    expect((await t.mutation(internal.outbox.beginSend, { outboxId: r1 })).ok).toBe(true);

    // While c1 is with the provider the page moves to $30: c2 is proposed later and delivered first.
    const to30 = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V30 });
    const [c2] = await pendingIds(t);
    expect(c2).not.toBe(c1);
    await s.owner.as.mutation(api.corrections.setText, { correctionId: c2, proposedText: "Our pet fee is now $30 per night.", evidenceQuote: "$30 per night pet fee" });
    await s.owner.as.mutation(api.corrections.review, { correctionId: c2, decision: "approve" });
    vi.unstubAllGlobals();
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_c2_out" }))]);
    await s.owner.as.mutation(api.corrections.send, { correctionId: c2 });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect((await corrections(t)).find((c) => c._id === c2)).toMatchObject({ status: "sent" });
    expect(await claimOf(t, s.claimId)).toMatchObject({ status: "corrected", checkedAgainstVersionId: to30.pageVersionId });

    // c1 (the older proposal) is delivered last: the guest now last heard "$40".
    await new Promise((r) => setTimeout(r, 5));
    await t.mutation(internal.outbox.commit, { outboxId: r1, providerMessageId: "msg_c1_out" });
    const rows = await corrections(t);
    const sentC1 = rows.find((c) => c._id === c1)!;
    expect(sentC1.status).toBe("sent");
    const [rep2, rep1] = await t.run(async (ctx) => [
      await ctx.db.get(rows.find((c) => c._id === c2)!.sentReplyIdForCorrection!),
      await ctx.db.get(sentC1.sentReplyIdForCorrection!),
    ]);
    expect(rep1!.sentAt).toBeGreaterThan(rep2!.sentAt);
    expect(sentC1._creationTime).toBeLessThan(rows.find((c) => c._id === c2)!._creationTime);
    // Immutable history: both delivered messages stand as they were sent.
    const outbound = (await t.run((ctx) => ctx.db.query("messages").collect())).filter((m) => m.direction === "out");
    expect(outbound.map((m) => m.text)).toEqual(["Our pet fee is now $30 per night.", "Our pet fee is now $40 per night."]);
    // Current-source review runs on the $40 the guest heard last: it is gone from the $30 page.
    expect(await claimOf(t, s.claimId)).toMatchObject({ status: "needs_review", checkedAgainstVersionId: to30.pageVersionId });
    const open = rows.filter((c) => c.status === "needs_review");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ oldQuote: "$40 per night pet fee", oldVersionId: to40.pageVersionId, newVersionId: to30.pageVersionId });
    expect(await controlsOf(s.owner, s.innId)).toEqual([]);

    // Restoring $40 heals it; restoring $30 would not, because $30 is no longer what the guest last heard.
    const back40 = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V40 + "\n" });
    expect(back40).toMatchObject({ affected: 0, unaffected: 1, affectedReplies: 0, unaffectedReplies: 1 });
    expect(await claimOf(t, s.claimId)).toMatchObject({ status: "corrected", checkedAgainstVersionId: back40.pageVersionId });
    expect((await corrections(t)).filter((c) => c.status === "needs_review" || c.status === "approved")).toEqual([]);
    // The control shows the passage the guest heard last ($40, delivered last), not the
    // later-proposed but earlier-delivered $30.
    const controls = await controlsOf(s.owner, s.innId);
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ claimId: s.claimId, quote: "$40 per night pet fee" });
  });

  it("a sent staff correction without evidence is never certified by the original quote", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    const to40 = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V40 });
    const [c1] = await pendingIds(t);
    await sendStaffCorrection(t, s, c1);
    expect((await corrections(t)).find((c) => c._id === c1)).toMatchObject({ status: "sent", textSource: "staff" });
    expect((await corrections(t)).find((c) => c._id === c1)?.evidenceQuote).toBeUndefined();

    // The page goes back to $25: mechanically that restores the original quote, but nobody
    // knows whether what the guest was told still holds → honest review, no proposal generated.
    const to25 = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V25 + "\n" });
    expect(to25).toMatchObject({ affected: 1, unaffected: 0, affectedReplies: 1, unaffectedReplies: 0 });
    expect(await claimOf(t, s.claimId)).toMatchObject({ status: "needs_review", checkedAgainstVersionId: to25.pageVersionId });
    const open = (await corrections(t)).filter((c) => c.status === "needs_review");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ oldVersionId: to40.pageVersionId, newVersionId: to25.pageVersionId, oldQuote: "$25 per night pet fee" });
    expect(open[0].newPassage).toBeUndefined();
    expect(open[0].statusReason).toMatch(/no evidence quote/);
    await settle(t);
    expect((await corrections(t)).find((c) => c._id === open[0]._id)?.proposedText).toBeUndefined();
    expect(await controlsOf(s.owner, s.innId)).toEqual([]);
  });
});
