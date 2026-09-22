import { ArrowRight } from "lucide-react";
import type { Id } from "../../../convex/_generated/dataModel";
import type { OverviewSummary } from "../types";
import { formatWhen, guestName } from "../lib/format";
import { StatusChip } from "../inbox/QueueRow";
import { sectionHeadingClass } from "../corrections/styles";
import { EmptyState } from "./EmptyState";

/**
 * The five most urgent threads: needs-you oldest first, then ready to send.
 * Row anatomy is the queue row's (guest + time, subject, status chip) with an
 * inline "Open"; the whole row is the button, so its accessible name carries
 * the subject the specs open threads by.
 */
export function UpNextList({
  items,
  now,
  onOpenThread,
}: {
  items: OverviewSummary["upNext"];
  now: number;
  onOpenThread: (threadId: Id<"threads">) => void;
}) {
  return (
    <section aria-labelledby="fd-overview-up-next">
      <h2 id="fd-overview-up-next" className={`${sectionHeadingClass} mb-2`}>
        Up next
      </h2>
      {items.length === 0 ? (
        <EmptyState title="Nothing needs you right now">
          Guest messages waiting on a staff answer, then verified drafts ready to send, appear here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border-1 overflow-hidden rounded-[10px] border border-border-1 bg-white">
          {items.map((t) => (
            <li key={t.threadId}>
              <button
                type="button"
                onClick={() => onOpenThread(t.threadId)}
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left outline-hidden transition-colors duration-micro hover:bg-bg-2 focus-visible:bg-bg-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-9"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[14px] leading-5 font-semibold text-ink-1">{t.guestName ?? guestName(t.guestEmail)}</span>
                    <span className="shrink-0 text-[12px] leading-4 text-ink-3 tabular-nums">{formatWhen(t.lastInboundAt, now)}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[14px] leading-5 font-medium text-ink-1">{t.subject}</span>
                  <span className="mt-1.5 flex flex-wrap gap-1.5">
                    <StatusChip status={t.status} />
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 text-[13px] leading-5 font-medium text-accent-10">
                  Open
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
