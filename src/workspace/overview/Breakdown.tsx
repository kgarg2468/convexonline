import type { ReactNode } from "react";
import type { OverviewSummary } from "../types";
import { cn } from "@/lib/utils";
import { sectionHeadingClass } from "../corrections/styles";
import { shortDayLabel } from "./metrics";
import { cardClass, chartTitleClass } from "./styles";

/** Grey first, one colour where it matters: accent for the current or highlighted series, ink-3 for the rest, secondary only for staff-written. */
type BarColor = "accent" | "ink" | "secondary";
const BAR: Record<BarColor, string> = { accent: "bg-accent-9", ink: "bg-ink-3", secondary: "bg-secondary-9" };

/** Bars only move when live data changes; nothing grows on mount, and reduced motion disables the transition. */
const barMotion = "motion-safe:transition-[height,width] motion-safe:duration-medium motion-safe:ease-out";

function ChartTitle({ children }: { children: ReactNode }) {
  return <h3 className={chartTitleClass}>{children}</h3>;
}

function Swatch({ color }: { color: BarColor }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 rounded-[2px]", BAR[color])} />;
}

/**
 * Replies per day, 14 inn-local days, oldest first: vertical bars as plain
 * divs, the current 7 days in accent, the previous 7 in ink-3. Three sparse
 * ticks (first day, start of this week, today); no gridlines, no axis line.
 */
function RepliesPerDay({ series, timezone }: { series: OverviewSummary["series"]["repliesPerDay14"]; timezone: string | undefined }) {
  const counts = series.map((d) => d.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  const split = series.length - 7;
  // The card is as tall as the two cards beside it; the bars take that height.
  return (
    <div className={cn(cardClass, "flex flex-col")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <ChartTitle>Replies per day · last 14 days</ChartTitle>
        <p className="flex items-center gap-3 text-[12px] leading-4 text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <Swatch color="accent" /> Last 7 days
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Swatch color="ink" /> Previous 7
          </span>
        </p>
      </div>
      {total === 0 ? (
        <p className="mt-4 text-[13px] leading-5 text-ink-2">No replies sent in the last 14 days yet.</p>
      ) : (
        <>
          <div aria-hidden="true" className="mt-4 flex min-h-28 flex-1 items-end gap-1 border-b border-border-1">
            {series.map((d, i) => (
              <div key={d.dayStart} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                <div
                  className={cn("w-full rounded-t-[2px]", i >= split ? BAR.accent : BAR.ink, barMotion)}
                  style={{ height: `${(d.count / max) * 100}%` }}
                />
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="mt-1 flex justify-between text-[11px] leading-4 text-ink-3 tabular-nums">
            <span>{shortDayLabel(series[0]!.dayStart, timezone)}</span>
            <span>{split > 0 && split < series.length ? shortDayLabel(series[split]!.dayStart, timezone) : ""}</span>
            <span>Today</span>
          </div>
          <p className="sr-only">Replies per day, oldest first: {counts.join(", ")}. {total} in total.</p>
        </>
      )}
    </div>
  );
}

type Row = { label: string; value: number; color: BarColor };

/** Horizontal bars for a categorical breakdown, labelled directly, widths relative to the largest row. */
function HorizontalBars({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  const total = rows.reduce((a, r) => a + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className={cardClass}>
      <ChartTitle>{title}</ChartTitle>
      {total === 0 ? (
        <p className="mt-3 text-[13px] leading-5 text-ink-2">{empty}</p>
      ) : (
        <>
          <ul aria-hidden="true" className="mt-3 flex flex-col gap-2.5">
            {rows.map((r) => (
              <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-[13px] leading-5">
                <span className="truncate text-ink-2">{r.label}</span>
                <span className="font-medium text-ink-1 tabular-nums">{r.value}</span>
                <span className="col-span-2 block h-1.5 overflow-hidden rounded-full bg-bg-3">
                  <span className={cn("block h-full rounded-full", BAR[r.color], barMotion)} style={{ width: `${(r.value / max) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
          <p className="sr-only">
            {title}: {rows.map((r) => `${r.label} ${r.value}`).join(", ")}.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Breakdown (design-spec §4.1 item 4): the day series on the left; draft
 * outcomes and the inquiry mix on the right. Staff-edited replies carry the
 * secondary colour, the staff-written marker everywhere else in the app.
 */
export function Breakdown({
  series,
  breakdown,
  timezone,
}: {
  series: OverviewSummary["series"];
  breakdown: OverviewSummary["breakdown"];
  timezone: string | undefined;
}) {
  const o = breakdown.draftOutcomes30d;
  const mix = breakdown.inquiryMix30d;
  return (
    <section aria-labelledby="fd-overview-breakdown">
      <h2 id="fd-overview-breakdown" className={`${sectionHeadingClass} mb-2`}>
        Breakdown
      </h2>
      <div className="grid gap-3 @3xl:grid-cols-[3fr_2fr]">
        <RepliesPerDay series={series.repliesPerDay14} timezone={timezone} />
        <div className="flex flex-col gap-3">
          <HorizontalBars
            title="Draft outcomes · last 30 days"
            empty="No replies sent in the last 30 days yet."
            rows={[
              { label: "Verified and sent as written", value: o.verified, color: "accent" },
              { label: "Edited by staff", value: o.editedByStaff, color: "secondary" },
              { label: "Needed a staff fact", value: o.neededStaffFact, color: "ink" },
              { label: "Blocked by the judge", value: o.blockedByJudge, color: "ink" },
            ]}
          />
          <HorizontalBars
            title="Inquiry mix · last 30 days"
            empty="No guest threads in the last 30 days yet."
            rows={[
              { label: "Inquiries", value: mix.inquiry, color: "ink" },
              { label: "Booked stays", value: mix.booked, color: "accent" },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
