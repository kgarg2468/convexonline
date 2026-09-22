import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, LogOut } from "lucide-react";
import type { Id } from "../../../convex/_generated/dataModel";
import type { InnSummary, Viewer, WorkspaceView } from "../types";
import { useIsNarrow, useStoredState } from "../lib/hooks";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { roleLabel } from "./nav";
import { Rail } from "./Rail";
import { TabBar } from "./TabBar";

/** What a view puts in the header. The shell lays it out differently per width. */
export type ShellHeader = {
  title: string;
  /** 13px line under the title; ignored when `meta` is given. */
  sub?: string;
  /** A block under the title, e.g. the inbox statistics. */
  meta?: ReactNode;
  /** Right-aligned controls. */
  actions?: ReactNode;
};

export type ShellProps = {
  viewer: Viewer;
  inns: InnSummary[];
  currentInn: InnSummary;
  onSwitchInn: (innId: Id<"inns">) => void;
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
  correctionsCount: number | undefined;
  isDemo: boolean;
  header: ShellHeader;
  children: ReactNode;
  /** The view fills the body edge to edge (the inbox's own panes carry their padding). */
  flush?: boolean;
  onOpenPalette: () => void;
  onSignOut: () => void;
};

/** Where the rail's width preference lives between visits. */
const RAIL_KEY = "frontdesk.rail";

/**
 * The workspace frame: rail (or bottom tab bar under 900px), sticky header,
 * body. Views own their header content and pass it in; the shell only lays
 * it out. The header bar is exactly `--header-h` tall (56px; 44px on narrow
 * screens, where the view's sub line, stats and actions move to a strip
 * under the bar) so panes can size off the variable.
 */
export function Shell(props: ShellProps) {
  const { header, view, onSignOut } = props;
  const narrow = useIsNarrow();
  const [railState, setRailState] = useStoredState<"open" | "collapsed">(RAIL_KEY, "open");
  const collapsed = railState === "collapsed";

  // A route change moves focus to the body and names the new view for screen
  // readers; selecting a thread inside the inbox does neither.
  const mainRef = useRef<HTMLElement>(null);
  const shownView = useRef(view);
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    mainRef.current?.focus({ preventScroll: true });
    setAnnounced(header.title);
  }, [view, header.title]);

  const strip =
    narrow && (header.meta || header.sub || header.actions) ? (
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border-1 bg-bg-1 px-4 py-2">
        <div className="min-w-0 flex-1">
          {header.meta ?? (header.sub ? <p className="truncate text-[13px] text-ink-2">{header.sub}</p> : null)}
        </div>
        {header.actions ? <HeaderActions className="flex-wrap">{header.actions}</HeaderActions> : null}
      </div>
    ) : null;

  return (
    <div
      className={cn(
        "grid min-h-dvh grid-cols-[var(--rail-w)_minmax(0,1fr)] motion-safe:transition-[grid-template-columns] motion-safe:duration-medium motion-safe:ease-in-out",
        collapsed && "[--rail-w:64px]",
        narrow && "grid-cols-1 [--header-h:44px]",
      )}
    >
      {narrow ? null : (
        <Rail
          viewer={props.viewer}
          inns={props.inns}
          currentInn={props.currentInn}
          onSwitchInn={props.onSwitchInn}
          view={props.view}
          onNavigate={props.onNavigate}
          correctionsCount={props.correctionsCount}
          isDemo={props.isDemo}
          collapsed={collapsed}
          onToggleCollapsed={() => setRailState(collapsed ? "open" : "collapsed")}
          onOpenPalette={props.onOpenPalette}
          onSignOut={onSignOut}
        />
      )}

      <div className="flex min-w-0 flex-col">
        <header
          className={cn(
            "sticky top-0 z-10 flex h-(--header-h) items-center justify-between gap-3 border-b border-border-1 bg-bg-1 px-6",
            narrow && "gap-2 px-4",
          )}
        >
          {narrow ? (
            <>
              <HeaderTitle title={header.title} />
              <MobileMenu
                viewer={props.viewer}
                inns={props.inns}
                currentInn={props.currentInn}
                onSwitchInn={props.onSwitchInn}
                isDemo={props.isDemo}
                onSignOut={onSignOut}
              />
            </>
          ) : (
            <>
              {/* The actions keep their own width; the title box takes what is left and truncates or wraps. */}
              <div className="min-w-0 flex-1">
                <HeaderTitle title={header.title} sub={header.meta ? undefined : header.sub} />
                {header.meta}
              </div>
              {header.actions ? <HeaderActions className="flex-none">{header.actions}</HeaderActions> : null}
            </>
          )}
        </header>
        {strip}
        <main
          ref={mainRef}
          id="fd-main"
          tabIndex={-1}
          className={cn(
            "min-w-0 flex-1 outline-none [contain:layout_paint]",
            props.flush ? "flex min-h-0" : "px-6 pt-5 pb-10",
            narrow && !props.flush && "px-4 pt-4",
            narrow && "pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+1rem)]",
          )}
        >
          {props.children}
        </main>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {announced}
        </div>
      </div>

      {narrow ? <TabBar view={props.view} onNavigate={props.onNavigate} correctionsCount={props.correctionsCount} /> : null}
    </div>
  );
}

/**
 * On narrow screens the property name stays in view as the header's account
 * menu: property switcher, who is signed in, the demo notice and sign out.
 */
function MobileMenu({
  viewer,
  inns,
  currentInn,
  onSwitchInn,
  isDemo,
  onSignOut,
}: {
  viewer: Viewer;
  inns: InnSummary[];
  currentInn: InnSummary;
  onSwitchInn: (innId: Id<"inns">) => void;
  isDemo: boolean;
  onSignOut: () => void;
}) {
  const displayName = viewer.isAnonymous ? "Demo visitor" : viewer.name ?? viewer.email ?? "Staff";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-8 max-w-[44vw] shrink-0 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-ink-1 outline-hidden transition-colors duration-micro hover:bg-bg-2 focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2 aria-expanded:bg-bg-2"
      >
        <span className="truncate">{currentInn.name}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-64 shadow-pop duration-(--dur-small) ease-out-expo">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-ink-1">{displayName}</span>
          <span className="text-[12px] font-normal text-ink-2">{roleLabel(currentInn.role)}</span>
        </DropdownMenuLabel>
        {inns.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Switch property</DropdownMenuLabel>
            {inns.map((inn) => (
              <DropdownMenuItem
                key={inn.innId}
                onSelect={() => onSwitchInn(inn.innId)}
                aria-current={inn.innId === currentInn.innId ? "true" : undefined}
              >
                <span className="min-w-0 flex-1 truncate">{inn.name}</span>
                {inn.innId === currentInn.innId ? <Check className="size-4 text-accent-9" /> : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {isDemo ? (
          <>
            <DropdownMenuSeparator />
            <p className="px-1.5 py-1 text-[12px] leading-4 text-ink-2">Demo workspace · no real email is sent</p>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut}>
          <LogOut className="text-ink-3" />
          {viewer.isAnonymous ? "Leave demo" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A view's title block: h1 22/600 with an optional 13px sub line. */
export function HeaderTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-balance text-ink-1 max-[900px]:text-[18px] max-[900px]:leading-6">
        {title}
      </h1>
      {sub ? <p className="truncate text-[13px] text-ink-2">{sub}</p> : null}
    </div>
  );
}

/** Right-aligned header controls, on one line unless a caller allows wrapping. */
export function HeaderActions({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex min-w-0 items-center justify-end gap-2", className)}>{children}</div>;
}
