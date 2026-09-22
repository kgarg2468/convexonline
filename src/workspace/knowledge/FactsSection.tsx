import type { Id } from "../../../convex/_generated/dataModel";
import type { StaffFact } from "../types";
import { formatStamp } from "../lib/format";
import { cn } from "@/lib/utils";
import { SectionLabel } from "../inbox/primitives";
import { AddFactPopover } from "./AddFactPopover";
import { metaClass, panelClass, rowEnterClass } from "./styles";
import { useMounted } from "./useMounted";

/**
 * General staff facts: things the website does not say that drafts may use.
 * Rows read question (500) over answer (400) over author · date (12px).
 */
export function FactsSection({ innId, facts }: { innId: Id<"inns">; facts: StaffFact[] }) {
  const mounted = useMounted();
  return (
    <section aria-labelledby="fd-facts-title" className={panelClass}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <SectionLabel id="fd-facts-title" as="h3">
          Staff facts
        </SectionLabel>
        <AddFactPopover innId={innId} />
      </div>
      {facts.length === 0 ? (
        <p className="border-t border-border-1 px-4 py-6 text-center text-[13px] leading-5 text-ink-2">
          No staff facts yet. Gap questions answered from a thread with “every future guest” land here.
        </p>
      ) : (
        <ul data-mounted={mounted || undefined} className="group/list border-t border-border-1">
          {facts.map((f) => (
            <li key={f._id} className={cn(rowEnterClass, "flex flex-col gap-0.5 border-b border-border-1 px-4 py-2.5 last:border-b-0")}>
              <span className="text-[14px] leading-5 font-medium text-ink-1">{f.question}</span>
              <span className="text-[14px] leading-5 text-ink-1">{f.answer}</span>
              <span className={metaClass}>
                {f.authorName} · {formatStamp(f.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
