import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import * as m from "motion/react-m";
import { CalendarDays, Lock, Tag, Users } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { LiveMailDecision, ThreadDetail as ThreadDetailData } from "../types";
import { useAsyncAction, useIsMid, useIsNarrow, useNow } from "../lib/hooks";
import { formatDate, formatStamp, formatWhen, guestName } from "../lib/format";
import { otherReplyOutbox } from "../lib/outbox";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusChip } from "./QueueRow";
import { ThreadSkeleton } from "./QueueSkeleton";
import { DraftPanel, type SendSource } from "./DraftPanel";
import { FollowUpPanel } from "./FollowUpPanel";
import { GapForm } from "./GapForm";
import { OutboxList } from "./OutboxList";
import { SourcePanel } from "./SourcePanel";
import { ThreadPresence } from "./ThreadPresence";
import { BackButton, InlineNotice } from "./primitives";
import { threadMainClass, threadPadClass } from "./styles";

/** The send FLIP: 260ms ease-out on a click, instant after ⌘⏎ (research-motion §3: keyboard never animates). */
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];
const sendTransition = (source: SendSource) =>
  source === "keyboard" ? { duration: 0 } : { duration: 0.26, ease: EASE_OUT };

/**
 * The thread pane: sticky head, claim bar, messages, gap form, the draft
 * review surface, follow-up and delivery history, then status actions. Beside
 * the queue it renders its main column and the sources pane as two grid items
 * of the inbox frame (each scrolling on its own); under 900px it is a single
 * stack that scrolls with the page.
 */
