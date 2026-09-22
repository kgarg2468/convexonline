import type { ReactNode } from "react";
import type { ThreadStats } from "../types";
import { formatDuration } from "../lib/format";

/**
 * Short zone label for "today" so staff know the count follows the inn's
 * calendar day, not their browser's (e.g. "PDT", "GMT+1"). Null when the
 * zone name is unknown or unrecognised by this browser.
 */
function zoneLabel(timezone: string | undefined): string | null {
  if (!timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(
      Date.now(),
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A value inside a stat sentence: ink-1, 600, tabular. */
function Value({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-ink-1">{children}</strong>;
}

/**
 * One stat. The list item's text is the sentence the specs read, so the
 * divider is a `::before` hairline, never a text node. It sits in the middle
 * of the 12px column gap to the item's left, so an item that starts a wrapped
 * line has its divider outside the list's box, where the list's clip-path
 * (left edge only) hides it: no stray tick at the start of a continuation line.
 */
function Stat({ children }: { children: ReactNode }) {
  return (
    <li className="relative whitespace-nowrap before:absolute before:top-1/2 before:left-[-6.5px] before:h-3 before:w-px before:-translate-y-1/2 before:bg-border-2 before:content-['']">
      {children}
    </li>
  );
}

/**
 * The inbox statistics strip: replies sent today (inn-local day, decided by
 * the server), median first-response time, and the open queue. Values come
 * straight from threads.stats; nothing is computed here.
 */
export function InboxStats({ stats, timezone }: { stats: ThreadStats; timezone: string | undefined }) {
  const zone = zoneLabel(timezone);
  const median = stats.medianFirstResponseMs;
  return (
    <ul
      aria-label="Inbox statistics"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] leading-4 text-ink-2 tabular-nums [clip-path:inset(0_-100vw_0_0)] max-[900px]:text-[12px]"
    >
      <Stat>
        <Value>{stats.sentToday}</Value> {plural(stats.sentToday, "reply", "replies")} today
        {zone ? <span> (inn time, {zone})</span> : null}
      </Stat>
      <Stat>
        {median === null ? (
          "No first responses yet"
        ) : (
          <>
            Median first response <Value>{formatDuration(median)}</Value>
          </>
        )}
      </Stat>
      <Stat>
        <Value>{stats.open}</Value> open
        {stats.open > 0 ? (
          <span>
            {" "}
            ({stats.needsStaff} need you, {stats.ready} ready)
          </span>
        ) : null}
      </Stat>
    </ul>
  );
}
