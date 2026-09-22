import { useState, type KeyboardEvent } from "react";
import { useMutation } from "convex/react";
import * as m from "motion/react-m";
import { api } from "../../../convex/_generated/api";
import type { LiveMailDecision, ThreadDetail } from "../types";
import { useAsyncAction } from "../lib/hooks";
import { LIVE_MAIL_REASON } from "../lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { MOD_LABEL } from "../shell/nav";
import { CitedText } from "./CitedText";
import { OutboxList } from "./OutboxList";
import { isInFlight, latestOutbox, outboxForDraft } from "../lib/outbox";
import { Chip, DisclosureButton, Hint, InlineNotice, type ChipTone } from "./primitives";
import { inboxHintClass } from "./styles";

type Draft = NonNullable<ThreadDetail["draft"]>;

/** How a send was triggered; the sent message's FLIP animates only after a click. */
export type SendSource = "pointer" | "keyboard";

const DRAFT_STATUS: Record<Draft["status"], { label: string; tone: ChipTone }> = {
  verifying: { label: "Verifying", tone: "neutral" },
  needs_edit: { label: "Needs edit", tone: "warning" },
  ready: { label: "Ready", tone: "accent" },
  sent: { label: "Sent", tone: "muted" },
  superseded: { label: "Superseded", tone: "muted" },
};

/** Provenance chip: staff-written text carries the secondary marker (design-spec §1), model and fixture text stay quiet. */
const TEXT_SOURCE: Record<Draft["textSource"], { label: string; tone: ChipTone }> = {
  model: { label: "Drafted by the model", tone: "muted" },
  staff: { label: "Staff-written", tone: "secondary" },
  fixture: { label: "Demo fixture text", tone: "muted" },
};

const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

/**
 * The grounded draft, as a review surface. Staff edit it once they hold the
 * thread. Sending reserves an outbox row (live) or commits a simulated
 * delivery (demo); the delivery state shown always comes from the outbox
 * query, never from the click itself. On send the body hands its box to the
 * new sent message through a shared `layoutId` (ThreadDetail renders the
 * other half); the body is not shown again once the draft is sent, and the
 * panel folds to a summary row (status, citations, delivery) that opens on
 * request. While read-only, sentences the claims rest on are marked and
 * linked to their source cards through `activeClaimId`.
 */
