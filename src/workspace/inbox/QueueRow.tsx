import type { Id } from "../../../convex/_generated/dataModel";
import type { ThreadStatus, ThreadSummary } from "../types";
import { STATUS_LABEL, formatWhen, guestName } from "../lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/** How the current selection was made; only pointer selection animates the accent bar. */
export type SelectSource = "pointer" | "keyboard";

/**
 * Status chip, text first (design-spec §0): needs-you = warning tint, ready =
 * accent tint, everything else a neutral outline. Labels are the ones the
 * specs read (STATUS_LABEL), unchanged.
 */
export function StatusChip({ status, className }: { status: ThreadStatus; className?: string }) {
  const label = STATUS_LABEL[status] ?? status;
  if (status === "needs_staff") {
    return <Badge className={cn("border-transparent bg-warning-3 text-warning-10", className)}>{label}</Badge>;
  }
  if (status === "ready") {
    return <Badge className={cn("border-transparent bg-accent-3 text-accent-10", className)}>{label}</Badge>;
  }
  return (
    <Badge variant="outline" className={cn("text-ink-2", className)}>
      {label}
    </Badge>
  );
}

/** The two-line row's status marker: a tinted 11px pill for the two states that ask for staff; a hidden label otherwise. */
function RowStatus({ status }: { status: ThreadStatus }) {
  const label = STATUS_LABEL[status] ?? status;
  if (status === "needs_staff" || status === "ready") {
    return <StatusChip status={status} className="h-[18px] px-1.5 text-[11px] leading-4" />;
  }
  return <span className="sr-only">{label}</span>;
}

/**
 * One queue row (design-spec §4.2), two lines like Front's: guest name with
 * the claim holder and time at the right, then "subject — snippet" on one
 * truncating line with the status marker at its right. The button's accessible name is its text, so the subject stays
 * a substring of it (the specs open threads by subject).
 *
 * The row is the only element `j`/`k` focus (`data-queue-row`, found again by
 * `data-thread-id` when a phone comes back from the thread); the selected row
 * carries `data-motion` so the left bar scales in only after a click.
 */
export function QueueRow({
  thread,
  selected,
  motion,
  viewerId,
  now,
  onSelect,
}: {
  thread: ThreadSummary;
  selected: boolean;
  motion: SelectSource;
  viewerId: Id<"users">;
  now: number;
  onSelect: (threadId: Id<"threads">, source: SelectSource) => void;
}) {
  return (
    <li className="transition-[opacity,translate] duration-small ease-out starting:-translate-y-1.5 starting:opacity-0 motion-reduce:starting:translate-y-0">
      <button
        type="button"
        data-queue-row=""
        data-thread-id={thread._id}
        data-selected={selected ? "true" : undefined}
        data-motion={selected ? motion : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={(event) => onSelect(thread._id, event.detail === 0 ? "keyboard" : "pointer")}
        className={cn(
          "relative flex w-full cursor-pointer flex-col gap-0.5 border-b border-border-1 px-4 py-2.5 text-left outline-hidden transition-colors duration-micro",
          // Selection bar: present on every row at scaleY(0) so a pointer selection can grow it.
          "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:scale-y-0 before:bg-accent-9 before:duration-small before:ease-out before:content-[''] motion-safe:before:transition-transform",
          "data-[motion=keyboard]:before:transition-none",
          selected ? "bg-bg-3 before:scale-y-100" : "hover:bg-bg-2 focus-visible:bg-bg-2",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-9",
        )}
      >
        <span className="flex w-full items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[13px] leading-5 font-semibold text-ink-1">
            {thread.status === "new" ? (
              <>
                {/* Unread dot (design-spec §4.2): 6px accent, centred on the x-height. */}
                <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-accent-9 align-middle" />
                <span className="sr-only">New </span>
              </>
            ) : null}
            {guestName(thread.guestEmail)}
          </span>
          <span className="flex shrink-0 items-baseline gap-2 text-[12px] leading-4 text-ink-3">
            {thread.claim ? (
              <span className="text-[11px]">{thread.claim.userId === viewerId ? "You have it" : `${thread.claim.name ?? "Someone"} has it`}</span>
            ) : null}
            <span className="tabular-nums">{formatWhen(thread.lastInboundAt, now)}</span>
          </span>
        </span>
        <span className="flex w-full items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[13px] leading-5">
            <span className="font-medium text-ink-1">{thread.subject}</span>
            {thread.snippet ? <span className="text-ink-3"> — {thread.snippet}</span> : null}
          </span>
          <RowStatus status={thread.status} />
        </span>
      </button>
    </li>
  );
}