export function ThreadDetail({
  threadId,
  innId,
  viewerId,
  liveMail,
  onBack,
  onOpenCorrections,
  onForeign,
  onBackToInbox,
}: {
  threadId: Id<"threads">;
  innId: Id<"inns">;
  viewerId: Id<"users">;
  liveMail: LiveMailDecision | undefined;
  onBack: (() => void) | null;
  onOpenCorrections: () => void;
  /** The thread belongs to another of the viewer's properties: the workspace drops it from the address bar. */
  onForeign?: () => void;
  /** Leaves such a thread for the inbox. */
  onBackToInbox?: () => void;
}) {
  const detail = useQuery(api.threads.get, { threadId }) as ThreadDetailData | undefined;
  // A deep link can name a thread from another inn the viewer belongs to; it is never shown inside this one.
  const foreign = detail !== undefined && detail.inn._id !== innId;
  useEffect(() => {
    if (foreign) onForeign?.();
  }, [foreign, onForeign]);
  const claim = useMutation(api.threads.claim);
  const release = useMutation(api.threads.release);
  const setStatus = useMutation(api.threads.setStatus);
  const regenerate = useMutation(api.drafts.regenerate);
  const lock = useAsyncAction();
  const statusAction = useAsyncAction();
  const regenAction = useAsyncAction();
  const now = useNow(15_000);
  const narrow = useIsNarrow();
  const mid = useIsMid();
  // How the last send was triggered: the sent message's FLIP reads it.
  const [sendSource, setSendSource] = useState<SendSource>("pointer");

  if (detail === undefined) return <ThreadSkeleton onBack={onBack} />;

  if (foreign) {
    return (
      <div className={cn(threadMainClass, threadPadClass, "py-4")}>
        {onBack ? <BackButton onBack={onBack} /> : null}
        <div className="mx-auto max-w-[440px] pt-12 text-center">
          <h2 className="text-[16px] leading-6 font-semibold text-ink-1">This thread belongs to another property.</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-2">
            The link you opened points at a thread in one of your other properties. Switch property to read it there.
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-4 bg-white text-[13px] text-ink-1" onClick={onBackToInbox}>
            Back to inbox
          </Button>
        </div>
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
  // The message the current draft became, so the draft body can hand its box
  // over to it (shared layoutId). Matched by text: messages carry no draft id.
  const sentMessageId =
    draft && draft.status === "sent"
      ? [...messages].reverse().find((msg) => msg.direction === "out" && msg.text.trim() === draft.answer.trim())?._id ?? null
      : null;

  const main = (
    <div className={threadMainClass}>
      <div
        className={cn(
          "fd-thread__head sticky top-0 z-10 border-b border-border-1 bg-bg-1/95 py-3 backdrop-blur-sm max-[900px]:top-(--header-h)",
          threadPadClass,
        )}
      >
        {onBack ? <BackButton onBack={onBack} /> : null}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[18px] leading-6 font-semibold text-balance text-ink-1">{thread.subject}</h2>
            <p className="mt-0.5 truncate text-[13px] leading-5 text-ink-2">
              {guestName(thread.guestEmail)} · {thread.guestEmail}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5 pt-0.5">
            <StatusChip status={thread.status} />
          </div>
        </div>
        {thread.stay ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-5 text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <Tag aria-hidden="true" className="size-3.5 text-ink-3" />
              {thread.stay.status === "booked" ? "Booked" : "Inquiry"}
            </span>
            {thread.stay.checkIn ? (
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <CalendarDays aria-hidden="true" className="size-3.5 text-ink-3" />
                {formatDate(thread.stay.checkIn)}
                {thread.stay.checkOut ? ` to ${formatDate(thread.stay.checkOut)}` : ""}
              </span>
            ) : null}
            {thread.stay.party ? (
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <Users aria-hidden="true" className="size-3.5 text-ink-3" />
                {thread.stay.party} {thread.stay.party === 1 ? "guest" : "guests"}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={cn(threadPadClass, "flex flex-col gap-4 pt-4 pb-10")}>
        {openCorrections > 0 ? (
          <InlineNotice tone="caution" className="flex flex-wrap items-center justify-between gap-2">
            <span>A reply sent in this thread quoted a page that has since changed.</span>
            <Button type="button" variant="outline" size="sm" className="bg-white text-[13px] text-ink-1" onClick={onOpenCorrections}>
              Review the correction
            </Button>
          </InlineNotice>
        ) : null}
        {detail.followUp ? (
          <InlineNotice tone="info">
            Reminder {detail.followUp.status === "due" ? "is due" : "set for"} {formatStamp(detail.followUp.dueAt)} if the guest has not
            replied. The reminder only flags the thread for staff; it never emails the guest.
          </InlineNotice>
        ) : null}

        <div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border-1 bg-bg-2 py-1.5 pr-1.5 pl-3">
            <p className="flex min-w-0 items-center gap-2 text-[13px] leading-5 text-ink-1">
              {heldByOther ? <Lock aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" /> : null}
              <span>
                {mine
                  ? `You have this thread until ${formatStamp(holder!.expiresAt)}.`
                  : heldByOther
                    ? `${holder!.name ?? "Another staff member"} is working on this until ${formatStamp(holder!.expiresAt)}.`
                    : "Nobody is working on this thread."}
              </span>
            </p>
            <div className="flex shrink-0 items-center gap-1">
              {mine ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-[13px] text-ink-2"
                    disabled={lock.busy}
                    onClick={() => void lock.run(() => claim({ threadId }))}
                  >
                    Extend
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="bg-white text-[13px]"
                    disabled={lock.busy}
                    onClick={() => void lock.run(() => release({ threadId }))}
                  >
                    Release
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="text-[13px]"
                  disabled={lock.busy || heldByOther}
                  onClick={() => void lock.run(() => claim({ threadId }))}
                >
                  {lock.busy ? "Taking…" : "Take this thread"}
                </Button>
              )}
            </div>
          </div>
          <ThreadPresence key={`${threadId}:${viewerId}`} threadId={threadId} />
          {lock.error ? (
            <InlineNotice tone="error" className="mt-2">
              {lock.error}
            </InlineNotice>
          ) : null}
        </div>

        {messages.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-border-2 px-4 py-6 text-center">
            <p className="text-[14px] leading-5 font-semibold text-ink-1">No messages stored for this thread</p>
          </div>
        ) : (
          <ol className="flex max-w-[68ch] flex-col gap-3">
            {messages.map((msg) => {
              const out = msg.direction === "out";
              const meta = (
                <div className="mb-1 flex items-baseline justify-between gap-3 text-[12px] leading-4 text-ink-3 tabular-nums">
                  <span className="truncate font-medium text-ink-2">{out ? `Front desk to ${guestName(msg.to)}` : guestName(msg.from)}</span>
                  <time dateTime={new Date(msg.at).toISOString()} title={formatStamp(msg.at)} className="shrink-0">
                    {formatWhen(msg.at, now)}
                  </time>
                </div>
              );
              const body = (
                <div
                  className={cn(
                    "whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-1",
                    out ? "text-[14px] leading-[1.55]" : "font-serif text-[15px] leading-[1.55] italic",
                  )}
                >
                  {msg.text}
                </div>
              );
              const bubble = cn("rounded-[10px] px-4 py-3", out ? "fd-msg--out border border-border-1 bg-white" : "bg-bg-2");
              return (
                <li key={msg._id}>
                  {msg._id === sentMessageId && draft ? (
                    <m.article layoutId={`draft-${draft._id}`} transition={sendTransition(sendSource)} className={bubble}>
                      {meta}
                      {body}
                    </m.article>
                  ) : (
                    <article className={bubble}>
                      {meta}
                      {body}
                    </article>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {draft?.gapQuestion ? (
          <GapForm innId={innId} threadId={threadId} question={draft.gapQuestion} canAnswer={mine} isDemo={isDemo} />
        ) : null}

        {draft && !draft.abstain ? (
          <DraftPanel detail={detail} canEdit={mine} liveMail={liveMail} onSend={setSendSource} />
        ) : draft ? (
          // An abstained draft with no gap question is a drafting failure
          // (no key, budget used up, provider error): show why, never a
          // made-up question, so staff know to redraft or answer by hand.
          draft.statusReason && !draft.gapQuestion && draft.status !== "sent" && draft.status !== "superseded" ? (
            <InlineNotice tone="caution">
              No reply was drafted: {draft.statusReason}.
              {canRegenerate ? " Use “Redraft from the latest message” below to try again." : ""}
            </InlineNotice>
          ) : null
        ) : (
          <InlineNotice tone="info">
            {thread.status === "drafting"
              ? "Drafting is running on the server. The reply appears here when it finishes."
              : "No draft yet. Drafting runs on the server after a guest message arrives."}
          </InlineNotice>
        )}

        <FollowUpPanel threadId={threadId} viewerId={viewerId} canAct={mine} isDemo={isDemo} outbox={followUpOutbox} />

        {earlierReplyOutbox.length > 0 ? <OutboxList rows={earlierReplyOutbox} title="Earlier reply delivery" /> : null}
        {correctionOutbox.length > 0 ? <OutboxList rows={correctionOutbox} title="Correction delivery" /> : null}

        <div className="flex flex-wrap items-center gap-1 border-t border-border-1 pt-3">
          {thread.status !== "closed" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-[13px] text-ink-2"
              disabled={!mine || statusAction.busy}
              onClick={() => void statusAction.run(() => setStatus({ threadId, status: "closed" }))}
            >
              Close thread
            </Button>
          ) : null}
          {thread.status !== "waiting_guest" && thread.status !== "closed" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-[13px] text-ink-2"
              disabled={!mine || statusAction.busy}
              onClick={() => void statusAction.run(() => setStatus({ threadId, status: "waiting_guest" }))}
            >
              Mark waiting on guest
            </Button>
          ) : null}
          {canRegenerate ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-[13px] text-ink-2"
              disabled={regenAction.busy}
              onClick={() => void regenAction.run(() => regenerate({ threadId }))}
            >
              {regenAction.busy ? "Requesting…" : "Redraft from the latest message"}
            </Button>
          ) : null}
          {!mine ? <span className="ml-1 text-[13px] leading-5 text-ink-3">Take the thread to change its status.</span> : null}
        </div>
        {regenAction.error ? <InlineNotice tone="error">{regenAction.error}</InlineNotice> : null}
        {statusAction.error ? <InlineNotice tone="error">{statusAction.error}</InlineNotice> : null}
      </div>
    </div>
  );

  if (narrow) {
    return (
      <div className="min-w-0">
        {main}
        <SourcePanel detail={detail} />
      </div>
    );
  }
  return (
    <>
      {main}
      {mid ? null : <SourcePanel detail={detail} />}
    </>
  );
}
