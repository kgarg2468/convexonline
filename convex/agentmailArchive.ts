/**
 * Durable, tenant-scoped archive of verified inbound deliveries in the
 * `@agentmail/convex` component (its `events` and `inboundMessages` tables).
 *
 * `inbound.receive` stays the authoritative path: the raw body is verified at
 * the HTTP root, the inbox is mapped to an owned live inn and the delivery is
 * deduplicated per inn *before* this helper runs, all in the same transaction.
 * The component call is a sub-mutation of that transaction, so the archive row
 * and the app's own receipt commit or roll back together. No component
 * callbacks are configured, so nothing is scheduled on its workpools and no
 * provider credentials are needed.
 *
 * The component deduplicates `event_id` globally, but the same provider event
 * (and the same event id) can legitimately be delivered to several inns. The
 * archived id is therefore namespaced by inn and the original id is hashed,
 * never truncated, so equal provider ids never collide across inns and an
 * oversized id cannot alias another. The original id is kept as bounded
 * metadata for operators.
 *
 * Only the app's parsed fields are archived, never the raw external payload:
 * the component stores the event twice (as `raw` on both rows), so every
 * string is bounded here to keep the documents far below Convex's size limit
 * even for a 2 MB delivery. Provider identity strings are never truncated:
 * oversized ones are archived as a namespaced hash (see `archiveIdentity`).
 * The app's own tables keep the exact provider ids for threading and replies.
 */
import type { AgentMailEvent } from "@agentmail/convex";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { MAX_INBOUND_TEXT, MAX_SUBJECT, type InboundEvent } from "./lib/inboundPayload";
import { sha256Hex } from "./lib/quotes";

/** Retry tuning the component requires in every call; irrelevant without callbacks or sends. */
export const ARCHIVE_CONFIG = { retryAttempts: 3, initialBackoffMs: 1000 } as const;

/** Address, header and metadata strings are capped for the archive copy only. */
export const MAX_ARCHIVE_ADDRESS = 2_048;
export const MAX_ARCHIVE_METADATA = 1_024;
export const MAX_ARCHIVE_PREVIEW = 200;
/**
 * Provider identity strings (`inbox_id`, `thread_id`, `message_id`) the
 * component indexes and stores four times (indexed field and `raw` on both
 * rows). Real AgentMail ids are far shorter than this and are archived exactly.
 */
export const MAX_ARCHIVE_IDENTITY = 1_024;
/**
 * Reserved prefix of the hashed identity form. A literal id that starts with
 * it is hashed too, so no delivery can present a short literal that equals the
 * hashed form of a different (oversized) id.
 */
export const HASHED_IDENTITY_PREFIX = "sha256:";

const cap = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** Stable component event id: namespaced by inn, original id hashed (never truncated). */
export async function archiveEventId(innId: Id<"inns">, originalEventId: string): Promise<string> {
  return `inn:${innId}:evt:${HASHED_IDENTITY_PREFIX}${await sha256Hex(originalEventId)}`;
}

/**
 * Bounded, collision-resistant archive form of a provider identity string.
 * Short ids that do not start with the reserved prefix are kept exact so the
 * component's own indexes still match them; anything else becomes
 * `sha256:<hex>` (never a truncation, so distinct ids never collide).
 */
export async function archiveIdentity(value: string): Promise<{ value: string; hashed: boolean }> {
  if (value.length <= MAX_ARCHIVE_IDENTITY && !value.startsWith(HASHED_IDENTITY_PREFIX)) return { value, hashed: false };
  return { value: `${HASHED_IDENTITY_PREFIX}${await sha256Hex(value)}`, hashed: true };
}

export type ArchiveEvent = AgentMailEvent & {
  metadata: {
    innId: Id<"inns">;
    original_event_id: string;
    original_event_id_length: number;
    /** Original lengths of the identity fields that were archived in hashed form (absent when all are exact). */
    hashed_identity_lengths?: Partial<Record<"inbox_id" | "thread_id" | "message_id", number>>;
  };
};

/** Builds the bounded, normalized `message.received` event the component archives. */
export async function normalizedArchiveEvent(innId: Id<"inns">, event: InboundEvent): Promise<ArchiveEvent> {
  const text = cap(event.text, MAX_INBOUND_TEXT);
  const receivedAt = Number.isFinite(event.receivedAt) ? Math.min(event.receivedAt, Date.now()) : Date.now();
  const timestamp = new Date(receivedAt);
  const [inboxId, threadId, messageId] = await Promise.all([
    archiveIdentity(event.inboxId),
    archiveIdentity(event.providerThreadId),
    archiveIdentity(event.providerMessageId),
  ]);
  const hashedLengths: NonNullable<ArchiveEvent["metadata"]["hashed_identity_lengths"]> = {
    ...(inboxId.hashed ? { inbox_id: event.inboxId.length } : {}),
    ...(threadId.hashed ? { thread_id: event.providerThreadId.length } : {}),
    ...(messageId.hashed ? { message_id: event.providerMessageId.length } : {}),
  };
  return {
    type: "event",
    event_type: "message.received",
    event_id: await archiveEventId(innId, event.eventId),
    message: {
      inbox_id: inboxId.value,
      thread_id: threadId.value,
      message_id: messageId.value,
      from: cap(event.from, MAX_ARCHIVE_ADDRESS),
      to: cap(event.to, MAX_ARCHIVE_ADDRESS),
      subject: cap(event.subject, MAX_SUBJECT),
      preview: text.replace(/\s+/g, " ").trim().slice(0, MAX_ARCHIVE_PREVIEW),
      text,
      in_reply_to: event.inReplyTo === undefined ? undefined : cap(event.inReplyTo, MAX_ARCHIVE_METADATA),
      timestamp: (Number.isNaN(timestamp.getTime()) ? new Date() : timestamp).toISOString(),
      ...(event.rfcMessageId === undefined ? {} : { headers: { "message-id": cap(event.rfcMessageId, MAX_ARCHIVE_METADATA) } }),
    },
    metadata: {
      innId,
      original_event_id: cap(event.eventId, MAX_ARCHIVE_METADATA),
      original_event_id_length: event.eventId.length,
      ...(Object.keys(hashedLengths).length > 0 ? { hashed_identity_lengths: hashedLengths } : {}),
    },
  };
}

/**
 * Archives one verified, owned, not-yet-seen delivery in the component. Must be
 * called from `inbound.receive` after its inn and dedupe checks; throws (and so
 * rolls the whole receipt back) if the component write fails.
 */
export async function archiveInbound(ctx: Pick<MutationCtx, "runMutation">, innId: Id<"inns">, event: InboundEvent): Promise<{ archiveEventId: string }> {
  const normalized = await normalizedArchiveEvent(innId, event);
  await ctx.runMutation(components.agentmail.lib.handleEvent, { config: ARCHIVE_CONFIG, event: normalized });
  return { archiveEventId: normalized.event_id };
}
