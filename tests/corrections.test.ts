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

/** Both quoted passages change: the fee and the check-in time. */
const V4 = "# Policies\n\nDogs are welcome for a $40 per night pet fee.\n\nCheck-in is from 4:00 PM.\n";

type Seeded = Awaited<ReturnType<typeof seedSentInn>>;
type Ctx = Parameters<Parameters<T["run"]>[0]>[0];

/** One more verified page claim on an existing (already sent) draft. */
async function insertClaim(ctx: Ctx, s: Seeded, threadId: Id<"threads">, draftId: Id<"drafts">, quote: string) {
  return await ctx.db.insert("claims", {
    draftId,
    threadId,
    innId: s.innId,
    statement: quote,
    pageId: s.pageId,
    pageVersionId: s.versionId,
    url: "https://seagull.example/policies",
    quote,
    verified: true,
    verifyMethod: "strict",
    status: "ok",
  });
}

/** A further sent reply in an existing thread, with one claim per quote. */
async function seedReply(t: T, s: Seeded, threadId: Id<"threads">, messageId: Id<"messages">, answer: string, quotes: string[]) {
  return await t.run(async (ctx) => {
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
    const claimIds = [];
    for (const quote of quotes) claimIds.push(await insertClaim(ctx, s, threadId, draftId, quote));
    const sentReplyId = await ctx.db.insert("sentReplies", {
      threadId,
      innId: s.innId,
      draftId,
      sentBy: s.owner.userId,
      sentAt: Date.now(),
      kind: "reply",
      text: answer,
      textSource: "model",
      simulated: false,
    });
    return { draftId, claimIds, sentReplyId };
  });
}

const pending = (_t: T, owner: Awaited<ReturnType<typeof signedInUser>>, innId: Id<"inns">) =>
  owner.as.query(api.corrections.list, { innId, status: "needs_review" });

type Viewer = Awaited<ReturnType<typeof signedInUser>>;
type ControlPage = Awaited<ReturnType<typeof controlPage>>;
type ControlRow = ControlPage["page"][number];
type Control = Extract<ControlRow, { kind: "control" }>;

const controlPage = (viewer: Viewer, innId: Id<"inns">, cursor: string | null = null, numItems = 25) =>
  viewer.as.query(api.corrections.unaffectedControls, { innId, paginationOpts: { cursor, numItems } });

