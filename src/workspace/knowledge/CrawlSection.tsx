import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { CrawlResult, CrawlRun } from "../types";
import { Notice, Pill } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { formatStamp, formatWhen } from "../lib/format";
import { useNow } from "../lib/hooks";

const RUN_TONE: Record<CrawlRun["status"], "neutral" | "pine" | "error"> = {
  running: "neutral",
  done: "pine",
  failed: "error",
};

/**
 * Site ingestion for real inns: one staff-triggered crawl (10-minute cooldown
 * per inn, 6 per hour per user; the server enforces both) and the last runs
 * from ingest.runs. Demo inns are seeded and never crawl.
 */
export function CrawlSection({ innId, siteUrl, isDemo, firecrawl }: { innId: Id<"inns">; siteUrl: string; isDemo: boolean; firecrawl: boolean | undefined }) {
  const runs = useQuery(api.ingest.runs, { innId }) as CrawlRun[] | undefined;
  const crawl = useAction(api.ingest.crawlSite);
  const action = useAsyncAction();
  const [last, setLast] = useState<CrawlResult | null>(null);
  const now = useNow(15_000);
  const running = runs?.some((r) => r.status === "running") ?? false;

  async function run() {
    const r = (await action.run(() => crawl({ innId }))) as CrawlResult | undefined;
    if (r) setLast(r);
  }

  if (isDemo) {
    return (
      <div className="fd-section">
        <p className="fd-section__title">Website crawl</p>
        <p className="fd-muted fd-small">Demo pages are seeded. Nothing is crawled and no provider credits are spent.</p>
      </div>
    );
  }

  return (
    <div className="fd-section">
      <div className="fd-btn-row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <p className="fd-section__title" style={{ margin: 0 }}>
          Website crawl
        </p>
        <button
          type="button"
          className="fd-btn fd-btn--small fd-btn--primary"
          disabled={action.busy || running || firecrawl === false}
          onClick={() => void run()}
        >
          {action.busy || running ? "Crawling…" : "Crawl the website"}
        </button>
      </div>
      <p className="fd-field__hint" style={{ marginBottom: 8 }}>
        Maps {siteUrl} and stores up to 10 pages (policies, rooms, rates and FAQ first). Sent replies that quoted a
        changed page are re-checked. One crawl per property every 10 minutes.
        {firecrawl === false ? " Crawling is not configured on this deployment." : ""}
      </p>
      {action.error ? (
        <div style={{ marginBottom: 8 }}>
          <Notice tone="error" role="alert">
            {action.error}
          </Notice>
        </div>
      ) : null}
      {last ? (
        <div style={{ marginBottom: 8 }}>
          <Notice tone={last.affectedClaims > 0 ? "caution" : "success"} role="status">
            Crawl finished: {last.pagesStored} {last.pagesStored === 1 ? "page" : "pages"} stored, {last.pagesSkipped} skipped
            {last.affectedClaims > 0 ? `, ${last.affectedClaims} sent ${last.affectedClaims === 1 ? "claim" : "claims"} now need review.` : "."}
          </Notice>
        </div>
      ) : null}
      {runs === undefined ? null : runs.length === 0 ? (
        <p className="fd-muted fd-small">No crawl has run yet.</p>
      ) : (
        <ul className="fd-runs">
          {runs.map((r) => (
            <li key={r._id} className="fd-runs__row">
              <Pill tone={RUN_TONE[r.status]}>{r.status === "running" ? "Running" : r.status === "done" ? "Done" : "Failed"}</Pill>
              <span className="fd-small">
                {r.trigger === "cron" ? "Scheduled re-check" : "Staff crawl"} · started {formatWhen(r.startedAt, now)}
                {r.finishedAt ? ` · finished ${formatStamp(r.finishedAt)}` : ""} · {r.pagesStored} stored, {r.pagesSkipped} skipped
              </span>
              {r.reason ? <span className="fd-small fd-muted">{r.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
