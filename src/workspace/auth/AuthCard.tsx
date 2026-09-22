import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Mark } from "../lib/Mark";

/**
 * The one card every signed-out or not-yet-in-a-property screen uses
 * (design-spec §4.6): centred on bg-2, 420px wide, wordmark first, no hero
 * copy. Sign-in, the invitation gate and the inn picker all render inside it.
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg-2 px-4 py-6 min-[600px]:p-6">
      <div className="w-full max-w-[420px]">{children}</div>
    </div>
  );
}

export function AuthCard({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-5 rounded-[10px] border border-border-1 bg-white px-5 py-6 min-[600px]:p-7", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2.5 text-ink-1">
      <Mark size={26} />
      <span className="font-serif text-[20px] leading-6 font-medium">Front Desk</span>
    </div>
  );
}

/** A hairline with an optional word in the middle ("or"). */
export function OrDivider({ children }: { children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[12px] leading-4 text-ink-3" aria-hidden={children ? undefined : true}>
      <span className="h-px flex-1 bg-border-1" />
      {children ? <span>{children}</span> : null}
      <span className="h-px flex-1 bg-border-1" />
    </div>
  );
}

/** 13px secondary copy inside the card. */
export function CardText({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn("text-[13px] leading-5 text-ink-2", className)}>{children}</p>;
}
