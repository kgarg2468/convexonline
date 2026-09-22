import { useState } from "react";
import { FileText } from "lucide-react";
import type { PageSummary } from "../types";
import { pathOf } from "../lib/format";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { VersionPane } from "./VersionPane";

/**
 * "View content" on a page row: the stored version opens in a right sheet
 * instead of unfolding under the row. The version query only runs while the
 * sheet is open (the pane is not mounted otherwise).
 */
export function ContentSheet({ page, version }: { page: PageSummary; version: NonNullable<PageSummary["lastVersion"]> }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="text-[13px]">
          <FileText data-icon="inline-start" aria-hidden="true" className="text-ink-3" />
          View content
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex min-h-0 flex-col gap-0 bg-popover p-0 duration-(--dur-medium) ease-drawer data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
      >
        <SheetHeader className="border-b border-border-1 pr-12">
          <SheetTitle className="truncate text-[16px] text-ink-1">{page.title}</SheetTitle>
          <SheetDescription className="truncate text-[13px] text-ink-2">
            {pathOf(page.url)} · the version replies are drafted from
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* The sheet is portaled outside `.fd-root`, where the legacy `--fd-*` variables live, so the pane's mono font is pinned here. */}
          <VersionPane
            versionId={version._id}
            label="Latest version"
            className="mt-0 max-h-none overflow-visible rounded-none border-0 bg-transparent p-0 [&_.fd-mono]:font-mono [&_pre]:font-mono"
          />
        </div>
        <SheetFooter className="flex-row justify-end border-t border-border-1 py-3">
          <SheetClose asChild>
            <Button variant="outline" size="sm" className="text-[13px]">
              Hide content
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
