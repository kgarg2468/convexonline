/**
 * Shared helpers for provider adapters. Pure TypeScript; no Convex imports so
 * the modules are unit-testable offline and callable from any Convex action.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ProviderName = "agentmail" | "firecrawl" | "openai";

export type ProviderErrorKind =
  | "missing_credentials"
  | "invalid_input"
  | "timeout"
  | "network"
  | "http"
  | "invalid_response"
  | "refusal";

export type ProviderErrorOptions = {
  provider: ProviderName;
  kind: ProviderErrorKind;
  message: string;
  status?: number;
  retryable: boolean;
  /** True when the provider may have completed the operation even though we saw an error. */
  ambiguous?: boolean;
  cause?: unknown;
};

/**
 * Typed, sanitized error. The message is always built from our own strings,
 * never from provider bodies or credentials.
 */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(opts: ProviderErrorOptions) {
    super(`${opts.provider}: ${opts.message}`);
    this.name = "ProviderError";
    this.provider = opts.provider;
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.ambiguous = opts.ambiguous ?? false;
  }
}

export function requireNonEmpty(provider: ProviderName, name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderError({
      provider,
      kind: name === "apiKey" ? "missing_credentials" : "invalid_input",
      message: `${name} is required`,
      retryable: false,
    });
  }
  return value;
}

export type HttpJsonResult = { status: number; ok: boolean; json: unknown };

/**
 * Upper bound on a response body we are willing to buffer. Large enough for a
 * whole-site Firecrawl map/scrape, small enough to keep a Convex action from
 * exhausting memory on a runaway stream.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * POST JSON with a bounded timeout that covers the *entire* exchange: connect,
 * headers and the complete response body. Timeouts, network failures and body
 * interruptions surface as ProviderError; `ambiguousOnFailure` decides whether
 * they are ambiguous (the provider may have completed the operation even
 * though we never saw a usable response, e.g. AgentMail sends). Non-2xx bodies
 * are discarded unread. Bodies larger than MAX_RESPONSE_BYTES are rejected as
 * `invalid_response`. Non-JSON bodies yield `json: undefined` so callers can
 * reject them without echoing content.
 */
export async function postJson(
  provider: ProviderName,
  fetchImpl: FetchLike,
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  ambiguousOnFailure: boolean,
): Promise<HttpJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = () => controller.signal.aborted;
  const fail = (kind: ProviderErrorKind, message: string, cause: unknown, status?: number) =>
    new ProviderError({
      provider,
      kind,
      status,
      message,
      retryable: kind === "invalid_response" ? false : !ambiguousOnFailure,
      ambiguous: ambiguousOnFailure,
      cause,
    });
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = timedOut() || (e instanceof Error && e.name === "AbortError");
      throw fail(
        aborted ? "timeout" : "network",
        aborted ? `request timed out after ${timeoutMs}ms` : "network request failed",
        e,
      );
    }
    if (!res.ok) {
      // Callers never inspect error bodies; drop them without reading.
      void res.body?.cancel().catch(() => undefined);
      return { status: res.status, ok: false, json: undefined };
    }
    let text: string;
    try {
      text = await readBodyBounded(res, controller.signal, MAX_RESPONSE_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        throw fail("invalid_response", `response body exceeded ${MAX_RESPONSE_BYTES} bytes`, e, res.status);
      }
      const aborted = timedOut() || (e instanceof Error && e.name === "AbortError");
      throw fail(
        aborted ? "timeout" : "network",
        aborted ? `response body timed out after ${timeoutMs}ms` : "response body interrupted",
        e,
        res.status,
      );
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

class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/**
 * Reads the full body as text, aborting when `signal` fires or the byte count
 * passes `maxBytes`. Falls back to `res.text()` (raced against the signal) for
 * Response-like objects without a readable stream.
 */
async function readBodyBounded(res: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  if (signal.aborted) throw abortError();
  const stream = res.body;
  if (!stream || typeof stream.getReader !== "function") {
    return await new Promise<string>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
      res.text().then(resolve, reject);
    });
  }
  const reader = stream.getReader();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let out = "";
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortError();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new BodyTooLargeError();
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (received > maxBytes) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Builds the error for a non-2xx status without exposing the response body. */
export function httpError(provider: ProviderName, status: number, ambiguousOn5xx: boolean): ProviderError {
  const serverSide = status >= 500;
  const rateLimited = status === 429;
  return new ProviderError({
    provider,
    kind: "http",
    status,
    message: `provider responded with HTTP ${status}`,
    retryable: rateLimited || (serverSide && !ambiguousOn5xx),
    ambiguous: serverSide && ambiguousOn5xx,
  });
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function optionalString(x: unknown): string | undefined {
  return typeof x === "string" && x.length > 0 ? x : undefined;
}
