/**
 * Pure helpers behind the dashboard's deltas and labels. The server computes
 * every number (convex/overview.ts); this file only decides how a pair of
 * numbers is described, so it can be unit-tested without React.
 */

/** How a KPI moved against its previous window. */
export type Delta =
  /** A signed, rounded change: percent for counts and durations, points for a percentage. */
  | { kind: "change"; amount: number; unit: "%" | "pts" }
  /** The previous window had nothing, so a percent change is undefined. */
  | { kind: "new" }
  /** One side is unknown (no first responses, no sends): nothing to compare. */
  | { kind: "unknown" };

export function computeDelta(value: number | null, previous: number | null, unit: "%" | "pts"): Delta {
  if (value === null || previous === null) return { kind: "unknown" };
  if (unit === "pts") return { kind: "change", amount: Math.round((value - previous) * 10) / 10, unit };
  if (previous === 0) return value === 0 ? { kind: "change", amount: 0, unit } : { kind: "new" };
  return { kind: "change", amount: Math.round(((value - previous) / previous) * 100), unit };
}

/**
 * Which way is good for a metric: more replies is good, a shorter response
 * time is good, and corrections have no good direction (a correction sent is
 * a fix, a correction needed is a miss). Encoded here, never inferred from
 * the sign (research-principles §135).
 */
export type GoodDirection = "up" | "down" | "none";

export type DeltaTone = "success" | "danger" | "neutral";

/** Semantic colour only when the metric moved and has a good direction; otherwise quiet. */
export function deltaTone(delta: Delta, good: GoodDirection): DeltaTone {
  if (good === "none" || delta.kind === "unknown") return "neutral";
  const up = delta.kind === "new" || delta.amount > 0;
  if (delta.kind === "change" && delta.amount === 0) return "neutral";
  return up === (good === "up") ? "success" : "danger";
}

/** "+12%", "−3 pts", "0%": a signed amount, using a real minus sign. */
export function formatDeltaAmount(delta: Extract<Delta, { kind: "change" }>): string {
  const sign = delta.amount > 0 ? "+" : delta.amount < 0 ? "−" : "";
  const abs = Math.abs(delta.amount);
  return delta.unit === "%" ? `${sign}${abs}%` : `${sign}${abs} pts`;
}

/**
 * Short zone label ("PDT", "GMT+1") so staff know the windows follow the inn's
 * calendar, not their browser's. Null when the zone is unknown to this browser.
 * (Same rule as the inbox statistics strip.)
 */
export function zoneLabel(timezone: string | undefined): string | null {
  if (!timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(Date.now());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

/** The inn's calendar date for `ms` ("Tue, Sep 22"); the browser's zone when the inn's is unknown. */
export function localDateLabel(ms: number, timezone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: timezone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(ms);
  }
}

/** "Sep 9": a day-series tick in the inn's zone. */
export function shortDayLabel(ms: number, timezone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: timezone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(ms);
  }
}

/**
 * The header's sub line: scope only ("Tue, Sep 22 · inn time, PDT · last 7
 * days"). The counts live in the needs-action strip below it, not here.
 */
export function overviewSubtitle(now: number, timezone: string | undefined): string {
  const zone = zoneLabel(timezone);
  return [localDateLabel(now, timezone), zone ? `inn time, ${zone}` : null, "last 7 days"].filter(Boolean).join(" · ");
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
