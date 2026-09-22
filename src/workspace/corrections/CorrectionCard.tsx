import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, Lock } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Correction, LiveMailDecision, ThreadDetail } from "../types";
import { useAsyncAction, useIsNarrow, useNow } from "../lib/hooks";
import { LIVE_MAIL_REASON, formatStamp, guestName, pathOf } from "../lib/format";
import { VersionPane } from "../knowledge/VersionPane";
import { OutboxList } from "../inbox/OutboxList";
import { Chip, Hint, InlineNotice, SectionLabel } from "../inbox/primitives";
import { isInFlight, latestOutbox, outboxForCorrection } from "../lib/outbox";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PassageDiff } from "./PassageDiff";
import { plainText } from "./plainText";
import { SOURCE_CHIP, STATUS_CHIP, outlineButtonClass, passageClass, pathLinkClass, textBoxClass } from "./styles";

/** How long a requested proposal counts as pending before the button is offered again. */
const REGEN_WAIT_MS = 90_000;

/**
 * A proposal counts as supported when its text rests on evidence in the
 * current page: staff-written text is the staff member's own; fixture and
 * generated text need a verified evidence quote, and generated text also
 * needs the judge to have accepted it. Unsupported proposals are shown but
 * must be edited before approval.
 */
function proposalSupported(c: Correction): boolean {
  if (!c.proposedText) return false;
  if (c.textSource === "staff") return true;
  if (!c.evidenceQuote) return false;
  if (c.textSource === "generated") {
    return c.judgeVerdict !== null && c.judgeVerdict.entailed && !c.judgeVerdict.promisedOutsideQuotes;
  }
  return c.textSource === "fixture";
}

/** Server-written reasons open lowercase; staff read them as sentences. */
const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A quiet disclosure button; the chevron is decorative so the accessible name
 * stays the label. `controls` is the id of the block it reveals, referenced
 * only while that block is in the document.
 */
function Disclosure({
  open,
  controls,
  onToggle,
  children,
}: {
  open: boolean;
  controls: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ml-2 text-[13px] text-ink-2"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
    >
      {children}
      <ChevronDown
        data-icon="inline-end"
        aria-hidden="true"
        className={cn("text-ink-3 transition-transform duration-small ease-out", open && "rotate-180")}
      />
    </Button>
  );
}

/** One step of the provenance trail: an 8px dot on the gutter line, a 12px label, then the content. */
function Step({ label, chips, children }: { label: ReactNode; chips?: ReactNode; children: ReactNode }) {
  return (
    <li className="relative before:absolute before:top-1 before:-left-5 before:size-2 before:rounded-full before:bg-accent-9 before:ring-2 before:ring-white before:content-['']">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SectionLabel as="p">{label}</SectionLabel>
        {chips}
      </div>
      <div className="mt-1.5 flex flex-col gap-2">{children}</div>
    </li>
  );
}

/**
 * The provenance trail: guest reply → the statement it made → the passage it
 * quoted → what that page says now → the correction. Approval and sending are
 * thread actions, so the card shows who holds the thread and offers to take it.
 */
