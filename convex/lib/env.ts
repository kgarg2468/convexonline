/**
 * Deployment environment access. Values are read only inside Convex functions
 * and never returned to clients; `integrationStatus` exposes booleans only.
 */

export type IntegrationName =
  | "OPENAI_API_KEY"
  | "FIRECRAWL_API_KEY"
  | "AGENTMAIL_API_KEY"
  | "AGENTMAIL_WEBHOOK_SECRET"
  /** Provider id of the product-scoped `message.received` webhook (set by scripts/register-webhook.mjs). */
  | "AGENTMAIL_WEBHOOK_ID"
  /** Deployment site origin, provided by Convex; the webhook must target it. */
  | "CONVEX_SITE_URL";

export function readEnv(name: IntegrationName): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = env?.[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function hasEnv(name: IntegrationName): boolean {
  return readEnv(name) !== undefined;
}

export function integrationStatus() {
  return {
    openai: hasEnv("OPENAI_API_KEY"),
    firecrawl: hasEnv("FIRECRAWL_API_KEY"),
    agentmail: hasEnv("AGENTMAIL_API_KEY"),
    webhookSecret: hasEnv("AGENTMAIL_WEBHOOK_SECRET"),
    /** The deployment knows which provider webhook it owns; not proof that any inbox is subscribed. */
    webhookId: hasEnv("AGENTMAIL_WEBHOOK_ID"),
  };
}

/** Today's date in YYYY-MM-DD for the given IANA timezone (falls back to UTC). */
export function currentDateIn(timezone: string, now = Date.now()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(now));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const out = `${get("year")}-${get("month")}-${get("day")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
  } catch {
    // fall through
  }
  return new Date(now).toISOString().slice(0, 10);
}
