import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { liveMailDecision, requireInnAccess, requireUser } from "./access";

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
    let siteUrl: URL;
    try {
      siteUrl = new URL(args.siteUrl.trim());
    } catch {
      throw new ConvexError({ code: "invalid", message: "Site URL must be a valid URL" });
    }
    if (siteUrl.protocol !== "https:" && siteUrl.protocol !== "http:") {
      throw new ConvexError({ code: "invalid", message: "Site URL must use http or https" });
    }
    const innId = await ctx.db.insert("inns", {
      name,
      siteUrl: siteUrl.toString(),
      timezone: args.timezone?.trim() || "America/Los_Angeles",
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
