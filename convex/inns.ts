import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { liveMailDecision, requireInnAccess, requireUser } from "./access";
import { readEnv } from "./lib/env";
import { deploymentOriginOf, isOnDeploymentOrigin } from "./lib/innWebsiteHtml";
import { assertPublicHttpsUrl } from "./providers/firecrawl";

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

const invalid = (message: string) => new ConvexError({ code: "invalid", message });

/** Maps assertPublicHttpsUrl's internal reasons to copy a receptionist can act on. */
function parseSiteUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw invalid("Website is required");
  try {
    return assertPublicHttpsUrl(trimmed);
  } catch (err) {
    const why = err instanceof Error ? err.message : "";
    if (why.includes("unparseable")) throw invalid("Website must be a valid URL, including https://");
    if (why.includes("scheme")) throw invalid("Website must start with https://");
    if (why.includes("credentials")) throw invalid("Website must not include a username or password");
    throw invalid("Website must be a public https address (not localhost, a private network, or a bare IP)");
  }
}

/** Accepts only IANA zones that Intl.DateTimeFormat can render; blank falls back to the default. */
function parseTimezone(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return DEFAULT_TIMEZONE;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    throw invalid(`Time zone "${trimmed}" is not recognized; use an IANA name like America/New_York`);
  }
}

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const result = [];
    for (const membership of memberships) {
      const inn = await ctx.db.get(membership.innId);
      if (!inn) continue;
      result.push({
        innId: inn._id,
        name: inn.name,
        siteUrl: inn.siteUrl,
        isDemo: inn.isDemo,
        role: membership.role,
      });
    }
    return result;
  },
});

export const get = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    const access = await requireInnAccess(ctx, innId);
    const staff = await ctx.db
      .query("memberships")
      .withIndex("by_inn", (q) => q.eq("innId", innId))
      .collect();
    return {
      inn: {
        _id: access.inn._id,
        name: access.inn.name,
        siteUrl: access.inn.siteUrl,
        timezone: access.inn.timezone,
        isDemo: access.inn.isDemo,
        inboxAddress: access.inn.inboxAddress ?? null,
      },
      role: access.membership.role,
      liveMail: liveMailDecision(access),
      staff: staff.map((m) => ({ userId: m.userId, name: m.name, role: m.role })),
    };
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    siteUrl: v.string(),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (user.isAnonymous === true) {
      throw new ConvexError({ code: "forbidden", message: "Demo visitors cannot create inns" });
    }
    const name = args.name.trim();
    if (name.length === 0 || name.length > 120) {
      throw new ConvexError({ code: "invalid", message: "Inn name is required" });
    }
    // Ingestion only ever fetches public https URLs (see providers/firecrawl),
    // so refuse anything else here rather than creating an inn that can never
    // be crawled. Same rules, friendlier wording.
    const siteUrl = parseSiteUrl(args.siteUrl);
    // This deployment's own origin is reserved for hosted fictional inns, whose
    // URL is derived server-side (innWebsites.createFictional). Pointing an
    // ordinary inn at it would let a crawl read the app or another inn's site.
    if (isOnDeploymentOrigin(siteUrl.toString(), deploymentOriginOf(readEnv("CONVEX_SITE_URL")))) {
      throw new ConvexError({
        code: "hosted_origin",
        message: "That address belongs to this service, not to an external property website. To run a fictional inn here, create a fictional inn instead.",
      });
    }
    const timezone = parseTimezone(args.timezone);
    const innId = await ctx.db.insert("inns", {
      name,
      siteUrl: siteUrl.toString(),
      timezone,
      isDemo: false,
      createdBy: user._id,
    });
    await ctx.db.insert("memberships", {
      innId,
      userId: user._id,
      role: "owner",
      name: user.name ?? user.email ?? "Owner",
    });
    return innId;
  },
});