export function CorrectionCard({
  correction,
  viewerId,
  isDemo,
  liveMail,
  onOpenThread,
}: {
  correction: Correction;
  viewerId: Id<"users">;
  isDemo: boolean;
  liveMail: LiveMailDecision | undefined;
  onOpenThread: (threadId: Id<"threads">) => void;
}) {
  const review = useMutation(api.corrections.review);
  const setText = useMutation(api.corrections.setText);
  const regenerateProposal = useMutation(api.corrections.regenerateProposal);
  const regen = useAsyncAction();
  const sendLive = useMutation(api.corrections.send);
  const sendSimulated = useMutation(api.demo.simulateCorrectionSend);
  const claimThread = useMutation(api.threads.claim);
  const thread = useQuery(api.threads.get, { threadId: correction.threadId }) as ThreadDetail | undefined;
  const action = useAsyncAction();
  const sendAction = useAsyncAction();
  const lock = useAsyncAction();
  const now = useNow(15_000);
  // Under 900px the two diff columns become one unified stream.
  const narrow = useIsNarrow();

  const serverText = correction.proposedText ?? "";
  const [base, setBase] = useState(serverText);
  const [text, setText_] = useState(serverText);
  const [editingApproved, setEditingApproved] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const dirty = text !== base;
  if (serverText !== base && !dirty) {
    setBase(serverText);
    setText_(serverText);
  }

  const open = correction.status === "needs_review";
  const approved = correction.status === "approved";
  const terminal = correction.status === "sent" || correction.status === "dismissed" || correction.status === "superseded";
  const stale = !correction.isCurrent;
  const supported = proposalSupported(correction);
  const holder = thread?.thread.claim && thread.thread.claim.expiresAt > now ? thread.thread.claim : null;
  const mine = holder?.userId === viewerId;
  const heldByOther = holder !== null && !mine;
  // Only rows for this exact correction: another correction's row in the same
  // thread neither shows as this one's delivery nor blocks sending it.
  const outboxRows = thread ? outboxForCorrection(thread.outbox, correction._id) : [];
  const inFlight = isInFlight(latestOutbox(outboxRows));
  const liveBlocked = !isDemo && liveMail !== undefined && !liveMail.allowed;
  const textId = `fd-corr-text-${correction._id}`;
  const titleId = `fd-corr-title-${correction._id}`;
  const sendWhyId = `fd-corr-send-why-${correction._id}`;
  const sentId = `fd-corr-sent-${correction._id}`;
  const versionsId = `fd-corr-versions-${correction._id}`;

  // Regenerating a proposal is explicit and bounded: one request per click,
  // "pending" until the server's proposal fields change, and after
  // REGEN_WAIT_MS with no change the button is offered again. Never auto-repeats.
  const proposalKey = `${correction.proposedText ?? ""}\u0000${correction.statusReason ?? ""}\u0000${correction.judgeVerdict?.notes ?? ""}`;
  const [regenRequest, setRegenRequest] = useState<{ key: string; at: number } | null>(null);
  // A request only counts while the proposal fields are still what they were
  // when it was made; once the server writes a new proposal it is over.
  const regenActive = regenRequest !== null && regenRequest.key === proposalKey;
  const regenPending = regenActive && now - regenRequest.at < REGEN_WAIT_MS;
  const regenTimedOut = regenActive && !regenPending;
  const proposalFailed = open && !stale && !isDemo && correction.textSource !== "staff" && !supported;
  const canRegenerate = proposalFailed && !heldByOther && thread !== undefined;
  async function requestProposal() {
    const ok = await regen.run(() => regenerateProposal({ correctionId: correction._id }));
    if (ok !== undefined) setRegenRequest({ key: proposalKey, at: Date.now() });
  }

  const sendBlocked = (() => {
    if (!approved) return null;
    if (liveBlocked) return LIVE_MAIL_REASON[(liveMail as { reason: string }).reason] ?? "Live mail is not available.";
    if (stale) return "The page changed again after this was approved. Review the newer proposal instead.";
    if (inFlight) return "Already handed to the sender. Its delivery state is shown below.";
    if (thread === undefined) return "Checking who holds the thread…";
    if (!mine) return heldByOther ? `${holder!.name ?? "Another staff member"} holds this thread.` : "Take the thread to send.";
    return null;
  })();

  async function approve() {
    const trimmed = text.trim();
    await action.run(() =>
      review({
        correctionId: correction._id,
        decision: "approve",
        proposedText: trimmed !== base ? trimmed : undefined,
      }),
    );
  }
  async function saveText() {
    const trimmed = text.trim();
    const ok = await action.run(() => setText({ correctionId: correction._id, proposedText: trimmed }));
    if (ok !== undefined) {
      setBase(trimmed);
      setText_(trimmed);
      setEditingApproved(false);
    }
  }
  async function send() {
    await sendAction.run(() =>
      isDemo ? sendSimulated({ correctionId: correction._id }) : sendLive({ correctionId: correction._id }),
    );
  }

  const status = STATUS_CHIP[correction.status];
  const judgeOk = correction.judgeVerdict ? correction.judgeVerdict.entailed && !correction.judgeVerdict.promisedOutsideQuotes : null;
  const editing = (open || (approved && editingApproved)) && !stale;

  const claimBar =
    (open || approved) && !stale ? (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border-1 bg-bg-2 py-1.5 pr-1.5 pl-3">
        <p className="flex min-w-0 items-center gap-2 text-[13px] leading-5 text-ink-1">
          {heldByOther ? <Lock aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" /> : null}
          <span>
            {thread === undefined
              ? "Checking the thread…"
              : mine
                ? `You hold this thread until ${formatStamp(holder!.expiresAt)}.`
                : heldByOther
                  ? `${holder!.name ?? "Another staff member"} holds this thread until ${formatStamp(holder!.expiresAt)}.`
                  : "Nobody holds this thread. Approving or sending needs it."}
          </span>
        </p>
        {!mine ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("shrink-0", outlineButtonClass)}
            disabled={lock.busy || heldByOther || thread === undefined}
            onClick={() => void lock.run(() => claimThread({ threadId: correction.threadId }))}
          >
            {lock.busy ? "Taking…" : "Take this thread"}
          </Button>
        ) : null}
      </div>
    ) : null;

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        // Enter transition only for cards that arrive after the list's first paint (the list sets data-settled).
        "rounded-[10px] border border-border-1 bg-white p-4 transition-[opacity,translate] duration-small ease-out in-data-settled:starting:-translate-y-1.5 in-data-settled:starting:opacity-0 motion-reduce:starting:translate-y-0",
        terminal && "opacity-80",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p id={titleId} className="text-[14px] leading-5 font-semibold text-ink-1">
            {guestName(correction.guestEmail)} <span className="font-normal text-ink-2">{correction.guestEmail}</span>
          </p>
          <p className="text-[14px] leading-5 text-ink-1">{correction.subject}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={status.tone}>{status.label}</Chip>
          {stale && !terminal ? <Chip tone="warning">Page changed again</Chip> : null}
          <Button type="button" variant="outline" size="sm" className={outlineButtonClass} onClick={() => onOpenThread(correction.threadId)}>
            Open thread
          </Button>
        </div>
      </div>

      {correction.statusReason ? <Hint className="mt-1.5">{sentenceCase(correction.statusReason)}</Hint> : null}
      {correction.status === "superseded" ? (
        <InlineNotice tone="info" className="mt-3">
          {correction.supersededById
            ? "The page changed again; a newer proposal replaces this one."
            : "The quoted passage is back on the page; no correction is needed."}
        </InlineNotice>
      ) : null}

      <ol className="relative mt-4 flex flex-col gap-5 pl-5 before:absolute before:top-2 before:bottom-2 before:left-[3.5px] before:w-px before:bg-border-2 before:content-['']">
        <Step label="Sent reply told the guest">
          <p className="text-[14px] leading-5 text-ink-1">{correction.statement || "(statement not recorded)"}</p>
          {correction.sentText ? (
            <div>
              <Disclosure open={showSent} controls={sentId} onToggle={() => setShowSent((s) => !s)}>
                {showSent ? "Hide the message as sent" : "Show the message as sent"}
              </Disclosure>
              {showSent ? (
                <blockquote id={sentId} className={cn(passageClass, "mt-1")}>
                  {correction.sentText}
                </blockquote>
              ) : null}
            </div>
          ) : null}
        </Step>

        <Step
          label={
            <span>
              Quoted from{" "}
              <a href={correction.pageUrl} target="_blank" rel="noreferrer noopener" className={cn(pathLinkClass, "normal-case tracking-normal")}>
                {pathOf(correction.pageUrl)}
              </a>
            </span>
          }
        >
          <PassageDiff
            oldText={correction.oldQuote}
            newText={correction.newPassage}
            oldLabel="When the reply was sent"
            newLabel={stale ? "Page at review time (since changed)" : "Page now"}
            unified={narrow}
          />
          <div>
            <Disclosure open={showVersions} controls={versionsId} onToggle={() => setShowVersions((s) => !s)}>
              {showVersions ? "Hide stored page versions" : "Show stored page versions"}
            </Disclosure>
            {showVersions ? (
              <div id={versionsId} className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
                <VersionPane versionId={correction.oldVersionId} label="Cited version" highlight={correction.oldQuote} />
                <VersionPane
                  versionId={correction.newVersionId}
                  label={stale ? "Reviewed version" : "Current version"}
                  highlight={correction.evidenceQuote ?? correction.newPassage ?? undefined}
                />
              </div>
            ) : null}
          </div>
        </Step>

        <Step
          label="Correction to the guest"
          chips={
            <>
              {correction.textSource ? <Chip tone={SOURCE_CHIP[correction.textSource].tone}>{SOURCE_CHIP[correction.textSource].label}</Chip> : null}
              {correction.judgeVerdict ? (
                <Chip tone={judgeOk ? "success" : "warning"}>{judgeOk ? "Judge: stays within the page" : "Judge: not accepted"}</Chip>
              ) : null}
            </>
          }
        >
          {correction.judgeVerdict?.notes ? <Hint>{correction.judgeVerdict.notes}</Hint> : null}
          {correction.evidenceQuote ? <Hint className="[overflow-wrap:anywhere]">Rests on: “{plainText(correction.evidenceQuote)}”</Hint> : null}
          {editing ? (
            <div>
              <label className="sr-only" htmlFor={textId}>
                Correction text
              </label>
              {/* Until the viewer holds the thread the proposal is read-only text in
                  a plain text box (ink-1, sized to its content); the editable
                  textarea takes its place once the thread is theirs. */}
              <Textarea
                id={textId}
                rows={mine ? 4 : 2}
                value={text}
                readOnly={!mine}
                aria-disabled={mine ? undefined : true}
                disabled={action.busy}
                onChange={(e) => setText_(e.target.value)}
                placeholder="What should the guest be told now?"
                className={
                  mine
                    ? "min-h-24 resize-y bg-bg-1 px-3 py-2.5 text-[14px] leading-[1.55] text-ink-1 md:text-[14px]"
                    : cn(textBoxClass, "min-h-0 resize-none rounded-md whitespace-pre-wrap md:text-[14px] focus-visible:ring-accent-9/50")
                }
              />
              {!correction.proposedText ? (
                <Hint className="mt-1.5">No proposal was produced. Write the correction from the passage above.</Hint>
              ) : !supported ? (
                <Hint className="mt-1.5">
                  This proposal is not supported by verified page text. Edit it before approving; your edit is sent as staff-written.
                </Hint>
              ) : null}
              {!mine && thread !== undefined ? <Hint className="mt-1.5">Take the thread to edit the text.</Hint> : null}
              {proposalFailed ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={outlineButtonClass}
                    disabled={!canRegenerate || regen.busy || regenPending}
                    onClick={() => void requestProposal()}
                  >
                    {regen.busy ? "Requesting…" : regenPending ? "Regenerating…" : "Regenerate proposal"}
                  </Button>
                  <span className="text-[13px] leading-5 text-ink-2" role="status">
                    {regen.busy
                      ? "Asking the server for a new proposal."
                      : regenPending
                        ? "The drafter is running on the server. The proposal updates here when it finishes."
                        : regenTimedOut
                          ? "No new proposal arrived yet. You can ask again or write the correction yourself."
                          : heldByOther
                            ? "Another staff member holds this thread."
                            : "Asks the drafter again, grounded only in the current page. Each request costs one model call."}
                  </span>
                </div>
              ) : null}
              {regen.error ? (
                <InlineNotice tone="error" className="mt-2">
                  {regen.error}
                </InlineNotice>
              ) : null}
            </div>
          ) : (
            <div className={textBoxClass}>{correction.proposedText ?? "(no text recorded)"}</div>
          )}
        </Step>
      </ol>

      {claimBar ? <div className="mt-4">{claimBar}</div> : null}
      {lock.error ? (
        <InlineNotice tone="error" className="mt-3">
          {lock.error}
        </InlineNotice>
      ) : null}

      {open ? (
        <div className="mt-4 border-t border-border-1 pt-3">
          {action.error ? (
            <InlineNotice tone="error" className="mb-3">
              {action.error}
            </InlineNotice>
          ) : null}
          {stale ? (
            <InlineNotice tone="caution">The page changed again. This proposal cannot be approved; a newer one replaces it.</InlineNotice>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="text-[13px]"
                disabled={action.busy || !mine || text.trim().length === 0 || (!supported && !dirty)}
                onClick={() => void approve()}
              >
                {action.busy ? "Saving…" : "Approve correction"}
              </Button>
              <Button type="button" variant="outline" size="sm" className={outlineButtonClass} disabled={action.busy || !mine || !dirty} onClick={() => void saveText()}>
                Save text
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={outlineButtonClass}
                disabled={action.busy}
                onClick={() => void action.run(() => review({ correctionId: correction._id, decision: "dismiss" }))}
              >
                Dismiss
              </Button>
              <span className="text-[13px] leading-5 text-ink-2">
                Approving records the text; it is only sent when you press {isDemo ? "Send correction (simulated)" : "Send correction"}.
              </span>
            </div>
          )}
        </div>
      ) : null}

      {approved ? (
        <div className="mt-4 border-t border-border-1 pt-3">
          {sendAction.error || action.error ? (
            <InlineNotice tone="error" className="mb-3">
              {sendAction.error ?? action.error}
            </InlineNotice>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {editingApproved ? (
              <>
                <Button type="button" size="sm" className="text-[13px]" disabled={action.busy || !dirty || text.trim().length === 0} onClick={() => void saveText()}>
                  {action.busy ? "Saving…" : "Save text (withdraws approval)"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={outlineButtonClass}
                  disabled={action.busy}
                  onClick={() => {
                    setEditingApproved(false);
                    setText_(base);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="text-[13px]"
                  disabled={sendBlocked !== null || sendAction.busy}
                  aria-describedby={sendWhyId}
                  onClick={() => void send()}
                >
                  {sendAction.busy ? "Sending…" : isDemo ? "Send correction (simulated)" : "Send correction"}
                </Button>
                {!stale && !inFlight ? (
                  <Button type="button" variant="outline" size="sm" className={outlineButtonClass} disabled={!mine} onClick={() => setEditingApproved(true)}>
                    Edit text
                  </Button>
                ) : null}
              </>
            )}
          </div>
          <Hint id={sendWhyId} className="mt-2">
            {sendBlocked ??
              (isDemo
                ? "Simulated send into the guest's thread; recorded in this demo only. No real email is sent."
                : "Sends the approved text into the guest's thread.")}
          </Hint>
          {correction.reviewedAt ? (
            <p className="mt-2 font-mono text-[12px] leading-4 text-ink-3 tabular-nums">approved {formatStamp(correction.reviewedAt)}</p>
          ) : null}
        </div>
      ) : null}

      {outboxRows.length > 0 && (approved || correction.status === "sent") ? (
        <OutboxList rows={outboxRows} title="Correction delivery" className="mt-3 border-t border-border-1 pt-3" />
      ) : null}
    </article>
  );
}
