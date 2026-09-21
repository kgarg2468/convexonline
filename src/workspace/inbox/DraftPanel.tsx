import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { LiveMailDecision, ThreadDetail } from "../types";
import { Notice, Pill } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { LIVE_MAIL_REASON } from "../lib/format";
import { OutboxList } from "./OutboxList";
import { isInFlight, latestOutbox, outboxForDraft } from "../lib/outbox";

type Draft = NonNullable<ThreadDetail["draft"]>;

const DRAFT_STATUS: Record<Draft["status"], { label: string; tone: "pine" | "caution" | "muted" | "neutral" }> = {
  verifying: { label: "Verifying", tone: "neutral" },
  needs_edit: { label: "Needs edit", tone: "caution" },
  ready: { label: "Ready", tone: "pine" },
  sent: { label: "Sent", tone: "muted" },
  superseded: { label: "Superseded", tone: "muted" },
};

const TEXT_SOURCE: Record<Draft["textSource"], string> = {
  model: "Drafted by the model",
  staff: "Staff-written",
  fixture: "Demo fixture text",
};

/**
 * The grounded draft. Staff edit it once they hold the thread. Sending
 * reserves an outbox row (live) or commits a simulated delivery (demo); the
 * delivery state shown always comes from the outbox query, never from the
 * click itself.
 */