export function DraftPanel({
  detail,
  canEdit,
  liveMail,
  onSend,
  activeClaimId = null,
  onActiveClaim = () => {},
  describeSources = true,
}: {
  detail: ThreadDetail;
  canEdit: boolean;
  liveMail: LiveMailDecision | undefined;
  /** Called as a send starts, with how it was triggered. */
  onSend?: (source: SendSource) => void;
  /** The claim whose sentence or source card is hovered or focused. */
  activeClaimId?: string | null;
  onActiveClaim?: (claimId: string | null) => void;
  /** False while the source cards are not in the document (900–1439px, sheet closed). */
  describeSources?: boolean;
}) {
  const draft = detail.draft!;
  const isDemo = detail.inn.isDemo;
  const editDraft = useMutation(api.drafts.edit);
  const sendLive = useMutation(api.drafts.send);
  const sendSimulated = useMutation(api.demo.simulateSend);
  const action = useAsyncAction();
  const sendAction = useAsyncAction();

  // `base` is the server text the editor was last synced from. When the server
  // moves on while there are unsaved edits, the edits are kept and a notice
  // offers the new text instead of overwriting silently.
  const [base, setBase] = useState({ id: draft._id, answer: draft.answer });
  const [text, setText] = useState(draft.answer);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [staffAuthored, setStaffAuthored] = useState(false);
  const [handedOff, setHandedOff] = useState(false);
  // A sent draft folds to its summary row; this remembers which draft was unfolded by hand.
  const [unfoldedId, setUnfoldedId] = useState<string | null>(null);
  const dirty = text !== base.answer;
  const serverMoved = base.id !== draft._id || base.answer !== draft.answer;
  if (serverMoved && !dirty) {
    setBase({ id: draft._id, answer: draft.answer });
    setText(draft.answer);
    setSavedAt(null);
    setStaffAuthored(false);
  }
  function adoptServerText() {
    setBase({ id: draft._id, answer: draft.answer });
    setText(draft.answer);
    setSavedAt(null);
  }

  // Only rows for this exact draft count: an older draft's sent or unknown row
  // in the same thread is history, not this draft's delivery state.
  const draftOutbox = outboxForDraft(detail.outbox, draft._id);
  const replyOutbox = latestOutbox(draftOutbox);
  const inFlight = isInFlight(replyOutbox);
  const sent = draft.status === "sent";
  const done = sent || draft.status === "superseded";
  const editable = canEdit && !done && draft.status !== "verifying" && !inFlight;
  const verifiedCount = detail.claims.filter((c) => c.verified && c.status === "ok").length;
  const flagged = detail.claims.filter((c) => c.status !== "ok").length;
  const staleSource = detail.claims.some((c) => c.status === "ok" && !c.currentSource);
  const staleInbound =
    draft.replyToMessageId !== null &&
    detail.thread.lastInboundMessageId !== null &&
    detail.thread.lastInboundMessageId !== draft.replyToMessageId;
  const status = DRAFT_STATUS[draft.status];
  const source = TEXT_SOURCE[draft.textSource];
  const verifiedExact = draft.status === "ready" && draft.verifiedText !== null && draft.verifiedText === draft.answer;
  const staffEdited = draft.status === "needs_edit" && draft.textSource === "staff" && draft.answer.trim().length > 0;
  const liveBlocked = !isDemo && liveMail !== undefined && !liveMail.allowed;
  const judgeOk = draft.judgeVerdict ? draft.judgeVerdict.entailed && !draft.judgeVerdict.promisedOutsideQuotes : null;

  const blocked = sendBlockedReason({
    draft,
    canEdit,
    dirty,
    inFlight,
    staleInbound,
    staleSource,
    verifiedExact,
    staffEdited,
    staffAuthored,
    liveBlocked: liveBlocked ? (LIVE_MAIL_REASON[(liveMail as { reason: string }).reason] ?? "Live mail is not available.") : null,
    isDemo,
  });
  const canSend = blocked === null && !sendAction.busy && !action.busy;

  async function save() {
    const trimmed = text.trim();
    const ok = await action.run(() => editDraft({ draftId: draft._id, answer: trimmed }));
    if (ok !== undefined) {
      setText(trimmed);
      setBase({ id: draft._id, answer: trimmed });
      setSavedAt(Date.now());
      setStaffAuthored(false);
    }
  }

  async function send(from: SendSource) {
    onSend?.(from);
    const args = { draftId: draft._id, staffAuthored: staffEdited ? staffAuthored : undefined };
    const result = await sendAction.run(() => (isDemo ? sendSimulated(args) : sendLive(args)));
    if (result !== undefined) setHandedOff(true);
  }

  /** ⌘⏎ / Ctrl+Enter inside the editor sends when the button would. */
  function onEditorKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (canSend) void send("keyboard");
  }

  const sendLabel = isDemo ? "Send (simulated)" : "Send reply";
  const sending = sendAction.busy;
  const folded = sent && unfoldedId !== draft._id;

  return (
    <section aria-labelledby="fd-draft-title" className="rounded-[10px] border border-border-1 bg-white p-4">
      <div className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 id="fd-draft-title" className="text-[14px] leading-5 font-semibold text-ink-1">
          {sent ? (
            <DisclosureButton expanded={!folded} controls="fd-draft-body" onClick={() => setUnfoldedId(folded ? draft._id : null)}>
              Draft reply
            </DisclosureButton>
          ) : (
            "Draft reply"
          )}
        </h3>
        <div className="flex flex-wrap gap-1.5 [&_[data-slot=badge]]:text-[11px]">
          <Chip tone={status.tone}>{status.label}</Chip>
          {folded ? (
            <Chip tone={verifiedCount > 0 ? "success" : "muted"}>
              {verifiedCount} {verifiedCount === 1 ? "citation" : "citations"}
            </Chip>
          ) : (
            <>
              <Chip tone={source.tone}>{source.label}</Chip>
              <Chip tone={verifiedCount > 0 ? "success" : "muted"}>
                {verifiedCount} {verifiedCount === 1 ? "citation" : "citations"} verified
              </Chip>
              {flagged > 0 ? <Chip tone="warning">{flagged} flagged</Chip> : null}
              {staleSource ? <Chip tone="warning">Source changed</Chip> : null}
              {draft.judgeVerdict ? (
                <Chip tone={judgeOk ? "success" : "warning"}>
                  {judgeOk ? "Stays within sources" : draft.judgeVerdict.entailed ? "Judge: promises beyond sources" : "Judge: not entailed"}
                </Chip>
              ) : draft.status === "ready" ? null : (
                <Chip tone="muted">Not verified</Chip>
              )}
            </>
          )}
        </div>
      </div>
      {folded ? (
        // The summary keeps the delivery line: the one fact that must stay
        // readable after a send, straight from the outbox row.
        <OutboxList rows={draftOutbox} title="Reply delivery" hideTitle className="mt-1" />
      ) : (
        <div id="fd-draft-body">
          {draft.statusReason ? <Hint className={cn(inboxHintClass, "mt-1.5")}>{draft.statusReason}</Hint> : null}

          {serverMoved && dirty ? (
            <InlineNotice tone="caution" className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span>
                {base.id !== draft._id ? "A new draft replaced this one on the server." : "This draft changed on the server."} Your unsaved
                edits are kept.
              </span>
              <Button type="button" variant="outline" size="sm" className="bg-white text-[13px] text-ink-1" onClick={adoptServerText}>
                Load the server text
              </Button>
            </InlineNotice>
          ) : null}

          {sent ? null : (
            <m.div
              layoutId={`draft-${draft._id}`}
              transition={{ duration: 0.26, ease: EASE_OUT }}
              className={cn("mt-3 transition-opacity duration-micro", sending && "opacity-70")}
              aria-busy={sending || undefined}
            >
              {editable ? (
                <>
                  <label className="sr-only" htmlFor="fd-draft-text">
                    Draft reply text
                  </label>
                  <Textarea
                    id="fd-draft-text"
                    rows={6}
                    value={text}
                    disabled={action.busy || sendAction.busy}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onEditorKey}
                    className="min-h-36 resize-y bg-bg-1 px-3 py-2.5 text-[14px] leading-6 text-ink-1 md:text-[14px]"
                  />
                </>
              ) : draft.answer ? (
                <CitedText
                  text={draft.answer}
                  claims={detail.claims}
                  activeClaimId={activeClaimId}
                  onActiveClaim={onActiveClaim}
                  describeCards={describeSources}
                  className="text-[14px] leading-6 whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-1"
                />
              ) : (
                <div className="text-[14px] leading-6 text-ink-3">No answer text.</div>
              )}
              {sending ? (
                <p className="mt-1.5 text-[12px] leading-4 text-ink-3" aria-live="polite">
                  Sending…
                </p>
              ) : null}
            </m.div>
          )}

          {action.error ? (
            <InlineNotice tone="error" className="mt-3">
              {action.error}
            </InlineNotice>
          ) : null}

          {editable && staffEdited && !dirty ? (
            <label
              htmlFor="fd-staff-authored"
              className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-md bg-warning-3 px-3 py-2 text-[13px] leading-5 text-warning-10"
            >
              <input
                id="fd-staff-authored"
                type="checkbox"
                checked={staffAuthored}
                onChange={(e) => setStaffAuthored(e.target.checked)}
                className="mt-[3px] size-3.5 shrink-0 cursor-pointer rounded-sm accent-accent-9 outline-hidden focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2 focus-visible:ring-offset-warning-3"
              />
              <span>
                Send this unverified, staff-written text as my own words. It was not checked against the website
                {isDemo ? " (demo edits are never re-judged)" : ""}.
              </span>
            </label>
          ) : null}

          {done && !dirty ? null : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {editable ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-[13px]"
                  disabled={!dirty || action.busy || sendAction.busy || text.trim().length === 0}
                  onClick={() => void save()}
                >
                  {action.busy ? "Saving…" : "Save edits"}
                </Button>
              ) : null}
              {!done ? (
                <Button
                  type="button"
                  size="sm"
                  className="text-[13px]"
                  disabled={!canSend}
                  aria-describedby="fd-send-why"
                  onClick={(event) => void send(event.detail === 0 ? "keyboard" : "pointer")}
                >
                  {sendAction.busy ? "Sending…" : sendLabel}
                  {editable ? (
                    <span aria-hidden="true" className="ml-1 inline-flex items-center gap-0.5">
                      <Kbd className="h-4 min-w-4 bg-white/20 px-1 text-[11px] text-white">{MOD_LABEL}</Kbd>
                      <Kbd className="h-4 min-w-4 bg-white/20 px-1 text-[11px] text-white">⏎</Kbd>
                    </span>
                  ) : null}
                </Button>
              ) : null}
              <span className="ml-auto text-[13px] leading-5 text-ink-2">
                {savedAt && !dirty ? "Saved." : dirty ? "Unsaved edits." : ""}
              </span>
            </div>
          )}
          <Hint id="fd-send-why" className={cn(inboxHintClass, "mt-2")}>
            {blocked ??
              (isDemo
                ? "Simulated send: the reply is recorded in this demo only. No real email is sent."
                : verifiedExact
                  ? "Sends exactly the verified text to the guest."
                  : "Sends your staff-written text to the guest under your name.")}
          </Hint>
          {sendAction.error ? (
            <InlineNotice tone="error" className="mt-3">
              {sendAction.error}
            </InlineNotice>
          ) : null}
          {handedOff && !isDemo && replyOutbox && replyOutbox.status !== "sent" ? (
            <InlineNotice tone="info" className="mt-3">
              Handed to the sender. The delivery state below updates as it happens.
            </InlineNotice>
          ) : null}
          <OutboxList rows={draftOutbox} title="Reply delivery" className="mt-3 border-t border-border-1 pt-3" />
          <p className="mt-3 font-mono text-[12px] leading-4 text-ink-3 tabular-nums">drafted by {draft.model}</p>
        </div>
      )}
    </section>
  );
}

