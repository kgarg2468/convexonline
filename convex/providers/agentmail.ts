/**
 * AgentMail reply adapter. Sends a threaded reply through
 * POST /v0/inboxes/{inbox}/messages/{message}/reply.
 *
 * Delivery semantics: a send is not idempotent on the provider side (no
 * idempotency key is documented), so this adapter never retries. Any timeout,
 * network failure or 5xx is reported as `ambiguous: true` because the message
 * may already have been sent; callers must reconcile rather than resend blindly.
 */
import { httpError, isRecord, optionalString, postJson, ProviderError, requireNonEmpty, type FetchLike } from "./shared";

export const AGENTMAIL_BASE_URL = "https://api.agentmail.to";
export const AGENTMAIL_DEFAULT_TIMEOUT_MS = 15_000;
export const AGENTMAIL_MAX_TEXT_CHARS = 50_000;

export type ReplyToMessageArgs = {
  apiKey: string;
  inboxId: string;
  messageId: string;
  text: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
};

export type ReplyResult = { messageId: string; threadId?: string };

export async function replyToMessage(args: ReplyToMessageArgs): Promise<ReplyResult> {
  const apiKey = requireNonEmpty("agentmail", "apiKey", args.apiKey);
  const inboxId = requireNonEmpty("agentmail", "inboxId", args.inboxId);
  const messageId = requireNonEmpty("agentmail", "messageId", args.messageId);
  const text = requireNonEmpty("agentmail", "text", args.text);
  if (text.length > AGENTMAIL_MAX_TEXT_CHARS) {
    throw new ProviderError({
      provider: "agentmail",
      kind: "invalid_input",
      message: `text exceeds ${AGENTMAIL_MAX_TEXT_CHARS} characters`,
      retryable: false,
    });
  }
  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as FetchLike);
  const url =
    `${args.baseUrl ?? AGENTMAIL_BASE_URL}/v0/inboxes/${encodeURIComponent(inboxId)}` +
    `/messages/${encodeURIComponent(messageId)}/reply`;

  const res = await postJson(
    "agentmail",
    fetchImpl,
    url,
    apiKey,
    { text },
    args.timeoutMs ?? AGENTMAIL_DEFAULT_TIMEOUT_MS,
    /* ambiguousOnFailure */ true,
  );
  if (!res.ok) throw httpError("agentmail", res.status, /* ambiguousOn5xx */ true);

  const body = res.json;
  const sentId = isRecord(body) ? optionalString(body.message_id) : undefined;
  if (!sentId) {
    // 2xx without an id: the provider most likely accepted the send.
    throw new ProviderError({
      provider: "agentmail",
      kind: "invalid_response",
      status: res.status,
      message: "reply response did not include message_id",
      retryable: false,
      ambiguous: true,
    });
  }
  const threadId = isRecord(body) ? optionalString(body.thread_id) : undefined;
  return threadId ? { messageId: sentId, threadId } : { messageId: sentId };
}
