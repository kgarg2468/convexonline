import { Skeleton } from "@/components/ui/skeleton";
import { cardClass, tileClass } from "./styles";

function TileSkeleton({ tall }: { tall?: boolean }) {
  return (
    <div className={tileClass}>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-2 h-7 w-12" />
      <Skeleton className="mt-2 h-3 w-32" />
      {tall ? <Skeleton className="mt-3 h-8 w-full" /> : null}
    </div>
  );
}

/** The dashboard's geometry while `overview.summary` is on its way, so the swap to numbers does not jump. */
export function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading overview" className="@container flex max-w-[1200px] flex-col gap-6">
      <div aria-hidden="true" className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <TileSkeleton key={i} />
        ))}
      </div>
      <div aria-hidden="true">
        <Skeleton className="mb-2 h-3 w-16" />
        <div className="divide-y divide-border-1 rounded-[10px] border border-border-1 bg-white">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-10" />
              </div>
              <Skeleton className="mt-2 h-3.5 w-2/3" />
              <Skeleton className="mt-2.5 h-5 w-20 rounded-full" />
            </div>
          ))}
        </div>
      </div>
      <div aria-hidden="true" className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <TileSkeleton key={i} tall />
        ))}
      </div>
      <div aria-hidden="true" className="grid gap-3 @3xl:grid-cols-[3fr_2fr]">
        <div className={cardClass}>
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="mt-4 h-28 w-full" />
        </div>
        <div className="flex flex-col gap-3">
          <div className={cardClass}>
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="mt-3 h-16 w-full" />
          </div>
          <div className={cardClass}>
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="mt-3 h-10 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
