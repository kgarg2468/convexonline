/**
 * Product-scoped AgentMail webhook: the deployment owns exactly one
 * `message.received` hook (id in AGENTMAIL_WEBHOOK_ID, signing secret in
 * AGENTMAIL_WEBHOOK_SECRET, both set by scripts/register-webhook.mjs) that is
 * scoped to an explicit inbox list. Provisioning an inn's inbox appends the new
 * address to that list; it never creates hooks and never widens one to the
 * whole organization.
 *
 * Pure TypeScript (no Convex imports) so the checks are unit-testable offline.
 * Nothing here ever returns, logs or embeds the hook's `secret` field.
 */
import { ProviderError, type FetchLike, type HttpJsonResult, type ProviderErrorKind } from "../providers/shared";

export const WEBHOOK_PATH = "/api/agentmail/webhook";
export const WEBHOOK_EVENT = "message.received";
/** Provider limit: one webhook covers at most this many inboxes. */
export const MAX_INBOXES_PER_WEBHOOK = 10;
/** Upper bound on a webhook record body; the record is a handful of short fields. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export type WebhookTarget = { url: string; clientId: string };

/**
 * The hook url and client_id this deployment expects, derived from its site
 * origin exactly like scripts/register-webhook.mjs does (`frontdesk-<name>`
 * where `<name>` is the `.convex.site` host label). Returns undefined for a
 * value that is not an https origin.
 */
export function webhookTargetFor(siteUrl: string): WebhookTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
  const name = parsed.hostname.replace(/\.convex\.site$/i, "").toLowerCase();
  if (!name) return undefined;
  return { url: `${parsed.origin}${WEBHOOK_PATH}`, clientId: `frontdesk-${name}` };
}

export type WebhookCheck =
  | { ok: true; webhookId: string; inboxIds: string[] }
  | { ok: false; reason: string };

/**
 * Validates a `GET /v0/webhooks/:id` record against what this deployment
 * registered. Every failure is a configuration error the operator must fix by
 * re-running the register script; none of them are retried automatically.
 * The returned value never contains the secret.
 */
export function checkProductWebhook(record: unknown, expected: { webhookId: string } & WebhookTarget): WebhookCheck {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { ok: false, reason: "provider returned no webhook record" };
  }
  const r = record as Record<string, unknown>;
  if (typeof r.webhook_id === "string" && r.webhook_id !== expected.webhookId) {
    return { ok: false, reason: "webhook id does not match AGENTMAIL_WEBHOOK_ID" };
  }
  if (r.url !== expected.url) return { ok: false, reason: "webhook does not target this deployment's /api/agentmail/webhook" };
  if (r.client_id !== expected.clientId) return { ok: false, reason: "webhook client_id was not issued for this deployment" };
  if (r.enabled === false) return { ok: false, reason: "webhook is disabled at the provider" };
  const events = Array.isArray(r.event_types) ? r.event_types : [];
  if (!events.includes(WEBHOOK_EVENT)) return { ok: false, reason: `webhook does not subscribe to ${WEBHOOK_EVENT}` };
  const inboxIds = Array.isArray(r.inbox_ids) ? r.inbox_ids.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  if (inboxIds.length === 0) {
    return { ok: false, reason: "webhook is not scoped to inboxes (organization-wide hooks are refused)" };
  }
  return { ok: true, webhookId: expected.webhookId, inboxIds };
}

export type SubscriptionPlan = "subscribed" | "add" | "full";

/** Whether `inboxId` is already covered, can be appended, or the hook is at the provider limit. */
export function planSubscription(inboxIds: readonly string[], inboxId: string): SubscriptionPlan {
  if (inboxIds.includes(inboxId)) return "subscribed";
  return inboxIds.length >= MAX_INBOXES_PER_WEBHOOK ? "full" : "add";
}

/**
 * Reads `inbox_ids` from a PATCH response when the provider echoes the record;
 * undefined when the body carries no list (a 2xx without a record still counts
 * as the provider's acknowledgement).
 */
export function inboxIdsFrom(record: unknown): string[] | undefined {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
  const ids = (record as Record<string, unknown>).inbox_ids;
  if (!Array.isArray(ids)) return undefined;
  return ids.filter((x): x is string => typeof x === "string");
}

/**
 * Bounded JSON request for the GET/PATCH webhook calls (providers/shared.postJson
 * is POST-only). One timeout covers the whole exchange; non-2xx bodies are
 * discarded unread; oversized or non-JSON bodies never reach the caller as text.
 * Errors are ProviderError with our own messages only.
 */
export async function requestJson(
  fetchImpl: FetchLike,
  method: "GET" | "PATCH",
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
): Promise<HttpJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fail = (kind: ProviderErrorKind, message: string, cause: unknown, status?: number) =>
    new ProviderError({ provider: "agentmail", kind, status, message, retryable: kind !== "invalid_response", cause });
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
      throw fail(aborted ? "timeout" : "network", aborted ? `request timed out after ${timeoutMs}ms` : "network request failed", e);
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return { status: res.status, ok: false, json: undefined };
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
      throw fail(aborted ? "timeout" : "network", aborted ? `response body timed out after ${timeoutMs}ms` : "response body interrupted", e, res.status);
    }
    if (text.length > MAX_WEBHOOK_BODY_BYTES) {
      throw fail("invalid_response", `response body exceeded ${MAX_WEBHOOK_BODY_BYTES} bytes`, undefined, res.status);
    }
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: true, json };
  } finally {
    clearTimeout(timer);
  }
}
