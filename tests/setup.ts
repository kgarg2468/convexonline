import { convexTest } from "convex-test";
import presenceComponent from "@convex-dev/presence/test";
import rateLimiterComponent from "@convex-dev/rate-limiter/test";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

export const modules = import.meta.glob("../convex/**/!(*.*.*)*.*s");

export function makeTest() {
  const t = convexTest(schema, modules);
  // The real presence component (and its nested batch worker), as mounted in
  // convex.config.ts, so presence tests exercise the published package.
  presenceComponent.register(t);
  // The real rate limiter component (and its nested batch worker) behind the
  // per-inn model budget, so throttle tests exercise the published package.
  rateLimiterComponent.register(t);
  return t;
}

export type T = ReturnType<typeof makeTest>;

/** Creates a user row and returns a client acting as that user. */
export async function signedInUser(
  t: T,
  profile: { name: string; email?: string; isAnonymous?: boolean } = { name: "Staff" },
) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: profile.name,
      email: profile.email,
      isAnonymous: profile.isAnonymous ?? false,
    }),
  );
  // Convex Auth encodes `${userId}|${sessionId}` in the JWT subject.
  const as = t.withIdentity({ subject: `${userId}|session-${userId}`, issuer: "test" });
  return { userId, as };
}

/** Seeds a non-demo inn owned by `userId`, with an optional extra staff member. */
export async function seedInn(t: T, ownerId: Id<"users">, name = "Test Inn") {
  return await t.run(async (ctx) => {
    const innId = await ctx.db.insert("inns", {
      name,
      siteUrl: "https://inn.example",
      timezone: "UTC",
      isDemo: false,
      createdBy: ownerId,
    });
    await ctx.db.insert("memberships", { innId, userId: ownerId, role: "owner", name: "Owner" });
    return innId;
  });
}

export async function addStaff(t: T, innId: Id<"inns">, userId: Id<"users">, name = "Staff") {
  await t.run(async (ctx) => {
    await ctx.db.insert("memberships", { innId, userId, role: "staff", name });
  });
}

export async function seedThread(t: T, innId: Id<"inns">, subject = "Question") {
  return await t.run(async (ctx) =>
    ctx.db.insert("threads", {
      innId,
      guestEmail: "guest@example.com",
      subject,
      snippet: "Hello, a question about " + subject,
      status: "ready",
      lastInboundAt: Date.now(),
    }),
  );
}
