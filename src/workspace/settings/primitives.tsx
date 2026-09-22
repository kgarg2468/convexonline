import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One settings section (design-spec §4.5): a real h2, an optional 13px
 * description, then the body. Sections stack with a hairline between them.
 */
export function SettingsSection({
  id,
  title,
  description,
  className,
  children,
  ...props
}: {
  id: string;
  title: string;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
  role?: "region";
}) {
  return (
    <section aria-labelledby={id} className={cn("border-t border-border-1 py-6 first:border-t-0 first:pt-0", className)} {...props}>
      <h2 id={id} className="text-[16px] leading-6 font-semibold tracking-[-0.01em] text-balance text-ink-1">
        {title}
      </h2>
      {description ? <p className="mt-1 max-w-[64ch] text-[13px] leading-5 text-ink-2">{description}</p> : null}
      <div className={cn("flex flex-col gap-3", description ? "mt-4" : "mt-3")}>{children}</div>
    </section>
  );
}

/** 13/600 sub-heading inside a section (invitations, member list). */
export function SubHeading({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <h3 id={id} className={cn("text-[14px] leading-5 font-semibold text-ink-1", className)}>
      {children}
    </h3>
  );
}

/** Two-column definition list: term in ink-2 on the left, value on the right; stacked under 600px. */
export function KeyValueList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("divide-y divide-border-1 rounded-[10px] border border-border-1 bg-white", className)}>{children}</dl>;
}

export function KeyValue({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-0.5 px-3 py-2.5 text-[14px] leading-5 min-[600px]:grid-cols-[168px_minmax(0,1fr)]">
      <dt className="text-ink-2">{term}</dt>
      <dd className="min-w-0 break-words text-ink-1">{children}</dd>
    </div>
  );
}

/** A hairline list whose rows are name + chip (providers) or name + actions (team). */
export function RowList({ className, children, ...props }: { className?: string; children: ReactNode; "aria-label"?: string }) {
  return (
    <ul className={cn("divide-y divide-border-1 rounded-[10px] border border-border-1 bg-white", className)} {...props}>
      {children}
    </ul>
  );
}

export function Row({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <li className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 text-[14px] leading-5 text-ink-1", className)}>
      {children}
    </li>
  );
}

/** Buttons plus a trailing hint on one line, wrapping on narrow screens. */
export function ActionRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>{children}</div>;
}
