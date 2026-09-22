import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BackButton } from "./primitives";
import { threadMainClass, threadPadClass } from "./styles";

/** Eight placeholder rows with the queue row's two-line geometry, so the swap to real rows does not jump. */
export function QueueSkeleton() {
  return (
    <div role="status" aria-label="Loading threads">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex flex-col gap-0.5 border-b border-border-1 px-4 py-2.5">
          <div className="flex h-5 items-center justify-between gap-3">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-10" />
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-11/12" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Placeholder for the thread pane while `threads.get` is on its way, shaped
 * like the thread it stands in for: head (subject, chip, meta line, claim
 * line), a guest message and the draft surface. Same column classes as the
 * real pane so the swap does not jump.
 */
export function ThreadSkeleton({ onBack }: { onBack: (() => void) | null }) {
  return (
    <div className={threadMainClass} role="status" aria-label="Loading thread">
      <div className={cn(threadPadClass, "border-b border-border-1 py-2")}>
        {onBack ? <BackButton onBack={onBack} /> : null}
        <div aria-hidden="true" className="flex h-7 items-center justify-between gap-3">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div aria-hidden="true" className="mt-0.5 flex h-5 items-center">
          <Skeleton className="h-3.5 w-1/2" />
        </div>
        <div aria-hidden="true" className="mt-1 flex h-4 items-center">
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <div aria-hidden="true" className={cn(threadPadClass, "flex flex-col gap-4 pt-4")}>
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-24 w-full max-w-[68ch]" />
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    </div>
  );
}
