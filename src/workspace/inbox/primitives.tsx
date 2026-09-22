import type { ReactNode } from "react";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Colour rules for every chip in the thread pane (design-spec §0, §1): text
 * first, tinted background, semantic colours only for status. `accent` is the
 * ready tint (same as the queue's "Ready to send"); `secondary` is reserved
 * for the staff-written marker; everything else is a quiet outline.
 */
export type ChipTone = "neutral" | "muted" | "accent" | "accentOutline" | "success" | "warning" | "danger" | "secondary";

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: "border-border-1 bg-transparent text-ink-1",
  muted: "border-border-1 bg-transparent text-ink-2",
  accent: "border-transparent bg-accent-3 text-accent-10",
  accentOutline: "border-accent-9/40 bg-transparent text-accent-10",
  success: "border-transparent bg-success-3 text-success-10",
  warning: "border-transparent bg-warning-3 text-warning-10",
  danger: "border-transparent bg-danger-3 text-danger-10",
  secondary: "border-transparent bg-secondary-3 text-secondary-10",
};

export function Chip({ tone = "neutral", className, children }: { tone?: ChipTone; className?: string; children: ReactNode }) {
  return (
    <Badge variant="outline" className={cn(CHIP_TONE[tone], className)}>
      {children}
    </Badge>
  );
}

const NOTICE_TONE = {
  info: "border-border-1 bg-bg-2 text-ink-1",
  caution: "border-warning-10/20 bg-warning-3 text-warning-10",
  error: "border-danger-10/20 bg-danger-3 text-danger-10",
  success: "border-success-10/20 bg-success-3 text-success-10",
} as const;

/**
 * A one-paragraph tinted message: status by default, `role="alert"` for
 * errors so screen readers announce them. Text only inside, so specs that
 * read an alert's exact text keep working.
 */
export function InlineNotice({
  tone = "info",
  role,
  className,
  children,
}: {
  tone?: keyof typeof NOTICE_TONE;
  role?: "alert" | "status";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={role ?? (tone === "error" ? "alert" : "status")}
      className={cn("rounded-md border px-3 py-2 text-[13px] leading-5", NOTICE_TONE[tone], className)}
    >
      {children}
    </div>
  );
}

/** 12/600 uppercase section label (sources pane, delivery lists, history). */
export function SectionLabel({ id, as: Tag = "p", className, children }: { id?: string; as?: "p" | "h3" | "h4"; className?: string; children: ReactNode }) {
  return (
    <Tag id={id} className={cn("text-[12px] leading-4 font-semibold tracking-[0.06em] text-ink-2 uppercase", className)}>
      {children}
    </Tag>
  );
}

/** 13px hint line under a control or a button row. */
export function Hint({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <p id={id} className={cn("text-[13px] leading-5 text-ink-2", className)}>
      {children}
    </p>
  );
}

/**
 * The toggle of a collapsible section (delivery lists, the follow-up panel,
 * a sent draft). Its `after:` box stretches over the nearest positioned
 * ancestor so the whole header row is the hit area while the accessible name
 * stays the title alone. The chevron only turns under `motion-safe`.
 */
export function DisclosureButton({
  expanded,
  controls,
  onClick,
  className,
  children,
}: {
  expanded: boolean;
  controls: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-left outline-hidden after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2",
        className,
      )}
    >
      {children}
      <ChevronDown
        aria-hidden="true"
        className={cn("size-3.5 shrink-0 text-ink-3 ease-out motion-safe:transition-transform motion-safe:duration-small", expanded && "rotate-180")}
      />
    </button>
  );
}

/** The empty third column beside a pane that has no sources of its own (only on the three-pane layout). */
export function SourcesPlaceholder() {
  return <div aria-hidden="true" className="hidden border-l border-border-1 bg-white min-[1440px]:block" />;
}

/**
 * The thread pane when the server refused the selected thread: a stale link,
 * a malformed id, or a thread from a property the viewer cannot see. The
 * queue and the rest of the workspace stay up around it.
 */
export function ThreadUnavailable({
  className,
  onBack,
  onBackToInbox,
}: {
  className?: string;
  onBack: (() => void) | null;
  onBackToInbox: () => void;
}) {
  return (
    <div className={cn(className, "py-4")} role="region" aria-labelledby="fd-thread-unavailable-title">
      {onBack ? <BackButton onBack={onBack} /> : null}
      <div className="mx-auto max-w-[440px] pt-12 text-center">
        <h2 id="fd-thread-unavailable-title" className="text-[16px] leading-6 font-semibold text-ink-1">
          This thread could not be opened.
        </h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-2">
          The link may be out of date, or the thread belongs to a property you do not have access to. Pick a
          thread from the queue instead.
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-4 bg-white text-[13px] text-ink-1" onClick={onBackToInbox}>
          Back to inbox
        </Button>
      </div>
    </div>
  );
}

/** Phone layout only: back to the queue. The accessible name stays "All threads" (mobile spec). */
export function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-1 text-[13px] text-ink-2 max-[900px]:h-11" onClick={onBack}>
      <ArrowLeft data-icon="inline-start" aria-hidden="true" />
      All threads
    </Button>
  );
}
