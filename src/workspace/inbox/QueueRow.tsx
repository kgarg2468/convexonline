import type { Id } from "../../../convex/_generated/dataModel";
import type { ThreadStatus, ThreadSummary } from "../types";
import { STATUS_LABEL, formatWhen, guestName } from "../lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/** How the current selection was made; only pointer selection animates the accent bar. */
export type SelectSource = "pointer" | "keyboard";

/**
 * Status chip, text first (design-spec §0): needs-you = warning tint, ready =
 * solid accent, everything else a neutral outline. Labels are the ones the
 * specs read (STATUS_LABEL), unchanged.
 */
export function StatusChip({ status }: { status: ThreadStatus }) {
  const label = STATUS_LABEL[status] ?? status;
  if (status === "needs_staff") {
    return <Badge className="border-transparent bg-warning-3 text-warning-10">{label}</Badge>;
  }
  if (status === "ready") return <Badge>{label}</Badge>;
  return (
    <Badge variant="outline" className="text-ink-2">
      {label}
    </Badge>
  );
}

/**
 * One queue row (design-spec §4.2): guest name + time, subject, one-line
 * snippet, chips. The button's accessible name is its text, so the subject
 * stays a substring of it (the specs open threads by subject).
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
          "relative block w-full cursor-pointer border-b border-border-1 p-3 text-left outline-hidden transition-colors duration-micro",
          // Selection bar: present on every row at scaleY(0) so a pointer selection can grow it.
          "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:scale-y-0 before:bg-accent-9 before:duration-small before:ease-out before:content-[''] motion-safe:before:transition-transform",
          "data-[motion=keyboard]:before:transition-none",
          selected ? "bg-bg-3 before:scale-y-100" : "hover:bg-bg-2 focus-visible:bg-bg-2",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-9",
        )}
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[14px] leading-5 font-semibold text-ink-1">
            {thread.status === "new" ? (
              <>
                {/* Unread dot (design-spec §4.2): 6px accent, centred on the x-height. */}
                <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-accent-9 align-middle" />
                <span className="sr-only">New </span>
              </>
            ) : null}
            {guestName(thread.guestEmail)}
          </span>
          <span className="shrink-0 text-[12px] leading-4 text-ink-3 tabular-nums">{formatWhen(thread.lastInboundAt, now)}</span>
        </span>
        <span className="mt-0.5 block truncate text-[14px] leading-5 font-medium text-ink-1">{thread.subject}</span>
        <span className="mt-0.5 block truncate text-[13px] leading-5 text-ink-2">{thread.snippet}</span>
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          <StatusChip status={thread.status} />
          {thread.claim ? (
            <Badge variant="outline" className="text-ink-2">
              {thread.claim.userId === viewerId ? "You have it" : `${thread.claim.name ?? "Someone"} has it`}
            </Badge>
          ) : null}
        </span>
      </button>
    </li>
  );
}
