/**
 * Calendar days in an inn's IANA time zone, computed from `Intl` alone so
 * DST transitions and zones east/west of UTC come out right without a
 * library. Pure: safe to call from queries, mutations and tests.
 */

export type LocalDay = {
  /** YYYY-MM-DD of the local calendar day containing the instant. */
  dayKey: string;
  /** Epoch ms of local midnight that starts the day. */
  startMs: number;
  /** Epoch ms of the next local midnight; the day is [startMs, endMs). */
  endMs: number;
  /** The zone the day was computed in (UTC when the requested zone is unusable). */
  timezone: string;
};

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const cached = FORMATTERS.get(timezone);
  if (cached) return cached;
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(timezone, f);
    return f;
  } catch {
    return null;
  }
}

function partsIn(f: Intl.DateTimeFormat, ms: number): Parts {
  const out: Partial<Parts> = {};
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type === "year" || p.type === "month" || p.type === "day" || p.type === "hour" || p.type === "minute" || p.type === "second") {
      out[p.type] = Number(p.value);
    }
  }
  // Some engines print midnight as "24" even with hourCycle h23.
  if (out.hour === 24) out.hour = 0;
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Epoch ms of the local wall-clock midnight of (year, month, day) in the zone. */
function localMidnightMs(f: Intl.DateTimeFormat, year: number, month: number, day: number): number {
  const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = wanted;
  // Converge on the instant whose local wall clock reads midnight. Two
  // rounds cover every fixed offset and DST edge; a midnight that does not
  // exist (a zone whose DST gap starts at 00:00) settles on the first instant
  // of the day instead.
  for (let i = 0; i < 3; i++) {
    const p = partsIn(f, guess);
    const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = local - wanted;
    if (diff === 0) break;
    guess -= diff;
  }
  // If the wall clock still reads a different day the midnight fell in a DST
  // gap; step forward minute by minute to the first instant of the day.
  let p = partsIn(f, guess);
  let steps = 0;
  while ((p.year !== year || p.month !== month || p.day !== day) && steps < 180) {
    guess += 60_000;
    p = partsIn(f, guess);
    steps += 1;
  }
  return guess;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * The local calendar day of `nowMs` in `timezone`. Unknown or malformed
 * zones fall back to UTC (mirrors `currentDateIn`), so a bad setting can
 * never break the stats screen.
 */
export function localDayOf(timezone: string, nowMs: number): LocalDay {
  const f = formatterFor(timezone) ?? formatterFor("UTC")!;
  const zone = formatterFor(timezone) ? timezone : "UTC";
  const p = partsIn(f, nowMs);
  const startMs = localMidnightMs(f, p.year, p.month, p.day);
  // The next day's midnight: advance the civil date by one day in UTC space,
  // which cannot skip or repeat days, then resolve it in the zone.
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const endMs = localMidnightMs(f, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return {
    dayKey: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`,
    startMs,
    endMs,
    timezone: zone,
  };
}

/** Epoch ms when the inn's current local day began. */
export function localDayStartMs(timezone: string, nowMs: number): number {
  return localDayOf(timezone, nowMs).startMs;
}
