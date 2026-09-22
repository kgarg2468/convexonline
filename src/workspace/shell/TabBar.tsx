import type { WorkspaceView } from "../types";
import { cn } from "@/lib/utils";
import { NAV } from "./nav";
import { ReviewCount } from "./Rail";

/**
 * The rail on narrow screens: a fixed bottom bar with the same four views,
 * icon over label, in one row. It is the same `nav[aria-label="Workspace"]`
 * the specs read, so nothing about how a view is reached changes with width.
 */
export function TabBar({
  view,
  onNavigate,
  correctionsCount,
}: {
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
  correctionsCount: number | undefined;
}) {
  return (
    <nav
      aria-label="Workspace"
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-border-1 bg-bg-1 pb-[env(safe-area-inset-bottom)]"
    >
      {NAV.map((item) => {
        const active = view === item.view;
        const Icon = item.icon;
        return (
          <button
            key={item.view}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onNavigate(item.view)}
            className={cn(
              "relative flex h-14 min-w-0 flex-col items-center justify-center gap-1 px-1 text-[11px] leading-none outline-hidden transition-colors duration-micro",
              active ? "font-medium text-accent-9" : "text-ink-2 hover:text-ink-1",
              "focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-inset",
            )}
          >
            <span className="relative">
              <Icon aria-hidden="true" className="size-5" strokeWidth={active ? 2 : 1.5} />
              {item.view === "corrections" ? (
                <ReviewCount
                  count={correctionsCount}
                  className={cn(
                    "absolute -top-1.5 -right-3 h-4 min-w-4 px-1 text-[11px] leading-4",
                    correctionsCount ? "bg-accent-9 text-white" : "text-ink-3",
                  )}
                />
              ) : null}
            </span>
            <span className="max-w-full truncate">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
