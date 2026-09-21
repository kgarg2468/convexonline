import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeTest, signedInUser } from "./setup";

describe("staff facts", () => {
  it("answering a gap question redrafts the demo thread with the fact cited verbatim", async () => {
    const t = makeTest();
    const visitor = await signedInUser(t, { name: "Visitor", isAnonymous: true });
    const innId = await visitor.as.mutation(api.demo.enter, {});
    const [gap] = await visitor.as.query(api.threads.queue, { innId, status: "needs_staff" });
    const detail = await visitor.as.query(api.threads.get, { threadId: gap._id });
    expect(detail.draft?.abstain).toBe(true);
    expect(detail.draft?.gapQuestion).toMatch(/hot tub/i);

    await expect(
      visitor.as.mutation(api.facts.add, { innId, question: "q", answer: "  ", scope: "general" }),
    ).rejects.toThrow(/invalid/);
    await expect(
      visitor.as.mutation(api.facts.add, { innId, question: "q", answer: "a", scope: "thread" }),
    ).rejects.toThrow(/invalid/);

    await visitor.as.mutation(api.facts.add, {
      innId,
      threadId: gap._id,
      question: detail.draft!.gapQuestion!,
      answer: "The hot tub is open year-round, shared, 8am-10pm.",
      scope: "general",
    });
    const after = await visitor.as.query(api.threads.get, { threadId: gap._id });
    // Demo inns never call a provider: the fixture drafter cites the staff fact itself.
    expect(after.thread.status).toBe("ready");
    expect(after.draft?.status).toBe("ready");
    expect(after.draft?.abstain).toBe(false);
    expect(after.draft?.answer).toContain("The hot tub is open year-round, shared, 8am-10pm.");
    expect(after.draft?.verifiedText).toBe(after.draft?.answer);
    expect(after.draft?.textSource).toBe("fixture");
    expect(after.claims).toHaveLength(1);
    expect(after.claims[0]).toMatchObject({ source: "fact", verified: true, status: "ok", currentSource: true });
    expect(after.claims[0].staffFactId).not.toBeNull();
    expect(after.facts).toHaveLength(1);
    const general = await visitor.as.query(api.facts.list, { innId });
    expect(general.some((f) => f.answer.includes("hot tub"))).toBe(true);
  });
});
