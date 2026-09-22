import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PageSummary, StaffFact } from "../types";

/** A value inside a stat sentence: ink-1, 600, tabular — the KPI of each item. */
function Value({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-ink-1 tabular-nums">{children}</strong>;
}

/**
 * One stat. The list item's text is the sentence the specs read, so the
 * divider is a `::before` hairline, never a text node. It sits in the middle
 * of the 12px column gap to the item's left, so an item that starts a wrapped
 * line has its divider outside the line's box, where the line's clip-path
 * (left edge only) hides it: no stray tick at the start of a continuation line.
 * Under 901px the dividers are dropped; the line wraps there anyway.
 */
function Stat({ children }: { children: ReactNode }) {
  return (
    <li className="relative whitespace-nowrap before:absolute before:top-1/2 before:left-[-6.5px] before:h-3 before:w-px before:-translate-y-1/2 before:bg-border-2 before:content-[''] max-[900px]:before:hidden">
      {children}
    </li>
  );
}

/**
 * The knowledge header's meta line: the site URL (the header's sub line moves
 * here because the shell drops `sub` when `meta` is given) followed by the
 * three counts as KPIs (pages · watched · staff facts). It subscribes to the
 * same `pages.list` and `facts.list` the view holds, so the counts cost nothing.
 */
export function KnowledgeStats({ innId, siteUrl }: { innId: Id<"inns">; siteUrl: string }) {
  const pages = useQuery(api.pages.list, { innId }) as PageSummary[] | undefined;
  const facts = useQuery(api.facts.list, { innId }) as StaffFact[] | undefined;
  const watched = pages?.filter((p) => p.watched).length ?? 0;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] leading-4 text-ink-2 tabular-nums [clip-path:inset(0_-100vw_0_0)] max-[900px]:text-[12px]">
      <span className="min-w-0 max-w-[36ch] truncate">{siteUrl}</span>
      {pages && facts ? (
        <ul aria-label="Knowledge statistics" className="contents">
          <Stat>
            <Value>{pages.length}</Value> {pages.length === 1 ? "page" : "pages"}
          </Stat>
          <Stat>
            <Value>{watched}</Value> watched for changes
          </Stat>
          <Stat>
            <Value>{facts.length}</Value> staff {facts.length === 1 ? "fact" : "facts"}
          </Stat>
        </ul>
      ) : null}
    </div>
  );
}
