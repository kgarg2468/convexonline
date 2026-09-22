import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { ChevronDown, Search } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ThreadStatus, ThreadSummary } from "../types";
import { useDebouncedValue, useDelayedFlag, useNow } from "../lib/hooks";
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

export type QueueFilter = ThreadStatus | "all";

/** Where a phone left the list before opening a thread: the row to hand focus back to and the page's scroll. */
export type QueueRestore = { threadId: Id<"threads">; scrollY: number };

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
  filter,
  onFilterChange,
  search,
  onSearchChange,
  restore,
  onRestored,
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
  /** Status filter and search text live in InboxView, so a phone's list → thread → back keeps them. */
  filter: QueueFilter;
  onFilterChange: (filter: QueueFilter) => void;
  search: string;
  onSearchChange: (search: string) => void;
  /** Set while a phone is coming back from a thread; consumed once the rows are on screen. */
  restore: QueueRestore | null;
  onRestored: () => void;
}) {
  const now = useNow();
  // The input is controlled and instant; the query follows ~180ms behind so a
  // typed word opens one search subscription, not one per keystroke.
  const query = useDebouncedValue(search.trim());
  const searching = query.length > 0;

  const queue = useQuery(
    api.threads.queue,
    searching ? "skip" : { innId, status: filter === "all" ? undefined : filter },
  ) as ThreadSummary[] | undefined;
  const found = useQuery(api.threads.search, searching ? { innId, text: query } : "skip") as
    | ThreadSummary[]
    | undefined;
  const threads = searching ? found : queue;

  // Skeleton on the first load only; later loads (filter, search) keep the
  // last list on screen until the new one arrives, so nothing flashes. A
  // cached empty list is the exception: it must not pose as the new query's
  // "no matches", so that case waits like a first load.
  const [last, setLast] = useState<ThreadSummary[] | undefined>(undefined);
  if (threads !== undefined && threads !== last) setLast(threads);
  const shown = threads ?? last;
  const loading = shown === undefined || (threads === undefined && shown.length === 0);
  const showSkeleton = useDelayedFlag(loading);
  // The previous list is still on screen while the new filter or search loads.
  const refreshing = threads === undefined && !loading;

  const listRef = useRef<HTMLUListElement | null>(null);

  // Back from a thread on a phone: put the page and the keyboard back where
  // they were, once the rows exist. Runs at most once per `restore`.
  useEffect(() => {
    if (!restore || loading) return;
    const row = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-queue-row][data-thread-id="${restore.threadId}"]`,
    );
    if (narrow) window.scrollTo({ top: restore.scrollY });
    if (row) {
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
    } else {
      // The thread left the active filter while it was open: land on the
      // filter control so the keyboard is still somewhere in the queue.
      document.getElementById("fd-queue-filter")?.focus({ preventScroll: true });
    }
    onRestored();
  }, [restore, loading, narrow, onRestored]);
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
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </InputGroup>
        <div className="flex items-center justify-between gap-2">
          <label className="sr-only" htmlFor="fd-queue-filter">
            Filter by status
          </label>
          <span className="relative inline-flex">
            <select
              id="fd-queue-filter"
              value={filter}
              disabled={searching}
              onChange={(e) => onFilterChange(e.target.value as QueueFilter)}
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
            // Short visible label so the row never wraps at 300px; the accessible name stays the full one.
            <Button type="button" variant="outline" size="sm" aria-label="Simulate a guest inquiry" className="ml-auto shrink-0 px-2 text-[13px]" onClick={onCompose}>
              Simulate inquiry
            </Button>
          ) : null}
        </div>
        {searching ? (
          <p className="text-[12px] leading-4 text-ink-2">
            Search covers subject, guest email and message preview; the status filter is paused.
          </p>
        ) : null}
      </div>

      <div
        aria-busy={refreshing || undefined}
        className={cn(
          "relative min-w-0",
          !narrow && "min-h-0 flex-1 overflow-y-auto",
          // Loading a new filter or search over the last list: a 1px accent hairline along the top and dimmed rows.
          "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-px before:bg-accent-9 before:opacity-0 before:content-[''] motion-safe:before:transition-opacity motion-safe:before:duration-small",
          refreshing && "before:opacity-100",
        )}
      >
        {shown === undefined || loading ? (
          showSkeleton ? <QueueSkeleton /> : null
        ) : shown.length === 0 ? (
          searching ? (
            <QueueEmpty
              title={`No threads match “${query}”`}
              hint="Try a word from the subject, the guest's email or their message."
              action={
                <Button type="button" variant="outline" size="sm" className="text-[13px]" onClick={() => onSearchChange("")}>
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
                <Button type="button" variant="outline" size="sm" className="text-[13px]" onClick={() => onFilterChange("all")}>
                  Show all threads
                </Button>
              }
            />
          )
        ) : (
          <ul
            ref={listRef}
            className={cn("motion-safe:transition-opacity motion-safe:duration-small", refreshing && "opacity-60")}
          >
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
