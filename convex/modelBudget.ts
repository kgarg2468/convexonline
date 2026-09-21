import { v } from "convex/values";
import { HOUR, MINUTE, RateLimiter, calculateRateLimit } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * Per-inn budget for OpenAI operations, backed by the registered
 * @convex-dev/rate-limiter component. One operation is one unit of provider
 * work: a normal draft + judge pair, one staff-edit re-verification, or one
 * generated correction (draft + judge). Two limits share every operation:
 * a burst bucket (BURST_OPERATIONS per minute, same capacity) and a fixed
 * hourly window (HOURLY_OPERATIONS, aligned to the clock hour so the reason
 * shown to staff has a predictable retry time).
 *
 * The key is always derived from the record being worked on, never from the
 * caller, and nothing here is public: no reset, no token exposure.
 */
export const BURST_OPERATIONS = 10;
export const HOURLY_OPERATIONS = 60;

const limiter = new RateLimiter(components.rateLimiter, {
  modelBurst: { kind: "token bucket", rate: BURST_OPERATIONS, period: MINUTE, capacity: BURST_OPERATIONS },
  modelHourly: { kind: "fixed window", rate: HOURLY_OPERATIONS, period: HOUR, start: 0 },
});

const LIMIT_NAMES = ["modelBurst", "modelHourly"] as const;

/**
 * What the operation is for. Each scope names the record and the precondition
 * the caller observed, so a stale or already-finished job is refused without
 * charging the inn (a superseded draft, a newer guest message, a re-edited
 * answer, a page that changed again).
 */
const scope = v.union(
  v.object({ kind: v.literal("draft"), draftId: v.id("drafts"), inboundMessageId: v.id("messages") }),
  v.object({ kind: v.literal("reverify"), draftId: v.id("drafts"), answer: v.string() }),
  v.object({ kind: v.literal("correction"), correctionId: v.id("corrections"), newVersionId: v.id("pageVersions") }),
);

export type ReserveResult =
  | { ok: true }
  /** The record is no longer in the state the caller saw; nothing was charged. */
  | { ok: false; kind: "stale" }
  /** Budget exhausted; nothing was charged. `retryAt` is an absolute ms timestamp. */
  | { ok: false; kind: "throttled"; retryAt: number; reason: string };

type Scope =
  | { kind: "draft"; draftId: Id<"drafts">; inboundMessageId: Id<"messages"> }
  | { kind: "reverify"; draftId: Id<"drafts">; answer: string }
  | { kind: "correction"; correctionId: Id<"corrections">; newVersionId: Id<"pageVersions"> };

/** The inn a still-current operation belongs to, or null when the work is obsolete or demo. */
async function resolveScope(ctx: MutationCtx, s: Scope): Promise<{ innId: Id<"inns">; timezone: string } | null> {
  let innId: Id<"inns"> | null = null;
  if (s.kind === "draft") {
    const draft = await ctx.db.get(s.draftId);
    if (!draft || draft.status !== "verifying" || draft.replyToMessageId !== s.inboundMessageId) return null;
    const thread = await ctx.db.get(draft.threadId);
    if (!thread || thread.lastInboundMessageId !== s.inboundMessageId) return null;
    innId = thread.innId;
  } else if (s.kind === "reverify") {
    const draft = await ctx.db.get(s.draftId);
    if (!draft || draft.status !== "needs_edit" || draft.answer !== s.answer) return null;
    const thread = await ctx.db.get(draft.threadId);
    if (!thread) return null;
    // A draft explicitly bound to an inbound the guest has since followed up on
    // is stale even when nothing superseded it yet. Legacy drafts without a
    // binding keep the old behaviour (judged; the send guard still refuses them).
    if (draft.replyToMessageId !== undefined && draft.replyToMessageId !== thread.lastInboundMessageId) return null;
    innId = thread.innId;
  } else {
    const correction = await ctx.db.get(s.correctionId);
    if (!correction || correction.status !== "needs_review" || correction.newVersionId !== s.newVersionId) return null;
    if (correction.textSource === "staff") return null;
    const page = await ctx.db.get(correction.pageId);
    if (!page || page.lastVersionId !== s.newVersionId) return null;
    innId = correction.innId;
  }
  const inn = await ctx.db.get(innId);
  if (!inn || inn.isDemo) return null;
  return { innId: inn._id, timezone: inn.timezone };
}

/**
 * "3:05:06 PM EDT" in the inn's timezone; ISO time as a fallback. Seconds are
 * shown because the burst bucket refills one token every 6 s: a minute-only
 * time would often already be in the past when staff read it.
 */
export function formatRetryAt(retryAt: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(new Date(retryAt));
  } catch {
    return new Date(retryAt).toISOString().slice(11, 19) + " UTC";
  }
}

export function throttleReason(retryAt: number, timezone: string): string {
  return (
    `this inn's model budget is used up (${BURST_OPERATIONS} per minute, ${HOURLY_OPERATIONS} per hour); ` +
    `try again after ${formatRetryAt(retryAt, timezone)}`
  );
}

/**
 * Charges one operation to the inn that owns the record, or explains why not.
 * Both limits are checked first and consumed only when both allow, inside this
 * one mutation, so a denial by either leaves the other untouched and two
 * concurrent callers can never both pass on the same last token.
 */
export const reserve = internalMutation({
  args: { scope },
  handler: async (ctx, { scope }): Promise<ReserveResult> => {
    const target = await resolveScope(ctx, scope);
    if (!target) return { ok: false, kind: "stale" };
    const key = target.innId;
    const now = Date.now();
    let retryAfter = 0;
    for (const name of LIMIT_NAMES) {
      const status = await limiter.check(ctx, name, { key });
      if (!status.ok) retryAfter = Math.max(retryAfter, status.retryAfter);
    }
    if (retryAfter > 0) {
      const retryAt = now + Math.ceil(retryAfter);
      return { ok: false, kind: "throttled", retryAt, reason: throttleReason(retryAt, target.timezone) };
    }
    for (const name of LIMIT_NAMES) {
      const status = await limiter.limit(ctx, name, { key });
      // Same transaction as the checks above: this cannot fail unless the
      // configuration is inconsistent. Surface it rather than half-charge.
      if (!status.ok) throw new Error(`model budget ${name} denied after a passing check`);
    }
    return { ok: true };
  },
});

/** Current remaining operations per limit for an inn (internal; used by tests). */
export const peek = internalQuery({
  args: { innId: v.id("inns") },
  handler: async (ctx: QueryCtx, { innId }) => {
    const now = Date.now();
    const out: Record<(typeof LIMIT_NAMES)[number], number> = { modelBurst: 0, modelHourly: 0 };
    for (const name of LIMIT_NAMES) {
      const { value, ts, config } = await limiter.getValue(ctx, name, { key: innId });
      out[name] = calculateRateLimit({ value, ts }, config, now).value;
    }
    return out;
  },
});
