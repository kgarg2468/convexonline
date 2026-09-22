import type { ReactNode } from "react";

/** The numbers the review page derives from its two queries; the tiles render them without recomputing anything. */
export type ChangesStatsData = {
  /** Open (needs_review) correction rows and the distinct sent replies behind them. */
  open: number;
  openReplies: number;
  /** Approved, not yet sent. */
  approved: number;
  approvedReplies: number;
  /** Claims re-checked against the latest page version and still true, and the distinct sent replies behind them. */
  controls: number;
  controlReplies: number;
  /** Sent replies the server declined to re-check in full. */
  unchecked: number;
  /** Every page of sent replies has been loaded. */
  allLoaded: boolean;
  /** Every reply is loaded and none was refused: the control count speaks for the whole history. */
  allChecked: boolean;
  /** Distinct pages behind the open corrections. */
  pagesTouched: number;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * One KPI tile: the value on its own line, then the rest of the sentence. The
 * whitespace text node between them keeps the tile's text the exact sentence
 * the specs read ("3 replies need review"), so the divider is layout only.
 */
function Tile({ value, children }: { value: number; children: ReactNode }) {
  return (
    <div className="min-w-[200px] flex-1 rounded-[10px] border border-border-1 bg-white px-4 py-3">
      <span className="block text-[22px] leading-7 font-semibold tracking-[-0.01em] text-ink-1 tabular-nums">{value}</span>{" "}
      <span className="mt-0.5 block text-[13px] leading-5 text-balance text-ink-2">{children}</span>
    </div>
  );
}

/**
 * The review strip as KPI tiles: replies that need review, replies re-checked
 * and still true, pages changed (and approved-not-sent when there are any).
 * The whole strip is one `role="status"` so a screen reader hears the numbers
 * change after a page edit, and the specs read every sentence from it.
 */
export function ChangesStats({ stats }: { stats: ChangesStatsData }) {
  const { open, openReplies, approved, approvedReplies, controls, controlReplies, unchecked, allLoaded, allChecked, pagesTouched } =
    stats;
  return (
    <div role="status" aria-label="Review statistics" className="flex flex-wrap gap-3">
      <Tile value={openReplies}>
        {plural(openReplies, "reply needs", "replies need")} review
        {open > openReplies ? ` (${open} passages)` : null}
      </Tile>
      {approved > 0 ? (
        <Tile value={approvedReplies}>
          {plural(approvedReplies, "reply has an approved correction", "replies have approved corrections")}, not sent
          {approved > approvedReplies ? ` (${approved} passages)` : null}
        </Tile>
      ) : null}
      <Tile value={controlReplies}>
        {plural(controlReplies, "reply", "replies")} re-checked{allChecked ? "" : " so far"} and still true
        {controls > controlReplies ? ` (${controls} passages)` : null}
        {allLoaded ? null : ", older replies not loaded yet"}
        {allLoaded && !allChecked ? `, ${unchecked} not verified` : null}
      </Tile>
      {open > 0 ? (
        <Tile value={pagesTouched}>{plural(pagesTouched, "page", "pages")} changed</Tile>
      ) : null}
    </div>
  );
}
