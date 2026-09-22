import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { LiveMailDecision } from "../types";
import { useDelayedFlag, useIsNarrow, useQueryResult } from "../lib/hooks";
import { parseInboxFilter } from "../lib/router";
import { cn } from "@/lib/utils";
import { QueueList, type QueueFilter, type QueueKeyHandler, type QueueRestore } from "./QueueList";
import type { SelectSource } from "./QueueRow";
import { ThreadSkeleton } from "./QueueSkeleton";
import { SourcesPlaceholder, ThreadUnavailable } from "./primitives";
import { threadMainClass, threadPadClass } from "./styles";
import { ThreadDetail } from "./ThreadDetail";
import { DemoInbound } from "../shell/DemoInbound";

/**
 * The inbox frame. From 1440px: queue 300 | thread | sources 288, each pane
 * scrolling on its own under the sticky header. 900–1439px: queue + thread,
 * the sources pane opens as a sheet from the header (SourcesSheet). Under
 * 900px the list and the thread are separate screens that scroll with the
 * page. ThreadDetail renders its main column and the sources pane as two
 * direct children of this grid.
 */
export function InboxView({
  innId,
  viewerId,
  isDemo,
  liveMail,
  selected,
  onSelect,
  onOpenCorrections,
  onForeignThread,
  registerKeys,
}: {
  innId: Id<"inns">;
  viewerId: Id<"users">;
  isDemo: boolean;
  liveMail: LiveMailDecision | undefined;
  selected: Id<"threads"> | null;
  onSelect: (threadId: Id<"threads"> | null) => void;
  onOpenCorrections: () => void;
  /** The selected thread turned out to belong to another property (see ThreadDetail). */
  onForeignThread?: () => void;
  /** The workspace's `onKey` slot; the queue installs `j` / `k` through it while mounted. */
  registerKeys: (handler: QueueKeyHandler | null) => void;
}) {
  const narrow = useIsNarrow();
  const [composing, setComposing] = useState(false);
  const [selectSource, setSelectSource] = useState<SelectSource>("keyboard");
  const showList = !narrow || (selected === null && !composing);
  const showDetail = !narrow || selected !== null || composing;

  // The queue's filter and search live here, not in QueueList: a phone
  // unmounts the list to show a thread and must find it as it was on the way back.
  // The filter is also the entry's `?filter=` query (lib/router.ts): a deep
  // link from the Overview's needs-action tiles or a bookmark sets it, the
  // status select rewrites it in place, and back/forward re-read it, so a
  // reload or a shared address opens the same queue. `navigate` carries the
  // query only between inbox routes, so it never follows the visitor elsewhere.
  const [filter, setFilterState] = useState<QueueFilter>(() => parseInboxFilter(window.location.search) ?? "all");
  const [search, setSearch] = useState("");
  const setFilter = useCallback((next: QueueFilter) => {
    setFilterState(next);
    const params = new URLSearchParams(window.location.search);
    if (next === "all") params.delete("filter");
    else params.set("filter", next);
    const rest = params.toString();
    try {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    } catch {
      /* history unavailable; the filter still applies */
    }
  }, []);
  useEffect(() => {
    const onPopState = () => setFilterState(parseInboxFilter(window.location.search) ?? "all");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Same subscription the thread pane opens (the client shares it), read here
  // only to know when the selected thread has arrived, or was refused: a stale
  // or hostile deep link gets a pane that says so, never a blank workspace.
  const detail = useQueryResult(api.threads.get, selected && !composing ? { threadId: selected } : "skip");
  const refused = selected !== null && !composing && detail.status === "error";
  const arrived = selected !== null && !composing && detail.status === "ok";

  // The thread whose pane is on screen. While a newly selected thread is still
  // loading the previous thread stays up (its own subscription is still live),
  // so a switch never flashes blank; the skeleton is only for the case where
  // there is nothing to keep (first open, or after the pane was empty).
  const [shownThread, setShownThread] = useState<Id<"threads"> | null>(null);
  if (arrived && shownThread !== selected) setShownThread(selected);
  if ((selected === null || composing || refused) && shownThread !== null) setShownThread(null);
  const threadLoading = selected !== null && !composing && !refused && shownThread === null;
  const showThreadSkeleton = useDelayedFlag(threadLoading);

  // Phone focus management. Opening a thread replaces the list, so focus
  // would land on <body>: it goes to the thread's heading instead (and the
  // page starts at the top, where the heading and "All threads" are). Going
  // back replaces the thread: the row that was opened gets focus and the
  // page's scroll again, once the list has rendered (QueueList consumes it).
  const root = useRef<HTMLDivElement | null>(null);
  const opened = useRef<{ threadId: Id<"threads">; scrollY: number } | null>(null);
  const [restore, setRestore] = useState<QueueRestore | null>(null);
  const onRestored = useCallback(() => setRestore(null), []);
  const focusedHeadingFor = useRef<Id<"threads"> | null>(null);
  useEffect(() => {
    if (!narrow || !arrived || selected === null || focusedHeadingFor.current === selected) return;
    const heading = root.current?.querySelector<HTMLElement>("h2");
    if (!heading) return;
    focusedHeadingFor.current = selected;
    window.scrollTo({ top: 0 });
    if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [narrow, arrived, selected]);
  useEffect(() => {
    if (selected !== null) return;
    focusedHeadingFor.current = null;
    if (!narrow || !opened.current) return;
    setRestore(opened.current);
    opened.current = null;
  }, [narrow, selected]);

  const back = narrow ? () => onSelect(null) : null;

  // Beside the rail the frame fills whatever the sticky header leaves of the
  // viewport: the outer box adds no height of its own (the shell's column is
  // min-h-dvh), so the panes' content never stretches the page and the
  // header may be as tall as its stats and actions need.
  return (
    <div
      ref={root}
      className={cn(
        "min-w-0 flex-1",
        narrow ? "flex min-h-0 flex-col" : "relative",
      )}
    >
      <div
        className={cn(
          narrow
            ? "contents"
            : "absolute inset-0 grid grid-cols-[300px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] min-[1440px]:grid-cols-[300px_minmax(0,1fr)_288px]",
        )}
      >
        {showList ? (
          <QueueList
            innId={innId}
            selected={selected}
            selectSource={selectSource}
            onSelect={(id, source) => {
              setSelectSource(source);
              setComposing(false);
              if (narrow) opened.current = { threadId: id, scrollY: window.scrollY };
              onSelect(id);
            }}
            viewerId={viewerId}
            registerKeys={registerKeys}
            narrow={narrow}
            filter={filter}
            onFilterChange={setFilter}
            search={search}
            onSearchChange={setSearch}
            restore={restore}
            onRestored={onRestored}
            onCompose={
              isDemo
                ? () => {
                    onSelect(null);
                    setComposing(true);
                  }
                : undefined
            }
          />
        ) : null}
        {showDetail ? (
          composing ? (
            <>
              <DemoInbound
                innId={innId}
                onCreated={(threadId) => {
                  setComposing(false);
                  onSelect(threadId);
                }}
                onCancel={() => setComposing(false)}
              />
              <SourcesPlaceholder />
            </>
          ) : refused ? (
            <>
              <ThreadUnavailable
                className={cn(threadMainClass, threadPadClass)}
                onBack={back}
                onBackToInbox={() => onSelect(null)}
              />
              <SourcesPlaceholder />
            </>
          ) : selected ? (
            shownThread === null ? (
              <>
                {showThreadSkeleton ? (
                  <ThreadSkeleton onBack={back} />
                ) : (
                  <div className={threadMainClass} />
                )}
                <SourcesPlaceholder />
              </>
            ) : (
              // While the next thread loads the previous one stays on screen
              // but inert: nothing in it can be claimed, sent or changed
              // under the new row's highlight.
              <div
                className={cn("contents", shownThread !== selected && "[&>*]:opacity-60")}
                inert={shownThread !== selected}
                aria-busy={shownThread !== selected || undefined}
              >
                <ThreadDetail
                  key={shownThread}
                  threadId={shownThread}
                  innId={innId}
                  viewerId={viewerId}
                  liveMail={liveMail}
                  onBack={back}
                  onOpenCorrections={onOpenCorrections}
                  onForeign={onForeignThread}
                  onBackToInbox={() => onSelect(null)}
                />
              </div>
            )
          ) : (
            <>
              <div className="flex min-h-0 min-w-0 items-center justify-center overflow-y-auto p-6">
                <div className="max-w-sm px-6 text-center">
                  <p className="text-[14px] leading-5 font-semibold text-ink-1">
                    Pick a thread
                  </p>
                  <p className="mt-1 text-[13px] leading-5 text-ink-2">
                    Guest messages, the drafted reply and its sources appear
                    here.
                  </p>
                </div>
              </div>
              <SourcesPlaceholder />
            </>
          )
        ) : null}
      </div>
    </div>
  );
}
