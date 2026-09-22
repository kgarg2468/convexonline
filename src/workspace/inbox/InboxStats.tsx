import type { ReactNode } from "react";
import type { ThreadStats } from "../types";
import { formatDuration } from "../lib/format";
import { Separator } from "@/components/ui/separator";

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
 * divider is a decorative separator inside the item and never a text node.
 */
function Stat({ first, children }: { first?: boolean; children: ReactNode }) {
  return (
    <li className="whitespace-nowrap">
      {first ? null : <Separator orientation="vertical" className="mr-3 inline-block h-3 align-[-1px] bg-border-2" />}
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
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] leading-4 text-ink-2 tabular-nums max-[900px]:text-[12px]"
    >
      <Stat first>
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
