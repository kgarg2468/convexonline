import { Check } from "lucide-react";
import type { Id } from "../../../convex/_generated/dataModel";
import type { UnaffectedControl } from "../types";
import { pathOf } from "../lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pathLinkClass } from "./styles";

/**
 * Sent claims re-checked against the latest page version and still true:
 * compact rows, one per claim. `.fd-controls` / `li.fd-control` are the
 * specs' locators; the subject button's accessible name is the subject and
 * it wears the same link treatment as the page path so it reads as a way in.
 */
export function UnaffectedControls({
  controls,
  onOpenThread,
}: {
  controls: UnaffectedControl[];
  onOpenThread: (threadId: Id<"threads">) => void;
}) {
  return (
    <ul className="fd-controls divide-y divide-border-1 rounded-[10px] border border-border-1 bg-white">
      {controls.map((c) => (
        <li key={c.claimId} className="fd-control flex items-start gap-2.5 px-3 py-2">
          <Check aria-hidden="true" className="mt-[3px] size-4 shrink-0 text-success-10" strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] leading-5 text-ink-1 [overflow-wrap:anywhere]">{c.statement}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] leading-5 text-ink-2">
              <Button
                type="button"
                variant="link"
                size="sm"
                className={cn(pathLinkClass, "h-5 px-0 text-[13px] font-normal")}
                onClick={() => onOpenThread(c.threadId)}
              >
                {c.subject}
              </Button>
              <span>
                still on{" "}
                <a href={c.pageUrl} target="_blank" rel="noreferrer noopener" className={pathLinkClass}>
                  {pathOf(c.pageUrl)}
                </a>
              </span>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
