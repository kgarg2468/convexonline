import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currentDateIn, readEnv } from "./lib/env";
import { describeError } from "./lib/errors";
import { decideDraft, groundClaims, type Source } from "./lib/grounding";
import { generateGroundedDraft, judgeDraft, DRAFT_MODEL_DEFAULT, JUDGE_MODEL_DEFAULT } from "./providers/openai";
import { supersedeUnsentDrafts } from "./inbound";
import { claimStatus, draftClass, judgeVerdict, stay, verifyMethod } from "./schema";

const MAX_PAGES = 60;
const MAX_PAGE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 600_000;
const MAX_INQUIRY_CHARS = 20_000;

/**
 * The guest text the drafter sees and the judge is later shown as guest
 * context: one builder so both stay byte-identical for the same inbound.
 */
function inquiryFor(subject: string, text: string): string {
  return `Subject: ${subject}\n\n${text}`.slice(0, MAX_INQUIRY_CHARS);
}

export type Snapshot = {
  inn: { _id: Id<"inns">; isDemo: boolean; timezone: string };
  thread: { _id: Id<"threads">; subject: string; lastInboundMessageId: Id<"messages"> | null };
  inbound: { _id: Id<"messages">; text: string; from: string } | null;
  pages: Array<{ pageId: Id<"pages">; url: string; versionId: Id<"pageVersions">; markdown: string }>;
  facts: Array<{ id: Id<"staffFacts">; question: string; answer: string; scope: "general" | "this_guest" }>;
};

/** Everything the drafter needs, read in one consistent transaction. */
export const snapshot = internalQuery({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }): Promise<Snapshot | null> => {
    const thread = await ctx.db.get(threadId);
    if (!thread) return null;
    const inn = await ctx.db.get(thread.innId);
    if (!inn) return null;
    const inbound = thread.lastInboundMessageId ? await ctx.db.get(thread.lastInboundMessageId) : null;
    const pagesRaw = await ctx.db
      .query("pages")
      .withIndex("by_inn", (q) => q.eq("innId", inn._id))
      .collect();
    const pages: Array<{ pageId: Id<"pages">; url: string; versionId: Id<"pageVersions">; markdown: string }> = [];
    let total = 0;
    for (const page of pagesRaw.slice(0, MAX_PAGES)) {
      if (!page.lastVersionId) continue;
      const version = await ctx.db.get(page.lastVersionId);
      if (!version) continue;
      const markdown = version.markdown.slice(0, MAX_PAGE_CHARS);
      if (total + markdown.length > MAX_TOTAL_CHARS) break;
      total += markdown.length;
      pages.push({ pageId: page._id, url: page.url, versionId: version._id, markdown });
    }
    const general = await ctx.db
      .query("staffFacts")
      .withIndex("by_inn_scope", (q) => q.eq("innId", inn._id).eq("scope", "general"))
      .collect();
    const threadFacts = await ctx.db
      .query("staffFacts")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    const seen = new Set<string>();
    const facts: Array<{ id: Id<"staffFacts">; question: string; answer: string; scope: "general" | "this_guest" }> = [];
    for (const f of [...general, ...threadFacts]) {
      if (f.supersededBy !== undefined || seen.has(f._id)) continue;
      seen.add(f._id);
      facts.push({ id: f._id, question: f.question, answer: f.answer, scope: f.scope === "general" ? "general" : "this_guest" });
    }
    return {
      inn: { _id: inn._id, isDemo: inn.isDemo, timezone: inn.timezone },
      thread: { _id: thread._id, subject: thread.subject, lastInboundMessageId: thread.lastInboundMessageId ?? null },
      inbound: inbound ? { _id: inbound._id, text: inbound.text, from: inbound.from } : null,
      pages,
      facts,
    };
  },
});

/** Opens a visible `verifying` draft bound to the inbound it answers. */
export const begin = internalMutation({
  args: { threadId: v.id("threads"), inboundMessageId: v.id("messages"), model: v.string() },
  handler: async (ctx, { threadId, inboundMessageId, model }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.lastInboundMessageId !== inboundMessageId) return null;
    await supersedeUnsentDrafts(ctx, threadId, "regenerated");
    const draftId = await ctx.db.insert("drafts", {
      threadId,
      replyToMessageId: inboundMessageId,
      class: "needs_staff_fact",
      answer: "",
      abstain: true,
      status: "verifying",
      model,
      textSource: "model",
    });
    await ctx.db.patch(threadId, { status: "drafting", lastGenerationAt: Date.now() });
    return draftId;
  },
});

const claimArg = v.object({
  statement: v.string(),
  url: v.string(),
  quote: v.string(),
  pageId: v.optional(v.id("pages")),
  pageVersionId: v.optional(v.id("pageVersions")),
  staffFactId: v.optional(v.id("staffFacts")),
  verified: v.boolean(),
  verifyMethod: v.optional(verifyMethod),
  status: claimStatus,
});

