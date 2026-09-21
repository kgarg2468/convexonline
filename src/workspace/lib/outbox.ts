import type { Id } from "../../../convex/_generated/dataModel";
import type { OutboxRow } from "../types";

/**
 * Outbox rows are attributed by exact id, never by thread. A row whose
 * draftId/correctionId is null (written before the projection carried the
 * ids, or served by an older deployment) is history for the thread, not the
 * delivery state of whatever draft or correction is on screen now.
 */
export function outboxForDraft(rows: OutboxRow[], draftId: Id<"drafts">): OutboxRow[] {
  return rows.filter((r) => r.kind === "reply" && r.draftId === draftId);
}

export function outboxForCorrection(rows: OutboxRow[], correctionId: Id<"corrections">): OutboxRow[] {
  return rows.filter((r) => r.kind === "correction" && r.correctionId === correctionId);
}

/** Reply rows that do not belong to the given draft: earlier drafts' deliveries and rows without an id. */
export function otherReplyOutbox(rows: OutboxRow[], draftId: Id<"drafts"> | null): OutboxRow[] {
  return rows.filter((r) => r.kind === "reply" && (draftId === null || r.draftId !== draftId));
}

/** The most recent row among the given ones. */
export function latestOutbox(rows: OutboxRow[]): OutboxRow | null {
  let latest: OutboxRow | null = null;
  for (const row of rows) {
    if (!latest || row.reservedAt > latest.reservedAt) latest = row;
  }
  return latest;
}

/** A row the sender still owns: nothing else may be sent for its draft/correction until it settles. */
export function isInFlight(row: OutboxRow | null): boolean {
  return row !== null && (row.status === "reserved" || row.status === "sending" || row.status === "unknown");
}
