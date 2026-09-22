import { Skeleton } from "@/components/ui/skeleton";

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
 * Placeholder for the thread pane while `threads.get` is on its way: head,
 * a guest message block and a draft block. Reuses the pane's own class so
 * the padding and scrolling match the thread it stands in for.
 */
export function ThreadSkeleton({ onBack }: { onBack: (() => void) | null }) {
  return (
    <div className="fd-thread__main" role="status" aria-label="Loading thread">
      {onBack ? (
        <button type="button" className="fd-btn fd-btn--quiet fd-btn--small fd-back" onClick={onBack}>
          ← All threads
        </button>
      ) : null}
      <div aria-hidden="true">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="mt-2 h-3.5 w-1/3" />
        <Skeleton className="mt-6 h-24 w-full rounded-[10px]" />
        <Skeleton className="mt-4 h-40 w-full rounded-[10px]" />
      </div>
    </div>
  );
}
