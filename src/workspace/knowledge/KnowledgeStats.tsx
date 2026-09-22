import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PageSummary, StaffFact } from "../types";
import { Separator } from "@/components/ui/separator";

/** A value inside a stat sentence: ink-1, 600, tabular. */
function Value({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-ink-1">{children}</strong>;
}

/** One stat; the divider is decorative and never part of the item's text. */
function Stat({ children }: { children: ReactNode }) {
  return (
    <li className="whitespace-nowrap">
      <Separator orientation="vertical" className="mr-3 inline-block h-3 align-[-1px] bg-border-2" />
      {children}
    </li>
  );
}

/**
 * The knowledge header's meta line: the site URL (the header's sub line moves
 * here because the shell drops `sub` when `meta` is given) followed by the
 * three counts the view used to show in its strip. It subscribes to the same
 * `pages.list` and `facts.list` the view holds, so the counts cost nothing.
 */
export function KnowledgeStats({ innId, siteUrl }: { innId: Id<"inns">; siteUrl: string }) {
  const pages = useQuery(api.pages.list, { innId }) as PageSummary[] | undefined;
  const facts = useQuery(api.facts.list, { innId }) as StaffFact[] | undefined;
  const watched = pages?.filter((p) => p.watched).length ?? 0;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] leading-4 text-ink-2 tabular-nums max-[900px]:text-[12px]">
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
