import { useState } from "react";
import { useQuery } from "convex/react";
import { PanelRight } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ThreadDetail as ThreadDetailData } from "../types";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SourcePanel } from "./SourcePanel";

/**
 * Between 900 and 1200px the sources pane leaves the grid and opens from this
 * header button as a right sheet. It subscribes to the same `threads.get` the
 * thread pane already holds (the Convex client shares one subscription), so
 * the count is the number of claims the source panel lists.
 */
export function SourcesSheet({ threadId }: { threadId: Id<"threads"> }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery(api.threads.get, { threadId }) as ThreadDetailData | undefined;
  const count = detail?.claims.length;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="text-[13px]">
          <PanelRight data-icon="inline-start" aria-hidden="true" className="text-ink-3" />
          {count === undefined ? "Sources" : `Sources (${count})`}
        </Button>
      </SheetTrigger>
      {/* Portalled outside the workspace root: `fd-root` brings the legacy tokens the panel's pills read. */}
      <SheetContent
        side="right"
        className="fd-root min-h-0 w-[360px] gap-0 overflow-y-auto bg-popover p-0 sm:max-w-[360px] [&_.fd-thread__side]:border-0 [&_.fd-thread__side]:bg-transparent [&_.fd-thread__side]:px-4 [&_.fd-thread__side]:pt-0 [&_#fd-sources-sheet-title]:sr-only"
      >
        <SheetHeader className="pr-12">
          <SheetTitle className="text-[16px]">Sources for this draft</SheetTitle>
          <SheetDescription className="text-[13px] text-ink-2">Every claim the draft makes and the passage it rests on.</SheetDescription>
        </SheetHeader>
        {detail ? <SourcePanel detail={detail} titleId="fd-sources-sheet-title" /> : null}
      </SheetContent>
    </Sheet>
  );
}
