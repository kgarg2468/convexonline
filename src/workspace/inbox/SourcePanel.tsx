import type { ThreadDetail } from "../types";
import { CLAIM_STATUS_LABEL, pathOf } from "../lib/format";
import { cn } from "@/lib/utils";
import { claimCardId } from "./claimMatch";
import { Chip, SectionLabel, type ChipTone } from "./primitives";

/** Non-ok claim statuses: a stale quote is a caution, a stripped one an error, a corrected one history. */
const CLAIM_TONE: Record<string, ChipTone> = {
  needs_review: "warning",
  stripped: "danger",
  corrected: "muted",
};

/**
 * Every claim the draft makes, with the verbatim quote it rests on. Page
 * claims link to the page; fact claims name the staff fact (their `url` is an
 * internal `staff:` reference, never rendered as a link).
 *
 * Beside the thread it is the third pane (`complementary "Sources for this
 * draft"`). Inside the header's sheet (`embedded`) it drops its own frame and
 * heading, which the sheet already provides, and takes a distinct `titleId`
 * so the two never share an id.
 *
 * `activeClaimId` is the claim whose sentence is hovered or focused in the
 * draft: its card is highlighted, and hovering a card names it in return.
 */
export function SourcePanel({
  detail,
  titleId = "fd-sources-title",
  embedded = false,
  activeClaimId = null,
  onActiveClaim,
}: {
  detail: ThreadDetail;
  titleId?: string;
  embedded?: boolean;
  activeClaimId?: string | null;
  onActiveClaim?: (claimId: string | null) => void;
}) {
  const { claims, facts } = detail;
  return (
    <aside
      aria-labelledby={titleId}
      className={cn(
        "min-w-0",
        embedded
          ? "px-4 pb-6"
          : "border-border-1 bg-white px-4 pt-4 pb-10 max-[900px]:border-t min-[901px]:min-h-0 min-[901px]:overflow-y-auto min-[901px]:border-l",
      )}
    >
      <SectionLabel id={titleId} as="h3" className={cn(embedded && "sr-only")}>
        Sources for this draft
      </SectionLabel>
      {claims.length === 0 ? (
        <p className={cn("text-[13px] leading-5 text-ink-2", !embedded && "mt-2")}>
          {detail.draft ? "This draft makes no claims about the website." : "No draft yet."}
        </p>
      ) : (
        <ul className={cn("flex flex-col gap-2", !embedded && "mt-3")}>
          {claims.map((c) => {
            const fact = c.source === "fact" ? (facts.find((f) => f._id === c.staffFactId) ?? null) : null;
            const ok = c.status === "ok";
            return (
              <li
                key={c._id}
                id={claimCardId(c._id)}
                data-active={activeClaimId === c._id || undefined}
                onMouseEnter={onActiveClaim ? () => onActiveClaim(c._id) : undefined}
                onMouseLeave={onActiveClaim ? () => onActiveClaim(null) : undefined}
                className={cn(
                  "rounded-[10px] border p-3 motion-safe:transition-[background-color,box-shadow] motion-safe:duration-micro",
                  ok ? "border-border-1" : "border-warning-10/30",
                  "data-active:bg-accent-2 data-active:ring-2 data-active:ring-accent-9/40",
                )}
              >
                <p className="text-[14px] leading-5 text-ink-1">{c.statement}</p>
                <p className="mt-1.5 font-serif text-[14px] leading-[1.5] text-ink-2 italic [overflow-wrap:anywhere]">“{c.quote}”</p>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <Chip tone={ok ? "accentOutline" : (CLAIM_TONE[c.status] ?? "danger")}>
                    {ok ? (c.verifyMethod === "strict" ? "Exact" : "Verified") : (CLAIM_STATUS_LABEL[c.status] ?? c.status)}
                  </Chip>
                  {ok ? (
                    <Chip tone={c.currentSource ? "muted" : "warning"}>
                      {c.currentSource
                        ? c.source === "fact"
                          ? "Fact current"
                          : "Page current"
                        : c.source === "fact"
                          ? "Fact superseded"
                          : "Page changed"}
                    </Chip>
                  ) : null}
                  <span className="ml-auto min-w-0 text-[13px] leading-5">
                    {c.source === "fact" ? (
                      <span className="text-ink-2 [overflow-wrap:anywhere]">
                        Staff fact{fact ? ` · ${fact.authorName}` : ""}
                        {fact ? ` · “${fact.question}”` : ""}
                      </span>
                    ) : (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-sm text-accent-10 underline-offset-4 outline-hidden transition-colors duration-micro hover:underline focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2"
                      >
                        {pathOf(c.url)}
                      </a>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <SectionLabel as="h3" className="mt-6">
        Staff facts on this thread
      </SectionLabel>
      {facts.length === 0 ? (
        <p className="mt-2 text-[13px] leading-5 text-ink-2">None yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border-1">
          {facts.map((f) => (
            <li key={f._id} className="py-2.5">
              <p className="text-[14px] leading-5 font-medium text-ink-1">{f.question}</p>
              <p className="mt-0.5 text-[14px] leading-5 text-ink-2 [overflow-wrap:anywhere]">{f.answer}</p>
              <p className="mt-1 text-[12px] leading-4 text-ink-3">{f.authorName}</p>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
