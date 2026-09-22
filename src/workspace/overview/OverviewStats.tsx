import type { ReactNode } from "react";
import type { OverviewSummary } from "../types";
import { localDateLabel, plural, zoneLabel } from "./metrics";

/** A value inside a stat sentence: ink-1, 600, tabular. */
function Value({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-ink-1">{children}</strong>;
}

/** One stat; the divider is a `::before` hairline so the item's text stays the plain sentence (same anatomy as the inbox strip). */
function Stat({ children }: { children: ReactNode }) {
  return (
    <li className="relative whitespace-nowrap before:absolute before:top-1/2 before:left-[-6.5px] before:h-3 before:w-px before:-translate-y-1/2 before:bg-border-2 before:content-['']">
      {children}
    </li>
  );
}

/**
 * The Overview's header line: the inn's local date, then the four needs-action
 * counts as sentences. Values come straight from `overview.summary`.
 */
export function OverviewStats({ summary, timezone, now }: { summary: OverviewSummary; timezone: string | undefined; now: number }) {
  const { needsStaff, ready, policyChangesToReview, followUpsDue } = summary.needsAction;
  const zone = zoneLabel(timezone);
  return (
    <ul
      aria-label="Overview statistics"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] leading-4 text-ink-2 tabular-nums [clip-path:inset(0_-100vw_0_0)] max-[900px]:text-[12px]"
    >
      <Stat>
        {localDateLabel(now, timezone)}
        {zone ? <span> (inn time, {zone})</span> : null}
      </Stat>
      <Stat>
        <Value>{needsStaff}</Value> {plural(needsStaff, "needs", "need")} you
      </Stat>
      <Stat>
        <Value>{ready}</Value> ready to send
      </Stat>
      <Stat>
        <Value>{policyChangesToReview}</Value> policy {plural(policyChangesToReview, "change", "changes")} to review
      </Stat>
      <Stat>
        <Value>{followUpsDue}</Value> {plural(followUpsDue, "follow-up", "follow-ups")} due
      </Stat>
    </ul>
  );
}
