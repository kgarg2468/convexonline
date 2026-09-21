import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { IntegrationStatus, PageSummary, StaffFact } from "../types";
import { Empty, Spinner } from "../lib/ui";
import { PageCard } from "./PageCard";
import { FactsSection } from "./FactsSection";
import { CrawlSection } from "./CrawlSection";

export function KnowledgeView({ innId, siteUrl, isDemo }: { innId: Id<"inns">; siteUrl: string; isDemo: boolean }) {
  const pages = useQuery(api.pages.list, { innId }) as PageSummary[] | undefined;
  const facts = useQuery(api.facts.list, { innId }) as StaffFact[] | undefined;
  const integrations = useQuery(api.integrations.status, { innId }) as IntegrationStatus | undefined;

  if (pages === undefined || facts === undefined) return <Spinner label="Loading knowledge" />;

  const watched = pages.filter((p) => p.watched).length;

  return (
    <div>
      <h2 className="fd-h2">What replies are drafted from</h2>
      <p className="fd-lede">
        Pages captured from the inn's website, each with the version currently in use, plus facts staff have
        added that the website does not cover.
      </p>
      <div className="fd-strip" role="status">
        <span>
          <strong>{pages.length}</strong> {pages.length === 1 ? "page" : "pages"}
        </span>
        <span>
          <strong>{watched}</strong> watched for changes
        </span>
        <span>
          <strong>{facts.length}</strong> staff {facts.length === 1 ? "fact" : "facts"}
        </span>
      </div>

      <CrawlSection innId={innId} siteUrl={siteUrl} isDemo={isDemo} firecrawl={integrations?.firecrawl} />

      <div className="fd-section">
        <p className="fd-section__title">Website pages</p>
        {pages.length === 0 ? (
          <Empty title="No pages captured yet">
            The site crawl for {siteUrl} has not run. Crawl it above, or paste a page's text once a page exists.
          </Empty>
        ) : (
          <ul className="fd-pages">
            {pages.map((p) => (
              <PageCard key={p._id} page={p} />
            ))}
          </ul>
        )}
      </div>

      <FactsSection innId={innId} facts={facts} />
    </div>
  );
}
