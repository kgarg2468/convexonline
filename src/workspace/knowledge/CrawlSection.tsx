import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Globe } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { CrawlResult, CrawlRun } from "../types";
import { useAsyncAction, useNow } from "../lib/hooks";
import { formatStamp, formatWhen } from "../lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Chip, Hint, InlineNotice, SectionLabel } from "../inbox/primitives";
import { RUN_STATUS, metaClass, panelClass } from "./styles";

/**
 * Site ingestion for real inns as one row: label, the latest run's status
 * chip, the crawl button; under it the hint, any outcome, and the run history
 * from ingest.runs. One staff-triggered crawl per inn every 10 minutes and 6
 * per hour per user (the server enforces both). Demo inns are seeded and never
 * crawl, so their row only says so.
 */
export function CrawlSection({ innId, siteUrl, isDemo, firecrawl }: { innId: Id<"inns">; siteUrl: string; isDemo: boolean; firecrawl: boolean | undefined }) {
  if (isDemo) {
    return (
      <section aria-labelledby="fd-crawl-title" className={cn(panelClass, "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3")}>
        <SectionLabel id="fd-crawl-title" as="h3">
          Website crawl
        </SectionLabel>
        <Chip tone="muted">Seeded</Chip>
        <p className="min-w-0 basis-full text-[13px] leading-5 text-ink-2 min-[901px]:basis-auto min-[901px]:flex-1">
          Demo pages are seeded. Nothing is crawled and no provider credits are spent.
        </p>
      </section>
    );
  }
  return <LiveCrawl innId={innId} siteUrl={siteUrl} firecrawl={firecrawl} />;
}

function LiveCrawl({ innId, siteUrl, firecrawl }: { innId: Id<"inns">; siteUrl: string; firecrawl: boolean | undefined }) {
  const runs = useQuery(api.ingest.runs, { innId }) as CrawlRun[] | undefined;
  const crawl = useAction(api.ingest.crawlSite);
  const action = useAsyncAction();
  const [last, setLast] = useState<CrawlResult | null>(null);
  const now = useNow(15_000);
  const running = runs?.some((r) => r.status === "running") ?? false;
  const latest = runs?.[0];

  async function run() {
    const r = (await action.run(() => crawl({ innId }))) as CrawlResult | undefined;
    if (r) setLast(r);
  }

  return (
    <section aria-labelledby="fd-crawl-title" className={panelClass}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <SectionLabel id="fd-crawl-title" as="h3">
          Website crawl
        </SectionLabel>
        {runs === undefined ? null : latest ? (
          <Chip tone={RUN_STATUS[latest.status].tone}>{RUN_STATUS[latest.status].label}</Chip>
        ) : (
          <p className="text-[13px] leading-5 text-ink-2">No crawl has run yet.</p>
        )}
        {latest ? (
          <p className={cn(metaClass, "min-w-0 truncate")}>
            {latest.trigger === "cron" ? "Scheduled re-check" : "Staff crawl"} · started {formatWhen(latest.startedAt, now)}
          </p>
        ) : null}
        <Button
          type="button"
          size="sm"
          className="ml-auto text-[13px]"
          disabled={action.busy || running || firecrawl === false}
          onClick={() => void run()}
        >
          <Globe data-icon="inline-start" aria-hidden="true" />
          {action.busy || running ? "Crawling…" : "Crawl the website"}
        </Button>
      </div>
      <div className="flex flex-col gap-2 border-t border-border-1 px-4 py-3">
        <Hint>
          Maps {siteUrl} and stores up to 10 pages (policies, rooms, rates and FAQ first). Sent replies that quoted a changed page are
          re-checked. One crawl per property every 10 minutes.
          {firecrawl === false ? " Crawling is not configured on this deployment." : ""}
        </Hint>
        {action.error ? <InlineNotice tone="error">{action.error}</InlineNotice> : null}
        {last ? (
          <InlineNotice tone={last.affectedClaims > 0 ? "caution" : "success"}>
            Crawl finished: {last.pagesStored} {last.pagesStored === 1 ? "page" : "pages"} stored, {last.pagesSkipped} skipped
            {last.affectedClaims > 0 ? `, ${last.affectedClaims} sent ${last.affectedClaims === 1 ? "claim" : "claims"} now need review.` : "."}
          </InlineNotice>
        ) : null}
      </div>
      {runs && runs.length > 0 ? (
        <>
          <div className="flex items-baseline gap-2 border-t border-border-1 px-4 py-2">
            <SectionLabel id="fd-crawl-runs-title" as="h4">
              Run history
            </SectionLabel>
            <span className={metaClass}>
              {runs.length} {runs.length === 1 ? "run" : "runs"}
            </span>
          </div>
          <ul aria-labelledby="fd-crawl-runs-title" className="border-t border-border-1">
            {runs.map((r) => (
              <li key={r._id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border-1 px-4 py-2 last:border-b-0">
                <Chip tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Chip>
                <span className="min-w-0 text-[13px] leading-5 text-ink-1 [overflow-wrap:anywhere]">
                  {r.trigger === "cron" ? "Scheduled re-check" : "Staff crawl"} · started {formatWhen(r.startedAt, now)}
                  {r.finishedAt ? ` · finished ${formatStamp(r.finishedAt)}` : ""} · {r.pagesStored} stored, {r.pagesSkipped} skipped
                </span>
                {r.reason ? <span className={cn(metaClass, "min-w-0 [overflow-wrap:anywhere]")}>{r.reason}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
