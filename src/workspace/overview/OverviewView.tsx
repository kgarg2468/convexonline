import type { Id } from "../../../convex/_generated/dataModel";
import type { OverviewSummary, ThreadStatus } from "../types";
import { useDelayedFlag } from "../lib/hooks";
import { Breakdown } from "./Breakdown";
import { Comparisons } from "./Comparisons";
import { KpiRow } from "./KpiRow";
import { NeedsActionStrip } from "./NeedsActionStrip";
import { OverviewSkeleton } from "./OverviewSkeleton";
import { UpNextList } from "./UpNextList";

/**
 * The Overview dashboard (design-spec §4.1): a vertical stack, needs-action
 * strip first, then the up-next list, KPI tiles, breakdowns and comparisons.
 * The summary is one server object; the workspace owns the subscription and
 * hands it down. The root is the one
 * `@container`: every grid below sizes off the content width, so a collapsed
 * rail gets more columns, not a different breakpoint.
 */
export function OverviewView({
  summary,
  timezone,
  now,
  onOpenThread,
  onOpenInbox,
  onOpenCorrections,
}: {
  summary: OverviewSummary | undefined;
  timezone: string | undefined;
  now: number;
  onOpenThread: (threadId: Id<"threads">) => void;
  onOpenInbox: (filter: ThreadStatus) => void;
  onOpenCorrections: () => void;
}) {
  const showSkeleton = useDelayedFlag(summary === undefined);
  if (summary === undefined) return showSkeleton ? <OverviewSkeleton /> : null;
  return (
    <div className="@container flex max-w-[1200px] flex-col gap-6">
      <NeedsActionStrip needsAction={summary.needsAction} onOpenInbox={onOpenInbox} onOpenCorrections={onOpenCorrections} />
      <UpNextList items={summary.upNext} now={now} onOpenThread={onOpenThread} />
      <KpiRow kpis={summary.kpis} />
      <Breakdown series={summary.series} breakdown={summary.breakdown} timezone={timezone} />
      <Comparisons comparisons={summary.comparisons} now={now} />
    </div>
  );
}
