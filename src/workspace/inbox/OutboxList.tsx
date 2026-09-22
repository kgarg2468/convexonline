import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { OutboxRow } from "../types";
import { OUTBOX_LABEL, formatStamp } from "../lib/format";
import { cn } from "@/lib/utils";
import { Chip, SectionLabel } from "./primitives";
import { LEGACY_TONE } from "./styles";

const KIND_LABEL: Record<OutboxRow["kind"], string> = {
  reply: "Reply",
  correction: "Correction",
  follow_up: "Follow-up",
};

/** Beyond this many rows the list folds behind a disclosure; it opens by itself whenever the newest row is unsettled. */
const FOLD_AFTER = 2;

/**
 * Delivery state straight from the outbox table. "Delivered" only appears once
 * the server commits the send; a reservation is shown as queued, never as sent.
 * `.fd-outbox[aria-label=title]` is the hook the specs read. `hideTitle` drops
 * the visible label where the surrounding row already says what this is (a
 * sent draft's summary); the `aria-label` keeps naming it.
 */
export function OutboxList({
  rows,
  title = "Delivery",
  className,
  hideTitle = false,
}: {
  rows: OutboxRow[];
  title?: string;
  className?: string;
  hideTitle?: boolean;
}) {
  const sorted = [...rows].sort((a, b) => b.reservedAt - a.reservedAt);
  const foldable = sorted.length > FOLD_AFTER;
  const newest = sorted[0];
  const unsettled = newest !== undefined && newest.status !== "sent";
  // The disclosure follows the newest row as it changes (a row that turns
  // failed or unknown later unfolds the list); a settled row never folds it.
  const newestKey = newest ? `${newest._id}:${newest.status}` : "";
  const [open, setOpen] = useState(unsettled);
  const [seenKey, setSeenKey] = useState(newestKey);
  if (seenKey !== newestKey) {
    setSeenKey(newestKey);
    if (unsettled) setOpen(true);
  }
  const listId = useId();
  if (rows.length === 0) return null;
  const expanded = !foldable || open;

  return (
    <div className={cn("fd-outbox", className)} aria-label={title}>
      {foldable ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-left outline-hidden transition-colors duration-micro hover:bg-bg-2 focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2"
        >
          <SectionLabel as="p">
            {title} <span className="ml-0.5 font-medium tabular-nums normal-case tracking-normal text-ink-3">· {sorted.length}</span>
          </SectionLabel>
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 text-ink-3 ease-out motion-safe:transition-transform motion-safe:duration-small", expanded && "rotate-180")}
          />
        </button>
      ) : hideTitle ? null : (
        <SectionLabel>{title}</SectionLabel>
      )}
      {expanded ? (
        <ul id={listId} className={cn("divide-y divide-border-1", !(hideTitle && !foldable) && "mt-1")}>
          {sorted.map((row) => (
            <li key={row._id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 text-[13px] leading-5 text-ink-2">
              <OutboxChip row={row} />
              <time
                dateTime={new Date(row.status === "sent" && row.sentAt ? row.sentAt : row.reservedAt).toISOString()}
                className="text-[12px] leading-4 text-ink-3 tabular-nums"
              >
                {row.status === "sent" && row.sentAt ? `delivered ${formatStamp(row.sentAt)}` : `queued ${formatStamp(row.reservedAt)}`}
              </time>
              <span className="[overflow-wrap:anywhere]">
                {KIND_LABEL[row.kind] ?? row.kind}
                {row.simulated ? " · simulated, nothing left this deployment" : ""}
              </span>
              {row.status === "failed" ? (
                <span className="basis-full text-danger-10">
                  {row.errorMessage ?? row.errorKind ?? "The provider rejected the message."}{" "}
                  {row.kind === "follow_up" ? "Nothing was sent. Approve a new follow-up if one is still wanted." : "You can try sending again."}
                </span>
              ) : null}
              {row.status === "unknown" ? (
                <span className="basis-full text-warning-10">
                  The provider did not confirm delivery
                  {row.errorMessage ? ` (${row.errorMessage})` : ""}. It may have reached the guest. Do not retry; check the mailbox first.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function OutboxChip({ row }: { row: OutboxRow }) {
  const meta = OUTBOX_LABEL[row.status] ?? { label: row.status, tone: "neutral" as const };
  return (
    <Chip tone={LEGACY_TONE[meta.tone]}>
      {meta.label}
      {row.simulated && row.status === "sent" ? " (simulated)" : ""}
    </Chip>
  );
}
