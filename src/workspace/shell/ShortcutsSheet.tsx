import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SHORTCUT_GROUPS } from "./nav";

/** A heading as an id fragment: lowercase, words joined by hyphens. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** `?`: every shortcut the shell knows, as a right-hand sheet. Groups come from nav.ts so views can add theirs. */
export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-80 gap-0 shadow-pop duration-(--dur-medium) ease-(--ease-drawer) data-closed:duration-200"
      >
        <SheetHeader className="border-b border-border-1">
          <SheetTitle className="text-[16px] font-semibold text-ink-1">Keyboard shortcuts</SheetTitle>
          <SheetDescription className="text-[13px] text-ink-2">Work the desk without reaching for the mouse.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 overflow-y-auto p-4">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.heading} aria-labelledby={`fd-shortcuts-${slug(group.heading)}`}>
              <h3
                id={`fd-shortcuts-${slug(group.heading)}`}
                className="mb-2 text-[12px] font-medium tracking-wide text-ink-3 uppercase"
              >
                {group.heading}
              </h3>
              <dl className="flex flex-col">
                {group.entries.map((entry) => (
                  <div
                    key={entry.label}
                    className="flex h-9 items-center justify-between gap-3 border-b border-border-1 last:border-b-0"
                  >
                    <dt className="truncate text-[13px] text-ink-1">{entry.label}</dt>
                    <dd className="m-0 shrink-0">
                      <KbdGroup>
                        {entry.keys.map((key, i) => (
                          <Kbd key={`${key}-${i}`} className="bg-bg-3 text-ink-2">
                            {key}
                          </Kbd>
                        ))}
                      </KbdGroup>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
