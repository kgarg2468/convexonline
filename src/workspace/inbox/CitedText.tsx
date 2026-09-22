import { Fragment, useMemo, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { claimCardId, matchClaims, type ClaimLike } from "./claimMatch";

/**
 * The read-only draft body with each cited sentence underlined in accent.
 * A sentence is a focusable button: hovering or focusing it names the active
 * claim, which the sources pane highlights (and vice versa); pressing it also
 * scrolls the source card into view. Only pointer devices get the pure-CSS
 * hover, and nothing here animates under reduced motion.
 */
export function CitedText({
  text,
  claims,
  activeClaimId,
  onActiveClaim,
  describeCards = true,
  className,
}: {
  text: string;
  claims: readonly ClaimLike[];
  activeClaimId: string | null;
  onActiveClaim: (claimId: string | null) => void;
  /** False when the source cards are not in the document (the sources sheet is closed): no dangling `aria-describedby`. */
  describeCards?: boolean;
  className?: string;
}) {
  const segments = useMemo(() => matchClaims(text, claims), [text, claims]);

  function reveal(claimId: string) {
    onActiveClaim(claimId);
    const card = document.getElementById(claimCardId(claimId));
    if (!card) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }

  function onKey(event: KeyboardEvent<HTMLSpanElement>, claimId: string) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    reveal(claimId);
  }

  return (
    <div className={className}>
      {segments.map((segment, i) =>
        segment.claimId === null ? (
          <Fragment key={i}>{segment.text}</Fragment>
        ) : (
          <span
            key={i}
            role="button"
            tabIndex={0}
            data-claim-id={segment.claimId}
            data-active={activeClaimId === segment.claimId || undefined}
            aria-describedby={describeCards ? claimCardId(segment.claimId) : undefined}
            onMouseEnter={() => onActiveClaim(segment.claimId)}
            onMouseLeave={() => onActiveClaim(null)}
            onFocus={() => onActiveClaim(segment.claimId)}
            onBlur={() => onActiveClaim(null)}
            onClick={() => reveal(segment.claimId!)}
            onKeyDown={(event) => onKey(event, segment.claimId!)}
            className={cn(
              "cursor-pointer rounded-[3px] underline decoration-accent-9/60 decoration-1 underline-offset-2 outline-hidden",
              "motion-safe:transition-colors motion-safe:duration-micro",
              "hover:decoration-accent-9 focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-1",
              "data-active:bg-accent-2 data-active:text-accent-10 data-active:decoration-accent-9",
            )}
          >
            {segment.text}
          </span>
        ),
      )}
    </div>
  );
}
