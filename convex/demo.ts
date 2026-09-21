import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireInnAccess, requireUser } from "./access";
import { verifyQuote } from "./lib/quotes";
import { recordPageVersion } from "./pages";
import { authorizeDraftSend } from "./drafts";
import { authorizeCorrectionSend } from "./corrections";
import { commitDelivery, reserveOutbox } from "./outbox";
import { searchableTextFor, supersedeUnsentDrafts } from "./inbound";
import {
  DEMO_CORRECTION_FIXTURES,
  DEMO_INBOUND_FIXTURES,
  DEMO_INN,
  DEMO_THREADS,
  POLICIES_V1,
  POLICIES_V2,
  RATES_V1,
  ROOMS_V1,
} from "./demoContent";

const HOUR = 60 * 60 * 1000;
const DEMO_INBOX = "frontdesk@harborlight.example";
const FIXTURE_VERDICT = {
  entailed: true,
  promisedOutsideQuotes: false,
  notes: "demo fixture: quotes verified mechanically against the stored page; no model judge ran",
};

async function findDemoInn(ctx: MutationCtx, userId: Id<"users">) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const m of memberships) {
    const inn = await ctx.db.get(m.innId);
    if (inn?.isDemo && inn.createdBy === userId) return inn;
  }
  return null;
}

async function requireDemoInn(ctx: MutationCtx, innId: Id<"inns">) {
  const access = await requireInnAccess(ctx, innId);
  if (!access.inn.isDemo) {
    throw new ConvexError({ code: "forbidden", message: "Only demo inns have simulated operations" });
  }
  return access;
}

/**
 * Idempotently seeds a private demo inn for the signed-in anonymous visitor.
 * Demo inns have `isDemo: true` and the visitor's role is `demo`, so nothing
 * created here can reach live mail (see lib/tenant.ts).
 */
export const enter = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    if (user.isAnonymous !== true) {
      throw new ConvexError({ code: "forbidden", message: "The demo is only for anonymous visitors" });
    }
    const existing = await findDemoInn(ctx, user._id);
    if (existing) return existing._id;

    const now = Date.now();
    const innId = await ctx.db.insert("inns", {
      name: DEMO_INN.name,
      siteUrl: DEMO_INN.siteUrl,
      timezone: DEMO_INN.timezone,
      isDemo: true,
      createdBy: user._id,
    });
    await ctx.db.insert("memberships", { innId, userId: user._id, role: "demo", name: "You (demo)" });

    const pageIds = {} as Record<"policies" | "rooms" | "rates", Id<"pages">>;
    const versionIds = {} as Record<"policies" | "rooms" | "rates", Id<"pageVersions">>;
    const bodies = { policies: POLICIES_V1, rooms: ROOMS_V1, rates: RATES_V1 };
    for (const kind of ["policies", "rooms", "rates"] as const) {
      const pageId = await ctx.db.insert("pages", {
        innId,
        url: `${DEMO_INN.siteUrl}/${kind}`,
        title: kind[0].toUpperCase() + kind.slice(1),
        kind,
        watched: true,
      });
      const result = await recordPageVersion(ctx, pageId, bodies[kind]);
      pageIds[kind] = pageId;
      versionIds[kind] = result.pageVersionId;
    }

    for (const spec of DEMO_THREADS) {
      const inboundAt = now - spec.hoursAgo * HOUR;
      const status =
        spec.draft.kind === "sent" ? "waiting_guest" : spec.draft.kind === "ready" ? "ready" : "needs_staff";
      const snippet = spec.inbound.slice(0, 200);
      const threadId = await ctx.db.insert("threads", {
        innId,
        guestEmail: spec.guestEmail,
        subject: spec.subject,
        snippet,
        status,
        stay: spec.stay,
        lastInboundAt: inboundAt,
        firstResponseMs: spec.draft.kind === "sent" ? 14 * 60 * 1000 : undefined,
        searchableText: searchableTextFor(spec.subject, spec.guestEmail, snippet),
      });
      const inboundId = await ctx.db.insert("messages", {
        threadId,
        innId,
        direction: "in",
        from: spec.guestEmail,
        to: DEMO_INBOX,
        text: spec.inbound,
        at: inboundAt,
      });
      await ctx.db.patch(threadId, { lastInboundMessageId: inboundId });
      if (spec.draft.kind === "gap") {
        await ctx.db.insert("drafts", {
          threadId,
          replyToMessageId: inboundId,
          class: "needs_staff_fact",
          answer: "",
          abstain: true,
          gapQuestion: spec.draft.gapQuestion,
          status: "needs_edit",
          statusReason: "drafter classified as needs_staff_fact",
          model: "demo-seed",
          textSource: "fixture",
        });
        continue;
      }
      const draftId = await ctx.db.insert("drafts", {
        threadId,
        replyToMessageId: inboundId,
        class: "answerable",
        answer: spec.draft.answer,
        abstain: false,
        status: spec.draft.kind === "sent" ? "sent" : "ready",
        model: "demo-seed",
        judgeVerdict: FIXTURE_VERDICT,
        verifiedText: spec.draft.answer,
        textSource: "fixture",
      });
      for (const claim of spec.draft.claims) {
        const verification = verifyQuote(bodies[claim.page], claim.quote);
        await ctx.db.insert("claims", {
          draftId,
          threadId,
          innId,
          statement: claim.statement,
          url: `${DEMO_INN.siteUrl}/${claim.page}`,
          pageId: pageIds[claim.page],
          pageVersionId: versionIds[claim.page],
          quote: claim.quote,
          verified: verification.verified,
          verifyMethod: verification.verified ? verification.method : undefined,
          status: verification.verified ? "ok" : "stripped",
        });
      }
      if (spec.draft.kind === "sent") {
        const sentAt = inboundAt + 14 * 60 * 1000;
        const messageId = await ctx.db.insert("messages", {
          threadId,
          innId,
          direction: "out",
          from: DEMO_INBOX,
          to: spec.guestEmail,
          text: spec.draft.answer,
          at: sentAt,
        });
        await ctx.db.insert("sentReplies", {
          threadId,
          innId,
          draftId,
          sentBy: user._id,
          sentAt,
          kind: "reply",
          messageId,
          text: spec.draft.answer,
          textSource: "fixture",
          simulated: true,
        });
      }
    }

    await ctx.db.insert("staffFacts", {
      innId,
      question: "Is parking available?",
      answer: "Yes, free parking in the gravel lot behind the inn; one space per room.",
      scope: "general",
      author: user._id,
      authorName: "You (demo)",
      createdAt: now - 5 * 24 * HOUR,
    });
    return innId;
  },
});

