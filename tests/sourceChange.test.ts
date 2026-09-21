import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeTest, signedInUser } from "./setup";

describe("source change re-verification", () => {
  it("flags sent claims whose quote vanished and leaves controls untouched", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});

    const before = await visitor.as.query(api.corrections.list, { innId });
    expect(before).toEqual([]);

    const result = await visitor.as.mutation(api.demo.changePolicyPage, { innId });
    expect(result.changeStatus).toBe("changed");
    // Only the pet fee moved ($25 → $40): three sent replies cited it, three sent
    // replies cite passages of the same page that did not change.
    expect(result.affected).toBe(3);
    expect(result.affectedReplies).toBe(3);
    expect(result.unaffectedReplies).toBe(3);
    expect(result.unaffected).toBeGreaterThanOrEqual(3);
    const status = await visitor.as.query(api.demo.status, { innId });
    expect(status).toMatchObject({ policyVersion: "changed", affectedReplies: 3, unaffectedReplies: 3, pendingCorrections: 3 });

    const corrections = await visitor.as.query(api.corrections.list, { innId, status: "needs_review" });
    expect(corrections).toHaveLength(result.affected);
    for (const c of corrections) {
      expect(c.oldQuote.length).toBeGreaterThan(0);
      expect(c.pageUrl).toMatch(/\/policies$/);
    }
    const petFee = corrections.find((c) => c.oldQuote.includes("$25 per night pet fee"));
    expect(petFee?.newPassage).toContain("$40 per night pet fee");
    // Fixture proposals are labelled as such and rest on a passage of the new version.
    expect(petFee?.textSource).toBe("fixture");
    expect(petFee?.proposedText).toContain("$40 per night pet fee");
    expect(petFee?.evidenceQuote).toContain("$40 per night pet fee");
    expect(petFee?.isCurrent).toBe(true);
    // Check-in did not change: the late-arrival reply is a control, not a correction.
    expect(corrections.some((c) => c.oldQuote.includes("Check-in is from"))).toBe(false);

    // The cancellation sentence did not change: it is a control, not a correction.
    const controls = await visitor.as.query(api.corrections.unaffectedControls, { innId });
    expect(controls.some((c) => c.quote.includes("full refund"))).toBe(true);
    expect(corrections.some((c) => c.oldQuote.includes("full refund"))).toBe(false);
    // Claims citing other pages were never re-checked or flagged.
    expect(corrections.some((c) => !c.pageUrl.endsWith("/policies"))).toBe(false);

    // The thread view shows the correction and the claim is now needs_review.
    const thread = await visitor.as.query(api.threads.get, { threadId: petFee!.threadId });
    expect(thread.corrections.map((c) => c.status)).toContain("needs_review");
    expect(thread.claims.some((c) => c.status === "needs_review")).toBe(true);

    // Only a ready (not sent) draft cited the rates page; unsent drafts never get corrections.
    const readyThread = (await visitor.as.query(api.threads.queue, { innId, status: "ready" }))[0];
    const readyDetail = await visitor.as.query(api.threads.get, { threadId: readyThread._id });
    expect(readyDetail.corrections).toEqual([]);
  });

  it("re-submitting identical content records no new version and no corrections", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    const pages = await visitor.as.query(api.pages.list, { innId });
    const policies = pages.find((p) => p.kind === "policies")!;
    const version = await visitor.as.query(api.pages.getVersion, { pageVersionId: policies.lastVersion!._id });
    const result = await visitor.as.mutation(api.pages.submitContent, { pageId: policies._id, markdown: version.markdown });
    expect(result.changeStatus).toBe("same");
    expect(result.pageVersionId).toBe(policies.lastVersion!._id);
    expect(await visitor.as.query(api.corrections.list, { innId })).toEqual([]);
    await expect(visitor.as.mutation(api.pages.submitContent, { pageId: policies._id, markdown: "  " })).rejects.toThrow(
      /invalid/,
    );
  });

  it("corrections can be approved with text or dismissed, once, by inn members only", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    const other = await signedInUser(t, { name: "Other", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    await visitor.as.mutation(api.demo.changePolicyPage, { innId });
    const [first, second] = await visitor.as.query(api.corrections.list, { innId, status: "needs_review" });

    await expect(other.as.mutation(api.corrections.review, { correctionId: first._id, decision: "dismiss" })).rejects.toThrow(
      /forbidden/,
    );
    // Without any proposal text there is nothing to approve.
    await t.run(async (ctx) => {
      await ctx.db.patch(first._id, { proposedText: undefined, evidenceQuote: undefined, textSource: undefined });
    });
    await expect(visitor.as.mutation(api.corrections.review, { correctionId: first._id, decision: "approve" })).rejects.toThrow(
      /invalid/,
    );
    await visitor.as.mutation(api.corrections.review, {
      correctionId: first._id,
      decision: "approve",
      proposedText: "Our pet fee is now $40 per night.",
    });
    await visitor.as.mutation(api.corrections.review, { correctionId: second._id, decision: "dismiss" });
    await expect(visitor.as.mutation(api.corrections.review, { correctionId: second._id, decision: "dismiss" })).rejects.toThrow(
      /invalid/,
    );
    const all = await visitor.as.query(api.corrections.list, { innId });
    expect(all.find((c) => c._id === first._id)?.status).toBe("approved");
    expect(all.find((c) => c._id === second._id)?.status).toBe("dismissed");
  });
});
