import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BackButton } from "./primitives";
import { threadMainClass, threadPadClass } from "./styles";

/** Six placeholder rows with the queue row's geometry, so the swap to real rows does not jump. */
export function QueueSkeleton() {
  return (
    <div role="status" aria-label="Loading threads">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} aria-hidden="true" className="border-b border-border-1 p-3">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-10" />
          </div>
          <Skeleton className="mt-2 h-3.5 w-3/4" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-2.5 h-5 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Placeholder for the thread pane while `threads.get` is on its way, shaped
 * like the thread it stands in for: head (subject, guest line, chip), claim
 * bar, a guest message and the draft surface. Same column classes as the real
 * pane so the swap does not jump.
 */
export function ThreadSkeleton({ onBack }: { onBack: (() => void) | null }) {
  return (
    <div className={threadMainClass} role="status" aria-label="Loading thread">
      <div className={cn(threadPadClass, "border-b border-border-1 py-3")}>
        {onBack ? <BackButton onBack={onBack} /> : null}
        <div aria-hidden="true" className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="mt-2 h-3.5 w-1/3" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton aria-hidden="true" className="mt-3 h-3.5 w-1/2" />
      </div>
      <div aria-hidden="true" className={cn(threadPadClass, "flex flex-col gap-4 pt-4")}>
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-24 w-full max-w-[68ch] rounded-[10px]" />
        <Skeleton className="h-56 w-full rounded-[10px]" />
      </div>
    </div>
  );
}
