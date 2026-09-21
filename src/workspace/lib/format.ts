import { ConvexError } from "convex/values";

const absolute = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const dateOnly = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function formatWhen(ms: number, now = Date.now()): string {
  const diff = now - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} d ago`;
  return dateOnly.format(ms);
}

export function formatStamp(ms: number): string {
  return absolute.format(ms);
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const parsed = new Date(`${iso}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? iso : dateOnly.format(parsed);
}

export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

export function guestName(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.host : u.pathname;
  } catch {
    return url;
  }
}

type ErrorData = {
  code?: string;
  message?: string;
  heldByName?: string | null;
  expiresAt?: number;
  reason?: string;
  retryAt?: number;
};

/** Server guard codes (see convex/lib/sendGuards.ts and the integration contracts) as staff-facing sentences. */
const CODE_MESSAGE: Record<string, string> = {
  not_ready: "This draft is not ready to send. It must be verified, or edited by you and sent as staff-written.",
  unverified_edit:
    "The text was edited after verification. Tick the staff-written confirmation to send it as your own words.",
  stale_inbound: "The guest wrote again after this draft was made. It answers an older message.",
  stale_source: "A page or fact this text relies on has changed since it was checked.",
  in_flight: "This message was already handed to the sender. Wait for its delivery state.",
  already_sent: "This was already sent.",
  no_reply_target: "There is no guest message to reply to.",
  inbox_not_configured: "This property has no inbox yet. Set one up in Settings.",
  not_approved: "Approve the correction before sending it.",
  invalid_quote: "That quote is not in the current page text.",
  demo_inn: "Not available on a demo property.",
  owner_only: "Only the property owner can do this.",
  already_configured: "An inbox is already set up for this property.",
  agentmail_unavailable: "Mail provisioning is not configured on this deployment.",
  provision_failed: "The mail provider could not create the inbox.",
  firecrawl_unavailable: "Site crawling is not configured on this deployment.",
  invalid_site_url: "The property website must be a public https address.",
  crawl_failed: "The site could not be crawled.",
  invalid: "The server rejected that request.",
};

/**
 * `invalid` and `claimed` errors come from our own validated backend with a
 * short, staff-facing message ("Time zone "X" is not recognized; …"). Keep it
 * when it is a bounded single-line sentence; otherwise fall back to the
 * generic one so a raw payload or stack trace never reaches the screen.
 */
const MAX_SERVER_MESSAGE = 300;
function boundedServerMessage(message: string | undefined): string | undefined {
  if (typeof message !== "string") return undefined;
  const text = message.trim();
  if (text.length === 0 || text.length > MAX_SERVER_MESSAGE) return undefined;
  // Newlines and other control characters mean a stack trace or raw payload, not a sentence.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c === 127) return undefined;
  }
  return text;
}

/** Turns a thrown Convex error into a sentence staff can act on. */
export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as ErrorData | string;
    if (typeof data === "string") return data;
    switch (data.code) {
      case "claimed": {
        // The server says exactly what is wrong when it can (e.g. "Claim the
        // thread before approving a follow-up"); that beats guessing.
        const explicit = boundedServerMessage(data.message);
        if (explicit) return explicit;
        if (data.heldByName) {
          const until = data.expiresAt ? ` until ${absolute.format(data.expiresAt)}` : "";
          return `${data.heldByName} is working on this thread${until}.`;
        }
        // No holder metadata: usually the caller's own claim expired or was
        // never taken, so "another staff member" would be false.
        return "You need an active claim on this thread to continue.";
      }
      case "unauthenticated":
        return "Your session ended. Sign in again.";
      case "forbidden":
        return data.message ?? "You do not have access to that.";
      case "live_mail_forbidden":
        return "Live mail is not available for this workspace.";
      case "cooldown": {
        const until = data.retryAt ? ` Try again after ${absolute.format(data.retryAt)}.` : "";
        return `Too soon since the last run.${until}`;
      }
      default: {
        const known = data.code ? CODE_MESSAGE[data.code] : undefined;
        if (known && data.code === "crawl_failed" && data.message) return `${known} ${data.message}`;
        if (known && data.code === "provision_failed" && data.message) return `${known} ${data.message}`;
        if (data.code === "invalid") return boundedServerMessage(data.message) ?? known!;
        return known ?? data.message ?? "Something went wrong.";
      }
    }
  }
  if (error instanceof Error) {
    // Auth provider errors arrive as plain Errors with a server message.
    const text = error.message;
    if (/InvalidAccountId|InvalidSecret/.test(text)) return "Email or password is incorrect.";
    if (/already exists/i.test(text)) return "An account with this email already exists. Sign in instead.";
    const server = text.match(/Uncaught Error: ([^\n]+)/);
    if (server) return server[1]!;
    return text;
  }
  return "Something went wrong.";
}

export const STATUS_LABEL: Record<string, string> = {
  new: "New",
  drafting: "Drafting",
  needs_staff: "Needs you",
  ready: "Ready to send",
  sent: "Sent",
  waiting_guest: "Waiting on guest",
  closed: "Closed",
};

export const LIVE_MAIL_REASON: Record<string, string> = {
  no_membership: "You are not a member of this inn.",
  anonymous_user: "Demo visitors cannot send real email.",
  demo_inn: "This is a demo workspace. No real email is sent.",
  demo_role: "Your role on this inn is demo-only.",
};

export const OUTBOX_LABEL: Record<string, { label: string; tone: "neutral" | "pine" | "caution" | "error" | "muted" }> = {
  reserved: { label: "Queued to send", tone: "neutral" },
  sending: { label: "Sending", tone: "neutral" },
  sent: { label: "Delivered", tone: "pine" },
  failed: { label: "Failed", tone: "error" },
  unknown: { label: "Delivery unknown", tone: "caution" },
};

export const CLAIM_STATUS_LABEL: Record<string, string> = {
  ok: "Verified",
  stripped: "Not in source",
  needs_review: "Source changed",
  corrected: "Corrected",
};

export function formatDuration(ms: number): string {
  const minute = 60_000;
  if (ms < minute) return "under a minute";
  if (ms < 60 * minute) return `${Math.round(ms / minute)} min`;
  const hours = ms / (60 * minute);
  return hours < 48 ? `${hours.toFixed(1)} h` : `${Math.round(hours / 24)} d`;
}
