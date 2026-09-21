import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeTest, signedInUser } from "./setup";
import { seedInboundThread, seedLiveInn } from "./integrationSetup";

/**
 * threads.get must attribute every outbox row to the exact draft or correction
 * it delivers, so the client can show a draft's own delivery state (and block
 * only that draft) instead of guessing from "latest row in the thread".
 */
describe("threads.get outbox projection", () => {
  it("carries draftId / correctionId per row, null when the row has none", async () => {
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const inn = await seedLiveInn(t, owner.userId);
    const { threadId, messageId } = await seedInboundThread(t, inn.innId);

    const ids = await t.run(async (ctx) => {
      const draftFields = {
        threadId,
        replyToMessageId: messageId,
        class: "answerable" as const,
        abstain: false,
        status: "sent" as const,
        model: "test",
        textSource: "model" as const,
      };
      const oldDraftId = await ctx.db.insert("drafts", { ...draftFields, answer: "Old answer" });
      const newDraftId = await ctx.db.insert("drafts", { ...draftFields, answer: "New answer", status: "ready" });
      const sentReplyId = await ctx.db.insert("sentReplies", {
        threadId,
        innId: inn.innId,
        draftId: oldDraftId,
        sentAt: 1_000,
        sentBy: owner.userId,
        kind: "reply",
        text: "Old answer",
        textSource: "model",
        simulated: false,
      });
      const claimId = await ctx.db.insert("claims", {
        draftId: oldDraftId,
        threadId,
        innId: inn.innId,
        statement: "Dogs $25/night",
        pageId: inn.pageId,
        pageVersionId: inn.versionId,
        url: "https://seagull.example/policies",
        quote: "$25 per night pet fee",
        verified: true,
        verifyMethod: "strict",
        status: "needs_review",
      });
      const correctionId = await ctx.db.insert("corrections", {
        innId: inn.innId,
        threadId,
        sentReplyId,
        claimId,
        pageId: inn.pageId,
        oldVersionId: inn.versionId,
        newVersionId: inn.versionId,
        oldQuote: "$25 per night pet fee",
        status: "approved",
      });
      const rowFields = {
        innId: inn.innId,
        threadId,
        replyToMessageId: messageId,
        text: "x",
        textSource: "model" as const,
        reservedBy: owner.userId,
        simulated: false,
      };
      const oldRow = await ctx.db.insert("outbox", { ...rowFields, kind: "reply", draftId: oldDraftId, reservedAt: 1_000, status: "sent", sentAt: 1_001 });
      const orphanRow = await ctx.db.insert("outbox", { ...rowFields, kind: "reply", reservedAt: 2_000, status: "unknown" });
      const corrRow = await ctx.db.insert("outbox", { ...rowFields, kind: "correction", correctionId, reservedAt: 3_000, status: "reserved" });
      return { oldDraftId, newDraftId, correctionId, oldRow, orphanRow, corrRow };
    });

    const detail = await owner.as.query(api.threads.get, { threadId });
    expect(detail).not.toBeNull();
    const byId = new Map(detail!.outbox.map((o) => [o._id, o]));
    expect(byId.size).toBe(3);

    expect(byId.get(ids.oldRow)).toMatchObject({ kind: "reply", draftId: ids.oldDraftId, correctionId: null, status: "sent" });
    // A row written without ids is reported as such, never attributed to whichever draft is current.
    expect(byId.get(ids.orphanRow)).toMatchObject({ kind: "reply", draftId: null, correctionId: null, status: "unknown" });
    expect(byId.get(ids.corrRow)).toMatchObject({ kind: "correction", draftId: null, correctionId: ids.correctionId, status: "reserved" });

    // The current draft (newDraftId) has no row of its own: nothing in the
    // thread claims to be its delivery, and the old sent/unknown rows cannot
    // block it.
    const forNewDraft = detail!.outbox.filter((o) => o.draftId === ids.newDraftId);
    expect(forNewDraft).toEqual([]);
  });
});