export function DraftPanel({
  detail,
  canEdit,
  liveMail,
}: {
  detail: ThreadDetail;
  canEdit: boolean;
  liveMail: LiveMailDecision | undefined;
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
  const editable = canEdit && draft.status !== "sent" && draft.status !== "superseded" && draft.status !== "verifying" && !inFlight;
  const verifiedCount = detail.claims.filter((c) => c.verified && c.status === "ok").length;
  const flagged = detail.claims.filter((c) => c.status !== "ok").length;
  const staleSource = detail.claims.some((c) => c.status === "ok" && !c.currentSource);
  const staleInbound =
    draft.replyToMessageId !== null &&
    detail.thread.lastInboundMessageId !== null &&
    detail.thread.lastInboundMessageId !== draft.replyToMessageId;
  const status = DRAFT_STATUS[draft.status];
  const verifiedExact = draft.status === "ready" && draft.verifiedText !== null && draft.verifiedText === draft.answer;
  const staffEdited = draft.status === "needs_edit" && draft.textSource === "staff" && draft.answer.trim().length > 0;
  const liveBlocked = !isDemo && liveMail !== undefined && !liveMail.allowed;

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

  async function send() {
    const args = { draftId: draft._id, staffAuthored: staffEdited ? staffAuthored : undefined };
    const result = await sendAction.run(() => (isDemo ? sendSimulated(args) : sendLive(args)));
    if (result !== undefined) setHandedOff(true);
  }

  const sendLabel = isDemo ? "Send (simulated)" : "Send reply";

  return (
    <section className="fd-draft" aria-labelledby="fd-draft-title">
      <div className="fd-draft__head">
        <h3 id="fd-draft-title" className="fd-small" style={{ fontWeight: 600 }}>
          Draft reply
        </h3>
        <div className="fd-draft__badges">
          <Pill tone={status.tone}>{status.label}</Pill>
          <Pill tone={draft.textSource === "staff" ? "caution" : "muted"}>{TEXT_SOURCE[draft.textSource]}</Pill>
          <Pill tone={verifiedCount > 0 ? "pine" : "muted"}>
            {verifiedCount} {verifiedCount === 1 ? "citation" : "citations"} verified
          </Pill>
          {flagged > 0 ? <Pill tone="caution">{flagged} flagged</Pill> : null}
          {staleSource ? <Pill tone="caution">Source changed</Pill> : null}
          {draft.judgeVerdict ? (
            <Pill tone={draft.judgeVerdict.entailed && !draft.judgeVerdict.promisedOutsideQuotes ? "pine" : "caution"}>
              {draft.judgeVerdict.entailed && !draft.judgeVerdict.promisedOutsideQuotes
                ? "Stays within sources"
                : draft.judgeVerdict.entailed
                  ? "Judge: promises beyond sources"
                  : "Judge: not entailed"}
            </Pill>
          ) : draft.status === "ready" ? null : (
            <Pill tone="muted">Not verified</Pill>
          )}
        </div>
      </div>
      {draft.statusReason ? <p className="fd-field__hint">{draft.statusReason}</p> : null}

      {serverMoved && dirty ? (
        <div style={{ marginBottom: 8 }}>
          <Notice tone="caution">
            {base.id !== draft._id ? "A new draft replaced this one on the server." : "This draft changed on the server."}{" "}
            Your unsaved edits are kept.{" "}
            <button type="button" className="fd-btn fd-btn--small" onClick={adoptServerText}>
              Load the server text
            </button>
          </Notice>
        </div>
      ) : null}

      {editable ? (
        <>
          <label className="fd-sr-only" htmlFor="fd-draft-text">
            Draft reply text
          </label>
          <textarea
            id="fd-draft-text"
            className="fd-textarea"
            value={text}
            disabled={action.busy || sendAction.busy}
            onChange={(e) => setText(e.target.value)}
          />
        </>
      ) : (
        <div className="fd-draft__read">{draft.answer || <span className="fd-muted">No answer text.</span>}</div>
      )}

      {action.error ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="error">{action.error}</Notice>
        </div>
      ) : null}

      {editable && staffEdited && !dirty ? (
        <label className="fd-check" htmlFor="fd-staff-authored">
          <input
            id="fd-staff-authored"
            type="checkbox"
            checked={staffAuthored}
            onChange={(e) => setStaffAuthored(e.target.checked)}
          />
          <span>
            Send this unverified, staff-written text as my own words. It was not checked against the website
            {isDemo ? " (demo edits are never re-judged)" : ""}.
          </span>
        </label>
      ) : null}

      <div className="fd-draft__foot">
        <div className="fd-btn-row">
          {editable ? (
            <button
              type="button"
              className="fd-btn"
              disabled={!dirty || action.busy || sendAction.busy || text.trim().length === 0}
              onClick={() => void save()}
            >
              {action.busy ? "Saving…" : "Save edits"}
            </button>
          ) : null}
          {draft.status !== "sent" && draft.status !== "superseded" ? (
            <button
              type="button"
              className="fd-btn fd-btn--primary"
              disabled={blocked !== null || sendAction.busy || action.busy}
              aria-describedby="fd-send-why"
              onClick={() => void send()}
            >
              {sendAction.busy ? "Sending…" : sendLabel}
            </button>
          ) : null}
        </div>
        <span className="fd-muted fd-small">
          {savedAt && !dirty ? "Saved." : dirty ? "Unsaved edits." : !canEdit && draft.status !== "sent" ? "Take the thread to edit or send." : ""}
        </span>
      </div>
      <p id="fd-send-why" className="fd-field__hint" style={{ marginTop: 8 }}>
        {blocked ??
          (isDemo
            ? "Simulated send: the reply is recorded in this demo only. No real email is sent."
            : verifiedExact
              ? "Sends exactly the verified text to the guest."
              : "Sends your staff-written text to the guest under your name.")}
      </p>
      {sendAction.error ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="error">{sendAction.error}</Notice>
        </div>
      ) : null}
      {handedOff && !isDemo && replyOutbox && replyOutbox.status !== "sent" ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="info">Handed to the sender. The delivery state below updates as it happens.</Notice>
        </div>
      ) : null}
      <div style={{ marginTop: 10 }}>
        <OutboxList rows={draftOutbox} title="Reply delivery" />
      </div>
      <p className="fd-mono" style={{ marginTop: 6 }}>
        drafted by {draft.model}
      </p>
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