/**
 * Applies a finished generation, unless the world moved: a newer inbound, a
 * superseded draft, a changed page version or a superseded fact discards the
 * result (the draft is marked superseded with the reason) and, when only the
 * sources changed, generation is re-scheduled once.
 */
export const complete = internalMutation({
  args: {
    draftId: v.id("drafts"),
    inboundMessageId: v.id("messages"),
    sourceVersions: v.array(v.object({ pageId: v.id("pages"), versionId: v.id("pageVersions") })),
    factIds: v.array(v.id("staffFacts")),
    result: v.object({
      class: draftClass,
      answer: v.string(),
      abstain: v.boolean(),
      gapQuestion: v.optional(v.string()),
      stay: v.optional(stay),
      claims: v.array(claimArg),
      judgeVerdict: v.optional(judgeVerdict),
      status: v.union(v.literal("ready"), v.literal("needs_edit")),
      threadStatus: v.union(v.literal("ready"), v.literal("needs_staff")),
      reason: v.optional(v.string()),
    }),
  },
  handler: async (ctx, { draftId, inboundMessageId, sourceVersions, factIds, result }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft || draft.status !== "verifying") return { applied: false, why: "draft no longer verifying" };
    const thread = await ctx.db.get(draft.threadId);
    if (!thread) return { applied: false, why: "thread missing" };
    if (thread.lastInboundMessageId !== inboundMessageId) {
      await ctx.db.patch(draftId, { status: "superseded", statusReason: "stale: a newer guest message arrived" });
      return { applied: false, why: "newer inbound" };
    }
    let stale: string | null = null;
    for (const { pageId, versionId } of sourceVersions) {
      const page = await ctx.db.get(pageId);
      if (!page || page.lastVersionId !== versionId) {
        stale = "a cited page changed while drafting";
        break;
      }
    }
    if (!stale) {
      for (const factId of factIds) {
        const fact = await ctx.db.get(factId);
        if (!fact || fact.supersededBy !== undefined) {
          stale = "a staff fact changed while drafting";
          break;
        }
      }
    }
    if (stale) {
      await ctx.db.patch(draftId, { status: "superseded", statusReason: `stale: ${stale}` });
      await ctx.scheduler.runAfter(0, internal.generation.generateForThread, {
        threadId: thread._id,
        inboundMessageId,
      });
      return { applied: false, why: stale };
    }
    await ctx.db.patch(draftId, {
      class: result.class,
      answer: result.answer,
      abstain: result.abstain,
      gapQuestion: result.gapQuestion,
      status: result.status,
      statusReason: result.reason,
      judgeVerdict: result.judgeVerdict,
      verifiedText: result.status === "ready" ? result.answer : undefined,
      stay: result.stay,
      textSource: "model",
    });
    for (const claim of result.claims) {
      await ctx.db.insert("claims", {
        draftId,
        threadId: thread._id,
        innId: thread.innId,
        statement: claim.statement,
        url: claim.url,
        pageId: claim.pageId,
        pageVersionId: claim.pageVersionId,
        staffFactId: claim.staffFactId,
        quote: claim.quote,
        verified: claim.verified,
        verifyMethod: claim.verifyMethod,
        status: claim.status,
      });
    }
    await ctx.db.patch(thread._id, {
      status: result.threadStatus,
      stay: result.stay ?? thread.stay,
    });
    return { applied: true, why: null };
  },
});

/** A generation that could not produce a verified result stays visible with its reason. */
export const fail = internalMutation({
  args: { draftId: v.id("drafts"), reason: v.string() },
  handler: async (ctx, { draftId, reason }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft || draft.status !== "verifying") return null;
    await ctx.db.patch(draftId, {
      status: "needs_edit",
      class: "needs_staff_fact",
      abstain: true,
      statusReason: reason,
      judgeVerdict: undefined,
      verifiedText: undefined,
    });
    const thread = await ctx.db.get(draft.threadId);
    if (thread && thread.lastInboundMessageId === draft.replyToMessageId) {
      await ctx.db.patch(thread._id, { status: "needs_staff" });
    }
    return null;
  },
});

function toStay(s: { checkIn: string | null; checkOut: string | null; party: number | null; status: "inquiry" | "booked" | null }) {
  if (!s.status) return undefined;
  return {
    checkIn: s.checkIn ?? undefined,
    checkOut: s.checkOut ?? undefined,
    party: s.party ?? undefined,
    status: s.status,
  };
}

/**
 * Drafts a reply for the thread's latest inbound. Real inns only; demo inns
 * never reach a provider. Missing keys and provider errors leave a visible
 * needs_edit draft with a safe reason. The exact answer text is judged
 * together with the verified claims, and only that text can become ready.
 */