function sendBlockedReason(input: {
  draft: Draft;
  canEdit: boolean;
  dirty: boolean;
  inFlight: boolean;
  staleInbound: boolean;
  staleSource: boolean;
  verifiedExact: boolean;
  staffEdited: boolean;
  staffAuthored: boolean;
  liveBlocked: string | null;
  isDemo: boolean;
}): string | null {
  const { draft } = input;
  if (draft.status === "sent") return "This reply was already sent.";
  if (draft.status === "superseded") return "A newer draft replaced this one.";
  if (input.liveBlocked) return input.liveBlocked;
  if (input.inFlight) return "This reply was already handed to the sender. Its delivery state is shown below.";
  if (!input.canEdit) return "Take this thread to send.";
  if (draft.status === "verifying") return "Verification is still running on the edited text.";
  if (input.staleInbound) return "The guest wrote again after this draft was made. It answers an older message.";
  if (input.staleSource) return "A page or fact this draft cites has changed since it was verified.";
  if (input.dirty) return "Save your edits first. Only saved text can be sent.";
  if (input.verifiedExact) return null;
  if (input.staffEdited) {
    return input.staffAuthored ? null : "Your edit was not verified. Confirm above to send it as staff-written text.";
  }
  if (draft.status === "ready") return "The verified text no longer matches the draft. Save an edit or wait for re-verification.";
  if (draft.answer.trim().length === 0) return "There is no reply text yet.";
  return "This draft is not verified. Edit and save it to send it as staff-written text.";
}
