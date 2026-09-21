import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { LiveMailDecision, ThreadDetail as ThreadDetailData } from "../types";
import { Empty, Notice, Pill, Spinner } from "../lib/ui";
import { useAsyncAction, useNow } from "../lib/hooks";
import { STATUS_LABEL, formatDate, formatStamp, formatWhen, guestName } from "../lib/format";
import { DraftPanel } from "./DraftPanel";
import { FollowUpPanel } from "./FollowUpPanel";
import { GapForm } from "./GapForm";
import { OutboxList } from "./OutboxList";
import { SourcePanel } from "./SourcePanel";
import { ThreadPresence } from "./ThreadPresence";
import { otherReplyOutbox } from "../lib/outbox";

export function ThreadDetail({
  threadId,
  innId,
  viewerId,
  liveMail,
  onBack,
  onOpenCorrections,
}: {
  threadId: Id<"threads">;
  innId: Id<"inns">;
  viewerId: Id<"users">;
  liveMail: LiveMailDecision | undefined;
  onBack: (() => void) | null;
  onOpenCorrections: () => void;
}) {
  const detail = useQuery(api.threads.get, { threadId }) as ThreadDetailData | undefined;
  const claim = useMutation(api.threads.claim);
  const release = useMutation(api.threads.release);
  const setStatus = useMutation(api.threads.setStatus);
  const regenerate = useMutation(api.drafts.regenerate);
  const lock = useAsyncAction();
  const statusAction = useAsyncAction();
  const regenAction = useAsyncAction();
  const now = useNow(15_000);

  if (detail === undefined) {
    return (
      <div className="fd-thread__main">
        {onBack ? <BackButton onBack={onBack} /> : null}
        <Spinner label="Loading thread" />
      </div>
    );
  }

  const { thread, messages, draft } = detail;
  const holder = thread.claim && thread.claim.expiresAt > now ? thread.claim : null;
  const mine = holder?.userId === viewerId;
  const heldByOther = holder !== null && !mine;
  const openCorrections = detail.corrections.filter((c) => c.status === "needs_review" || c.status === "approved").length;
  // Thread-level history: every correction row, plus reply rows that are not
  // the current draft's (earlier drafts, or rows written without a draftId).
  // The current draft's own rows are shown inside the draft panel.
  const correctionOutbox = detail.outbox.filter((o) => o.kind === "correction");
  // Approved follow-up deliveries are their own group: they never count as
  // reply deliveries and are shown inside the follow-up panel.
  const followUpOutbox = detail.outbox.filter((o) => o.kind === "follow_up");
  const earlierReplyOutbox = otherReplyOutbox(detail.outbox, draft && !draft.abstain ? draft._id : null);
  const isDemo = detail.inn.isDemo;
  const canRegenerate =
    !isDemo && mine && thread.lastInboundMessageId !== null && (draft === null || draft.abstain || draft.status === "needs_edit");

  return (
    <div className="fd-thread">
      <div className="fd-thread__main">
        {onBack ? <BackButton onBack={onBack} /> : null}
        <div className="fd-thread__head">
          <div style={{ minWidth: 0 }}>
            <h2 className="fd-thread__subject">{thread.subject}</h2>
            <div className="fd-thread__guest">
              {guestName(thread.guestEmail)} · {thread.guestEmail}
            </div>
          </div>
          <div className="fd-btn-row">
            <Pill tone={thread.status === "needs_staff" ? "caution" : thread.status === "ready" ? "pine" : "neutral"}>
              {STATUS_LABEL[thread.status] ?? thread.status}
            </Pill>
          </div>
        </div>
        {thread.stay ? (
          <div className="fd-thread__stay">
            <span>{thread.stay.status === "booked" ? "Booked" : "Inquiry"}</span>
            {thread.stay.checkIn ? (
              <span>
                {formatDate(thread.stay.checkIn)}
                {thread.stay.checkOut ? ` to ${formatDate(thread.stay.checkOut)}` : ""}
              </span>
            ) : null}
            {thread.stay.party ? <span>{thread.stay.party} {thread.stay.party === 1 ? "guest" : "guests"}</span> : null}
          </div>
        ) : null}

        {openCorrections > 0 ? (
          <div style={{ marginBottom: 14 }}>
            <Notice tone="caution">
              A reply sent in this thread quoted a page that has since changed.{" "}
              <button type="button" className="fd-btn fd-btn--small" onClick={onOpenCorrections}>
                Review the correction
              </button>
            </Notice>
          </div>
        ) : null}
        {detail.followUp ? (
          <div style={{ marginBottom: 14 }}>
            <Notice tone="info">
              Reminder {detail.followUp.status === "due" ? "is due" : "set for"} {formatStamp(detail.followUp.dueAt)} if the guest has not
              replied. The reminder only flags the thread for staff; it never emails the guest.
            </Notice>
          </div>
        ) : null}

        <div className={`fd-claimbar${mine ? " fd-claimbar--mine" : heldByOther ? " fd-claimbar--other" : ""}`}>
          <span>
            {mine
              ? `You have this thread until ${formatStamp(holder!.expiresAt)}.`
              : heldByOther
                ? `${holder!.name ?? "Another staff member"} is working on this until ${formatStamp(holder!.expiresAt)}.`
                : "Nobody is working on this thread."}
          </span>
          <div className="fd-btn-row">
            {mine ? (
              <>
                <button
                  type="button"
                  className="fd-btn fd-btn--small"
                  disabled={lock.busy}
                  onClick={() => void lock.run(() => claim({ threadId }))}
                >
                  Extend
                </button>
                <button
                  type="button"
                  className="fd-btn fd-btn--small"
                  disabled={lock.busy}
                  onClick={() => void lock.run(() => release({ threadId }))}
                >
                  Release
                </button>
              </>
            ) : (
              <button
                type="button"
                className="fd-btn fd-btn--small fd-btn--primary"
                disabled={lock.busy || heldByOther}
                onClick={() => void lock.run(() => claim({ threadId }))}
              >
                {lock.busy ? "Taking…" : "Take this thread"}
              </button>
            )}
          </div>
        </div>
        <ThreadPresence key={`${threadId}:${viewerId}`} threadId={threadId} />
        {lock.error ? (
          <div style={{ marginBottom: 14 }}>
            <Notice tone="error">{lock.error}</Notice>
          </div>
        ) : null}

        <div className="fd-messages">
          {messages.length === 0 ? (
            <Empty title="No messages stored for this thread" />
          ) : (
            messages.map((m) => (
              <article key={m._id} className={`fd-msg${m.direction === "out" ? " fd-msg--out" : ""}`}>
                <div className="fd-msg__meta">
                  <span>{m.direction === "in" ? guestName(m.from) : `Front desk to ${guestName(m.to)}`}</span>
                  <span title={formatStamp(m.at)}>{formatWhen(m.at, now)}</span>
                </div>
                <div className="fd-msg__text">{m.text}</div>
              </article>
            ))
          )}
        </div>

        {draft?.gapQuestion ? (
          <GapForm innId={innId} threadId={threadId} question={draft.gapQuestion} canAnswer={mine} isDemo={isDemo} />
        ) : null}

        {draft && !draft.abstain ? (
          <DraftPanel detail={detail} canEdit={mine} liveMail={liveMail} />
        ) : draft ? null : (
          <Notice tone="info">
            {thread.status === "drafting"
              ? "Drafting is running on the server. The reply appears here when it finishes."
              : "No draft yet. Drafting runs on the server after a guest message arrives."}
          </Notice>
        )}

        <div style={{ marginTop: 14 }}>
          <FollowUpPanel threadId={threadId} viewerId={viewerId} canAct={mine} isDemo={isDemo} outbox={followUpOutbox} />
        </div>

        {earlierReplyOutbox.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <OutboxList rows={earlierReplyOutbox} title="Earlier reply delivery" />
          </div>
        ) : null}
        {correctionOutbox.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <OutboxList rows={correctionOutbox} title="Correction delivery" />
          </div>
        ) : null}

        <div className="fd-btn-row" style={{ marginTop: 18 }}>
          {thread.status !== "closed" ? (
            <button
              type="button"
              className="fd-btn fd-btn--small"
              disabled={!mine || statusAction.busy}
              onClick={() => void statusAction.run(() => setStatus({ threadId, status: "closed" }))}
            >
              Close thread
            </button>
          ) : null}
          {thread.status !== "waiting_guest" && thread.status !== "closed" ? (
            <button
              type="button"
              className="fd-btn fd-btn--small"
              disabled={!mine || statusAction.busy}
              onClick={() => void statusAction.run(() => setStatus({ threadId, status: "waiting_guest" }))}
            >
              Mark waiting on guest
            </button>
          ) : null}
          {canRegenerate ? (
            <button
              type="button"
              className="fd-btn fd-btn--small"
              disabled={regenAction.busy}
              onClick={() => void regenAction.run(() => regenerate({ threadId }))}
            >
              {regenAction.busy ? "Requesting…" : "Redraft from the latest message"}
            </button>
          ) : null}
          {!mine ? <span className="fd-muted fd-small">Take the thread to change its status.</span> : null}
        </div>
        {regenAction.error ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="error">{regenAction.error}</Notice>
          </div>
        ) : null}
        {statusAction.error ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="error">{statusAction.error}</Notice>
          </div>
        ) : null}
      </div>
      <SourcePanel detail={detail} />
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="fd-btn fd-btn--quiet fd-btn--small fd-back" onClick={onBack}>
      ← All threads
    </button>
  );
}
