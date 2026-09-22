import type { PageSummary, StaffFact } from "../types";
import { useIsNarrow } from "../lib/hooks";
import { Stat } from "../corrections/ChangesStats";

/**
 * The knowledge strip (design-spec §4.4): pages captured, pages watched for
 * changes, staff facts. The same tiles as the Policy changes strip (`Stat` is
 * shared, so the two views' KPIs are one component): a three-column grid
 * beside the rail, one stat line under 901px. The counts come from the lists
 * the view already holds, so nothing is queried twice, and the strip is one
 * labelled group so the specs read every sentence from it.
 */
export function KnowledgeStats({ pages, facts }: { pages: PageSummary[]; facts: StaffFact[] }) {
  const narrow = useIsNarrow();
  const watched = pages.filter((p) => p.watched).length;
  return (
    <div
      role="group"
      aria-label="Knowledge statistics"
      className={narrow ? "flex flex-wrap gap-x-4 gap-y-0.5" : "grid gap-3 min-[901px]:grid-cols-3"}
    >
      <Stat value={pages.length} narrow={narrow}>
        {pages.length === 1 ? "page" : "pages"} captured
      </Stat>
      <Stat value={watched} narrow={narrow}>
        watched for changes
      </Stat>
      <Stat value={facts.length} narrow={narrow}>
        staff {facts.length === 1 ? "fact" : "facts"}
      </Stat>
    </div>
  );
}
