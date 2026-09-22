import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Correction, LiveMailDecision, RecordVersionResult, UnaffectedControl, UnaffectedControlRow } from "../types";
import { Empty, Spinner } from "../lib/ui";
import { CorrectionCard } from "./CorrectionCard";
import { UnaffectedControls } from "./UnaffectedControls";
import { DemoActions } from "../shell/DemoActions";
import type { DemoPolicy } from "../shell/useDemoPolicy";

/** Sent replies asked for per page; the server caps the walk at the same size. */
const CONTROLS_PAGE_SIZE = 25;

export function CorrectionsView({
  innId,
  viewerId,
  isDemo,
  demo,
  liveMail,
  lastDemoChange,
  onDemoChange,
  onOpenThread,
}: {
  innId: Id<"inns">;
  viewerId: Id<"users">;
  isDemo: boolean;
  /** The workspace's demo-edit instance, shared with the header control and the palette. */
  demo: DemoPolicy;
  liveMail: LiveMailDecision | undefined;
  /** Result of the last scripted demo edit, held by the workspace so the notice survives this view's re-layout. */
  lastDemoChange: RecordVersionResult | null;
  onDemoChange: (result: RecordVersionResult) => void;
  onOpenThread: (threadId: Id<"threads">) => void;
}) {
  const corrections = useQuery(api.corrections.list, { innId }) as Correction[] | undefined;
  // Controls arrive in pages of sent replies, newest first. Until `status` is
  // "Exhausted" only the replies loaded so far have been re-checked, and the
  // copy says so rather than claiming the whole history was checked.
  const controlPages = usePaginatedQuery(api.corrections.unaffectedControls, { innId }, { initialNumItems: CONTROLS_PAGE_SIZE });

  if (corrections === undefined || controlPages.status === "LoadingFirstPage") {
    return <Spinner label="Checking sent replies against the latest page versions" />;
  }

  const rows = controlPages.results as UnaffectedControlRow[];
  const controls = rows.filter((r): r is UnaffectedControl => r.kind === "control");
  const unchecked = rows.filter((r) => r.kind === "unchecked");
  const allLoaded = controlPages.status === "Exhausted";
  // Every reply loaded and none refused by the server: only then is the count
  // a statement about the whole history rather than about the replies verified.
  const allChecked = allLoaded && unchecked.length === 0;
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
  const untouched = corrections.length === 0 && rows.length === 0 && allLoaded;

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
          <DemoActions innId={innId} demo={demo} last={lastDemoChange} onResult={onDemoChange} />
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
          <strong>{controlReplies}</strong> {controlReplies === 1 ? "reply" : "replies"} re-checked{allChecked ? "" : " so far"} and still true
          {controls.length > controlReplies ? ` (${controls.length} passages)` : null}
          {allLoaded ? null : ", older replies not loaded yet"}
          {allLoaded && !allChecked ? `, ${unchecked.length} not verified` : null}
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
            <DemoActions innId={innId} demo={demo} variant="hero" last={lastDemoChange} onResult={onDemoChange} />
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
          <p className="fd-muted fd-small">
            {!allLoaded
              ? "None of the sent replies loaded so far has been re-checked against a newer page version."
              : unchecked.length > 0
                ? "No loaded sent reply was verified still true; the ones below were not re-checked."
                : corrections.length > 0
                  ? "Every sent reply that cites a changed page is listed above; none was re-checked and still true."
                  : "No sent reply has been re-checked against a newer page version yet."}
          </p>
        ) : (
          <UnaffectedControls controls={controls} onOpenThread={onOpenThread} />
        )}
        {unchecked.length > 0 ? (
          <p className="fd-muted fd-small">
            {unchecked.length === 1 ? "1 sent reply cites" : `${unchecked.length} sent replies cite`} more passages or past corrections than
            this view re-checks and {unchecked.length === 1 ? "is" : "are"} not counted as still true.
          </p>
        ) : null}
        {allLoaded ? null : (
          <p className="fd-small">
            <button
              type="button"
              className="fd-btn fd-btn--quiet fd-btn--small"
              disabled={controlPages.status === "LoadingMore"}
              onClick={() => controlPages.loadMore(CONTROLS_PAGE_SIZE)}
            >
              {controlPages.status === "LoadingMore" ? "Loading older sent replies…" : "Load more sent replies"}
            </button>
          </p>
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