export const generateForThread = internalAction({
  args: { threadId: v.id("threads"), inboundMessageId: v.id("messages") },
  handler: async (ctx, { threadId, inboundMessageId }): Promise<null> => {
    const snap = await ctx.runQuery(internal.generation.snapshot, { threadId });
    if (!snap || snap.inn.isDemo) return null;
    if (!snap.inbound || snap.inbound._id !== inboundMessageId) return null;
    const draftId = await ctx.runMutation(internal.generation.begin, {
      threadId,
      inboundMessageId,
      model: DRAFT_MODEL_DEFAULT,
    });
    if (!draftId) return null;

    const apiKey = readEnv("OPENAI_API_KEY");
    if (!apiKey) {
      await ctx.runMutation(internal.generation.fail, { draftId, reason: "drafter unavailable: OPENAI_API_KEY is not configured" });
      return null;
    }
    // No source means no provider work is possible (the drafter itself would
    // reject the call), so fail visibly before any budget is reserved.
    if (snap.pages.length === 0 && snap.facts.length === 0) {
      await ctx.runMutation(internal.generation.fail, {
        draftId,
        reason: "nothing to draft from: this inn has no website pages or staff facts yet",
      });
      return null;
    }
    // One budget operation covers the draft and its judge. Charged only once
    // a provider call is actually possible (key present, draft still current);
    // a denial leaves a visible needs_edit draft for staff to redraft later.
    const budget = await ctx.runMutation(internal.modelBudget.reserve, {
      scope: { kind: "draft", draftId, inboundMessageId },
    });
    if (!budget.ok) {
      if (budget.kind === "throttled") {
        await ctx.runMutation(internal.generation.fail, { draftId, reason: `drafting paused: ${budget.reason}` });
      }
      return null;
    }
    const currentDate = currentDateIn(snap.inn.timezone);
    const inquiry = inquiryFor(snap.thread.subject, snap.inbound.text);
    let generated;
    try {
      generated = await generateGroundedDraft({
        apiKey,
        inquiry,
        pages: snap.pages.map((p) => ({ url: p.url, versionId: p.versionId, markdown: p.markdown })),
        facts: snap.facts,
        currentDate,
      });
    } catch (e) {
      const err = describeError(e);
      await ctx.runMutation(internal.generation.fail, { draftId, reason: `drafter failed (${err.kind}): ${err.message}` });
      return null;
    }

    const sources: Source[] = [
      ...snap.pages.map((p) => ({ kind: "page" as const, id: p.versionId, url: p.url, markdown: p.markdown, pageId: p.pageId })),
      ...snap.facts.map((f) => ({ kind: "fact" as const, id: f.id, answer: f.answer })),
    ];
    const grounded = groundClaims(generated.claims, sources);
    const okClaims = grounded.filter((c) => c.status === "ok");

    let judge: { entailed: boolean; promised: boolean } | { error: string } | null = null;
    let verdict: Doc<"drafts">["judgeVerdict"];
    const shouldJudge =
      generated.class === "answerable" && !generated.abstain && okClaims.length === grounded.length && okClaims.length > 0;
    if (shouldJudge) {
      try {
        const j = await judgeDraft({
          apiKey,
          reply: generated.answer,
          statements: okClaims.map((c) => ({ statement: c.statement, quote: c.quote, url: c.url })),
          currentDate,
          model: JUDGE_MODEL_DEFAULT,
          // The exact text the drafter answered, so the judge can tell a
          // faithful acknowledgment of the guest's own words from a claim.
          guestContext: inquiry,
        });
        judge = { entailed: j.entailed, promised: j.promised };
        verdict = { entailed: j.entailed, promisedOutsideQuotes: j.promised, notes: j.notes };
      } catch (e) {
        judge = { error: describeError(e).message };
      }
    }
    const decision = decideDraft({
      class: generated.class,
      abstain: generated.abstain,
      answer: generated.answer,
      claims: grounded,
      judge,
    });
    const pageByVersion = new Map(snap.pages.map((p) => [p.versionId, p]));
    await ctx.runMutation(internal.generation.complete, {
      draftId,
      inboundMessageId,
      sourceVersions: snap.pages.map((p) => ({ pageId: p.pageId, versionId: p.versionId })),
      factIds: snap.facts.map((f) => f.id),
      result: {
        class: generated.class,
        answer: generated.answer,
        abstain: generated.abstain,
        gapQuestion: generated.gapQuestion ?? undefined,
        stay: toStay(generated.stay),
        claims: grounded.map((c) => {
          const page = c.source?.kind === "page" ? pageByVersion.get(c.source.id as Id<"pageVersions">) : undefined;
          return {
            statement: c.statement,
            url: c.url,
            quote: c.quote,
            pageId: page?.pageId,
            pageVersionId: page?.versionId,
            staffFactId: c.source?.kind === "fact" ? (c.source.id as Id<"staffFacts">) : undefined,
            verified: c.status === "ok",
            verifyMethod: c.verification.verified ? c.verification.method : undefined,
            status: c.status,
          };
        }),
        judgeVerdict: verdict,
        status: decision.status,
        threadStatus: decision.threadStatus,
        reason: decision.reason,
      },
    });
    return null;
  },
});