/**
 * The demo's "the inn edits its policy page" step. Only valid on demo inns.
 * Affected replies receive honest fixture proposals whose evidence quote is
 * verified against the new version before it is stored.
 */
export const changePolicyPage = mutation({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    await requireDemoInn(ctx, innId);
    const page = await ctx.db
      .query("pages")
      .withIndex("by_inn_url", (q) => q.eq("innId", innId).eq("url", `${DEMO_INN.siteUrl}/policies`))
      .unique();
    if (!page) throw new ConvexError({ code: "not_found", message: "Demo policies page missing" });
    const current = page.lastVersionId ? await ctx.db.get(page.lastVersionId) : null;
    const next = current?.markdown === POLICIES_V2 ? POLICIES_V1 : POLICIES_V2;
    const result = await recordPageVersion(ctx, page._id, next, undefined, "none");
    for (const correctionId of result.correctionIds) {
      const correction = await ctx.db.get(correctionId);
      if (!correction) continue;
      const fixture = DEMO_CORRECTION_FIXTURES.find((f) => correction.oldQuote.includes(f.oldQuoteIncludes));
      if (!fixture) {
        await ctx.db.patch(correctionId, { statusReason: "no fixture proposal; write the correction" });
        continue;
      }
      const verification = verifyQuote(next, fixture.evidenceQuote);
      if (!verification.verified) {
        await ctx.db.patch(correctionId, { statusReason: "fixture evidence not found in the new page" });
        continue;
      }
      await ctx.db.patch(correctionId, {
        proposedText: fixture.text,
        evidenceQuote: fixture.evidenceQuote,
        evidenceVerifyMethod: verification.method,
        textSource: "fixture",
        statusReason: "demo fixture proposal; evidence quote verified against the new page, no model ran",
      });
    }
    return {
      pageVersionId: result.pageVersionId,
      changeStatus: result.changeStatus,
      affected: result.affected,
      unaffected: result.unaffected,
      affectedReplies: result.affectedReplies,
      unaffectedReplies: result.unaffectedReplies,
    };
  },
});

