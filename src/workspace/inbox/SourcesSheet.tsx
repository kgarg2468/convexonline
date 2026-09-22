import { useState } from "react";
import { PanelRight } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ThreadDetail as ThreadDetailData } from "../types";
import { useQueryResult } from "../lib/hooks";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SourcePanel } from "./SourcePanel";

/**
 * Between 900 and 1440px the sources pane leaves the grid and opens from this
 * header button as a right sheet. It subscribes to the same `threads.get` the
 * thread pane already holds (the Convex client shares one subscription), so
 * the count is the number of claims the source panel lists.
 */
export function SourcesSheet({ threadId }: { threadId: Id<"threads"> }) {
  const [open, setOpen] = useState(false);
  const result = useQueryResult(api.threads.get, { threadId });
  // The thread pane explains a refused thread; a sources button for it would only mislead.
  if (result.status === "error") return null;
  const detail = result.data as ThreadDetailData | undefined;
  const count = detail?.claims.length;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="text-[13px]">
          <PanelRight data-icon="inline-start" aria-hidden="true" className="text-ink-3" />
          {count === undefined ? "Sources" : `Sources (${count})`}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="min-h-0 w-[360px] gap-0 overflow-y-auto bg-popover p-0 sm:max-w-[360px]">
        <SheetHeader className="pr-12">
          <SheetTitle className="text-[16px]">Sources for this draft</SheetTitle>
          <SheetDescription className="text-[13px] text-ink-2">Every claim the draft makes and the passage it rests on.</SheetDescription>
        </SheetHeader>
        {detail ? <SourcePanel detail={detail} titleId="fd-sources-sheet-title" embedded /> : null}
      </SheetContent>
    </Sheet>
  );
}