/** Every page of controls, walked cursor by cursor; the unchecked rows are returned apart. */
async function allControls(viewer: Viewer, innId: Id<"inns">, numItems = 25) {
  const controls: Control[] = [];
  const unchecked: Exclude<ControlRow, Control>[] = [];
  const pages: ControlPage[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: ControlPage = await controlPage(viewer, innId, cursor, numItems);
    pages.push(page);
    for (const row of page.page) {
      if (row.kind === "control") controls.push(row);
      else unchecked.push(row);
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
    if (pages.length > 100) throw new Error("controls never finished");
  }
  return { controls, unchecked, pages };
}

/** Control rows only, all pages; the shape the tests compared before pagination. */
const controlsOf = async (viewer: Viewer, innId: Id<"inns">) => (await allControls(viewer, innId)).controls;

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
    const controls = await controlsOf(s.owner, s.innId);
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

  it.each(["needs_staff_fact", "needs_availability_or_approval"] as const)(
    "a %s draft with a well-grounded quote is held for staff without judging or storing a proposal",
    async (cls) => {
      withEnv({ OPENAI_API_KEY: "sk-test" });
      const t = makeTest();
      const s = await seedSentInn(t);
      stubFetch(openaiRoutes({ draft: () => json(500, { error: "not yet" }) }));
      const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
      vi.unstubAllGlobals();
      let judgeCalls = 0;
      stubFetch(
        openaiRoutes({
          draft: () =>
            responsesOutput(
              draftOutput({
                class: cls,
                abstain: false,
                answer: "Update: our pet fee is now $40 per night pet fee, one dog per room.",
                claims: [{ statement: "fee is $40", url: "https://seagull.example/policies", quote: "$40 per night pet fee", sourceId: result.pageVersionId }],
              }),
            ),
          judge: () => {
            judgeCalls += 1;
            return responsesOutput(judgeOutput());
          },
        }),
      );
      await t.action(internal.corrections.generateProposal, { correctionId: (await pending(t, s.owner, s.innId))[0]._id });
      expect(judgeCalls).toBe(0);
      const [c] = await pending(t, s.owner, s.innId);
      expect(c).toMatchObject({ status: "needs_review", proposedText: null, evidenceQuote: null, judgeVerdict: null });
      expect(c.statusReason).toContain(cls);
      await s.owner.as.mutation(api.threads.claim, { threadId: s.pet.threadId });
      await expect(s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve" })).rejects.toThrow(/needs text before approval/);
      expect((await pending(t, s.owner, s.innId))[0].status).toBe("needs_review");
      expect(await t.run((ctx) => ctx.db.query("outbox").collect())).toEqual([]);
    },
  );

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

  it("review counts are per sent reply: two changed passages in one reply share one sentReplyId, a second reply in the same thread keeps its own", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await seedSentInn(t);
    // The pet thread gets a second reply that also quotes check-in, and the
    // first reply gains a check-in claim: one thread, two sent replies.
    const petCheckin = await t.run((ctx) => insertClaim(ctx, s, s.pet.threadId, s.pet.draftId, "Check-in is from 3:00 PM."));
    const later = await seedReply(t, s, s.pet.threadId, s.pet.messageId, "Check-in is from 3:00 PM.", ["Check-in is from 3:00 PM."]);
    expect(later.sentReplyId).not.toBe(s.pet.sentReplyId);

    const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V4 });
    // Four claims changed (fee + three check-ins) across three replies.
    expect(result).toMatchObject({ affected: 4, unaffected: 0, affectedReplies: 3, unaffectedReplies: 0 });
    const open = await pending(t, s.owner, s.innId);
    expect(open).toHaveLength(4);
    const byReply = new Map<string, Id<"claims">[]>();
    for (const c of open) byReply.set(c.sentReplyId, [...(byReply.get(c.sentReplyId) ?? []), c.claimId]);
    expect(byReply.size).toBe(3);
    expect(byReply.get(s.pet.sentReplyId)?.sort()).toEqual([s.pet.claimId, petCheckin].sort());
    expect(byReply.get(later.sentReplyId)).toEqual([later.claimIds[0]]);
    expect(byReply.get(s.checkin.sentReplyId)).toEqual([s.checkin.claimId]);
    // Both replies of the pet thread carry the same thread id: counting threads would report 2, not 3.
    expect(new Set(open.map((c) => c.threadId)).size).toBe(2);
    expect(await controlsOf(s.owner, s.innId)).toEqual([]);
  });

  it("a sent reply with one vanished and one surviving quote is affected only, never a control, until every affected claim is corrected or restored", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    const petCheckin = await t.run((ctx) => insertClaim(ctx, s, s.pet.threadId, s.pet.draftId, "Check-in is from 3:00 PM."));
    const later = await seedReply(t, s, s.pet.threadId, s.pet.messageId, "Check-in is from 3:00 PM.", ["Check-in is from 3:00 PM."]);
    const controlsNow = async () => {
      const controls = await controlsOf(s.owner, s.innId);
      return { controls, replies: new Set(controls.map((c) => c.sentReplyId)) };
    };

    const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    // The first pet reply lost the fee but kept check-in: one affected reply, two control replies.
    expect(result).toMatchObject({ affected: 1, unaffected: 3, affectedReplies: 1, unaffectedReplies: 2 });
    const [c] = await pending(t, s.owner, s.innId);
    expect(c.sentReplyId).toBe(s.pet.sentReplyId);
    let { controls, replies } = await controlsNow();
    // The surviving check-in claim of the affected reply is not a control row: its reply is under review.
    expect(controls.map((x) => x.claimId)).not.toContain(petCheckin);
    expect(controls.map((x) => x.claimId).sort()).toEqual([later.claimIds[0], s.checkin.claimId].sort());
    expect([...replies].sort()).toEqual([later.sentReplyId, s.checkin.sentReplyId].sort());
    // The later reply of the same thread is a control with its own id, so the
    // thread appears on both sides only through distinct replies.
    expect(controls.find((x) => x.threadId === s.pet.threadId)?.sentReplyId).toBe(later.sentReplyId);
    // Version checks and quotes are unchanged by the reply-level contract.
    for (const x of controls) expect(x.quote).toBe("Check-in is from 3:00 PM.");
    const claims = await t.run((ctx) => ctx.db.query("claims").collect());
    for (const id of [petCheckin, later.claimIds[0], s.checkin.claimId]) {
      expect(claims.find((k) => k._id === id)).toMatchObject({ status: "ok", checkedAgainstVersionId: result.pageVersionId });
    }

    // Approved but unsent: the claim is still needs_review, so the reply stays out of the controls.
    await s.owner.as.mutation(api.threads.claim, { threadId: s.pet.threadId });
    await s.owner.as.mutation(api.corrections.setText, { correctionId: c._id, proposedText: "Our pet fee is now $40 per night.", evidenceQuote: "$40 per night pet fee" });
    await s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve" });
    ({ controls, replies } = await controlsNow());
    expect(replies.has(s.pet.sentReplyId)).toBe(false);
    expect(replies.size).toBe(2);

    // Sent: the claim is corrected against the current version, so the whole
    // reply is a control again, listed under its ORIGINAL sent reply id (the
    // corrective email is not a new control).
    const { calls } = stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_corr_out" }))]);
    await s.owner.as.mutation(api.corrections.send, { correctionId: c._id });
    await settle(t);
    expect(calls).toHaveLength(1);
    const detail = await s.owner.as.query(api.threads.get, { threadId: s.pet.threadId });
    const corrective = detail.sentReplies.find((r) => r.kind === "correction")!;
    expect(corrective).toBeDefined();
    ({ controls, replies } = await controlsNow());
    expect([...replies].sort()).toEqual([s.pet.sentReplyId, later.sentReplyId, s.checkin.sentReplyId].sort());
    expect(replies.has(corrective._id)).toBe(false);
    const petRows = controls.filter((x) => x.sentReplyId === s.pet.sentReplyId);
    expect(petRows.map((x) => x.claimId).sort()).toEqual([s.pet.claimId, petCheckin].sort());
    expect(petRows.find((x) => x.claimId === s.pet.claimId)?.quote).toBe("$40 per night pet fee");
    expect(petRows.find((x) => x.claimId === petCheckin)?.quote).toBe("Check-in is from 3:00 PM.");
    expect(await pending(t, s.owner, s.innId)).toEqual([]);
  });

  it("a dismissed correction keeps its reply out of the controls until the passage is restored", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await seedSentInn(t);
    const petCheckin = await t.run((ctx) => insertClaim(ctx, s, s.pet.threadId, s.pet.draftId, "Check-in is from 3:00 PM."));
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    const [c] = await pending(t, s.owner, s.innId);
    await s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "dismiss" });
    expect(await pending(t, s.owner, s.innId)).toEqual([]);
    let controls = await controlsOf(s.owner, s.innId);
    // Dismissing resolves nothing about the claim: the reply is neither under review nor "still true".
    expect(controls.map((x) => x.sentReplyId)).toEqual([s.checkin.sentReplyId]);
    expect(controls.map((x) => x.claimId)).not.toContain(petCheckin);

    const restored = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V1 + "\n" });
    expect(restored).toMatchObject({ affected: 0, unaffected: 3, affectedReplies: 0, unaffectedReplies: 2 });
    controls = await controlsOf(s.owner, s.innId);
    expect(new Set(controls.map((x) => x.sentReplyId))).toEqual(new Set([s.pet.sentReplyId, s.checkin.sentReplyId]));
    expect(controls.filter((x) => x.sentReplyId === s.pet.sentReplyId).map((x) => x.claimId).sort()).toEqual([s.pet.claimId, petCheckin].sort());
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

