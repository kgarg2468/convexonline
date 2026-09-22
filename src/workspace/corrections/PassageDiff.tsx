import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { passageClass } from "./styles";
import { type DiffHunk, wordDiff } from "./wordDiff";

const delClass = "rounded-[3px] bg-danger-3 px-0.5 text-danger-10 line-through decoration-danger-10/40 [box-decoration-break:clone]";
const insClass = "rounded-[3px] bg-success-3 px-0.5 text-success-10 no-underline [box-decoration-break:clone]";

/** The old passage with the words the page dropped struck through. */
function OldSide({ hunks }: { hunks: DiffHunk[] }) {
  return hunks.map((h, i) =>
    h.kind === "same" ? (
      <span key={i}>{h.text}</span>
    ) : h.del ? (
      <del key={i} className={delClass}>
        {h.del}
      </del>
    ) : null,
  );
}

/** The new passage with the words the page added marked. */
function NewSide({ hunks }: { hunks: DiffHunk[] }) {
  return hunks.map((h, i) =>
    h.kind === "same" ? (
      <span key={i}>{h.text}</span>
    ) : h.ins ? (
      <ins key={i} className={insClass}>
        {h.ins}
      </ins>
    ) : null,
  );
}

/** Both passages in one stream: what was dropped, then what replaced it. */
function Unified({ hunks }: { hunks: DiffHunk[] }) {
  return hunks.map((h, i) =>
    h.kind === "same" ? (
      <span key={i}>{h.text}</span>
    ) : (
      <span key={i}>
        {h.del ? <del className={delClass}>{h.del}</del> : null}
        {h.del && h.ins ? " " : null}
        {h.ins ? <ins className={insClass}>{h.ins}</ins> : null}
      </span>
    ),
  );
}

function ColumnLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-[12px] leading-4 font-medium text-ink-2">{children}</p>;
}

const MISSING = "The quoted passage is gone and no replacement was found on the page.";

/**
 * The quoted passage then and now. Split into two columns beside the queue,
 * one unified stream under 900px (`unified`). The old and new containers keep
 * `fd-quote--old` / `fd-quote--new` for the specs; in the unified layout the
 * one container is both.
 */
export function PassageDiff({
  oldText,
  newText,
  oldLabel,
  newLabel,
  unified,
}: {
  oldText: string;
  newText: string | null;
  oldLabel: string;
  newLabel: string;
  unified: boolean;
}) {
  const hunks = newText === null ? null : wordDiff(oldText, newText);

  if (unified) {
    return (
      <div>
        <ColumnLabel>
          <span className="inline-flex flex-wrap items-center gap-1">
            <span>{oldLabel}</span>
            <ArrowRight aria-hidden="true" className="size-3 text-ink-3" />
            <span>{newLabel}</span>
          </span>
        </ColumnLabel>
        <blockquote className={cn(passageClass, "fd-quote fd-quote--old", hunks && "fd-quote--new")}>
          {hunks ? <Unified hunks={hunks} /> : <del className={delClass}>{oldText}</del>}
        </blockquote>
        {hunks ? null : <p className="mt-1.5 text-[13px] leading-5 text-danger-10">{MISSING}</p>}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="min-w-0">
        <ColumnLabel>{oldLabel}</ColumnLabel>
        <blockquote className={cn(passageClass, "fd-quote fd-quote--old border-danger-10/40")}>
          {hunks ? <OldSide hunks={hunks} /> : <del className={delClass}>{oldText}</del>}
        </blockquote>
      </div>
      <div className="min-w-0">
        <ColumnLabel>{newLabel}</ColumnLabel>
        {hunks ? (
          <blockquote className={cn(passageClass, "fd-quote fd-quote--new border-success-10/40")}>
            <NewSide hunks={hunks} />
          </blockquote>
        ) : (
          <p className="rounded-md border border-danger-10/20 bg-danger-3 px-3 py-2 text-[13px] leading-5 text-danger-10">{MISSING}</p>
        )}
      </div>
    </div>
  );
}
