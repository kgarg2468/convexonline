import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireInnAccess, requireUser } from "./access";
import { verifyQuote } from "./lib/quotes";
import { recordPageVersion } from "./pages";
import { DEMO_INN, DEMO_THREADS, POLICIES_V1, POLICIES_V2, RATES_V1, ROOMS_V1 } from "./demoContent";

const HOUR = 60 * 60 * 1000;

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
        spec.draft.kind === "sent" ? "sent" : spec.draft.kind === "ready" ? "ready" : "needs_staff";
      const threadId = await ctx.db.insert("threads", {
        innId,
        guestEmail: spec.guestEmail,
        subject: spec.subject,
        snippet: spec.inbound.slice(0, 200),
        status,
        stay: spec.stay,
        lastInboundAt: inboundAt,
        firstResponseMs: spec.draft.kind === "sent" ? 14 * 60 * 1000 : undefined,
      });
      const inboundId = await ctx.db.insert("messages", {
        threadId,
        direction: "in",
        from: spec.guestEmail,
        to: "frontdesk@harborlight.example",
        text: spec.inbound,
        at: inboundAt,
      });
      if (spec.draft.kind === "gap") {
        await ctx.db.insert("drafts", {
          threadId,
          replyToMessageId: inboundId,
          class: "needs_staff_fact",
          answer: "",
          abstain: true,
          gapQuestion: spec.draft.gapQuestion,
          status: "needs_edit",
          model: "demo-seed",
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
        judgeVerdict: { entailed: true, promisedOutsideQuotes: false, notes: "seeded" },
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
        await ctx.db.insert("messages", {
          threadId,
          direction: "out",
          from: "frontdesk@harborlight.example",
          to: spec.guestEmail,
          text: spec.draft.answer,
          at: sentAt,
        });
        await ctx.db.insert("sentReplies", { threadId, innId, draftId, sentBy: user._id, sentAt });
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

/** The demo's "the inn edits its policy page" step. Only valid on demo inns. */
export const changePolicyPage = mutation({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    const { inn } = await requireInnAccess(ctx, innId);
    if (!inn.isDemo) {
      throw new ConvexError({ code: "forbidden", message: "Only demo inns have a scripted policy change" });
    }
    const page = await ctx.db
      .query("pages")
      .withIndex("by_inn_url", (q) => q.eq("innId", innId).eq("url", `${DEMO_INN.siteUrl}/policies`))
      .unique();
    if (!page) throw new ConvexError({ code: "not_found", message: "Demo policies page missing" });
    const current = page.lastVersionId ? await ctx.db.get(page.lastVersionId) : null;
    const next = current?.markdown === POLICIES_V2 ? POLICIES_V1 : POLICIES_V2;
    return recordPageVersion(ctx, page._id, next);
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
    return { policyVersion: current?.markdown === POLICIES_V2 ? "changed" : "original" };
  },
});
