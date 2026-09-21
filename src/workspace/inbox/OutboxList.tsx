import type { OutboxRow } from "../types";
import { Pill } from "../lib/ui";
import { OUTBOX_LABEL, formatStamp } from "../lib/format";

const KIND_LABEL: Record<OutboxRow["kind"], string> = {
  reply: "Reply",
  correction: "Correction",
  follow_up: "Follow-up",
};

/**
 * Delivery state straight from the outbox table. "Delivered" only appears once
 * the server commits the send; a reservation is shown as queued, never as sent.
 */
export function OutboxList({ rows, title = "Delivery" }: { rows: OutboxRow[]; title?: string }) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.reservedAt - a.reservedAt);
  return (
    <div className="fd-outbox" aria-label={title}>
      <p className="fd-section__title">{title}</p>
      <ul className="fd-outbox__list">
        {sorted.map((row) => (
          <li key={row._id} className="fd-outbox__row">
            <OutboxPill row={row} />
            <span className="fd-small">
              {KIND_LABEL[row.kind] ?? row.kind}
              {row.simulated ? " · simulated, nothing left this deployment" : ""}
              {" · "}
              {row.status === "sent" && row.sentAt ? `delivered ${formatStamp(row.sentAt)}` : `queued ${formatStamp(row.reservedAt)}`}
            </span>
            {row.status === "failed" ? (
              <span className="fd-small" style={{ color: "var(--fd-error)" }}>
                {row.errorMessage ?? row.errorKind ?? "The provider rejected the message."}{" "}
                {row.kind === "follow_up" ? "Nothing was sent. Approve a new follow-up if one is still wanted." : "You can try sending again."}
              </span>
            ) : null}
            {row.status === "unknown" ? (
              <span className="fd-small" style={{ color: "var(--fd-caution)" }}>
                The provider did not confirm delivery
                {row.errorMessage ? ` (${row.errorMessage})` : ""}. It may have reached the guest. Do not retry;
                check the mailbox first.
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OutboxPill({ row }: { row: OutboxRow }) {
  const meta = OUTBOX_LABEL[row.status] ?? { label: row.status, tone: "neutral" as const };
  return (
    <Pill tone={meta.tone}>
      {meta.label}
      {row.simulated && row.status === "sent" ? " (simulated)" : ""}
    </Pill>
  );
}
