import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { ChevronDown, Search } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ThreadStatus, ThreadSummary } from "../types";
import { useDelayedFlag, useNow } from "../lib/hooks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { QueueRow, type SelectSource } from "./QueueRow";
import { QueueSkeleton } from "./QueueSkeleton";

const FILTERS: { value: ThreadStatus | "all"; label: string }[] = [
  { value: "all", label: "All threads" },
  { value: "needs_staff", label: "Needs you" },
  { value: "ready", label: "Ready to send" },
  { value: "new", label: "New" },
  { value: "drafting", label: "Drafting" },
  { value: "sent", label: "Sent" },
  { value: "waiting_guest", label: "Waiting on guest" },
  { value: "closed", label: "Closed" },
];

/** What the queue installs into the workspace's `useShortcuts` `onKey` slot; true = handled. */
export type QueueKeyHandler = (event: KeyboardEvent) => boolean;

/** Centred text block for the empty list: status, one-line hint, next action. */
function QueueEmpty({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <div>
        <p className="text-[14px] leading-5 font-semibold text-ink-1">{title}</p>
        <p className="mt-1 text-[13px] leading-5 text-ink-2">{hint}</p>
      </div>
      {action}
    </div>
  );
}

export function QueueList({
  innId,
  selected,
  selectSource,
  onSelect,
  viewerId,
  onCompose,
  registerKeys,
  narrow,
}: {
  innId: Id<"inns">;
  selected: Id<"threads"> | null;
  /** How `selected` was chosen; keyboard selection must not animate the bar. */
  selectSource: SelectSource;
  onSelect: (threadId: Id<"threads">, source: SelectSource) => void;
  viewerId: Id<"users">;
  /** Demo only: opens the simulated guest inquiry form. */
  onCompose?: () => void;
  /** Hands `j` / `k` to the workspace's single key listener while the queue is mounted (null on unmount). */
  registerKeys: (handler: QueueKeyHandler | null) => void;
  /** Phone layout: the list scrolls with the page instead of inside the pane. */
  narrow: boolean;
}) {
  const [filter, setFilter] = useState<ThreadStatus | "all">("all");
  const [search, setSearch] = useState("");
  const now = useNow();
  const searching = search.trim().length > 0;

  const queue = useQuery(
    api.threads.queue,
    searching ? "skip" : { innId, status: filter === "all" ? undefined : filter },
  ) as ThreadSummary[] | undefined;
  const found = useQuery(api.threads.search, searching ? { innId, text: search } : "skip") as
    | ThreadSummary[]
    | undefined;
  const threads = searching ? found : queue;

  // Skeleton on the first load only; later loads (filter, search) keep the
  // last list on screen until the new one arrives, so nothing flashes.
  const [last, setLast] = useState<ThreadSummary[] | undefined>(undefined);
  if (threads !== undefined && threads !== last) setLast(threads);
  const shown = threads ?? last;
  const showSkeleton = useDelayedFlag(shown === undefined);

  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    registerKeys((event) => {
      if (event.key !== "j" && event.key !== "k") return false;
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-queue-row]") ?? []);
      if (rows.length === 0) return false;
      const focused = rows.findIndex((row) => row === document.activeElement);
      const current = focused >= 0 ? focused : rows.findIndex((row) => row.dataset.selected === "true");
      const next =
        current < 0 ? 0 : event.key === "j" ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0);
      const row = rows[next]!;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
      return true;
    });
    return () => registerKeys(null);
  }, [registerKeys]);

  return (
    <section
      aria-label="Guest threads"
      className={cn("flex min-w-0 flex-col bg-white", !narrow && "min-h-0 overflow-hidden border-r border-border-1")}
    >
      <div className="flex flex-col gap-2 border-b border-border-1 p-3">
        <label className="sr-only" htmlFor="fd-queue-search">
          Search subject, guest email or message
        </label>
        <InputGroup className="bg-bg-1">
          <InputGroupAddon>
            <Search aria-hidden="true" className="text-ink-3" />
          </InputGroupAddon>
          <InputGroupInput
            id="fd-queue-search"
            type="search"
            placeholder="Search subject, email or message"
            className="text-[14px] placeholder:text-ink-3"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </InputGroup>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="sr-only" htmlFor="fd-queue-filter">
            Filter by status
          </label>
          <span className="relative inline-flex">
            <select
              id="fd-queue-filter"
              value={filter}
              disabled={searching}
              onChange={(e) => setFilter(e.target.value as ThreadStatus | "all")}
              className="h-7 cursor-pointer appearance-none rounded-full border border-border-1 bg-bg-1 pr-6 pl-2.5 text-[13px] font-medium text-ink-1 outline-hidden transition-colors duration-micro hover:bg-bg-2 focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50"
            >
              {FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-ink-3" />
          </span>
          {onCompose ? (
            <Button type="button" variant="outline" size="sm" className="px-2 text-[13px]" onClick={onCompose}>
              Simulate a guest inquiry
            </Button>
          ) : null}
        </div>
        {searching ? (
          <p className="text-[12px] leading-4 text-ink-2">
            Search covers subject, guest email and message preview; the status filter is paused.
          </p>
        ) : null}
      </div>

      <div className={cn("min-w-0", !narrow && "min-h-0 flex-1 overflow-y-auto")}>
        {shown === undefined ? (
          showSkeleton ? <QueueSkeleton /> : null
        ) : shown.length === 0 ? (
          searching ? (
            <QueueEmpty
              title={`No threads match “${search.trim()}”`}
              hint="Try a word from the subject, the guest's email or their message."
              action={
                <Button type="button" variant="outline" size="sm" className="text-[13px]" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              }
            />
          ) : filter === "all" ? (
            <QueueEmpty
              title="No guest threads yet"
              hint="Guest email appears here once the inbox is connected."
              action={
                onCompose ? (
                  <Button type="button" variant="outline" size="sm" className="text-[13px]" onClick={onCompose}>
                    Simulate a guest inquiry
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <QueueEmpty
              title="No threads with this status"
              hint="Nothing is waiting here right now."
              action={
                <Button type="button" variant="outline" size="sm" className="text-[13px]" onClick={() => setFilter("all")}>
                  Show all threads
                </Button>
              }
            />
          )
        ) : (
          <ul ref={listRef}>
            {shown.map((t) => (
              <QueueRow
                key={t._id}
                thread={t}
                selected={selected === t._id}
                motion={selectSource}
                viewerId={viewerId}
                now={now}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
