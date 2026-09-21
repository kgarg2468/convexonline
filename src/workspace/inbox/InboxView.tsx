import { useState } from "react";
import type { Id } from "../../../convex/_generated/dataModel";
import type { LiveMailDecision } from "../types";
import { useIsNarrow } from "../lib/hooks";
import { Empty } from "../lib/ui";
import { QueueList } from "./QueueList";
import { ThreadDetail } from "./ThreadDetail";
import { DemoInbound } from "../shell/DemoInbound";

/** 300px queue beside the thread on wide screens; list/detail navigation on narrow ones. */
export function InboxView({
  innId,
  viewerId,
  isDemo,
  liveMail,
  selected,
  onSelect,
  onOpenCorrections,
}: {
  innId: Id<"inns">;
  viewerId: Id<"users">;
  isDemo: boolean;
  liveMail: LiveMailDecision | undefined;
  selected: Id<"threads"> | null;
  onSelect: (threadId: Id<"threads"> | null) => void;
  onOpenCorrections: () => void;
}) {
  const narrow = useIsNarrow();
  const [composing, setComposing] = useState(false);
  const showList = !narrow || (selected === null && !composing);
  const showDetail = !narrow || selected !== null || composing;

  return (
    <div className="fd-inbox">
      {showList ? (
        <QueueList
          innId={innId}
          selected={selected}
          onSelect={(id) => {
            setComposing(false);
            onSelect(id);
          }}
          viewerId={viewerId}
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
          <DemoInbound
            innId={innId}
            onCreated={(threadId) => {
              setComposing(false);
              onSelect(threadId);
            }}
            onCancel={() => setComposing(false)}
          />
        ) : selected ? (
          <ThreadDetail
            key={selected}
            threadId={selected}
            innId={innId}
            viewerId={viewerId}
            liveMail={liveMail}
            onBack={narrow ? () => onSelect(null) : null}
            onOpenCorrections={onOpenCorrections}
          />
        ) : (
          <div className="fd-thread__main">
            <Empty title="Pick a thread">Guest messages, the drafted reply and its sources appear here.</Empty>
          </div>
        )
      ) : null}
    </div>
  );
}