// ---- Re-verification of staff edits ----------------------------------------

export const draftForReverify = internalQuery({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, { draftId }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) return null;
    const thread = await ctx.db.get(draft.threadId);
    const inn = thread ? await ctx.db.get(thread.innId) : null;
    if (!thread || !inn) return null;
    const claims = await ctx.db
      .query("claims")
      .withIndex("by_draft", (q) => q.eq("draftId", draftId))
      .collect();
    // Guest context is the inbound this draft is bound to (the one the drafter
    // answered), never the thread's newest message, and only if it really
    // belongs to this thread. Otherwise the judge runs source-only.
    const inbound = draft.replyToMessageId ? await ctx.db.get(draft.replyToMessageId) : null;
    const guestContext =
      inbound && inbound.threadId === draft.threadId && inbound.direction === "in"
        ? inquiryFor(thread.subject, inbound.text)
        : undefined;
    return {
      status: draft.status,
      answer: draft.answer,
      textSource: draft.textSource ?? "model",
      isDemo: inn.isDemo,
      timezone: inn.timezone,
      claims: claims.filter((c) => c.status === "ok").map((c) => ({ statement: c.statement, quote: c.quote, url: c.url })),
      guestContext,
    };
  },
});

export const applyReverify = internalMutation({
  args: {
    draftId: v.id("drafts"),
    answer: v.string(),
    verdict: v.optional(judgeVerdict),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { draftId, answer, verdict, reason }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft || draft.status !== "needs_edit" || draft.answer !== answer) return { applied: false };
    const thread = await ctx.db.get(draft.threadId);
    const ready = verdict !== undefined && verdict.entailed && !verdict.promisedOutsideQuotes;
    await ctx.db.patch(draftId, {
      judgeVerdict: verdict,
      verifiedText: ready ? answer : undefined,
      status: ready ? "ready" : "needs_edit",
      statusReason: ready
        ? undefined
        : reason ??
          (verdict && !verdict.entailed ? "judge: edited text not entailed by quotes" : "judge: edited text promises beyond the quotes"),
    });
    if (thread && thread.lastInboundMessageId === draft.replyToMessageId) {
      await ctx.db.patch(thread._id, { status: ready ? "ready" : "needs_staff" });
    }
    return { applied: true };
  },
});

/** Judges the exact edited text against the draft's verified claims. */
export const reverify = internalAction({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, { draftId }): Promise<null> => {
    const snap = await ctx.runQuery(internal.generation.draftForReverify, { draftId });
    if (!snap || snap.status !== "needs_edit" || snap.isDemo) return null;
    const answer = snap.answer;
    const apiKey = readEnv("OPENAI_API_KEY");
    if (!apiKey) {
      await ctx.runMutation(internal.generation.applyReverify, {
        draftId,
        answer,
        reason: "edited text not re-judged: OPENAI_API_KEY is not configured (send as staff-authored or wait)",
      });
      return null;
    }
    // Each re-judge of an edit is one budget operation, so repeated edits
    // cannot run the judge without bound. The scope pins the exact text seen.
    const budget = await ctx.runMutation(internal.modelBudget.reserve, { scope: { kind: "reverify", draftId, answer } });
    if (!budget.ok) {
      if (budget.kind === "throttled") {
        await ctx.runMutation(internal.generation.applyReverify, {
          draftId,
          answer,
          reason: `edited text not re-judged: ${budget.reason} (or send as staff-authored)`,
        });
      }
      return null;
    }
    try {
      const j = await judgeDraft({
        apiKey,
        reply: answer,
        statements: snap.claims,
        currentDate: currentDateIn(snap.timezone),
        model: JUDGE_MODEL_DEFAULT,
        guestContext: snap.guestContext,
      });
      await ctx.runMutation(internal.generation.applyReverify, {
        draftId,
        answer,
        verdict: { entailed: j.entailed, promisedOutsideQuotes: j.promised, notes: j.notes },
      });
    } catch (e) {
      const err = describeError(e);
      await ctx.runMutation(internal.generation.applyReverify, {
        draftId,
        answer,
        reason: `judge unavailable (${err.kind}); send as staff-authored or retry the edit`,
      });
    }
    return null;
  },
});
