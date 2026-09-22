import type { ReactNode } from "react";
import { useIsNarrow } from "../lib/hooks";

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
 * One statistic. Beside the queue it is a KPI tile: the value on its own
 * line, then the rest of the sentence. On a phone it is one entry of a stat
 * line: the value in bold, then the sentence, wrapping as prose. Either way
 * the whitespace text node between the two keeps the element's text the
 * exact sentence the specs read ("3 replies need review"). Shared with the
 * Knowledge strip so both views' KPIs are the same tile.
 */
export function Stat({ value, narrow, children }: { value: number; narrow: boolean; children: ReactNode }) {
  if (narrow) {
    return (
      <span className="text-[13px] leading-5 text-ink-2">
        <strong className="font-semibold text-ink-1 tabular-nums">{value}</strong> <span>{children}</span>
      </span>
    );
  }
  return (
    <div className="min-w-0 rounded-[10px] border border-border-1 bg-white px-4 py-3">
      <span className="block text-[22px] leading-7 font-semibold tracking-[-0.01em] text-ink-1 tabular-nums">{value}</span>{" "}
      <span className="mt-0.5 block text-[13px] leading-5 text-balance text-ink-2">{children}</span>
    </div>
  );
}

/**
 * The review strip: replies that need review, replies re-checked and still
 * true, pages changed (and approved-not-sent when there are any). The three
 * are always there, "0 pages changed" included, so the strip reads the same
 * before and after a page edit. Beside the queue it is a fixed three-column
 * grid of KPI tiles, so a tile's width never depends on how many tiles there are; under 901px it collapses into one stat
 * line so the first card stays above the fold on a phone. The whole strip is
 * one `role="status"` so a screen reader hears the numbers change after a
 * page edit, and the specs read every sentence from it.
 */
export function ChangesStats({ stats }: { stats: ChangesStatsData }) {
  const { open, openReplies, approved, approvedReplies, controls, controlReplies, unchecked, allLoaded, allChecked, pagesTouched } =
    stats;
  const narrow = useIsNarrow();
  return (
    <div
      role="status"
      aria-label="Review statistics"
      className={narrow ? "flex flex-wrap gap-x-4 gap-y-0.5" : "grid gap-3 min-[901px]:grid-cols-3"}
    >
      <Stat value={openReplies} narrow={narrow}>
        {plural(openReplies, "reply needs", "replies need")} review
        {open > openReplies ? ` (${open} passages)` : null}
      </Stat>
      {approved > 0 ? (
        <Stat value={approvedReplies} narrow={narrow}>
          {plural(approvedReplies, "reply has an approved correction", "replies have approved corrections")}, not sent
          {approved > approvedReplies ? ` (${approved} passages)` : null}
        </Stat>
      ) : null}
      <Stat value={controlReplies} narrow={narrow}>
        {plural(controlReplies, "reply", "replies")} re-checked{allChecked ? "" : " so far"} and still true
        {controls > controlReplies ? ` (${controls} passages)` : null}
        {allLoaded ? null : ", older replies not loaded yet"}
        {allLoaded && !allChecked ? `, ${unchecked} not verified` : null}
      </Stat>
      <Stat value={pagesTouched} narrow={narrow}>
        {plural(pagesTouched, "page", "pages")} changed
      </Stat>
    </div>
  );
}
