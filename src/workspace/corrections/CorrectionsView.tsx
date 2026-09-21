import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Correction, LiveMailDecision, RecordVersionResult, UnaffectedControl } from "../types";
import { Empty, Spinner } from "../lib/ui";
import { CorrectionCard } from "./CorrectionCard";
import { UnaffectedControls } from "./UnaffectedControls";
import { DemoActions } from "../shell/DemoActions";

export function CorrectionsView({
  innId,
  viewerId,
  isDemo,
  liveMail,
  lastDemoChange,
  onDemoChange,
  onOpenThread,
}: {
  innId: Id<"inns">;
  viewerId: Id<"users">;
  isDemo: boolean;
  liveMail: LiveMailDecision | undefined;
  /** Result of the last scripted demo edit, held by the workspace so the notice survives this view's re-layout. */
  lastDemoChange: RecordVersionResult | null;
  onDemoChange: (result: RecordVersionResult) => void;
  onOpenThread: (threadId: Id<"threads">) => void;
}) {
  const corrections = useQuery(api.corrections.list, { innId }) as Correction[] | undefined;
  const controls = useQuery(api.corrections.unaffectedControls, { innId }) as UnaffectedControl[] | undefined;

  if (corrections === undefined || controls === undefined) {
    return <Spinner label="Checking sent replies against the latest page versions" />;
  }

  const open = corrections.filter((c) => c.status === "needs_review");
  const approved = corrections.filter((c) => c.status === "approved");
  const reviewed = corrections.filter((c) => c.status === "sent" || c.status === "dismissed" || c.status === "superseded");
  const pagesTouched = new Set(open.map((c) => c.pageUrl)).size;
  // Cards are listed per claim (one sent reply with several changed passages
  // yields several cards), but the strip counts sent replies: distinct
  // `sentReplyId` on every side, so affected, approved and control numbers
  // are comparable. The passage count is shown only when it differs.
  const openReplies = new Set(open.map((c) => c.sentReplyId)).size;
  const approvedReplies = new Set(approved.map((c) => c.sentReplyId)).size;
  const controlReplies = new Set(controls.map((c) => c.sentReplyId)).size;
  // Before the demo's page edit there is nothing to show; the hero explains
  // the walkthrough and carries the only "Change the policy page" action.
  const untouched = corrections.length === 0 && controls.length === 0;

  const cardProps = { viewerId, isDemo, liveMail, onOpenThread };

  return (
    <div>
      <h2 className="fd-h2">Replies to review</h2>
      <p className="fd-lede">
        When a page on the inn's website changes, every reply that quoted it is checked again. Replies whose
        quoted passage no longer holds are listed here with what the page says now.
      </p>

      {isDemo && !untouched ? (
        <div className="fd-demo-bar">
          <span className="fd-small fd-muted">Demo controls</span>
          <DemoActions innId={innId} last={lastDemoChange} onResult={onDemoChange} />
        </div>
      ) : null}

      <div className="fd-strip" role="status">
        <span>
          <strong>{openReplies}</strong> {openReplies === 1 ? "reply needs" : "replies need"} review
          {open.length > openReplies ? ` (${open.length} passages)` : null}
        </span>
        {approved.length > 0 ? (
          <span>
            <strong>{approvedReplies}</strong>{" "}
            {approvedReplies === 1
              ? "reply has an approved correction"
              : "replies have approved corrections"}
            , not sent
            {approved.length > approvedReplies ? ` (${approved.length} passages)` : null}
          </span>
        ) : null}
        <span>
          <strong>{controlReplies}</strong> {controlReplies === 1 ? "reply" : "replies"} re-checked and still true
          {controls.length > controlReplies ? ` (${controls.length} passages)` : null}
        </span>
        {open.length > 0 ? (
          <span>
            <strong>{pagesTouched}</strong> {pagesTouched === 1 ? "page" : "pages"} changed
          </span>
        ) : null}
      </div>

      {open.length === 0 ? (
        <div className="fd-section">
          {isDemo && untouched ? (
            <DemoActions innId={innId} variant="hero" last={lastDemoChange} onResult={onDemoChange} />
          ) : (
            <Empty title="Nothing to review">
              {untouched
                ? "No sent reply cites a page that has changed since it was sent."
                : "Every sent reply that cites a changed page has been reviewed."}
            </Empty>
          )}
        </div>
      ) : (
        <div className="fd-section fd-corr">
          {open.map((c) => (
            <CorrectionCard key={c._id} correction={c} {...cardProps} />
          ))}
        </div>
      )}

      {approved.length > 0 ? (
        <div className="fd-section">
          <p className="fd-section__title">Approved, waiting to be sent</p>
          <div className="fd-corr">
            {approved.map((c) => (
              <CorrectionCard key={c._id} correction={c} {...cardProps} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="fd-section">
        <p className="fd-section__title">Re-checked and unaffected</p>
        {controls.length === 0 ? (
          <p className="fd-muted fd-small">No sent reply has been re-checked against a newer page version yet.</p>
        ) : (
          <UnaffectedControls controls={controls} onOpenThread={onOpenThread} />
        )}
      </div>

      {reviewed.length > 0 ? (
        <div className="fd-section">
          <p className="fd-section__title">Already reviewed</p>
          <div className="fd-corr">
            {reviewed.map((c) => (
              <CorrectionCard key={c._id} correction={c} {...cardProps} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
