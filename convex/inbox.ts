import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireLiveMailAccess } from "./access";
import { readEnv } from "./lib/env";
import { describeError } from "./lib/errors";
import { checkProductWebhook, inboxIdsFrom, MAX_INBOXES_PER_WEBHOOK, planSubscription, requestJson, webhookTargetFor } from "./lib/inboxWebhook";
import { AGENTMAIL_BASE_URL } from "./providers/agentmail";
import { httpError, isRecord, optionalString, postJson, ProviderError, type FetchLike } from "./providers/shared";

const PROVIDER_TIMEOUT_MS = 15_000;

/** Provider-safe display name: letters, digits, spaces and a few marks, ≤ 60 chars. */
export function constrainDisplayName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 .'&-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return cleaned.length >= 2 ? cleaned : "Front Desk";
}

/** Deterministic username per inn so a retried provisioning cannot mint a second address. */
export function usernameFor(innId: string): string {
  return `frontdesk-${innId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}`;
}

/** Manager-only binding of an inbox the deployment owns (run via `npx convex run inbox:configureInbox`). */
export const configureInbox = internalMutation({
  args: { innId: v.id("inns"), inboxId: v.string(), inboxAddress: v.optional(v.string()), clientId: v.optional(v.string()) },
  handler: async (ctx, { innId, inboxId, inboxAddress, clientId }) => {
    const inn = await ctx.db.get(innId);
    if (!inn) throw new ConvexError({ code: "not_found", message: "inn not found" });
    if (inn.isDemo) throw new ConvexError({ code: "demo_inn", message: "demo inns never get a live inbox" });
    const trimmed = inboxId.trim();
    if (!trimmed.includes("@")) throw new ConvexError({ code: "invalid", message: "inboxId must be an address" });
    const taken = await ctx.db
      .query("inns")
      .withIndex("by_inboxId", (q) => q.eq("inboxId", trimmed))
      .first();
    if (taken && taken._id !== innId) throw new ConvexError({ code: "invalid", message: "inbox already bound to another inn" });
    await ctx.db.patch(innId, {
      inboxId: trimmed,
      inboxAddress: inboxAddress?.trim() || trimmed,
      inboxClientId: clientId,
      // A different address than before is not subscribed anywhere yet.
      ...(inn.inboxId !== trimmed ? { inboxWebhookId: undefined, inboxWebhookConfirmedAt: undefined } : {}),
    });
    return null;
  },
});

/**
 * Records that the provider confirmed the inn's bound inbox is on the product
 * webhook. Refuses to mark a different address than the one currently bound.
 */
export const recordWebhookSubscription = internalMutation({
  args: { innId: v.id("inns"), inboxId: v.string(), webhookId: v.string() },
  handler: async (ctx, { innId, inboxId, webhookId }) => {
    const inn = await ctx.db.get(innId);
    if (!inn) throw new ConvexError({ code: "not_found", message: "inn not found" });
    if (inn.inboxId !== inboxId) throw new ConvexError({ code: "invalid", message: "inbox binding changed during provisioning" });
    await ctx.db.patch(innId, { inboxWebhookId: webhookId, inboxWebhookConfirmedAt: Date.now() });
    return null;
  },
});

/**
 * Authorization plus the inn's current provisioning state. Whether the inn is
 * "already configured" depends on the deployment's current webhook, which the
 * action decides, so this mutation only reports what is recorded.
 */
export const authorizeProvision = internalMutation({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    const access = await requireLiveMailAccess(ctx, innId);
    if (access.membership.role !== "owner") throw new ConvexError({ code: "owner_only", message: "Only the owner can provision an inbox" });
    return {
      name: access.inn.name,
      inboxId: access.inn.inboxId ?? null,
      inboxWebhookId: access.inn.inboxWebhookId ?? null,
    };
  },
});

const providerFailure = (e: unknown) => new ConvexError({ code: "provision_failed", message: describeError(e).message });

/**
 * Creates the inn's address at the provider and subscribes it to the
 * deployment's product webhook. Order of operations (each step idempotent on
 * retry, nothing client-supplied):
 *
 *   1. the deployment must know its webhook (AGENTMAIL_WEBHOOK_ID) — otherwise a
 *      clear onboarding error before any provider call;
 *   2. GET the webhook and verify it is ours: url, client_id, enabled,
 *      `message.received`, explicitly scoped (never organization-wide);
 *   3. refuse with `webhook_full` when the hook is at the provider's 10-inbox
 *      limit, before creating an inbox that could never receive mail;
 *   4. create the inbox (username + client_id derived from the inn id) and
 *      record the binding once the provider returns it;
 *   5. PATCH `{ add_inbox_ids: [inbox] }` (append, atomic at the provider) and
 *      record the confirmed hook only after a 2xx.
 *
 * A failure after step 4 leaves the inbox bound but unsubscribed; calling
 * `provision` again skips creation and only completes the subscription.
 * The provider's GET/PATCH responses carry the hook's signing secret; it is
 * never logged, stored or returned.
 */
