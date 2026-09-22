import { ArrowUpRight } from "lucide-react";
import type { OverviewSummary, ThreadStatus } from "../types";
import { cn } from "@/lib/utils";
import { sectionHeadingClass } from "../corrections/styles";
import { valueClass } from "./styles";

/** Semantic tint of a non-zero tile (design-spec §4.1): needs-you warning, ready accent, policy danger. */
type Tone = "warning" | "accent" | "danger";

const TONE: Record<Tone, { tile: string; label: string }> = {
  warning: { tile: "border-warning-10/20 bg-warning-3 hover:border-warning-10/40", label: "text-warning-10" },
  accent: { tile: "border-accent-9/30 bg-accent-3 hover:border-accent-9/50", label: "text-accent-10" },
  danger: { tile: "border-danger-10/20 bg-danger-3 hover:border-danger-10/40", label: "text-danger-10" },
};

/**
 * One needs-action tile: a real button that deep-links to the filtered view.
 * Label 12 → value 28/600 tabular → sub 12; the label and the sub wrap to a
 * second line on a narrow tile rather than lose their ends to an ellipsis.
 * A zero tile is calm neutral and reads "Clear"; the value itself is never
 * coloured, only the tile's ground.
 * The arrow is visible at rest so the tile reads as a link beside the inert
 * KPI tiles. `zeroName` is the zero tile's accessible name: its visible text
 * ends in "Clear", which a screen reader would announce as the action.
 */
function Tile({
  label,
  value,
  sub,
  zeroName,
  tone,
  onOpen,
}: {
  label: string;
  value: number;
  sub: string;
  zeroName: string;
  tone: Tone;
  onOpen: () => void;
}) {
  const zero = value === 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={zero ? zeroName : undefined}
      className={cn(
        // A flex column: a button centres its content vertically, and a tile whose neighbour wrapped must stay top-aligned.
        "group flex min-w-0 cursor-pointer flex-col rounded-[10px] border px-4 py-3 text-left outline-hidden transition-colors duration-micro focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2",
        zero ? "border-border-1 bg-white hover:bg-bg-2" : TONE[tone].tile,
      )}
    >
      <span className={cn("flex items-start justify-between gap-2 text-[12px] leading-4 font-medium", zero ? "text-ink-2" : TONE[tone].label)}>
        <span className="line-clamp-2">{label}</span>
        <ArrowUpRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-ink-3 opacity-60 transition-opacity duration-micro group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </span>
      <span className={cn(valueClass, "mt-1")}>{value}</span>
      <span className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-ink-2">{zero ? "Clear" : sub}</span>
    </button>
  );
}

/**
 * The first thing on the dashboard (design-spec §0): four counts, each a link
 * to where the work is. Follow-ups due opens the needs-you filter: a due
 * reminder flips its thread to needs_staff, and there is no follow-up filter
 * in the queue yet, so the tile says so. Two per row on a phone, so the strip
 * is a block above "Up next" rather than the whole first screen.
 */
export function NeedsActionStrip({
  needsAction,
  onOpenInbox,
  onOpenCorrections,
}: {
  needsAction: OverviewSummary["needsAction"];
  onOpenInbox: (filter: ThreadStatus) => void;
  onOpenCorrections: () => void;
}) {
  const { needsStaff, ready, policyChangesToReview, followUpsDue } = needsAction;
  return (
    <div>
      <h2 id="fd-overview-needs-action" className={`${sectionHeadingClass} mb-2`}>
        Needs action
      </h2>
      <div role="group" aria-labelledby="fd-overview-needs-action" className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Tile
          label="Needs you"
          value={needsStaff}
          sub="Waiting on a staff answer"
          zeroName="Needs you: 0, nothing waiting on you. Open the inbox"
          tone="warning"
          onOpen={() => onOpenInbox("needs_staff")}
        />
        <Tile
          label="Ready to send"
          value={ready}
          sub="Verified drafts to send"
          zeroName="Ready to send: 0, nothing to send. Open the inbox"
          tone="accent"
          onOpen={() => onOpenInbox("ready")}
        />
        <Tile
          label="Policy changes to review"
          value={policyChangesToReview}
          sub="Sent replies quoting a changed page"
          zeroName="Policy changes to review: 0, nothing to review. Open policy changes"
          tone="danger"
          onOpen={onOpenCorrections}
        />
        <Tile
          label="Follow-ups due"
          value={followUpsDue}
          sub="Reminders due — opens everything that needs you"
          zeroName="Follow-ups due: 0, nothing due. Open the inbox"
          tone="warning"
          onOpen={() => onOpenInbox("needs_staff")}
        />
      </div>
    </div>
  );
}
