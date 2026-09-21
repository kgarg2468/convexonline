import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { makeTest, signedInUser } from "./setup";
import { agentmailReplyRoute, draftOutput, json, judgeOutput, openaiRoutes, responsesOutput, seedInboundThread, seedLiveInn, settle, stubFetch, withEnv } from "./integrationSetup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type T = ReturnType<typeof makeTest>;

const V1 = "# Policies\n\nDogs are welcome for a $25 per night pet fee.\n\nCheck-in is from 3:00 PM.\n";
const V2 = "# Policies\n\nDogs are welcome for a $40 per night pet fee, limited to one dog per room.\n\nCheck-in is from 3:00 PM.\n";
const V3 = "# Policies\n\nSorry, no pets at all.\n\nCheck-in is from 3:00 PM.\n";

/** A real inn with two already-sent replies: one cites the pet fee, one cites check-in (control). */
async function seedSentInn(t: T) {
  const owner = await signedInUser(t, { name: "Owner" });
  const inn = await seedLiveInn(t, owner.userId, { markdown: V1 });
  const pet = await seedInboundThread(t, inn.innId, { text: "Dogs?", providerMessageId: "msg_pet" });
  const checkin = await seedInboundThread(t, inn.innId, { text: "Check-in?", providerMessageId: "msg_checkin" });
  const seedSent = async (threadId: Id<"threads">, messageId: Id<"messages">, answer: string, quote: string) =>
    await t.run(async (ctx) => {
      const draftId = await ctx.db.insert("drafts", {
        threadId,
        replyToMessageId: messageId,
        class: "answerable",
        answer,
        abstain: false,
        status: "sent",
        model: "test",
        verifiedText: answer,
        textSource: "model",
      });
      const claimId = await ctx.db.insert("claims", {
        draftId,
        threadId,
        innId: inn.innId,
        statement: quote,
        pageId: inn.pageId,
        pageVersionId: inn.versionId,
        url: "https://seagull.example/policies",
        quote,
        verified: true,
        verifyMethod: "strict",
        status: "ok",
      });
      const sentReplyId = await ctx.db.insert("sentReplies", {
        threadId,
        innId: inn.innId,
        draftId,
        sentBy: owner.userId,
        sentAt: Date.now(),
        kind: "reply",
        text: answer,
        textSource: "model",
        simulated: false,
      });
      await ctx.db.patch(threadId, { status: "waiting_guest" });
      return { draftId, claimId, sentReplyId };
    });
  const petSent = await seedSent(pet.threadId, pet.messageId, "Dogs are welcome for a $25 per night pet fee.", "$25 per night pet fee");
  const checkinSent = await seedSent(checkin.threadId, checkin.messageId, "Check-in is from 3:00 PM.", "Check-in is from 3:00 PM.");
  return { owner, ...inn, pet: { ...pet, ...petSent }, checkin: { ...checkin, ...checkinSent } };
}

const pending = (_t: T, owner: Awaited<ReturnType<typeof signedInUser>>, innId: Id<"inns">) =>
  owner.as.query(api.corrections.list, { innId, status: "needs_review" });

