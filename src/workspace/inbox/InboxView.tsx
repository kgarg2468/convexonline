import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type {
  LiveMailDecision,
  ThreadDetail as ThreadDetailData,
} from "../types";
import { useDelayedFlag, useIsNarrow } from "../lib/hooks";
import { cn } from "@/lib/utils";
import { QueueList, type QueueKeyHandler } from "./QueueList";
import type { SelectSource } from "./QueueRow";
import { ThreadSkeleton } from "./QueueSkeleton";
import { ThreadDetail } from "./ThreadDetail";
import { DemoInbound } from "../shell/DemoInbound";

/** The empty third column beside a pane that has no sources of its own (only on the three-pane layout). */
function SourcesPlaceholder() {
  return (
    <div
      aria-hidden="true"
      className="hidden border-l border-border-1 bg-white min-[1200px]:block"
    />
  );
}

/**
 * The inbox frame. From 1200px: queue 340 | thread | sources 320, each pane
 * scrolling on its own under the sticky header. 900–1199px: queue + thread,
 * the sources pane opens as a sheet from the header (SourcesSheet). Under
 * 900px the list and the thread are separate screens that scroll with the
 * page. The thread's own two-column markup is untouched: its main and side
 * panes join this grid through `display: contents` on `.fd-thread`.
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

  // Same subscription the thread pane opens (the client shares it), read here
  // only to hold a skeleton in the pane until the thread has arrived.
  const detail = useQuery(
    api.threads.get,
    selected && !composing ? { threadId: selected } : "skip",
  ) as ThreadDetailData | undefined;
  const threadLoading = selected !== null && !composing && detail === undefined;
  const showThreadSkeleton = useDelayedFlag(threadLoading);
  const back = narrow ? () => onSelect(null) : null;

  // Beside the rail the frame fills whatever the sticky header leaves of the
  // viewport: the outer box adds no height of its own (the shell's column is
  // min-h-dvh), so the panes' content never stretches the page and the
  // header may be as tall as its stats and actions need.
  return (
    <div
      className={cn(
        "min-w-0 flex-1",
        narrow ? "flex min-h-0 flex-col" : "relative",
      )}
    >
      <div
        className={cn(
          narrow
            ? "contents"
            : "absolute inset-0 grid grid-cols-[340px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] min-[1200px]:grid-cols-[340px_minmax(0,1fr)_320px]",
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
              onSelect(id);
            }}
            viewerId={viewerId}
            registerKeys={registerKeys}
            narrow={narrow}
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
          ) : selected ? (
            threadLoading ? (
              <>
                {showThreadSkeleton ? (
                  <ThreadSkeleton onBack={back} />
                ) : (
                  <div className="fd-thread__main" />
                )}
                <SourcesPlaceholder />
              </>
            ) : (
              <ThreadDetail
                key={selected}
                threadId={selected}
                innId={innId}
                viewerId={viewerId}
                liveMail={liveMail}
                onBack={back}
                onOpenCorrections={onOpenCorrections}
                onForeign={onForeignThread}
                onBackToInbox={() => onSelect(null)}
              />
            )
          ) : (
            <>
              <div className="flex min-h-0 min-w-0 items-center justify-center overflow-y-auto p-6">
                <div className="max-w-sm rounded-[10px] border border-dashed border-border-2 px-6 py-8 text-center">
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