export const status = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    const { inn } = await requireInnAccess(ctx, innId);
    if (!inn.isDemo) return null;
    const page = await ctx.db
      .query("pages")
      .withIndex("by_inn_url", (q) => q.eq("innId", innId).eq("url", `${DEMO_INN.siteUrl}/policies`))
      .unique();
    const current = page?.lastVersionId ? await ctx.db.get(page.lastVersionId) : null;
    const corrections = await ctx.db
      .query("corrections")
      .withIndex("by_inn_status", (q) => q.eq("innId", innId))
      .collect();
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_inn_lastInbound", (q) => q.eq("innId", innId))
      .collect();
    let sentReplies = 0;
    const affected = new Set<string>();
    const control = new Set<string>();
    for (const thread of threads) {
      const replies = await ctx.db
        .query("sentReplies")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .collect();
      for (const reply of replies) {
        if (reply.kind === "correction") continue;
        sentReplies += 1;
        const claims = await ctx.db
          .query("claims")
          .withIndex("by_draft", (q) => q.eq("draftId", reply.draftId))
          .collect();
        if (claims.some((c) => c.status === "needs_review" || c.status === "corrected")) affected.add(reply._id);
        else if (page && claims.some((c) => c.pageId === page._id && c.checkedAgainstVersionId === page.lastVersionId)) {
          control.add(reply._id);
        }
      }
    }
    const count = (s: Doc<"corrections">["status"]) => corrections.filter((c) => c.status === s).length;
    return {
      policyVersion: current?.markdown === POLICIES_V2 ? ("changed" as const) : ("original" as const),
      sentReplies,
      affectedReplies: affected.size,
      unaffectedReplies: control.size,
      pendingCorrections: count("needs_review"),
      approvedCorrections: count("approved"),
      sentCorrections: count("sent"),
    };
  },
});

/** Sends a demo draft "to the guest": same guard decisions as the live send, no provider. */
export const simulateSend = mutation({
  args: { draftId: v.id("drafts"), staffAuthored: v.optional(v.boolean()) },
  handler: async (ctx, { draftId, staffAuthored }) => {
    const authorized = await authorizeDraftSend(ctx, draftId, staffAuthored === true);
    if (!authorized.inn.isDemo) throw new ConvexError({ code: "forbidden", message: "Simulated sends are demo-only" });
    const outboxId = await reserveOutbox(ctx, {
      innId: authorized.inn._id,
      threadId: authorized.thread._id,
      kind: "reply",
      draftId,
      replyToMessageId: authorized.inbound._id,
      text: authorized.draft.answer,
      textSource: authorized.textSource,
      reservedBy: authorized.user._id,
      simulated: true,
    });
    const row = (await ctx.db.get(outboxId))!;
    const { sentReplyId } = await commitDelivery(ctx, row, {});
    return { outboxId, sentReplyId };
  },
});

export const simulateCorrectionSend = mutation({
  args: { correctionId: v.id("corrections") },
  handler: async (ctx, { correctionId }) => {
    const authorized = await authorizeCorrectionSend(ctx, correctionId);
    if (!authorized.inn.isDemo) throw new ConvexError({ code: "forbidden", message: "Simulated sends are demo-only" });
    const outboxId = await reserveOutbox(ctx, {
      innId: authorized.inn._id,
      threadId: authorized.thread._id,
      kind: "correction",
      correctionId,
      replyToMessageId: authorized.inbound._id,
      text: authorized.correction.proposedText!,
      textSource: authorized.correction.textSource === "staff" ? "staff" : "fixture",
      reservedBy: authorized.user._id,
      simulated: true,
    });
    const row = (await ctx.db.get(outboxId))!;
    const { sentReplyId } = await commitDelivery(ctx, row, {});
    return { outboxId, sentReplyId };
  },
});

/**
 * Fixture regeneration after a knowledge gap is answered: the draft cites the
 * staff fact verbatim (source "fact") and is verified mechanically. Used by
 * facts.add on demo inns instead of the drafter.
 */
