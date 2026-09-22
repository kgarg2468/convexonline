import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import * as m from "motion/react-m";
import { Lock } from "lucide-react";
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
import { BackButton, InlineNotice, SourcesPlaceholder } from "./primitives";
import { threadMainClass, threadPadClass, touchControlClass } from "./styles";

/** The send FLIP: 260ms ease-out on a click, instant after ⌘⏎ (research-motion §3: keyboard never animates). */
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];
const sendTransition = (source: SendSource) =>
  source === "keyboard" ? { duration: 0 } : { duration: 0.26, ease: EASE_OUT };

const clockOnly = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A claim expiry as the bar shows it: the clock alone while it falls today, the dated stamp otherwise. */
function formatExpiry(ms: number, now: number): string {
  return new Date(ms).toDateString() === new Date(now).toDateString() ? clockOnly.format(ms) : formatStamp(ms);
}

/**
 * The thread pane: one sticky head (subject, status, claim actions, guest and
 * stay meta, claim and presence line), the messages, gap form, the draft
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
  // The claim whose sentence (draft) or card (sources) is hovered or focused; each side highlights the other.
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);

  // Both early returns keep the third grid column's ground, as InboxView does.
  if (detail === undefined) {
    return (
      <>
        <ThreadSkeleton onBack={onBack} />
        <SourcesPlaceholder />
      </>
    );
  }

  if (foreign) {
    return (
      <>
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
        <SourcesPlaceholder />
      </>
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

  const claimLine = mine
    ? `You have this thread until ${formatExpiry(holder!.expiresAt, now)}.`
    : heldByOther
      ? `${holder!.name ?? "Another staff member"} is working on this until ${formatExpiry(holder!.expiresAt, now)}.`
      : "Nobody is working on this thread.";

  const main = (
    <div className={threadMainClass}>
      {/* One compact head: subject + status + claim actions, the guest and stay meta, the claim and presence line.
          It sticks beside the queue, where the column scrolls on its own; on phones the page scrolls and it scrolls with it.
          It is also the container the head row queries so the actions can wrap under the subject in a narrow pane. */}
      <div
        className={cn(
          "fd-thread__head @container z-10 border-b border-border-1 bg-bg-1 py-2 min-[901px]:sticky min-[901px]:top-0",
          threadPadClass,
        )}
      >
        {onBack ? <BackButton onBack={onBack} /> : null}
        {/* Under ~700px of pane the subject keeps the whole first line and the actions wrap beneath it, so it never truncates
            just because the claim actions grew. Wider than that, both share the line. */}
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h2 title={thread.subject} className="min-w-0 flex-1 basis-full truncate text-[18px] leading-6 font-semibold text-ink-1 @min-[660px]:basis-0">
            {thread.subject}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            <StatusChip status={thread.status} />
            {mine ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn("text-[13px] text-ink-2", touchControlClass)}
                  disabled={lock.busy}
                  onClick={() => void lock.run(() => claim({ threadId }))}
                >
                  Extend
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn("bg-white text-[13px]", touchControlClass)}
                  disabled={lock.busy}
                  onClick={() => void lock.run(() => release({ threadId }))}
                >
                  Release
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn("bg-white text-[13px] text-ink-1", touchControlClass)}
                disabled={lock.busy || heldByOther}
                onClick={() => void lock.run(() => claim({ threadId }))}
              >
                {lock.busy ? "Taking…" : "Take this thread"}
              </Button>
            )}
          </div>
        </div>
        <p className="mt-0.5 truncate text-[13px] leading-5 text-ink-2">
          <span className="font-medium text-ink-1">{guestName(thread.guestEmail)}</span>
          {" · "}
          {thread.guestEmail}
          {thread.stay ? (
            <>
              {" · "}
              {thread.stay.status === "booked" ? "Booked" : "Inquiry"}
              {thread.stay.checkIn ? (
                <span className="tabular-nums">
                  {" · "}
                  {formatDate(thread.stay.checkIn)}
                  {thread.stay.checkOut ? ` to ${formatDate(thread.stay.checkOut)}` : ""}
                </span>
              ) : null}
              {thread.stay.party ? (
                <span className="tabular-nums">
                  {" · "}
                  {thread.stay.party} {thread.stay.party === 1 ? "guest" : "guests"}
                </span>
              ) : null}
            </>
          ) : null}
        </p>
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-3">
          {heldByOther ? <Lock aria-hidden="true" className="size-3 shrink-0" /> : null}
          <span className="truncate" title={holder ? formatStamp(holder.expiresAt) : undefined}>
            {claimLine}
          </span>
          <ThreadPresence key={`${threadId}:${viewerId}`} threadId={threadId} />
        </p>
      </div>

      {/* One measure for the whole stack (68ch of content, padding outside it) so every section shares a right edge. */}
      <div className={cn(threadPadClass, "box-content flex max-w-[68ch] flex-col gap-4 pt-4 pb-10")}>
        {lock.error ? <InlineNotice tone="error">{lock.error}</InlineNotice> : null}
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

        {messages.length === 0 ? (
          <p className="text-[13px] leading-5 text-ink-2">No messages stored for this thread.</p>
        ) : (
          // The conversation: flat messages separated by hairlines (Gmail/Front), never bordered cards.
          <ol className="divide-y divide-border-1 [&>li:first-child>article]:pt-0">
            {messages.map((msg) => {
              const out = msg.direction === "out";
              const meta = (
                <div className="flex items-baseline gap-2 text-[13px] leading-5">
                  <span className="truncate font-semibold text-ink-1">{out ? `Front desk to ${guestName(msg.to)}` : guestName(msg.from)}</span>
                  <span aria-hidden="true" className="text-ink-3">
                    ·
                  </span>
                  <time dateTime={new Date(msg.at).toISOString()} title={formatStamp(msg.at)} className="shrink-0 text-[12px] leading-4 text-ink-3 tabular-nums">
                    {formatWhen(msg.at, now)}
                  </time>
                </div>
              );
              const body = (
                <div
                  className={cn(
                    "mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-1",
                    out ? "text-[14px] leading-6" : "font-serif text-[15px] leading-6 italic",
                  )}
                >
                  {msg.text}
                </div>
              );
              const article = cn("py-4", out && "fd-msg--out");
              return (
                <li key={msg._id}>
                  {msg._id === sentMessageId && draft ? (
                    <m.article layoutId={`draft-${draft._id}`} transition={sendTransition(sendSource)} className={article}>
                      {meta}
                      {body}
                    </m.article>
                  ) : (
                    <article className={article}>
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
          <DraftPanel
            detail={detail}
            canEdit={mine}
            liveMail={liveMail}
            onSend={setSendSource}
            activeClaimId={activeClaimId}
            onActiveClaim={setActiveClaimId}
            describeSources={!mid}
          />
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

        <div className="border-t border-border-1 pt-3">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {thread.status !== "closed" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn("-ml-2.5 text-[13px] text-ink-2", touchControlClass)}
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
                className={cn("text-[13px] text-ink-2", touchControlClass)}
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
                className={cn("text-[13px] text-ink-2", touchControlClass)}
                disabled={regenAction.busy}
                onClick={() => void regenAction.run(() => regenerate({ threadId }))}
              >
                {regenAction.busy ? "Requesting…" : "Redraft from the latest message"}
              </Button>
            ) : null}
          </div>
          {/* The hint sits on its own line under the buttons, never on their baseline where it reads as a third button. */}
          {!mine ? <p className="mt-1 text-[12px] leading-4 text-ink-3">Take the thread to change its status.</p> : null}
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
        <SourcePanel detail={detail} activeClaimId={activeClaimId} onActiveClaim={setActiveClaimId} />
      </div>
    );
  }
  return (
    <>
      {main}
      {mid ? null : <SourcePanel detail={detail} activeClaimId={activeClaimId} onActiveClaim={setActiveClaimId} />}
    </>
  );
}
