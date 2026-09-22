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

/** The bars and their ticks share one 14-column grid, so a tick sits under the bar it names. */
const dayGridClass = "grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1.5";

/**
 * Replies per day, 14 inn-local days, oldest first: vertical bars as plain
 * divs, the current 7 days in accent, the previous 7 in ink-3. The plot is a
 * fixed 140px at every width, the peak bar carries its value, and three sparse
 * ticks (first day, start of this week, today) sit centred under their bars;
 * no gridlines, no axis line.
 */
function RepliesPerDay({ series, timezone }: { series: OverviewSummary["series"]["repliesPerDay14"]; timezone: string | undefined }) {
  const counts = series.map((d) => d.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  const peak = counts.indexOf(max);
  const split = series.length - 7;
  const ticks = [
    { col: 1, label: shortDayLabel(series[0]!.dayStart, timezone) },
    ...(split > 0 && split < series.length ? [{ col: split + 1, label: shortDayLabel(series[split]!.dayStart, timezone) }] : []),
    { col: series.length, label: "Today" },
  ];
  return (
    <div className={cn(cardClass, "self-start")}>
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
          {/* 18px of top padding is the peak label's room, so a full-height bar never pushes it out. */}
          <div aria-hidden="true" className={cn(dayGridClass, "mt-4 h-[140px] items-end border-b border-border-1 pt-[18px]")}>
            {series.map((d, i) => (
              <div key={d.dayStart} className="relative flex h-full min-w-0 flex-col items-center justify-end">
                {i === peak ? (
                  <span
                    className="absolute inset-x-0 text-center text-[11px] leading-4 font-medium text-ink-2 tabular-nums"
                    style={{ bottom: `calc(${(d.count / max) * 100}% + 2px)` }}
                  >
                    {d.count}
                  </span>
                ) : null}
                <div
                  className={cn("w-4 rounded-t-[2px]", i >= split ? BAR.accent : BAR.ink, barMotion)}
                  style={{ height: `${(d.count / max) * 100}%` }}
                />
              </div>
            ))}
          </div>
          <div aria-hidden="true" className={cn(dayGridClass, "mt-1 text-[11px] leading-4 text-ink-3 tabular-nums")}>
            {ticks.map((t) => (
              <span key={t.col} className="justify-self-center whitespace-nowrap" style={{ gridColumnStart: t.col }}>
                {t.label}
              </span>
            ))}
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
 * secondary colour, the staff-written marker everywhere else in the app; the
 * inquiry mix is two plain counts, so neither row takes a colour.
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
              { label: "Booked stays", value: mix.booked, color: "ink" },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
