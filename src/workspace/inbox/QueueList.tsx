import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ThreadStatus, ThreadSummary } from "../types";
import { Empty, Pill, Spinner } from "../lib/ui";
import { STATUS_LABEL, formatWhen, guestName } from "../lib/format";
import { useNow } from "../lib/hooks";

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

function statusTone(status: ThreadStatus): "caution" | "pine" | "muted" | "neutral" {
  if (status === "needs_staff") return "caution";
  if (status === "ready") return "pine";
  if (status === "closed" || status === "sent") return "muted";
  return "neutral";
}

export function QueueList({
  innId,
  selected,
  onSelect,
  viewerId,
  onCompose,
}: {
  innId: Id<"inns">;
  selected: Id<"threads"> | null;
  onSelect: (threadId: Id<"threads">) => void;
  viewerId: Id<"users">;
  /** Demo only: opens the simulated guest inquiry form. */
  onCompose?: () => void;
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

  return (
    <section className="fd-queue" aria-label="Guest threads">
      <div className="fd-queue__tools">
        <label className="fd-sr-only" htmlFor="fd-queue-search">
          Search subject, guest email or message
        </label>
        <input
          id="fd-queue-search"
          className="fd-input"
          type="search"
          placeholder="Search subject, email or message"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="fd-sr-only" htmlFor="fd-queue-filter">
          Filter by status
        </label>
        <select
          id="fd-queue-filter"
          className="fd-select"
          value={filter}
          disabled={searching}
          onChange={(e) => setFilter(e.target.value as ThreadStatus | "all")}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        {searching ? (
          <p className="fd-muted fd-small">Search covers subject, guest email and message preview; the status filter is paused.</p>
        ) : null}
        {onCompose ? (
          <button type="button" className="fd-btn fd-btn--small" onClick={onCompose}>
            Simulate a guest inquiry
          </button>
        ) : null}
      </div>
      <div className="fd-queue__list">
        {threads === undefined ? (
          <div style={{ padding: 12 }}>
            <Spinner label={searching ? "Searching" : "Loading threads"} />
          </div>
        ) : threads.length === 0 ? (
          <div style={{ padding: 12 }}>
            <Empty title={searching ? "No matches" : "No threads here"}>
              {searching
                ? "Try a word from the subject, the guest's email or their message."
                : filter === "all"
                  ? "Guest email will appear here once the inbox is connected."
                  : "Nothing with this status right now."}
            </Empty>
          </div>
        ) : (
          <ul>
            {threads.map((t) => (
              <li key={t._id}>
                <button
                  type="button"
                  className="fd-queue__item"
                  aria-current={selected === t._id ? "true" : undefined}
                  onClick={() => onSelect(t._id)}
                >
                  <div className="fd-queue__top">
                    <span className="fd-queue__name">{guestName(t.guestEmail)}</span>
                    <span className="fd-queue__when">{formatWhen(t.lastInboundAt, now)}</span>
                  </div>
                  <div className="fd-queue__subject">{t.subject}</div>
                  <div className="fd-queue__snippet">{t.snippet}</div>
                  <div className="fd-queue__meta">
                    <Pill tone={statusTone(t.status)}>{STATUS_LABEL[t.status] ?? t.status}</Pill>
                    {t.claim ? (
                      <Pill tone="neutral">
                        {t.claim.userId === viewerId ? "You have it" : `${t.claim.name ?? "Someone"} has it`}
                      </Pill>
                    ) : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
