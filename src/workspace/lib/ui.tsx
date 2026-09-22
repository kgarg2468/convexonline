import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Chip } from "../inbox/primitives";
import { LEGACY_TONE } from "../inbox/styles";

const NOTICE_TONE = {
  info: "border-border-1 bg-bg-2 text-ink-1",
  caution: "border-warning-10/20 bg-warning-3 text-warning-10",
  error: "border-danger-10/20 bg-danger-3 text-danger-10",
  success: "border-success-10/20 bg-success-3 text-success-10",
} as const;

/**
 * A tinted message block. No live-region role by default: state that is simply
 * true on load should not announce itself. Pass `role="status"` where a notice
 * answers an action (invite created, page stored) and `role="alert"` for the
 * error a submit came back with. Same tones as the inbox's InlineNotice, but
 * this one may hold inline markup (the sign-in banner uses <strong>).
 */
export function Notice({
  tone = "info",
  children,
  role,
  className,
}: {
  tone?: keyof typeof NOTICE_TONE;
  children: ReactNode;
  role?: "alert" | "status";
  className?: string;
}) {
  return (
    <div
      className={cn("rounded-md border px-3 py-2 text-[13px] leading-5", NOTICE_TONE[tone], className)}
      role={role}
    >
      {children}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-3 text-[14px] text-ink-2" role="status" aria-live="polite">
      <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-accent-9 motion-reduce:animate-none" />
      <span>{label}…</span>
    </div>
  );
}

/** Empty state: what is true now, then the next action; never an apology (design-spec §5). */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-border-1 bg-bg-2 px-5 py-6 text-center">
      <p className="text-[14px] leading-5 font-semibold text-ink-1">{title}</p>
      {children ? <p className="mt-1 text-[13px] leading-5 text-ink-2">{children}</p> : null}
    </div>
  );
}

/** Legacy pill: the old tones mapped onto the chip tones (pine → success, caution → warning, …). */
export function Pill({ tone = "neutral", children }: { tone?: keyof typeof LEGACY_TONE; children: ReactNode }) {
  return <Chip tone={LEGACY_TONE[tone]}>{children}</Chip>;
}

/** Label above the control, optional 12px hint under it. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label className="text-[13px] leading-5 font-medium text-ink-1" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-[12px] leading-4 text-ink-2">{hint}</p> : null}
    </div>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      className={cn(
        "rounded-xs text-accent-10 underline decoration-accent-9/40 underline-offset-2 transition-colors duration-micro hover:decoration-accent-9 focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2 focus-visible:outline-hidden",
        className,
      )}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}
