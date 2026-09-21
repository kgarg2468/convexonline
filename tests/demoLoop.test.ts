import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { makeTest, seedInn, signedInUser } from "./setup";
import { stubFetch, withEnv } from "./integrationSetup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("demo loop (no providers, no live mail)", () => {
  it("gap → staff fact → verified draft → simulated send, without a single provider call", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test", AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const { calls } = stubFetch([]);
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    const [gap] = await visitor.as.query(api.threads.queue, { innId, status: "needs_staff" });
    const before = await visitor.as.query(api.threads.get, { threadId: gap._id });
    expect(before.draft?.gapQuestion).toBeTruthy();

    await visitor.as.mutation(api.facts.add, {
      innId,
      threadId: gap._id,
      question: before.draft!.gapQuestion!,
      answer: "The hot tub is open year-round from 8am to 10pm.",
      scope: "general",
    });
    const drafted = await visitor.as.query(api.threads.get, { threadId: gap._id });
    expect(drafted.draft).toMatchObject({ status: "ready", textSource: "fixture" });
    expect(drafted.claims[0]).toMatchObject({ source: "fact", status: "ok", currentSource: true });
    const factId = drafted.claims[0].staffFactId!;

    // Same guards as live: unclaimed → refused; live send → never for demo data.
    await expect(visitor.as.mutation(api.demo.simulateSend, { draftId: drafted.draft!._id })).rejects.toThrow(/claimed/);
    await visitor.as.mutation(api.threads.claim, { threadId: gap._id });
    await expect(visitor.as.mutation(api.drafts.send, { draftId: drafted.draft!._id })).rejects.toThrow(/live_mail_forbidden/);

    const { outboxId, sentReplyId } = await visitor.as.mutation(api.demo.simulateSend, { draftId: drafted.draft!._id });
    const after = await visitor.as.query(api.threads.get, { threadId: gap._id });
    expect(after.thread.status).toBe("waiting_guest");
    expect(after.draft?.status).toBe("sent");
    expect(after.sentReplies[0]).toMatchObject({ _id: sentReplyId, outboxId, simulated: true, textSource: "fixture", text: drafted.draft!.answer });
    expect(after.outbox[0]).toMatchObject({ status: "sent", simulated: true });
    expect(after.messages.at(-1)).toMatchObject({ direction: "out", text: drafted.draft!.answer });
    await expect(visitor.as.mutation(api.demo.simulateSend, { draftId: drafted.draft!._id })).rejects.toThrow(/already_sent/);

    // A superseding fact makes the cited fact stale and blocks the next draft's send until regenerated.
    const [other] = await visitor.as.query(api.threads.queue, { innId, status: "ready" });
    const otherDetail = await visitor.as.query(api.threads.get, { threadId: other._id });
    expect(otherDetail.draft?.textSource).toBe("fixture");
    await t.run((ctx) => ctx.db.patch(factId, { supersededBy: factId }));
    expect((await visitor.as.query(api.threads.get, { threadId: gap._id })).claims[0].currentSource).toBe(false);

    expect(calls).toEqual([]);
    const stats = await visitor.as.query(api.threads.stats, { innId });
    expect(stats.sentTotal).toBe(7);
    expect(stats.sentToday).toBeGreaterThanOrEqual(1);
  });

  it("the review path: one fee change → 3 affected, 3 controls, fixture proposals sent through the same guards", async () => {
    withEnv({ OPENAI_API_KEY: "sk-test", AGENTMAIL_API_KEY: "am-test" });
    const t = makeTest();
    const { calls } = stubFetch([]);
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    const initial = await visitor.as.query(api.demo.status, { innId });
    expect(initial).toMatchObject({ policyVersion: "original", sentReplies: 6, affectedReplies: 0, unaffectedReplies: 0, pendingCorrections: 0 });

    const change = await visitor.as.mutation(api.demo.changePolicyPage, { innId });
    expect(change).toMatchObject({ changeStatus: "changed", affected: 3, affectedReplies: 3, unaffectedReplies: 3 });
    const proposals = await visitor.as.query(api.corrections.list, { innId, status: "needs_review" });
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.textSource).toBe("fixture");
      expect(p.evidenceQuote).toContain("$40 per night pet fee");
      expect(p.proposedText).toContain("$40");
      expect(p.isCurrent).toBe(true);
      expect(p.oldQuote).toContain("$25");
    }
    expect(new Set(proposals.map((p) => p.threadId)).size).toBe(3);
    // Paginated contract: the demo inn's six replies fit one page, and every row is a control.
    const controlPage = await visitor.as.query(api.corrections.unaffectedControls, { innId, paginationOpts: { cursor: null, numItems: 25 } });
    expect(controlPage.isDone).toBe(true);
    const controls = controlPage.page.filter((c) => c.kind === "control");
    expect(controls).toHaveLength(controlPage.page.length);
    // Controls are listed per claim; three distinct sent replies cite unchanged passages.
    expect(new Set(controls.map((c) => c.threadId)).size).toBe(3);
    expect(controls.every((c) => !c.quote.includes("$25"))).toBe(true);

    // Approve and simulate-send one; the others stay pending; live send is refused.
    const [first, second, third] = proposals;
    await expect(visitor.as.mutation(api.demo.simulateCorrectionSend, { correctionId: first._id })).rejects.toThrow(/claimed|not_approved/);
    await visitor.as.mutation(api.corrections.review, { correctionId: first._id, decision: "approve" });
    await expect(visitor.as.mutation(api.corrections.send, { correctionId: first._id })).rejects.toThrow(/live_mail_forbidden/);
    const sent = await visitor.as.mutation(api.demo.simulateCorrectionSend, { correctionId: first._id });
    const thread = await visitor.as.query(api.threads.get, { threadId: first.threadId });
    expect(thread.sentReplies.find((r) => r.kind === "correction")).toMatchObject({ _id: sent.sentReplyId, simulated: true, textSource: "fixture", text: first.proposedText });
    expect(thread.claims.find((c) => c._id === first.claimId)?.status).toBe("corrected");
    await expect(visitor.as.mutation(api.demo.simulateCorrectionSend, { correctionId: first._id })).rejects.toThrow(/already_sent/);

    // Dismiss one, leave one pending; status reflects real counts.
    await visitor.as.mutation(api.corrections.review, { correctionId: second._id, decision: "dismiss" });
    const status = await visitor.as.query(api.demo.status, { innId });
    expect(status).toMatchObject({ policyVersion: "changed", affectedReplies: 3, unaffectedReplies: 3, pendingCorrections: 1, approvedCorrections: 0, sentCorrections: 1 });
    expect(await visitor.as.query(api.threads.stats, { innId })).toMatchObject({ pendingCorrections: 1 });

    // Toggling the page back restores the wording: the pending proposal closes, the corrected claim stays corrected.
    const back = await visitor.as.mutation(api.demo.changePolicyPage, { innId });
    expect(back.changeStatus).toBe("changed");
    const afterBack = await visitor.as.query(api.corrections.list, { innId });
    expect(afterBack.find((c) => c._id === third._id)?.status).toBe("superseded");
    expect(afterBack.find((c) => c._id === first._id)?.status).toBe("sent");
    expect((await visitor.as.query(api.demo.status, { innId }))?.policyVersion).toBe("original");
    expect(calls).toEqual([]);
  });

  it("simulated inbound answers from fixtures or opens a gap; simulated operations are demo-only", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    const { threadId } = await visitor.as.mutation(api.demo.simulateInbound, { innId, guestEmail: "New@Example.com", subject: "Puppy", text: "Can I bring my puppy in October?" });
    let d = await visitor.as.query(api.threads.get, { threadId });
    expect(d.thread.status).toBe("ready");
    expect(d.thread.guestEmail).toBe("new@example.com");
    expect(d.draft).toMatchObject({ status: "ready", textSource: "fixture" });
    expect(d.claims[0]).toMatchObject({ source: "page", status: "ok", verified: true, currentSource: true });
    const found = await visitor.as.query(api.threads.search, { innId, text: "puppy" });
    expect(found.some((r) => r._id === threadId)).toBe(true);

    const gap = await visitor.as.mutation(api.demo.simulateInbound, { innId, guestEmail: "g@example.com", subject: "Parking", text: "Do you have EV charging?" });
    d = await visitor.as.query(api.threads.get, { threadId: gap.threadId });
    expect(d.thread.status).toBe("needs_staff");
    expect(d.draft).toMatchObject({ status: "needs_edit", abstain: true });
    expect(d.draft?.gapQuestion).toContain("EV charging");
    await expect(visitor.as.mutation(api.demo.simulateInbound, { innId, guestEmail: "g@example.com", subject: "x", text: "  " })).rejects.toThrow(/invalid/);

    const staff = await signedInUser(t, { name: "Staff", email: "s@example.com" });
    const realInn = await seedInn(t, staff.userId);
    await expect(staff.as.mutation(api.demo.simulateInbound, { innId: realInn, guestEmail: "g@example.com", subject: "x", text: "hi" })).rejects.toThrow(/forbidden/);
    const stranger = await signedInUser(t, { name: "Other", isAnonymous: true });
    await expect(stranger.as.mutation(api.demo.simulateSend, { draftId: d.draft!._id })).rejects.toThrow(/forbidden/);
  });
});