export async function regenerateDemoDraftFromFact(ctx: MutationCtx, thread: Doc<"threads">, factId: Id<"staffFacts">) {
  const fact = await ctx.db.get(factId);
  if (!fact || !thread.lastInboundMessageId) return null;
  await supersedeUnsentDrafts(ctx, thread._id, "regenerated with a staff fact");
  const answer = `Hi, thanks for asking. ${fact.answer} Let us know if we can help with anything else.`;
  const verification = verifyQuote(fact.answer, fact.answer);
  const draftId = await ctx.db.insert("drafts", {
    threadId: thread._id,
    replyToMessageId: thread.lastInboundMessageId,
    class: "answerable",
    answer,
    abstain: false,
    status: verification.verified ? "ready" : "needs_edit",
    statusReason: verification.verified ? undefined : "staff fact is empty",
    model: "demo-fixture",
    judgeVerdict: verification.verified ? FIXTURE_VERDICT : undefined,
    verifiedText: verification.verified ? answer : undefined,
    textSource: "fixture",
  });
  await ctx.db.insert("claims", {
    draftId,
    threadId: thread._id,
    innId: thread.innId,
    statement: fact.answer,
    url: `staff:${factId}`,
    staffFactId: factId,
    quote: fact.answer,
    verified: verification.verified,
    verifyMethod: verification.verified ? verification.method : undefined,
    status: verification.verified ? "ok" : "stripped",
  });
  await ctx.db.patch(thread._id, { status: verification.verified ? "ready" : "needs_staff" });
  return draftId;
}

/** A visitor-typed inquiry; the fixture drafter answers from the stored pages or asks a gap question. */
export const simulateInbound = mutation({
  args: { innId: v.id("inns"), guestEmail: v.string(), subject: v.string(), text: v.string() },
  handler: async (ctx, { innId, guestEmail, subject, text }) => {
    await requireDemoInn(ctx, innId);
    const email = guestEmail.trim().toLowerCase().slice(0, 200) || "guest@example.com";
    const subj = subject.trim().slice(0, 200) || "(no subject)";
    const body = text.trim().slice(0, 5000);
    if (!body) throw new ConvexError({ code: "invalid", message: "Message text is required" });
    const now = Date.now();
    const snippet = body.slice(0, 200);
    const threadId = await ctx.db.insert("threads", {
      innId,
      guestEmail: email,
      subject: subj,
      snippet,
      status: "drafting",
      lastInboundAt: now,
      searchableText: searchableTextFor(subj, email, snippet),
    });
    const inboundId = await ctx.db.insert("messages", {
      threadId,
      innId,
      direction: "in",
      from: email,
      to: DEMO_INBOX,
      text: body,
      at: now,
    });
    await ctx.db.patch(threadId, { lastInboundMessageId: inboundId });
    const fixture = DEMO_INBOUND_FIXTURES.find((f) => f.pattern.test(body));
    const page = fixture
      ? await ctx.db
          .query("pages")
          .withIndex("by_inn_url", (q) => q.eq("innId", innId).eq("url", `${DEMO_INN.siteUrl}/${fixture.page}`))
          .unique()
      : null;
    const version = page?.lastVersionId ? await ctx.db.get(page.lastVersionId) : null;
    const verification = fixture && version ? verifyQuote(version.markdown, fixture.quote) : null;
    if (fixture && page && version && verification?.verified) {
      const draftId = await ctx.db.insert("drafts", {
        threadId,
        replyToMessageId: inboundId,
        class: "answerable",
        answer: fixture.answer,
        abstain: false,
        status: "ready",
        model: "demo-fixture",
        judgeVerdict: FIXTURE_VERDICT,
        verifiedText: fixture.answer,
        textSource: "fixture",
      });
      await ctx.db.insert("claims", {
        draftId,
        threadId,
        innId,
        statement: fixture.statement,
        url: page.url,
        pageId: page._id,
        pageVersionId: version._id,
        quote: fixture.quote,
        verified: true,
        verifyMethod: verification.method,
        status: "ok",
      });
      await ctx.db.patch(threadId, { status: "ready" });
    } else {
      await ctx.db.insert("drafts", {
        threadId,
        replyToMessageId: inboundId,
        class: "needs_staff_fact",
        answer: "",
        abstain: true,
        gapQuestion: `What should we tell ${email} about: "${snippet.slice(0, 120)}"?`,
        status: "needs_edit",
        statusReason: fixture ? "fixture quote not found in the current page" : "no stored page covers this question",
        model: "demo-fixture",
        textSource: "fixture",
      });
      await ctx.db.patch(threadId, { status: "needs_staff" });
    }
    return { threadId };
  },
});
