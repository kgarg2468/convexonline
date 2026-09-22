import { useEffect, useRef, type ReactNode } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Correction, LiveMailDecision, RecordVersionResult, UnaffectedControl, UnaffectedControlRow } from "../types";
import { Spinner } from "../lib/ui";
import { SectionLabel } from "../inbox/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CorrectionCard } from "./CorrectionCard";
import { ChangesStats } from "./ChangesStats";
import { UnaffectedControls } from "./UnaffectedControls";
import { outlineButtonClass, sectionHeadingClass } from "./styles";
import { DemoActions } from "../shell/DemoActions";
import type { DemoPolicy } from "../shell/useDemoPolicy";

/** Sent replies asked for per page; the server caps the walk at the same size. */
const CONTROLS_PAGE_SIZE = 25;

/** A titled block of the review page; the header carries the h1, so these are h2. */
function Section({ id, title, className, children }: { id: string; title: string; className?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={cn("mt-6", className)}>
      <h2 id={id} className={cn(sectionHeadingClass, "mb-2")}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Empty state: status, then what it means. Never apologises. */
function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-dashed border-border-2 px-5 py-8 text-center">
      <p className="text-[14px] leading-5 font-semibold text-ink-1">{title}</p>
      <p className="mt-1 text-[13px] leading-5 text-ink-2">{children}</p>
    </div>
  );
}

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
  const loaded = corrections !== undefined && controlPages.status !== "LoadingFirstPage";

  // Cards animate in only when they arrive after the page's first paint (a
  // demo edit, an approval moving a card): once the first loaded render is
  // committed the container is marked `data-settled`, and the card's enter
  // transition is gated on it, so opening the page never slides the queue in.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (loaded) listRef.current?.setAttribute("data-settled", "");
  }, [loaded]);

  if (!loaded) {
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
  // yields several cards), but the tiles count sent replies: distinct
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
    <div ref={listRef} className="max-w-[1040px]">
      <ChangesStats
        stats={{
          open: open.length,
          openReplies,
          approved: approved.length,
          approvedReplies,
          controls: controls.length,
          controlReplies,
          unchecked: unchecked.length,
          allLoaded,
          allChecked,
          pagesTouched,
        }}
      />

      {isDemo && !untouched ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[10px] border border-border-1 bg-white py-2 pr-2 pl-4">
          <SectionLabel as="p">Demo controls</SectionLabel>
          <DemoActions innId={innId} demo={demo} last={lastDemoChange} onResult={onDemoChange} />
        </div>
      ) : null}

      <Section id="fd-changes-open" title="Replies to review">
        <p className="mb-3 max-w-[64ch] text-[13px] leading-5 text-ink-2">
          When a page on the inn's website changes, every reply that quoted it is checked again. Replies whose quoted
          passage no longer holds are listed here with what the page says now.
        </p>
        {open.length === 0 ? (
          isDemo && untouched ? (
            <DemoActions innId={innId} demo={demo} variant="hero" last={lastDemoChange} onResult={onDemoChange} />
          ) : (
            <EmptyState title="Nothing to review">
              {untouched
                ? "No sent reply cites a page that has changed since it was sent."
                : "Every sent reply that cites a changed page has been reviewed."}
            </EmptyState>
          )
        ) : (
          <div className="flex flex-col gap-4">
            {open.map((c) => (
              <CorrectionCard key={c._id} correction={c} {...cardProps} />
            ))}
          </div>
        )}
      </Section>

      {approved.length > 0 ? (
        <Section id="fd-changes-approved" title="Approved, waiting to be sent">
          <div className="flex flex-col gap-4">
            {approved.map((c) => (
              <CorrectionCard key={c._id} correction={c} {...cardProps} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section id="fd-changes-controls" title="Re-checked and unaffected">
        {controls.length === 0 ? (
          <p className="text-[13px] leading-5 text-ink-2">
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
          <p className="mt-2 text-[13px] leading-5 text-ink-2">
            {unchecked.length === 1 ? "1 sent reply cites" : `${unchecked.length} sent replies cite`} more passages or past corrections than
            this view re-checks and {unchecked.length === 1 ? "is" : "are"} not counted as still true.
          </p>
        ) : null}
        {allLoaded ? null : (
          <div className="mt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={outlineButtonClass}
              disabled={controlPages.status === "LoadingMore"}
              onClick={() => controlPages.loadMore(CONTROLS_PAGE_SIZE)}
            >
              {controlPages.status === "LoadingMore" ? "Loading older sent replies…" : "Load more sent replies"}
            </Button>
          </div>
        )}
      </Section>

      {reviewed.length > 0 ? (
        <Section id="fd-changes-reviewed" title="Already reviewed">
          <div className="flex flex-col gap-4">
            {reviewed.map((c) => (
              <CorrectionCard key={c._id} correction={c} {...cardProps} />
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
