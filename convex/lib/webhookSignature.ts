/**
 * Standard Webhooks (Svix) signature verification over the raw request body.
 *
 *   signed = `${id}.${timestamp}.${body}`
 *   header `webhook-signature` / `svix-signature` = "v1,<base64 hmac-sha256>" (space separated list)
 *   secret = "whsec_" + base64 key
 *
 * Pure Web Crypto so it runs in the Convex default runtime and in tests. The
 * comparison is constant time over the decoded bytes; the timestamp must be
 * within TOLERANCE_SECONDS of `now` to defeat replay of captured deliveries.
 */

export const TOLERANCE_SECONDS = 5 * 60;

export type SignatureHeaders = { id: string | null; timestamp: string | null; signature: string | null };

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "bad_timestamp" | "stale_timestamp" | "bad_secret" | "no_match" };

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function readSignatureHeaders(headers: Headers): SignatureHeaders {
  const pick = (a: string, b: string) => headers.get(a) ?? headers.get(b);
  return {
    id: pick("svix-id", "webhook-id"),
    timestamp: pick("svix-timestamp", "webhook-timestamp"),
    signature: pick("svix-signature", "webhook-signature"),
  };
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  headers: SignatureHeaders,
  nowMs = Date.now(),
): Promise<VerifyResult> {
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, reason: "missing_headers" };
  if (!/^\d+$/.test(headers.timestamp)) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(headers.timestamp);
  if (Math.abs(nowMs / 1000 - ts) > TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };
  const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = base64ToBytes(keyB64);
  if (!keyBytes || keyBytes.length === 0) return { ok: false, reason: "bad_secret" };
  const expected = await hmacSha256(keyBytes, `${headers.id}.${headers.timestamp}.${rawBody}`);
  for (const part of headers.signature.split(/\s+/)) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = base64ToBytes(value);
    if (given && constantTimeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "no_match" };
}

/** Test/tooling helper: produces the headers a Svix delivery would carry. */
export async function signWebhook(
  secret: string,
  rawBody: string,
  id: string,
  nowMs = Date.now(),
): Promise<{ "svix-id": string; "svix-timestamp": string; "svix-signature": string }> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = base64ToBytes(keyB64);
  if (!keyBytes) throw new Error("invalid secret");
  const mac = await hmacSha256(keyBytes, `${id}.${timestamp}.${rawBody}`);
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${bytesToBase64(mac)}` };
}
