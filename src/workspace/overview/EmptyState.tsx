import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Empty state: status, then what it means. Never apologises, never a fake zero. */
export function EmptyState({ title, className, children }: { title: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("rounded-[10px] border border-dashed border-border-2 px-5 py-6 text-center", className)}>
      <p className="text-[14px] leading-5 font-semibold text-ink-1">{title}</p>
      {children ? <p className="mt-1 text-[13px] leading-5 text-ink-2">{children}</p> : null}
    </div>
  );
}