describe("unaffected controls are paged over sent replies", () => {
  /** `n` further threads, each with its own sent reply quoting the untouched check-in line. */
  async function seedControlReplies(t: T, s: Seeded, n: number) {
    const ids: Id<"sentReplies">[] = [];
    for (let i = 0; i < n; i++) {
      const thread = await seedInboundThread(t, s.innId, { text: `Arrival ${i}?`, providerMessageId: `msg_arrival_${i}` });
      const reply = await seedReply(t, s, thread.threadId, thread.messageId, "Check-in is from 3:00 PM.", ["Check-in is from 3:00 PM."]);
      ids.push(reply.sentReplyId);
    }
    return ids;
  }

  it("walks unique replies page by page, caps a page at 25 replies, and keeps the affected reply off every page", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await seedSentInn(t);
    // 29 sent replies: the pet reply (affected once the fee changes), the
    // seeded check-in control and 27 more controls, each in its own thread.
    const extra = await seedControlReplies(t, s, 27);
    const expected = [s.checkin.sentReplyId, ...extra].sort();
    const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    expect(result).toMatchObject({ affected: 1, unaffected: 28, affectedReplies: 1, unaffectedReplies: 28 });

    // Asking for everything at once still yields a page of at most 25 replies.
    const greedy = await allControls(s.owner, s.innId, 500);
    expect(greedy.pages).toHaveLength(2);
    expect(greedy.pages[0].isDone).toBe(false);
    expect(new Set(greedy.pages[0].page.map((r) => r.sentReplyId)).size).toBe(25);
    expect(greedy.pages[1].isDone).toBe(true);
    expect(greedy.unchecked).toEqual([]);
    expect(greedy.controls.map((c) => c.sentReplyId).sort()).toEqual(expected);
    expect(new Set(greedy.controls.map((c) => c.claimId)).size).toBe(28);
    expect(greedy.controls.some((c) => c.sentReplyId === s.pet.sentReplyId)).toBe(false);

    // Smaller pages: 10 + 10 + 9 replies, the last page reported done; the
    // affected pet reply is the oldest, so it sits on the last page and is
    // still excluded there, and no reply repeats across pages.
    const small = await allControls(s.owner, s.innId, 10);
    expect(small.pages.map((p) => p.isDone)).toEqual([false, false, true]);
    const perPage = small.pages.map((p) => new Set(p.page.map((r) => r.sentReplyId)));
    expect(perPage.map((ids) => ids.size)).toEqual([10, 10, 8]);
    expect(perPage.every((ids) => ids.size <= 10)).toBe(true);
    const seen = new Set<string>();
    for (const ids of perPage) {
      for (const id of ids) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect([...seen].sort()).toEqual(expected);
    for (const c of small.controls) expect(c.quote).toBe("Check-in is from 3:00 PM.");
    // A page is a fresh read: the same cursor returns the same replies.
    const again = await controlPage(s.owner, s.innId, small.pages[0].continueCursor, 10);
    expect(new Set(again.page.map((r) => r.sentReplyId))).toEqual(perPage[1]);
  });

  it("a page that holds only affected replies is empty but not done, and a corrected reply returns under its original id on its own page", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    // Two more pet-fee replies (newest) plus the two seeded ones: page 1 of 2
    // replies holds only affected replies, the older controls follow.
    const dog2 = await seedInboundThread(t, s.innId, { text: "Two dogs?", providerMessageId: "msg_dog2" });
    const dog3 = await seedInboundThread(t, s.innId, { text: "Puppy?", providerMessageId: "msg_dog3" });
    const r2 = await seedReply(t, s, dog2.threadId, dog2.messageId, "Dogs are welcome for a $25 per night pet fee.", ["$25 per night pet fee"]);
    const r3 = await seedReply(t, s, dog3.threadId, dog3.messageId, "Dogs are welcome for a $25 per night pet fee.", ["$25 per night pet fee"]);
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });

    const first = await controlPage(s.owner, s.innId, null, 2);
    expect(first).toMatchObject({ page: [], isDone: false });
    const second = await controlPage(s.owner, s.innId, first.continueCursor, 2);
    expect(second.page.map((r) => r.sentReplyId)).toEqual([s.checkin.sentReplyId]);
    const before = await allControls(s.owner, s.innId, 2);
    expect(before.pages.at(-1)?.isDone).toBe(true);
    expect(before.controls.map((x) => x.sentReplyId)).toEqual([s.checkin.sentReplyId]);

    // Correct the newest reply: its corrective email is a fourth sent reply of
    // the inn (newest of all), yet the control appears once, under r3's id.
    const open = await pending(t, s.owner, s.innId);
    const c = open.find((x) => x.sentReplyId === r3.sentReplyId)!;
    await s.owner.as.mutation(api.threads.claim, { threadId: dog3.threadId });
    await s.owner.as.mutation(api.corrections.setText, { correctionId: c._id, proposedText: "Our pet fee is now $40 per night.", evidenceQuote: "$40 per night pet fee" });
    await s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve" });
    stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_corr_out" }))]);
    await s.owner.as.mutation(api.corrections.send, { correctionId: c._id });
    await settle(t);
    const corrective = (await s.owner.as.query(api.threads.get, { threadId: dog3.threadId })).sentReplies.find((r) => r.kind === "correction")!;
    // Newest first: [corrective, r3] → r3; [r2, checkin] → checkin; [pet] → nothing.
    const walked = await allControls(s.owner, s.innId, 2);
    expect(walked.pages.map((p) => p.page.map((r) => r.sentReplyId)).filter((ids) => ids.length > 0)).toEqual([[r3.sentReplyId], [s.checkin.sentReplyId]]);
    expect(walked.pages.slice(0, -1).every((p) => !p.isDone) && walked.pages.at(-1)?.isDone).toBe(true);
    expect(walked.controls.map((x) => x.sentReplyId)).not.toContain(corrective._id);
    expect(walked.controls.map((x) => x.sentReplyId)).not.toContain(r2.sentReplyId);
    expect(walked.controls.find((x) => x.sentReplyId === r3.sentReplyId)?.quote).toBe("$40 per night pet fee");
  });

  it("a draft with more claims than one query reads is reported unchecked, never asserted still true", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await seedSentInn(t);
    // 51 claims on the check-in draft, every one still verifiable after the change.
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) await insertClaim(ctx, s, s.checkin.threadId, s.checkin.draftId, "Check-in is from 3:00 PM.");
    });
    const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    expect(result).toMatchObject({ affected: 1, unaffected: 51, affectedReplies: 1, unaffectedReplies: 1 });
    const { controls, unchecked, pages } = await allControls(s.owner, s.innId);
    expect(pages).toHaveLength(1);
    expect(controls).toEqual([]);
    expect(unchecked).toEqual([{ kind: "unchecked", threadId: s.checkin.threadId, sentReplyId: s.checkin.sentReplyId, subject: "Dog?" }]);
    // The affected pet reply is on neither list.
    expect(pages[0].page.some((r) => r.sentReplyId === s.pet.sentReplyId)).toBe(false);
  });

  /** Sends a staff correction for the open proposal of `threadId` and returns its id. */
  async function sendCorrection(t: T, s: Seeded, threadId: Id<"threads">, evidenceQuote: string) {
    const c = (await pending(t, s.owner, s.innId)).find((x) => x.threadId === threadId)!;
    await s.owner.as.mutation(api.threads.claim, { threadId });
    await s.owner.as.mutation(api.corrections.setText, { correctionId: c._id, proposedText: "Our pet fee is now $40 per night.", evidenceQuote });
    await s.owner.as.mutation(api.corrections.review, { correctionId: c._id, decision: "approve" });
    await s.owner.as.mutation(api.corrections.send, { correctionId: c._id });
    await settle(t);
    return c._id;
  }

  /** `n` further closed correction rows on a claim: history the query must read before it can name the latest sent one. */
  async function padHistory(t: T, correctionId: Id<"corrections">, n: number) {
    await t.run(async (ctx) => {
      const c = (await ctx.db.get(correctionId))!;
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("corrections", {
          innId: c.innId,
          sentReplyId: c.sentReplyId,
          threadId: c.threadId,
          claimId: c.claimId,
          pageId: c.pageId,
          oldVersionId: c.oldVersionId,
          newVersionId: c.newVersionId,
          oldQuote: c.oldQuote,
          status: "superseded",
        });
      }
    });
  }

  it("a corrected claim with more correction history than one query reads is unchecked, never shown with a stale or guessed quote", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    const petCheckin = await t.run((ctx) => insertClaim(ctx, s, s.pet.threadId, s.pet.draftId, "Check-in is from 3:00 PM."));
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    stubFetch([agentmailReplyRoute(() => json(200, { message_id: "msg_corr_out" }))]);
    const sent = await sendCorrection(t, s, s.pet.threadId, "$40 per night pet fee");

    // Within budget: the corrected reply is a control on the sent evidence, its untouched claim beside it.
    await padHistory(t,sent, 19);
    let walked = await allControls(s.owner, s.innId);
    expect(walked.unchecked).toEqual([]);
    expect(walked.controls.find((x) => x.claimId === s.pet.claimId)?.quote).toBe("$40 per night pet fee");
    expect(walked.controls.map((x) => x.claimId).sort()).toEqual([s.pet.claimId, petCheckin, s.checkin.claimId].sort());

    // One row over the per-claim budget: the whole reply is unchecked, no partial rows, the other reply unaffected.
    await padHistory(t,sent, 1);
    walked = await allControls(s.owner, s.innId);
    expect(walked.pages).toHaveLength(1);
    expect(walked.pages[0].isDone).toBe(true);
    expect(walked.unchecked).toEqual([{ kind: "unchecked", threadId: s.pet.threadId, sentReplyId: s.pet.sentReplyId, subject: "Dog?" }]);
    expect(walked.controls.map((x) => x.claimId)).toEqual([s.checkin.claimId]);
    expect(walked.controls.map((x) => x.sentReplyId)).not.toContain(s.pet.sentReplyId);
  });

  it("delivery order still picks the evidence within budget, and the per-call budget turns later corrected replies unchecked instead of scanning on", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    // 21 corrected replies (the pet reply + 20 more), each with 20 rows of history: 420 rows, over the 400 a call reads.
    const threads = [s.pet];
    for (let i = 0; i < 20; i++) {
      const thread = await seedInboundThread(t, s.innId, { text: `Dog ${i}?`, providerMessageId: `msg_dog_${i}` });
      const reply = await seedReply(t, s, thread.threadId, thread.messageId, "Dogs are welcome for a $25 per night pet fee.", ["$25 per night pet fee"]);
      threads.push({ ...thread, ...reply, claimId: reply.claimIds[0] });
    }
    const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    // Mark every proposal sent and every claim corrected against the new version
    // directly (a real send adds a corrective reply per thread, which would push
    // the walk onto a second page and reset its budget).
    const sentIds: Id<"corrections">[] = [];
    for (const th of threads) {
      const c = (await pending(t, s.owner, s.innId)).find((x) => x.threadId === th.threadId)!;
      sentIds.push(c._id);
      await t.run(async (ctx) => {
        await ctx.db.patch(c._id, { status: "sent", evidenceQuote: "$40 per night pet fee", proposedText: "Fee is $40." });
        await ctx.db.patch(th.claimId, { status: "corrected", checkedAgainstVersionId: result.pageVersionId });
      });
    }
    // The pet claim's sent correction was delivered late; a later-proposed one was
    // delivered first: the guest last heard "$40", so that is the evidence.
    await t.run(async (ctx) => {
      const c = (await ctx.db.get(sentIds[0]))!;
      const corrective = (sentAt: number) =>
        ctx.db.insert("sentReplies", {
          threadId: c.threadId,
          innId: c.innId,
          draftId: s.pet.draftId,
          sentBy: s.owner.userId,
          sentAt,
          kind: "correction",
          text: "correction",
          textSource: "staff",
          simulated: false,
        });
      await ctx.db.patch(c._id, { sentReplyIdForCorrection: await corrective(Date.now() + 60_000) });
      await ctx.db.insert("corrections", {
        innId: c.innId,
        sentReplyId: c.sentReplyId,
        threadId: c.threadId,
        claimId: c.claimId,
        pageId: c.pageId,
        oldVersionId: c.oldVersionId,
        newVersionId: c.newVersionId,
        oldQuote: c.oldQuote,
        status: "sent",
        evidenceQuote: "Check-in is from 3:00 PM.",
        sentReplyIdForCorrection: await corrective(1),
      });
    });
    let walked = await allControls(s.owner, s.innId);
    expect(walked.pages).toHaveLength(1);
    expect(walked.unchecked).toEqual([]);
    const corrected = walked.controls.filter((x) => x.quote === "$40 per night pet fee");
    expect(corrected.map((x) => x.sentReplyId).sort()).toEqual(threads.map((th) => th.sentReplyId).sort());
    expect(walked.controls.find((x) => x.claimId === s.pet.claimId)?.quote).toBe("$40 per night pet fee");

    // Each claim stays within its own budget (20 rows), yet together they exceed the
    // call's 400: the pet reply, oldest and read last, is unchecked, never a control.
    await padHistory(t,sentIds[0], 17);
    for (const id of sentIds.slice(1)) await padHistory(t,id, 19);
    walked = await allControls(s.owner, s.innId);
    expect(walked.pages).toHaveLength(1);
    expect(walked.pages[0].isDone).toBe(true);
    expect(walked.unchecked).toEqual([{ kind: "unchecked", threadId: s.pet.threadId, sentReplyId: s.pet.sentReplyId, subject: "Dog?" }]);
    expect(walked.controls.map((x) => x.sentReplyId)).not.toContain(s.pet.sentReplyId);
    expect(new Set(walked.controls.map((x) => x.sentReplyId)).size).toBe(threads.length);
    expect(walked.controls.map((x) => x.sentReplyId)).toContain(s.checkin.sentReplyId);
    for (const x of walked.controls) expect(["$40 per night pet fee", "Check-in is from 3:00 PM."]).toContain(x.quote);
  });

  it("an oversized correction history is charged to the call budget, lookahead row included, never read for free", async () => {
    withEnv({ OPENAI_API_KEY: undefined, AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const s = await seedSentInn(t);
    const threads = [s.pet];
    for (let i = 0; i < 20; i++) {
      const thread = await seedInboundThread(t, s.innId, { text: `Dog ${i}?`, providerMessageId: `msg_dog_${i}` });
      const reply = await seedReply(t, s, thread.threadId, thread.messageId, "Dogs are welcome for a $25 per night pet fee.", ["$25 per night pet fee"]);
      threads.push({ ...thread, ...reply, claimId: reply.claimIds[0] });
    }
    const result = await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    const sentIds: Id<"corrections">[] = [];
    for (const th of threads) {
      const c = (await pending(t, s.owner, s.innId)).find((x) => x.threadId === th.threadId)!;
      sentIds.push(c._id);
      await t.run(async (ctx) => {
        await ctx.db.patch(c._id, { status: "sent", evidenceQuote: "$40 per night pet fee", proposedText: "Fee is $40." });
        await ctx.db.patch(th.claimId, { status: "corrected", checkedAgainstVersionId: result.pageVersionId });
      });
    }
    // Newest reply (read first): 21 rows, one over its per-claim budget. It is
    // unchecked and its 21 rows, lookahead included, are charged to the call.
    // The next 19 replies read 19 rows each (361), leaving 18 of the 400; the
    // pet reply, oldest and read last, holds 19 rows, so it is unchecked too.
    // Were the overflow a free read, 39 rows would remain and the pet reply
    // would be listed as a control.
    const newest = threads[threads.length - 1];
    await padHistory(t, sentIds[sentIds.length - 1], 20);
    for (const id of sentIds.slice(1, -1)) await padHistory(t, id, 18);
    await padHistory(t, sentIds[0], 18);
    const walked = await allControls(s.owner, s.innId);
    expect(walked.pages).toHaveLength(1);
    expect(walked.pages[0].isDone).toBe(true);
    expect(walked.unchecked).toEqual([
      { kind: "unchecked", threadId: newest.threadId, sentReplyId: newest.sentReplyId, subject: "Dog?" },
      { kind: "unchecked", threadId: s.pet.threadId, sentReplyId: s.pet.sentReplyId, subject: "Dog?" },
    ]);
    expect(walked.controls.map((x) => x.sentReplyId)).not.toContain(newest.sentReplyId);
    expect(walked.controls.map((x) => x.sentReplyId)).not.toContain(s.pet.sentReplyId);
    expect(new Set(walked.controls.map((x) => x.sentReplyId)).size).toBe(threads.length - 1);
    expect(walked.controls.map((x) => x.sentReplyId)).toContain(s.checkin.sentReplyId);
  });

  it("pages never cross inns and strangers get nothing", async () => {
    withEnv({ OPENAI_API_KEY: undefined });
    const t = makeTest();
    const s = await seedSentInn(t);
    const other = await signedInUser(t, { name: "Other" });
    const otherInn = await seedLiveInn(t, other.userId, { markdown: V1, inboxId: "gull@agentmail.to" });
    const otherThread = await seedInboundThread(t, otherInn.innId, { text: "Check-in?", providerMessageId: "msg_other_checkin" });
    const otherReply = await seedReply(
      t,
      { ...s, innId: otherInn.innId, pageId: otherInn.pageId, versionId: otherInn.versionId, owner: other },
      otherThread.threadId,
      otherThread.messageId,
      "Check-in is from 3:00 PM.",
      ["Check-in is from 3:00 PM."],
    );
    await s.owner.as.mutation(api.pages.submitContent, { pageId: s.pageId, markdown: V2 });
    await other.as.mutation(api.pages.submitContent, { pageId: otherInn.pageId, markdown: V2 });

    expect((await controlsOf(s.owner, s.innId)).map((c) => c.sentReplyId)).toEqual([s.checkin.sentReplyId]);
    expect((await controlsOf(other, otherInn.innId)).map((c) => c.sentReplyId)).toEqual([otherReply.sentReplyId]);
    await expect(controlPage(s.owner, otherInn.innId)).rejects.toThrow(/forbidden/);
    await expect(controlPage(other, s.innId)).rejects.toThrow(/forbidden/);
    const stranger = await signedInUser(t, { name: "Stranger" });
    await expect(controlPage(stranger, s.innId)).rejects.toThrow(/forbidden/);
  });
});
