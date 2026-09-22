import { useState } from "react";
import { useQuery } from "convex/react";
import { FilePen, MessageSquareText, RotateCcw } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { RecordVersionResult, ThreadSummary, WorkspaceView } from "../types";
import { STATUS_LABEL, guestName } from "../lib/format";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { NAV } from "./nav";
import type { DemoPolicy } from "./useDemoPolicy";

/** Threads listed at most, recent or found. */
const THREAD_LIMIT = 8;

/** Every whitespace-separated word of the query appears somewhere in the label. */
function matches(label: string, query: string): boolean {
  const hay = label.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

type PaletteProps = {
  innId: Id<"inns">;
  isDemo: boolean;
  /** The workspace's demo-edit instance; its busy and error state outlive this palette. */
  demo: DemoPolicy;
  onGo: (view: WorkspaceView) => void;
  onOpenThread: (threadId: Id<"threads">) => void;
  onDemoResult: (result: RecordVersionResult) => void;
  /** Closes the palette before the chosen action runs. */
  onClose: () => void;
};

/**
 * ⌘K. Three groups: views (with their `g …` keycaps), threads (the most
 * recent until two characters are typed, then the server's full-text search),
 * and, in the demo, the scripted policy-page edit. Picking a view or thread
 * closes the palette first, then acts; the demo edit runs first and closes
 * only once it has succeeded, so a failure is shown here. The palette (and
 * its scrim, see app.css) opens instantly and only fades out, because it is
 * keyboard furniture used all day.
 */
export function CommandPalette({
  open,
  onOpenChange,
  ...body
}: { open: boolean; onOpenChange: (open: boolean) => void } & Omit<PaletteProps, "onClose">) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search and commands"
      description="Go to a view, open a thread or run an action"
      className="fd-palette shadow-pop data-open:animate-none data-closed:duration-(--dur-micro) sm:max-w-lg"
    >
      {/* Mounted only while open: the query and its subscriptions start fresh each time. */}
      <PaletteBody {...body} onClose={() => onOpenChange(false)} />
    </CommandDialog>
  );
}

function PaletteBody({ innId, isDemo, demo, onGo, onOpenThread, onDemoResult, onClose }: PaletteProps) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const searching = trimmed.length >= 2;

  // One of the two at a time.
  const recent = useQuery(api.threads.queue, searching ? "skip" : { innId }) as ThreadSummary[] | undefined;
  const found = useQuery(api.threads.search, searching ? { innId, text: trimmed } : "skip") as
    | ThreadSummary[]
    | undefined;
  const threads = (searching ? found : recent)?.slice(0, THREAD_LIMIT) ?? [];

  /** The demo edit: close on success and hand the result on; on failure stay open and show why. */
  async function runDemo() {
    const result = await demo.run();
    if (!result) return;
    onClose();
    onDemoResult(result);
  }

  function pick(action: () => void) {
    onClose();
    action();
  }

  const views = NAV.filter((item) => matches(item.label, trimmed));
  const showDemoAction = isDemo && matches(`${demo.label} policy demo`, trimmed);

  return (
    <Command shouldFilter={false} loop>
      <CommandInput placeholder="Go to a view, open a thread…" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>Nothing matches. Try a view, a subject or a guest's name.</CommandEmpty>
        {views.length ? (
          <CommandGroup heading="Go to">
            {views.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem key={item.view} value={`go:${item.view}`} onSelect={() => pick(() => onGo(item.view))}>
                  <Icon className="text-ink-3" />
                  <span>{item.label}</span>
                  <CommandShortcut>
                    <KbdGroup>
                      <Kbd>g</Kbd>
                      <Kbd>{item.chord}</Kbd>
                    </KbdGroup>
                  </CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {threads.length ? (
          <CommandGroup heading="Threads">
            {threads.map((t) => (
              <CommandItem key={t._id} value={`thread:${t._id}`} onSelect={() => pick(() => onOpenThread(t._id))}>
                <MessageSquareText className="text-ink-3" />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate">{t.subject}</span>
                  <span className="truncate text-[12px] text-ink-2">
                    {guestName(t.guestEmail)} · {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {showDemoAction ? (
          <CommandGroup heading="Actions">
            <CommandItem value="action:policy-page" disabled={!demo.ready || demo.busy} onSelect={() => void runDemo()}>
              {demo.changed ? <RotateCcw className="text-ink-3" /> : <FilePen className="text-ink-3" />}
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span>{demo.busy ? "Updating page…" : demo.label}</span>
                <span className="truncate text-[12px] text-ink-2">{demo.description}</span>
              </span>
            </CommandItem>
            {demo.error ? (
              <p role="alert" className="px-2 pt-1 pb-1.5 text-[12px] leading-4 text-danger-10">
                {demo.error}
              </p>
            ) : null}
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
}
