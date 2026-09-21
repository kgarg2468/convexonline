import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ApproveFollowUpResult, FollowUpEmail, FollowUpEmailView, OutboxRow } from "../types";
import { Notice, Pill } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { OUTBOX_LABEL, formatStamp } from "../lib/format";
import { OutboxList } from "./OutboxList";

type Tone = "neutral" | "pine" | "caution" | "error" | "muted";

/**
 * The approved follow-up email for a thread. Everything shown comes from
 * `followUps.emailForThread`: the exact text that can be approved (the panel
 * never composes text), the time bounds, the pending approval and the
 * thread's approval history. Approving the original reply never approves a
 * follow-up; only the explicit button here does, and only while the caller
 * holds the thread claim. Nothing is sent from the browser.
 */
export function FollowUpPanel({
  threadId,
  viewerId,
  canAct,
  isDemo,
  outbox,
}: {
  threadId: Id<"threads">;
  viewerId: Id<"users">;
  /** The viewer holds the thread claim right now. */
  canAct: boolean;
  isDemo: boolean;
  /** Outbox rows of kind follow_up for this thread. */
  outbox: OutboxRow[];
}) {
  const view = useQuery(api.followUps.emailForThread, { threadId }) as FollowUpEmailView | undefined;
  const approve = useMutation(api.followUps.approveEmail);
  const cancel = useMutation(api.followUps.cancelEmail);
  const approveAction = useAsyncAction();
  const cancelAction = useAsyncAction();
  // The picker's text as typed; null means "not touched", which follows the
  // server's default (or the pending approval's time when rescheduling).
  const [typed, setTyped] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  if (view === undefined) return null;
  const current = view.current;
  const scheduled = current && current.status === "scheduled" ? current : null;
  const showPanel = view.canApprove || current !== null || view.history.length > 0 || outbox.length > 0;
  if (!showPanel) return null;

  const zoneName = browserZoneName();
  const inputValue = typed ?? toLocalInput(scheduled ? scheduled.dueAt : view.defaultDueAt);
  // The picker's label carries the offset of the instant typed, not today's:
  // a time on the far side of a DST change has a different one.
  const parsedInput = fromLocalInput(inputValue);
  const inputZoneLabel = parsedInput.ok ? zoneLabelAt(parsedInput.ms) : zoneName;
  // Approval (first time) or reschedule (a pending approval with a new time).
  const offerApproval = view.canApprove && (current === null || scheduled !== null);
  const claimHint = view.requiresClaim || !canAct;
  const approveLabel = scheduled
    ? isDemo ? "Reschedule follow-up (simulated)" : "Reschedule follow-up"
    : isDemo ? "Approve follow-up email (simulated)" : "Approve follow-up email";

  async function submit() {
    setLocalError(null);
    const parsed = fromLocalInput(inputValue);
    if (!parsed.ok) {
      setLocalError(
        parsed.reason === "nonexistent"
          ? `That time does not exist in ${zoneName}: clocks skip it when they move forward. Choose a different time.`
          : "Enter a valid date and time.",
      );
      return;
    }
    const dueAt = parsed.ms;
    if (dueAt < view!.minDueAt || dueAt > view!.maxDueAt) {
      setLocalError(
        `The follow-up must be scheduled between ${formatStamp(view!.minDueAt)} (${offsetAt(view!.minDueAt)}) and ${formatStamp(view!.maxDueAt)} (${offsetAt(view!.maxDueAt)}) in ${zoneName}.`,
      );
      return;
    }
    if (scheduled && dueAt === scheduled.dueAt) {
      setLocalError("That is already the scheduled time.");
      return;
    }
    const result = (await approveAction.run(() => approve({ threadId, text: view!.text, dueAt }))) as
      | ApproveFollowUpResult
      | undefined;
    if (result !== undefined) setTyped(null);
  }

  async function withdraw(followUpId: Id<"followUps">) {
    setLocalError(null);
    const result = await cancelAction.run(() => cancel({ followUpId }));
    if (result !== undefined) setTyped(null);
  }

  const busy = approveAction.busy || cancelAction.busy;
  const history = view.history.filter((row) => row._id !== current?._id);

  return (
    <section className="fd-followup" aria-labelledby="fd-followup-title">
      <div className="fd-followup__head">
        <h3 id="fd-followup-title" className="fd-small" style={{ fontWeight: 600 }}>
          Follow-up email
        </h3>
        {current ? <StatusPill row={current} /> : <Pill tone="muted">Not approved</Pill>}
      </div>
      <p className="fd-field__hint">
        {current
          ? "One follow-up email per answered inquiry. It goes out only at the approved time, and only if the guest has not written again and the thread is still an open inquiry."
          : "If the guest does not reply, staff may approve one follow-up email with exactly the text below. Sending the reply did not approve it; nothing is emailed unless it is approved here."}
      </p>

      {current ? (
        <div className="fd-followup__current">
          <blockquote className="fd-followup__text" aria-label="Approved follow-up text">
            {current.text ?? view.text}
          </blockquote>
          <dl className="fd-followup__meta">
            <div>
              <dt>{current.status === "sent" ? "Sent" : current.status === "scheduled" ? "Sends" : "Was due"}</dt>
              <dd>
                <time dateTime={new Date(current.sentAt ?? current.dueAt).toISOString()}>
                  {formatStamp(current.sentAt ?? current.dueAt)}
                </time>{" "}
                <span className="fd-muted">({zoneLabelAt(current.sentAt ?? current.dueAt)})</span>
              </dd>
            </div>
            <div>
              <dt>Approved by</dt>
              <dd>
                {approverLabel(current, viewerId)}
                {current.approvedAt ? ` on ${formatStamp(current.approvedAt)}` : ""}
              </dd>
            </div>
          </dl>
          <p className="fd-field__hint">{currentExplanation(current, isDemo)}</p>
          {canCancel(current) ? (
            <div className="fd-btn-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="fd-btn fd-btn--small"
                disabled={busy || claimHint}
                onClick={() => void withdraw(current._id)}
              >
                {cancelAction.busy ? "Cancelling…" : "Cancel follow-up"}
              </button>
              {claimHint ? <span className="fd-muted fd-small">Take this thread to cancel the follow-up.</span> : null}
            </div>
          ) : null}
        </div>
      ) : view.canApprove ? (
        <blockquote className="fd-followup__text" aria-label="Proposed follow-up text">
          {view.text}
        </blockquote>
      ) : null}

      {offerApproval ? (
        <div className="fd-followup__form">
          <div className="fd-field" style={{ marginBottom: 8 }}>
            <label className="fd-field__label" htmlFor="fd-followup-when">
              {scheduled ? "New send time" : "Send at"} ({inputZoneLabel})
            </label>
            <input
              id="fd-followup-when"
              className="fd-input fd-followup__when"
              type="datetime-local"
              value={inputValue}
              min={toLocalInput(view.minDueAt)}
              max={toLocalInput(view.maxDueAt)}
              step={60}
              disabled={busy || claimHint}
              onChange={(e) => {
                setTyped(e.target.value);
                setLocalError(null);
              }}
            />
            <p className="fd-field__hint">
              Times are in your browser's time zone, {zoneName}. Allowed: between 1 minute and 30 days from now
              {scheduled ? "" : "; the default is 48 hours"}.
            </p>
          </div>
          <div className="fd-btn-row">
            <button
              type="button"
              className={`fd-btn${scheduled ? "" : " fd-btn--primary"}`}
              disabled={busy || claimHint}
              aria-describedby="fd-followup-why"
              onClick={() => void submit()}
            >
              {approveAction.busy ? "Approving…" : approveLabel}
            </button>
          </div>
          <p id="fd-followup-why" className="fd-field__hint" style={{ marginTop: 8 }}>
            {claimHint
              ? "Take this thread to approve a follow-up."
              : isDemo
                ? "Simulated: the follow-up is recorded in this demo at the chosen time. No real email is sent."
                : "Emails exactly the text above to the guest at the chosen time, with your approval. It is withdrawn automatically if the guest writes first, the thread is closed, or your access ends."}
          </p>
        </div>
      ) : view.blockedReason && current === null ? (
        <p className="fd-field__hint">No follow-up can be approved: {view.blockedReason}.</p>
      ) : null}

      {localError ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="error">{localError}</Notice>
        </div>
      ) : null}
      {approveAction.error ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="error">{approveAction.error}</Notice>
        </div>
      ) : null}
      {cancelAction.error ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="error">{cancelAction.error}</Notice>
        </div>
      ) : null}

      {outbox.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <OutboxList rows={outbox} title="Follow-up delivery" />
        </div>
      ) : null}

      {history.length > 0 ? (
        <div className="fd-followup__history" aria-label="Follow-up history">
          <p className="fd-section__title">Follow-up history</p>
          <ul className="fd-outbox__list">
            {history.map((row) => (
              <li key={row._id} className="fd-outbox__row">
                <StatusPill row={row} />
                <span className="fd-small">
                  {row.status === "sent" && row.sentAt
                    ? `sent ${formatStamp(row.sentAt)} (${offsetAt(row.sentAt)})`
                    : `due ${formatStamp(row.dueAt)} (${offsetAt(row.dueAt)})`}
                  {" · "}approved by {approverLabel(row, viewerId)}
                  {row.statusReason ? ` · ${row.statusReason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** Status straight from the approval row, refined by its outbox row once the due worker has reserved delivery. */
function statusMeta(row: FollowUpEmail): { label: string; tone: Tone } {
  switch (row.status) {
    case "scheduled":
      return { label: "Scheduled", tone: "neutral" };
    case "reserved": {
      const delivery = row.delivery?.status ?? "reserved";
      const meta = OUTBOX_LABEL[delivery] ?? { label: "Queued to send", tone: "neutral" as const };
      return { label: meta.label, tone: meta.tone };
    }
    case "sent":
      return { label: row.simulated ? "Sent (simulated)" : "Sent", tone: "pine" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted" };
  }
}

function StatusPill({ row }: { row: FollowUpEmail }) {
  const meta = statusMeta(row);
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

function currentExplanation(row: FollowUpEmail, isDemo: boolean): string {
  if (row.status === "scheduled") {
    return isDemo
      ? "Approved. At the due time the demo records a simulated delivery; nothing leaves this deployment. Cancel or reschedule while it is still scheduled."
      : "Approved. At the due time the sender re-checks that the guest has not replied and that the approving staff member still has mail authority, then sends exactly this text. Cancel or reschedule while it is still scheduled.";
  }
  if (row.status === "reserved") {
    const delivery = row.delivery?.status;
    if (delivery === "unknown") {
      return `The send outcome could not be confirmed${row.delivery?.errorMessage ? ` (${row.delivery.errorMessage})` : ""}. It may have reached the guest. It will not be retried and no new follow-up can be approved for this message; check the mailbox.`;
    }
    if (delivery === "sending") return "The follow-up is with the mail provider and can no longer be cancelled.";
    return "The due worker has queued the follow-up for delivery. It can still be cancelled until the provider is called.";
  }
  if (row.status === "sent") {
    return row.simulated ? "Simulated delivery recorded in this demo; nothing left this deployment." : "The follow-up was sent.";
  }
  return row.statusReason ?? "";
}

/** Only a schedule, or a reservation the provider has not been handed, can be withdrawn. */
function canCancel(row: FollowUpEmail): boolean {
  if (row.status === "scheduled") return true;
  if (row.status !== "reserved") return false;
  return row.delivery === null || row.delivery.status === "reserved";
}

function approverLabel(row: FollowUpEmail, viewerId: Id<"users">): string {
  if (row.approvedBy === viewerId) return row.approvedByName ? `you (${row.approvedByName})` : "you";
  return row.approvedByName ?? "a staff member";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local wall-clock text for a datetime-local input, minute precision. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type LocalInputResult =
  | { ok: true; ms: number }
  /** Not a calendar date and time at all (bad syntax, Feb 30, 25:00). */
  | { ok: false; reason: "invalid" }
  /** A real wall-clock reading that the browser's zone skips (clocks jump over it, spring-forward). */
  | { ok: false; reason: "nonexistent" };

/**
 * The instant a datetime-local value names in the browser's zone. The
 * components are round-tripped through `Date` so that a local time the zone
 * skips (a DST gap) or an impossible date is refused rather than silently
 * approved as a different time from the one typed. Valid readings, including
 * both readings of a repeated fall-back hour, keep the instant `Date` picks.
 */
function fromLocalInput(value: string): LocalInputResult {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return { ok: false, reason: "invalid" };
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // Calendar validity is zone-independent: check it in UTC so a gap cannot masquerade as a bad date.
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return { ok: false, reason: "invalid" };
  }
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: "invalid" };
  const local = new Date(year, month - 1, day, hour, minute, second, 0);
  const ms = local.getTime();
  if (!Number.isFinite(ms)) return { ok: false, reason: "invalid" };
  const same =
    local.getFullYear() === year &&
    local.getMonth() === month - 1 &&
    local.getDate() === day &&
    local.getHours() === hour &&
    local.getMinutes() === minute &&
    local.getSeconds() === second;
  return same ? { ok: true, ms } : { ok: false, reason: "nonexistent" };
}

/** The browser's IANA zone name, with no offset: offsets belong to instants, not to zones. */
function browserZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

/** The UTC offset the browser's zone uses at `ms`, e.g. "UTC+11:00". Never today's offset for another day. */
function offsetAt(ms: number): string {
  const offsetMin = -new Date(ms).getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "Zone, UTC±HH:MM" for the instant actually being shown. */
function zoneLabelAt(ms: number): string {
  return `${browserZoneName()}, ${offsetAt(ms)}`;
}