export const createAtProvider = internalAction({
  args: {
    innId: v.id("inns"),
    name: v.string(),
    existingInboxId: v.union(v.string(), v.null()),
    recordedWebhookId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { innId, name, existingInboxId, recordedWebhookId }) => {
    const webhookId = readEnv("AGENTMAIL_WEBHOOK_ID");
    if (existingInboxId && webhookId && recordedWebhookId === webhookId) {
      throw new ConvexError({ code: "already_configured", message: "This inn already has an inbox" });
    }
    const apiKey = readEnv("AGENTMAIL_API_KEY");
    if (!apiKey) throw new ConvexError({ code: "agentmail_unavailable", message: "Mail provisioning is not configured" });
    const siteUrl = readEnv("CONVEX_SITE_URL");
    const target = siteUrl ? webhookTargetFor(siteUrl) : undefined;
    if (!webhookId || !target) {
      throw new ConvexError({
        code: "webhook_not_configured",
        message: "The inbound mail webhook is not registered for this deployment; run scripts/register-webhook.mjs first",
      });
    }
    const fetchImpl = globalThis.fetch as FetchLike;
    const hookUrl = `${AGENTMAIL_BASE_URL}/v0/webhooks/${encodeURIComponent(webhookId)}`;

    // 2. The configured hook must be the product hook for this deployment.
    let got;
    try {
      got = await requestJson(fetchImpl, "GET", hookUrl, apiKey, undefined, PROVIDER_TIMEOUT_MS);
    } catch (e) {
      throw providerFailure(e);
    }
    if (!got.ok) {
      if (got.status === 404) {
        throw new ConvexError({
          code: "webhook_not_found",
          message: "The registered inbound mail webhook no longer exists at the provider; re-run scripts/register-webhook.mjs",
          status: got.status,
        });
      }
      const err = httpError("agentmail", got.status, false);
      throw new ConvexError({
        code: "provision_failed",
        message: got.status === 402 ? "The mail provider account has no credits" : err.message,
        status: got.status,
      });
    }
    const check = checkProductWebhook(got.json, { webhookId, ...target });
    if (!check.ok) {
      throw new ConvexError({ code: "webhook_mismatch", message: `Inbound mail webhook is misconfigured: ${check.reason}` });
    }

    // 3. Capacity: never mint an inbox the hook cannot cover.
    const clientId = `frontdesk-inn-${innId}`;
    let inboxId = existingInboxId ?? undefined;
    const alreadyCovered = inboxId !== undefined && planSubscription(check.inboxIds, inboxId) === "subscribed";
    if (!alreadyCovered && check.inboxIds.length >= MAX_INBOXES_PER_WEBHOOK) {
      throw new ConvexError({
        code: "webhook_full",
        message: `The inbound mail webhook already covers ${MAX_INBOXES_PER_WEBHOOK} inboxes (provider limit); register a new webhook before adding inns`,
      });
    }

    // 4. Create the inbox (idempotent via the server-derived client_id).
    if (!inboxId) {
      let res;
      try {
        res = await postJson(
          "agentmail",
          fetchImpl as Parameters<typeof postJson>[1],
          `${AGENTMAIL_BASE_URL}/v0/inboxes`,
          apiKey,
          { username: usernameFor(innId), display_name: constrainDisplayName(name), client_id: clientId },
          PROVIDER_TIMEOUT_MS,
          false,
        );
      } catch (e) {
        throw providerFailure(e);
      }
      if (!res.ok) {
        const err = httpError("agentmail", res.status, false);
        throw new ConvexError({ code: "provision_failed", message: err.message, status: res.status });
      }
      const created = isRecord(res.json) ? optionalString(res.json.inbox_id) : undefined;
      if (!created) {
        throw new ConvexError({ code: "provision_failed", message: new ProviderError({ provider: "agentmail", kind: "invalid_response", message: "no inbox_id", retryable: false }).message });
      }
      inboxId = created;
      await ctx.runMutation(internal.inbox.configureInbox, { innId, inboxId, inboxAddress: inboxId, clientId });
    }

    // 5. Append to the hook's scope; the provider applies add_inbox_ids atomically.
    if (planSubscription(check.inboxIds, inboxId) === "add") {
      let patched;
      try {
        patched = await requestJson(fetchImpl, "PATCH", hookUrl, apiKey, { add_inbox_ids: [inboxId] }, PROVIDER_TIMEOUT_MS);
      } catch (e) {
        throw new ConvexError({ code: "webhook_subscribe_failed", message: `Inbox created but not yet subscribed (${describeError(e).message}); retry provisioning` });
      }
      if (!patched.ok) {
        throw new ConvexError({
          code: "webhook_subscribe_failed",
          message: `Inbox created but not yet subscribed (${httpError("agentmail", patched.status, false).message}); retry provisioning`,
          status: patched.status,
        });
      }
      const echoed = inboxIdsFrom(patched.json);
      if (echoed && !echoed.includes(inboxId)) {
        throw new ConvexError({ code: "webhook_subscribe_failed", message: "Provider did not confirm the inbox on the webhook; retry provisioning" });
      }
    }
    await ctx.runMutation(internal.inbox.recordWebhookSubscription, { innId, inboxId, webhookId });
    return { inboxAddress: inboxId };
  },
});

export const provision = action({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }): Promise<{ inboxAddress: string }> => {
    const state = await ctx.runMutation(internal.inbox.authorizeProvision, { innId });
    return await ctx.runAction(internal.inbox.createAtProvider, {
      innId,
      name: state.name,
      existingInboxId: state.inboxId,
      recordedWebhookId: state.inboxWebhookId,
    });
  },
});