describe("corrections on real inns", () => {
  it("a vanished quote opens exactly one correction with provenance; controls stay untouched", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await seedSentInn(t);
    const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    expect(result).toMatchObject({ changeStatus: "changed", affected: 1, affectedReplies: 1, unaffectedReplies: 1 });
    const [c] = await pending(t, s.owner, s.innId);
    expect(c).toMatchObject({
      threadId: s.pet.threadId,
      claimId: s.pet.claimId,
      sentReplyId: s.pet.sentReplyId,
      oldQuote: "$25 per night pet fee",
      oldVersionId: s.versionId,
      newVersionId: result.pageVersionId,
      isCurrent: true,
      sentText: "Dogs are welcome for a $25 per night pet fee.",
      proposedText: null,
    });
    expect(c.newPassage).toContain("$40 per night pet fee");
    // Without a drafter key the proposal stays empty with a reason, never fabricated.
    await settle(t);
    const [after] = await pending(t, s.owner, s.innId);
    expect(after.proposedText).toBeNull();
    expect(after.statusReason).toMatch(/OPENAI_API_KEY is not configured/);
    const claims = await t.run((ctx) => ctx.db.query("claims").collect());
    expect(claims.find((c) => c._id === s.pet.claimId)?.status).toBe("needs_review");
    expect(claims.find((c) => c._id === s.checkin.claimId)).toMatchObject({ status: "ok", checkedAgainstVersionId: result.pageVersionId });
    const controls = await s.owner.as.query(api.corrections.unaffectedControls, { innId: s.innId });
    expect(controls.map((c) => c.quote)).toEqual(["Check-in is from 3:00 PM."]);
  });

  it("the drafter proposes a correction grounded only in the new page and staff text is never overwritten", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    let drafterPages: unknown;
    let drafterBody: Record<string, unknown> | undefined;
    let judgeBody: Record<string, unknown> | undefined;
    stubFetch(
      openaiRoutes({
        draft: (body) => {
          drafterPages = JSON.stringify(body);
          return responsesOutput(
            draftOutput({
              answer: "Update: our pet fee is now $40 per night pet fee, one dog per room.",
              claims: [{ statement: "fee is $40", url: "https://seagull.example/policies", quote: "$40 per night pet fee", sourceId: "__NEW__" }],
            }),
          );
        },
      }),
    );
    // The mock does not know the new version id up front; resolve it once the page changes.
    const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    vi.unstubAllGlobals();
    stubFetch(
      openaiRoutes({
        draft: (body) => {
          drafterPages = JSON.stringify(body);
          drafterBody = body;
          return responsesOutput(
            draftOutput({
              answer: "Update: our pet fee is now $40 per night pet fee, one dog per room.",
              claims: [{ statement: "fee is $40", url: "https://seagull.example/policies", quote: "$40 per night pet fee", sourceId: result.pageVersionId }],
            }),
          );
        },
        judge: (body) => {
          judgeBody = body;
          return responsesOutput(judgeOutput());
        },
      }),
    );
    await settle(t);
    const [c] = await pending(t, s.owner, s.innId);
    expect(c).toMatchObject({ textSource: "generated", evidenceQuote: "$40 per night pet fee", statusReason: null });
    expect(c.proposedText).toContain("$40");
    expect(c.judgeVerdict).toEqual({ entailed: true, promisedOutsideQuotes: false, notes: "ok" });
    // The drafter was shown only the new version, never the old $25 text as a source.
    expect(String(drafterPages)).toContain("limited to one dog per room");
    expect(String(drafterPages)).not.toMatch(/"markdown":"[^"]*\$25 per night/);

    // Correction instructions travel in the trusted system message (adapter correction
    // mode), not inside the untrusted <guest_email> block, which holds history only.
    const drafterInput = drafterBody!.input as Array<{ role: string; content: string }>;
    const drafterSystem = drafterInput[0].content;
    const drafterUser = drafterInput[1].content;
    expect(drafterInput[0].role).toBe("system");
    expect(drafterSystem).toMatch(/Correction mode\. This is not a fresh guest inquiry/);
    expect(drafterSystem).toMatch(/ONE purpose only: to identify which topic/);
    expect(drafterSystem).toMatch(/Do not repeat the earlier figure, time or wording/);
    expect(drafterSystem).toMatch(/Do not say or imply that anything changed/);
    expect(drafterUser).toContain("<guest_email>\nSubject: Re: Dog?\n\nReply already sent to this guest:\nDogs are welcome for a $25 per night pet fee.\n");
    expect(drafterUser).toContain('Passage of the old page that reply relied on (no longer on the page): "$25 per night pet fee"');
    expect(drafterUser).not.toMatch(/Write a short, polite/);
    expect(drafterUser).not.toMatch(/citing only the current page/);
    expect(drafterUser).not.toMatch(/Correction mode/);
    // The old reply and passage appear nowhere except inside <guest_email>.
    const guestBlock = drafterUser.slice(drafterUser.indexOf("<guest_email>"));
    expect(drafterUser.slice(0, drafterUser.indexOf("<guest_email>"))).not.toContain("$25");
    expect(guestBlock).toContain("$25 per night pet fee");

    // The judge stays source-only: it sees the reply and the verified current-page
    // quote, never the earlier reply or the old passage as evidence or context.
    const judgeInput = judgeBody!.input as Array<{ role: string; content: string }>;
    expect(judgeInput[0].content).not.toMatch(/guest_email/);
    expect(judgeInput[0].content).not.toMatch(/Correction mode/);
    expect(judgeInput[1].content).not.toContain("<guest_email>");
    expect(judgeInput[1].content).not.toContain("$25");
    expect(judgeInput[1].content).not.toContain("Reply already sent");
    expect(judgeInput[1].content).toContain("<quote>$40 per night pet fee</quote>");

    // Staff rewrite: the drafter's later output must not clobber it.
    await s.owner.as.mutation(api.threads.claim, { threadId: s.pet.threadId });
    await s.owner.as.mutation(api.corrections.setText, { correctionId: c._id, proposedText: "Heads up: the pet fee is now $40 per night.", evidenceQuote: "$40 per night pet fee" });
    await t.action(internal.corrections.generateProposal, { correctionId: c._id });
    const [edited] = await pending(t, s.owner, s.innId);
    expect(edited).toMatchObject({ textSource: "staff", proposedText: "Heads up: the pet fee is now $40 per night.", judgeVerdict: null });
    await expect(
      s.owner.as.mutation(api.corrections.setText, { correctionId: c._id, proposedText: "x", evidenceQuote: "$25 per night pet fee" }),
    ).rejects.toThrow(/invalid_quote/);
  });

  it("a generated correction the judge rejects stays held and cannot be approved unedited", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    stubFetch(openaiRoutes({ draft: () => json(500, { error: "not yet" }) }));
    const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    vi.unstubAllGlobals();
    // The drafter still repeats the old figure; the source-only judge rejects it.
    const repeated = "Correction: the pet fee is $40 per night pet fee, not the $25 we quoted before.";
    stubFetch(
      openaiRoutes({
        draft: () =>
          responsesOutput(
            draftOutput({
              answer: repeated,
              claims: [{ statement: "fee is $40", url: "https://seagull.example/policies", quote: "$40 per night pet fee", sourceId: result.pageVersionId }],
            }),
          ),
        judge: () => responsesOutput(judgeOutput(false, false, "the earlier $25 quote is not supported by the evidence")),
      }),
    );
    await t.action(internal.corrections.generateProposal, { correctionId: (await pending(t, s.owner, s.innId))[0]._id });
    const [c] = await pending(t, s.owner, s.innId);
    expect(c).toMatchObject({
      status: "needs_review",
      textSource: "generated",
      proposedText: repeated,
      evidenceQuote: "$40 per night pet fee",
      judgeVerdict: { entailed: false, promisedOutsideQuotes: false, notes: "the earlier $25 quote is not supported by the evidence" },
    });
    expect(c.statusReason).toMatch(/judge did not accept/);
    await s.owner.as.mutation(api.threads.claim, { threadId: s.pet.threadId });
    await expect(s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve" })).rejects.toThrow(/unverified_proposal/);
    await expect(s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve", proposedText: repeated })).rejects.toThrow(
      /unverified_proposal/,
    );
    await expect(s.owner.as.mutation(api.corrections.send, { correctionId: c._id })).rejects.toThrow(/claimed|not_approved/);
    expect((await pending(t, s.owner, s.innId))[0].status).toBe("needs_review");
    expect(await t.run((ctx) => ctx.db.query("outbox").collect())).toEqual([]);
  });

  it("approve → live send into the original thread; the claim becomes corrected and cannot be sent twice", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    await settle(t);
    const [c] = await pending(t, s.owner, s.innId);
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_corr_out" }))]);

    await expect(s.owner.as.mutation(api.corrections.send, { correctionId: c._id })).rejects.toThrow(/claimed|not_approved/);
    await expect(s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve" })).rejects.toThrow(/invalid/);
    // Approving an unclaimed thread takes the claim so the send that follows is owned.
    await s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve", proposedText: "Our pet fee is now $40 per night." });
    const approved = (await s.owner.as.query(api.corrections.list, { innId: s.innId, status: "approved" }))[0];
    expect(approved).toMatchObject({ _id: c._id, textSource: "staff" });
    expect((await t.run((ctx) => ctx.db.get(s.pet.threadId)))?.claimedBy).toBe(s.owner.userId);

    const { outboxId } = await s.owner.as.mutation(api.corrections.send, { correctionId: c._id });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/messages/msg_pet/reply");
    expect(calls[0].body).toEqual({ text: "Our pet fee is now $40 per night." });
    const detail = await s.owner.as.query(api.threads.get, { threadId: s.pet.threadId });
    expect(detail.sentReplies.map((r) => r.kind)).toEqual(["reply", "correction"]);
    expect(detail.sentReplies[1]).toMatchObject({ correctionId: c._id, outboxId, textSource: "staff", simulated: false });
    expect(detail.claims.find((cl) => cl._id === s.pet.claimId)?.status).toBe("corrected");
    expect((await s.owner.as.query(api.corrections.list, { innId: s.innId }))[0].status).toBe("sent");
    expect(await s.owner.as.query(api.threads.stats, { innId: s.innId })).toMatchObject({ pendingCorrections: 0 });
    await expect(s.owner.as.mutation(api.corrections.send, { correctionId: c._id })).rejects.toThrow(/already_sent/);
    await expect(s.owner.as.mutation(api.corrections.setText, { correctionId: c._id, proposedText: "again" })).rejects.toThrow(/invalid/);
    expect(calls).toHaveLength(1);
  });

  it("a second change invalidates an earlier approval and a dismissed correction is re-evaluated", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await seedSentInn(t);
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    const [first] = await pending(t, s.owner, s.innId);
    await s.owner.as.mutation(api.threads.claim, { threadId: s.pet.threadId });
    await s.owner.as.mutation(api.corrections.review, { correctionId: first._id, decision: "approve", proposedText: "Fee is $40." });

    // The page changes again: the approval no longer describes the current page.
    const third = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V3 });
    expect(third.affected).toBe(1);
    const all = await s.owner.as.query(api.corrections.list, { innId: s.innId });
    const second = all.find((c) => c.status === "needs_review")!;
    expect(all.find((c) => c._id === first._id)).toMatchObject({ status: "superseded", supersededById: second._id, isCurrent: false });
    expect(second).toMatchObject({ claimId: s.pet.claimId, newVersionId: third.pageVersionId, proposedText: null });
    await expect(s.owner.as.mutation(api.corrections.send, { correctionId: first._id })).rejects.toThrow(/not_approved/);
    await expect(s.owner.as.mutation(api.corrections.review, { correctionId: first._id, decision: "approve" })).rejects.toThrow(/invalid/);

    // Dismissing does not silence future changes on the same claim.
    await s.owner.as.mutation(api.corrections.review, { correctionId: second._id, decision: "dismiss" });
    const fourth = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    expect(fourth.affected).toBe(1);
    const after = await s.owner.as.query(api.corrections.list, { innId: s.innId });
    expect(after.filter((c) => c.status === "needs_review")).toHaveLength(1);
    expect(after.find((c) => c._id === second._id)?.status).toBe("dismissed");

    // Restoring the original wording closes every open correction and heals the claim.
    const restored = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V1 + "\n" });
    expect(restored.affected).toBe(0);
    expect((await s.owner.as.query(api.corrections.list, { innId: s.innId })).filter((c) => c.status === "needs_review")).toEqual([]);
    const claim = await t.run((ctx) => ctx.db.get(s.pet.claimId));
    expect(claim).toMatchObject({ status: "ok", checkedAgainstVersionId: restored.pageVersionId });
  });

  it("approval and sends refuse stale sources, wrong claims, other tenants, and non-live members", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    const [c] = await pending(t, s.owner, s.innId);

    const stranger = await signedInUser(t, { name: "Stranger" });
    await expect(stranger.as.query(api.corrections.list, { innId: s.innId })).rejects.toThrow(/forbidden/);
    await expect(stranger.as.mutation(api.corrections.setText, { correctionId: c._id, proposedText: "x" })).rejects.toThrow(/forbidden/);
    await expect(stranger.as.mutation(api.corrections.send, { correctionId: c._id })).rejects.toThrow(/forbidden/);

    // A colleague holds the claim: the owner may neither approve nor send.
    const staff = await signedInUser(t, { name: "Staff" });
    await t.run((ctx) => ctx.db.insert("memberships", { innId: s.innId, userId: staff.userId, role: "staff", name: "Staff" }));
    await staff.as.mutation(api.threads.claim, { threadId: s.pet.threadId });
    await expect(s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve", proposedText: "x" })).rejects.toThrow(/claimed/);
    await staff.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve", proposedText: "Fee is now $40." });
    await expect(s.owner.as.mutation(api.corrections.send, { correctionId: c._id })).rejects.toThrow(/claimed/);

    // The page moves on before dispatch: reservation fails preflight, nothing is sent.
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "never" }))]);
    const { outboxId } = await staff.as.mutation(api.corrections.send, { correctionId: c._id });
    await t.run(async (ctx) => {
      const v = await ctx.db.insert("pageVersions", { pageId: s.pageId, markdown: V3, hash: "h3", scrapedAt: Date.now(), changeStatus: "changed" });
      await ctx.db.patch(s.pageId, { lastVersionId: v });
    });
    await t.action(internal.outbox.deliver, { outboxId });
    await settle(t);
    const [row] = await t.run((ctx) => ctx.db.query("outbox").collect());
    expect(row).toMatchObject({ status: "failed", errorKind: "precondition" });
    expect(row.errorMessage).toMatch(/changed again/);
    expect(calls).toEqual([]);
    await expect(staff.as.mutation(api.corrections.send, { correctionId: c._id })).rejects.toThrow(/stale_source/);

    // An anonymous member never gets live authority even with an approved correction.
    const anon = await signedInUser(t, { name: "Anon", isAnonymous: true });
    await t.run((ctx) => ctx.db.insert("memberships", { innId: s.innId, userId: anon.userId, role: "staff", name: "Anon" }));
    const t2 = makeTest();
    const s2 = await seedSentInn(t2);
    await s2.owner.as.mutation(api.pages.submitContent, { pageId: s2.pageId, markdown: V2 });
    const [c2] = await pending(t2, s2.owner, s2.innId);
    const anon2 = await signedInUser(t2, { name: "Anon", isAnonymous: true });
    await t2.run((ctx) => ctx.db.insert("memberships", { innId: s2.innId, userId: anon2.userId, role: "staff", name: "Anon" }));
    await anon2.as.mutation(api.threads.claim, { threadId: s2.pet.threadId });
    await anon2.as.mutation(api.corrections.review, { correctionId: c2._id, decision: "approve", proposedText: "Fee is now $40." });
    await expect(anon2.as.mutation(api.corrections.send, { correctionId: c2._id })).rejects.toThrow(/live_mail_forbidden/);
    expect(await t2.run((ctx) => ctx.db.query("outbox").collect())).toEqual([]);
  });

  it("unsent drafts and other pages never produce corrections", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await seedSentInn(t);
    // A ready (unsent) draft citing the same passage.
    const extra = await seedInboundThread(t, s.innId, { text: "Puppy?", providerMessageId: "msg_puppy" });
    await t.run(async (ctx) => {
      const draftId = await ctx.db.insert("drafts", { threadId: extra.threadId, replyToMessageId: extra.messageId, class: "answerable", answer: "a", abstain: false, status: "ready", model: "m", verifiedText: "a" });
      await ctx.db.insert("claims", { draftId, threadId: extra.threadId, innId: s.innId, statement: "s", pageId: s.pageId, pageVersionId: s.versionId, url: "u", quote: "$25 per night pet fee", verified: true, status: "ok" });
    });
    const r = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    expect(r.affected).toBe(1);
    const list = await s.owner.as.query(api.corrections.list, { innId: s.innId });
    expect(list).toHaveLength(1);
    expect(list[0].threadId).toBe(s.pet.threadId);
    // The unsent draft is simply blocked from sending until regenerated.
    await s.owner.as.mutation(api.threads.claim, { threadId: extra.threadId });
    const extraDraft = (await s.owner.as.query(api.threads.get, { threadId: extra.threadId })).draft!;
    await expect(s.owner.as.mutation(api.drafts.send, { draftId: extraDraft._id })).rejects.toThrow(/stale_source/);
  });
});
