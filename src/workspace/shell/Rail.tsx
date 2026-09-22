import { useDeferredValue, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import NumberFlow from "@number-flow/react";
import { Check, ChevronsUpDown, LogOut, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import type { Id } from "../../../convex/_generated/dataModel";
import type { InnSummary, Viewer, WorkspaceView } from "../types";
import { Mark } from "../lib/Mark";
import { cn } from "@/lib/utils";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MOD_LABEL, NAV, initials, reviewCountLabel, roleLabel } from "./nav";

export type RailProps = {
  viewer: Viewer;
  inns: InnSummary[];
  currentInn: InnSummary;
  onSwitchInn: (innId: Id<"inns">) => void;
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
  correctionsCount: number | undefined;
  isDemo: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenPalette: () => void;
  onSignOut: () => void;
};

/**
 * Shared look of every rail control: quiet by default, hairline-free, and a
 * focus ring in `--rail-accent` (accent-9 is ≈2:1 on the dark ground). Padding
 * puts a 16px glyph's centre at 32px from the rail edge (12px rail padding +
 * 12px + 8px), which is the collapsed rail's centre: glyphs never move when
 * the rail collapses, only the labels fade.
 */
const railControl =
  "relative flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-[14px] text-rail-muted outline-hidden transition-colors duration-micro ease-out hover:bg-white/6 hover:text-rail-ink focus-visible:ring-2 focus-visible:ring-rail-accent focus-visible:ring-offset-2 focus-visible:ring-offset-rail-bg";

/** Rows carrying a 28px avatar glyph: 12px + 6px + 14px = the same 32px centre. */
const avatarRow = "px-1.5";

/** A label that fades and slides out while the rail collapses; the icon before it never moves. */
function RailLabel({ collapsed, className, children }: { collapsed: boolean; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "min-w-0 flex-1 truncate transition-[opacity,translate] duration-small ease-out",
        collapsed && "pointer-events-none -translate-x-1 opacity-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Wraps a rail control in a tooltip carrying its keycap. Shown on hover in
 * both widths; in the collapsed rail it is the only place the label appears.
 */
function RailTip({ label, keys, children }: { label: string; keys?: string[]; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
        {keys ? (
          <KbdGroup>
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </KbdGroup>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The "needs review" count beside Policy changes: nothing at 0 (the button's
 * aria-label still carries the sentence), an ellipsis while loading.
 * NumberFlow rolls the digits and starts from 0 on first paint so a count
 * arriving late is seen to arrive.
 */
export function ReviewCount({ count, className }: { count: number | undefined; className?: string }) {
  // First paint shows 0, the next render the real count: the digits roll in.
  const shown = useDeferredValue(count ?? 0, 0);
  if (count === 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[12px] leading-5 tabular-nums transition-colors duration-micro",
        count ? "bg-white/12 font-medium text-white" : "text-rail-muted",
        className,
      )}
    >
      {count === undefined ? (
        "…"
      ) : (
        <NumberFlow
          value={shown}
          transformTiming={{ duration: 260, easing: "cubic-bezier(0.23,1,0.32,1)" }}
          spinTiming={{ duration: 400, easing: "cubic-bezier(0.23,1,0.32,1)" }}
          opacityTiming={{ duration: 160, easing: "ease-out" }}
        />
      )}
    </span>
  );
}

/** The 2px accent bar of the active item, sliding between items with a shared layoutId (a plain bar under reduced motion). */
function ActiveBar() {
  const reduced = useReducedMotion();
  const className = "absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-rail-accent";
  if (reduced) return <span aria-hidden="true" className={className} />;
  return (
    <m.span
      aria-hidden="true"
      layoutId="rail-active-bar"
      className={className}
      transition={{ type: "spring", stiffness: 500, damping: 40, mass: 1 }}
    />
  );
}

function PropertyBlock({ inn, collapsed, chevron }: { inn: InnSummary; collapsed: boolean; chevron: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-md bg-white/8 text-[12px] font-semibold text-rail-ink"
      >
        {initials(inn.name, null)}
      </span>
      <RailLabel collapsed={collapsed} className="flex flex-col leading-tight">
        <span className="truncate text-[13px] font-medium text-rail-ink">{inn.name}</span>
        <span className="truncate text-[11px] text-rail-muted">Property</span>
      </RailLabel>
      {chevron ? (
        <ChevronsUpDown
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-rail-muted transition-opacity duration-small", collapsed && "opacity-0")}
        />
      ) : null}
    </>
  );
}

/** The desktop rail: brand, property, search, views, user. 232px wide, 64px collapsed. */
export function Rail(props: RailProps) {
  const { viewer, inns, currentInn, view, onNavigate, correctionsCount, isDemo, collapsed } = props;
  const displayName = viewer.isAnonymous ? "Demo visitor" : viewer.name ?? viewer.email ?? "Staff";
  const signOutLabel = viewer.isAnonymous ? "Leave demo" : "Sign out";

  return (
    <nav
      aria-label="Workspace"
      className="sticky top-0 flex h-dvh min-h-0 flex-col overflow-hidden bg-rail-bg text-rail-ink"
    >
      <div className="flex h-14 shrink-0 items-center gap-3 px-5">
        <span className="flex shrink-0">
          <Mark size={24} />
        </span>
        <RailLabel collapsed={collapsed} className="font-serif text-[18px] font-medium text-white">
          Front Desk
        </RailLabel>
      </div>

      <div className="shrink-0 border-y border-white/10 px-3 py-2">
        {inns.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(railControl, "h-11", avatarRow)}
              aria-label={collapsed ? `Switch property (${currentInn.name})` : undefined}
            >
              <PropertyBlock inn={currentInn} collapsed={collapsed} chevron />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="right"
              align="start"
              sideOffset={8}
              className="w-64 shadow-pop duration-(--dur-small) ease-out-expo"
            >
              <DropdownMenuLabel>Switch property</DropdownMenuLabel>
              {inns.map((inn) => (
                <DropdownMenuItem
                  key={inn.innId}
                  onSelect={() => props.onSwitchInn(inn.innId)}
                  aria-current={inn.innId === currentInn.innId ? "true" : undefined}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium">{inn.name}</span>
                    <span className="truncate text-[12px] text-ink-2">{roleLabel(inn.role)}</span>
                  </span>
                  {inn.innId === currentInn.innId ? <Check className="size-4 text-accent-9" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className={cn("flex h-11 items-center gap-3", avatarRow)}>
            <PropertyBlock inn={currentInn} collapsed={collapsed} chevron={false} />
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 px-3 pt-3">
        <RailTip label="Search and commands" keys={[MOD_LABEL, "K"]}>
          <button type="button" className={railControl} onClick={props.onOpenPalette}>
            <Search aria-hidden="true" className="size-4 shrink-0" />
            <RailLabel collapsed={collapsed}>Search</RailLabel>
            <KbdGroup
              aria-hidden="true"
              className={cn("transition-opacity duration-small", collapsed && "opacity-0")}
            >
              <Kbd className="bg-white/10 text-rail-muted">{MOD_LABEL}</Kbd>
              <Kbd className="bg-white/10 text-rail-muted">K</Kbd>
            </KbdGroup>
          </button>
        </RailTip>
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 px-3 pt-2">
        {NAV.map((item) => {
          const active = view === item.view;
          const Icon = item.icon;
          return (
            <RailTip key={item.view} label={item.label} keys={["g", item.chord]}>
              <button
                type="button"
                className={cn(railControl, active && "bg-rail-active font-medium text-rail-ink")}
                aria-current={active ? "page" : undefined}
                aria-label={item.view === "corrections" ? `${item.label}, ${reviewCountLabel(correctionsCount)}` : undefined}
                onClick={() => onNavigate(item.view)}
              >
                {active ? <ActiveBar /> : null}
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <RailLabel collapsed={collapsed}>{item.label}</RailLabel>
                {item.view === "corrections" ? (
                  <ReviewCount
                    count={correctionsCount}
                    className={cn(
                      "transition-[opacity,translate,scale] duration-small ease-out",
                      collapsed && "absolute top-0.5 right-0.5 h-4 min-w-4 scale-90 px-1 text-[11px] leading-4",
                    )}
                  />
                ) : null}
              </button>
            </RailTip>
          );
        })}
      </div>

      <div className="mt-auto flex shrink-0 flex-col gap-1 border-t border-white/10 px-3 py-3">
        <div className={cn("flex h-9 items-center gap-3", avatarRow)}>
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-rail-active text-[12px] font-semibold text-rail-ink"
          >
            {initials(displayName, viewer.email)}
          </span>
          <RailLabel collapsed={collapsed} className="flex flex-col leading-tight">
            <span className="truncate text-[13px] font-medium text-rail-ink">{displayName}</span>
            <span className="truncate text-[12px] text-rail-muted">{roleLabel(currentInn.role)}</span>
          </RailLabel>
        </div>
        {isDemo ? (
          <p
            className={cn(
              "px-3 text-[12px] leading-4 text-rail-muted transition-opacity duration-small",
              collapsed && "h-0 overflow-hidden opacity-0",
            )}
          >
            Demo workspace · no real email is sent
          </p>
        ) : null}
        <RailTip label={signOutLabel}>
          <button type="button" className={railControl} onClick={props.onSignOut} aria-label={collapsed ? signOutLabel : undefined}>
            <LogOut aria-hidden="true" className="size-4 shrink-0" />
            <RailLabel collapsed={collapsed}>{signOutLabel}</RailLabel>
          </button>
        </RailTip>
        <RailTip label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <button
            type="button"
            className={railControl}
            onClick={props.onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <PanelLeftClose aria-hidden="true" className="size-4 shrink-0" />
            )}
            <RailLabel collapsed={collapsed}>Collapse</RailLabel>
          </button>
        </RailTip>
      </div>
    </nav>
  );
}
