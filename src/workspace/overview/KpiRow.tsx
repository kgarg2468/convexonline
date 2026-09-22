import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import type { OverviewSummary } from "../types";
import { formatDuration } from "../lib/format";
import { cn } from "@/lib/utils";
import { sectionHeadingClass } from "../corrections/styles";
import { type Delta, type DeltaTone, type GoodDirection, computeDelta, deltaTone, formatDeltaAmount } from "./metrics";
import { tileClass, valueClass } from "./styles";

const TONE_TEXT: Record<DeltaTone, string> = {
  success: "text-success-10",
  danger: "text-danger-10",
  neutral: "text-ink-2",
};

/**
 * Arrow + amount (semantic colour only when the metric moved and has a good
 * direction) + the window it is measured against. "New" when the previous
 * window had nothing. `note` replaces the row when there is nothing to
 * compare yet, so an empty inn never reads "no change".
 */
function DeltaRow({ delta, good, against, note }: { delta: Delta; good: GoodDirection; against: string; note: string | null }) {
  if (note !== null || delta.kind === "unknown") {
    return <p className="mt-1 text-[13px] leading-5 text-ink-3">{note ?? "Nothing to compare yet"}</p>;
  }
  const tone = deltaTone(delta, good);
  const flat = delta.kind === "change" && delta.amount === 0;
  const up = delta.kind === "new" || delta.amount > 0;
  const Icon = flat ? Minus : up ? ArrowUp : ArrowDown;
  return (
    <p className="mt-1 flex items-center gap-1 text-[13px] leading-5 text-ink-3 tabular-nums">
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} strokeWidth={2} />
      <span className={cn("font-medium", TONE_TEXT[tone])}>
        {delta.kind === "new" ? "New" : flat ? "No change" : formatDeltaAmount(delta)}
      </span>
      <span>{against}</span>
    </p>
  );
}

/**
 * One KPI tile: label → value → delta row, the same three lines and height as
 * a needs-action tile. The value is a string so the tile never formats
 * anything itself.
 */
function KpiTile({
  label,
  value,
  delta,
  good,
  against,
  note,
}: {
  label: string;
  value: string;
  delta: Delta;
  good: GoodDirection;
  against: string;
  note: string | null;
}) {
  return (
    <li className={tileClass}>
      <span className="block truncate text-[12px] leading-4 font-medium text-ink-2">{label}</span>
      <span className={cn(valueClass, "mt-1")}>{value}</span>
      <DeltaRow delta={delta} good={good} against={against} note={note} />
    </li>
  );
}

/**
 * The four KPIs (design-spec §4.1). Each tile's visual is its delta row; the
 * day series is drawn once, in the Breakdown below (the backend keeps one
 * 14-day series, so a sparkline per tile would need more of them).
 */
export function KpiRow({ kpis }: { kpis: OverviewSummary["kpis"] }) {
  const replies = kpis.repliesSent7d;
  const median = kpis.medianFirstResponseMs7d;
  const verified = kpis.verifiedBeforeSendPct7d;
  const corrections = kpis.correctionsSent30d;
  return (
    <section aria-labelledby="fd-overview-key-figures">
      <h2 id="fd-overview-key-figures" className={`${sectionHeadingClass} mb-2`}>
        Key figures
      </h2>
      <ul aria-labelledby="fd-overview-key-figures" className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
        <KpiTile
          label="Replies sent · 7d"
          value={String(replies.value)}
          delta={computeDelta(replies.value, replies.previous, "%")}
          good="up"
          against="vs prev 7d"
          note={replies.value === 0 && replies.previous === 0 ? "No replies sent yet" : null}
        />
        <KpiTile
          label="Median first response · 7d"
          value={median.value === null ? "—" : formatDuration(median.value)}
          delta={computeDelta(median.value, median.previous, "%")}
          good="down"
          against="vs prev 7d"
          note={median.value === null ? "No first responses yet" : null}
        />
        <KpiTile
          label="Verified before send · 7d"
          value={verified.value === null ? "—" : `${Math.round(verified.value)}%`}
          delta={computeDelta(verified.value, verified.previous, "pts")}
          good="up"
          against="vs prev 7d"
          note={verified.value === null ? "No replies sent yet" : null}
        />
        <KpiTile
          label="Corrections sent · 30d"
          value={String(corrections.value)}
          delta={computeDelta(corrections.value, corrections.previous, "%")}
          good="none"
          against="vs prev 30d"
          note={corrections.value === 0 && corrections.previous === 0 ? "No corrections sent yet" : null}
        />
      </ul>
    </section>
  );
}
