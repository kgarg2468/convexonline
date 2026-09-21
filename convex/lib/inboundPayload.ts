/**
 * Parses an AgentMail `message.received` webhook body into the fields the
 * inbound mutation needs. Shape follows the PoC evidence
 * (poc/infra/POC-KEYS-RESULTS.md §M2): `event_type`, `event_id`, `message`
 * with `inbox_id`, `message_id`, `thread_id`, `from` (string), `to` (string or
 * array), `subject`, `text`, `extracted_text`, `preview`, `timestamp`,
 * `in_reply_to` (absent on first messages).
 */

export const MAX_INBOUND_TEXT = 50_000;
export const MAX_SUBJECT = 500;

export type InboundEvent = {
  eventId: string;
  inboxId: string;
  providerMessageId: string;
  providerThreadId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  rfcMessageId?: string;
  receivedAt: number;
};

export type ParsedWebhook =
  | { kind: "message_received"; event: InboundEvent }
  | { kind: "ignored_event"; eventType: string }
  | { kind: "invalid"; reason: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x.trim().length > 0 ? x : undefined;
}

function addressString(x: unknown): string | undefined {
  if (typeof x === "string") return str(x);
  if (Array.isArray(x)) {
    const parts = x.map((v) => (typeof v === "string" ? v : isRecord(v) ? str(v.email) ?? str(v.address) : undefined));
    const joined = parts.filter((p): p is string => !!p).join(", ");
    return joined || undefined;
  }
  if (isRecord(x)) return str(x.email) ?? str(x.address);
  return undefined;
}

/** Extracts the bare address from "Name <addr@host>" for thread matching/display. */
export function bareAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  const addr = (m ? m[1] : from).trim().toLowerCase();
  return addr.length > 0 ? addr : from.trim().toLowerCase();
}

export function parseWebhookBody(raw: unknown): ParsedWebhook {
  if (!isRecord(raw)) return { kind: "invalid", reason: "body is not an object" };
  const eventType = str(raw.event_type);
  const eventId = str(raw.event_id);
  if (!eventType || !eventId) return { kind: "invalid", reason: "event_type and event_id are required" };
  if (eventType !== "message.received") return { kind: "ignored_event", eventType };
  const m = raw.message;
  if (!isRecord(m)) return { kind: "invalid", reason: "message.received without message" };
  const inboxId = str(m.inbox_id);
  const providerMessageId = str(m.message_id);
  const providerThreadId = str(m.thread_id);
  const from = addressString(m.from) ?? addressString(m.from_);
  if (!inboxId || !providerMessageId || !providerThreadId || !from) {
    return { kind: "invalid", reason: "message is missing inbox_id, message_id, thread_id or from" };
  }
  const textRaw = str(m.extracted_text) ?? str(m.text) ?? str(m.preview) ?? "";
  const text = textRaw.slice(0, MAX_INBOUND_TEXT);
  const subject = (str(m.subject) ?? "(no subject)").slice(0, MAX_SUBJECT);
  let receivedAt = Date.now();
  const ts = m.timestamp;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) receivedAt = parsed;
  } else if (typeof ts === "number" && Number.isFinite(ts)) {
    receivedAt = ts > 1e12 ? ts : ts * 1000;
  }
  const headers = isRecord(m.headers) ? m.headers : {};
  const rfcMessageId = str(headers["message-id"]) ?? str(headers["Message-ID"]) ?? str(headers["Message-Id"]);
  return {
    kind: "message_received",
    event: {
      eventId,
      inboxId,
      providerMessageId,
      providerThreadId,
      from,
      to: addressString(m.to) ?? inboxId,
      subject,
      text,
      inReplyTo: str(m.in_reply_to),
      rfcMessageId,
      receivedAt,
    },
  };
}
