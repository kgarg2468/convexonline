/**
 * Fictional inn websites hosted by this deployment. A signed-in (non-anonymous)
 * user creates a fictional inn whose `siteUrl` is `${CONVEX_SITE_URL}/inn/<innId>/`;
 * the inn owner edits a bounded, structured content document that the public
 * HTTP route renders (see http.ts and lib/innWebsiteHtml.ts).
 *
 * Editing the website only ever touches `innWebsites`. Source pages, page
 * versions, claims and corrections change exclusively through the real crawl
 * pipeline reading the rendered site back.
 */
import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireInnAccess, requireUser } from "./access";
import { readEnv } from "./lib/env";
import {
  defaultWebsiteContent,
  hostedPageUrls,
  hostedSiteUrl,
  InnWebsiteContentError,
  normalizeWebsiteContent,
  type InnWebsiteContent,
} from "./lib/innWebsiteHtml";
import { isPublicHttpsUrl } from "./providers/firecrawl";

const DEFAULT_TIMEZONE = "America/Los_Angeles";

const invalid = (message: string, field?: string) => new ConvexError({ code: "invalid", message, field });

/** Same acceptance rule as `inns.create`: an IANA zone Intl can render, blank → default. */
function parseTimezone(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return DEFAULT_TIMEZONE;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    throw invalid(`Time zone "${trimmed}" is not recognized; use an IANA name like America/New_York`, "timezone");
  }
}

const contentArgs = {
  publicName: v.string(),
  intro: v.string(),
  checkIn: v.string(),
  checkOut: v.string(),
  petFeePerDogPerNight: v.number(),
  maxDogs: v.number(),
  petPolicy: v.string(),
  breakfastHours: v.string(),
  wifi: v.string(),
  roomsDescription: v.string(),
  notice: v.string(),
};

function toContent(doc: Doc<"innWebsites">): InnWebsiteContent {
  return {
    publicName: doc.publicName,
    intro: doc.intro,
    checkIn: doc.checkIn,
    checkOut: doc.checkOut,
    petFeePerDogPerNight: doc.petFeePerDogPerNight,
    maxDogs: doc.maxDogs,
    petPolicy: doc.petPolicy,
    breakfastHours: doc.breakfastHours,
    wifi: doc.wifi,
    roomsDescription: doc.roomsDescription,
    notice: doc.notice,
  };
}

function validated(input: Record<string, unknown>): InnWebsiteContent {
  try {
    return normalizeWebsiteContent(input);
  } catch (e) {
    if (e instanceof InnWebsiteContentError) throw invalid(e.message, e.field);
    throw e;
  }
}

async function websiteFor(ctx: QueryCtx | MutationCtx, innId: Id<"inns">): Promise<Doc<"innWebsites"> | null> {
  return await ctx.db
    .query("innWebsites")
    .withIndex("by_inn", (q) => q.eq("innId", innId))
    .unique();
}

/** The deployment's public https origin; without it no hosted site can exist. */
function requireSiteOrigin(): string {
  const raw = readEnv("CONVEX_SITE_URL");
  if (!raw || !isPublicHttpsUrl(raw)) {
    throw new ConvexError({
      code: "site_url_unavailable",
      message: "This deployment has no public https site URL configured, so it cannot host an inn website",
    });
  }
  return new URL(raw).origin;
}

/**
 * Creates a fictional inn, makes the caller its owner and seeds the website
 * with the default (clearly illustrative) policies. The site URL is derived
 * on the server from the deployment origin; callers never supply a URL.
 */
export const createFictional = mutation({
  args: { name: v.string(), timezone: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (user.isAnonymous === true) {
      throw new ConvexError({ code: "forbidden", message: "Demo visitors cannot create inns" });
    }
    const name = args.name.trim();
    if (name.length === 0 || name.length > 120) throw invalid("Inn name is required", "name");
    const timezone = parseTimezone(args.timezone);
    const origin = requireSiteOrigin();
    // The id is only known after insert; the row is finalised in the same transaction.
    const innId = await ctx.db.insert("inns", { name, siteUrl: origin, timezone, isDemo: false, createdBy: user._id });
    const siteUrl = hostedSiteUrl(origin, innId);
    await ctx.db.patch(innId, { siteUrl });
    await ctx.db.insert("memberships", { innId, userId: user._id, role: "owner", name: user.name ?? user.email ?? "Owner" });
    const defaults = defaultWebsiteContent(name.slice(0, 80));
    await ctx.db.insert("innWebsites", { innId, ...defaults, updatedAt: Date.now(), updatedBy: user._id });
    return { innId, siteUrl };
  },
});

/** Owner-only editor view: the current content plus the public URLs it renders at. */
export const editor = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    const { inn, membership, user } = await requireInnAccess(ctx, innId);
    if (membership.role !== "owner" || user.isAnonymous === true) {
      throw new ConvexError({ code: "owner_only", message: "Only the inn owner can edit the website" });
    }
    const site = await websiteFor(ctx, innId);
    if (!site) return null;
    return {
      siteUrl: inn.siteUrl,
      pages: hostedPageUrls(inn.siteUrl),
      content: toContent(site),
      updatedAt: site.updatedAt,
    };
  },
});

/** Any member of the inn may see what the public site currently says (read-only). */
export const publicView = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    const { inn } = await requireInnAccess(ctx, innId);
    const site = await websiteFor(ctx, innId);
    if (!site) return null;
    return { siteUrl: inn.siteUrl, pages: hostedPageUrls(inn.siteUrl), content: toContent(site) };
  },
});

/** Owner-only, explicit save of the whole content document. Never touches pages or versions. */
export const update = mutation({
  args: { innId: v.id("inns"), content: v.object(contentArgs) },
  handler: async (ctx, { innId, content }) => {
    const { inn, membership, user } = await requireInnAccess(ctx, innId);
    if (membership.role !== "owner" || user.isAnonymous === true || inn.isDemo) {
      throw new ConvexError({ code: "owner_only", message: "Only the inn owner can edit the website" });
    }
    const site = await websiteFor(ctx, innId);
    if (!site) throw new ConvexError({ code: "no_website", message: "This inn has no hosted website" });
    const next = validated(content);
    await ctx.db.patch(site._id, { ...next, updatedAt: Date.now(), updatedBy: user._id });
    return { updatedAt: Date.now() };
  },
});

/**
 * Used only by the public HTTP route. Returns nothing but the website content
 * for an inn that has one; unknown ids, inns without a site document and demo
 * inns all read as absent (404 upstream). No staff, guest or user data.
 */
export const publicContent = internalQuery({
  args: { innId: v.string() },
  handler: async (ctx, { innId }): Promise<InnWebsiteContent | null> => {
    const id = ctx.db.normalizeId("inns", innId);
    if (!id) return null;
    const inn = await ctx.db.get(id);
    if (!inn || inn.isDemo) return null;
    const site = await websiteFor(ctx, id);
    if (!site) return null;
    return toContent(site);
  },
});
