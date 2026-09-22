import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { IntegrationStatus, PageSummary, StaffFact } from "../types";
import { Spinner } from "../lib/ui";
import { cn } from "@/lib/utils";
import { SectionLabel } from "../inbox/primitives";
import { CrawlSection } from "./CrawlSection";
import { FactsSection } from "./FactsSection";
import { PageRow } from "./PageRow";
import { pageGridClass, panelClass } from "./styles";
import { useMounted } from "./useMounted";

/** Column headings over the page table; hidden on phones, where each row stacks its cells. */
const COLUMNS = ["Page", "Path", "Watched", "Latest version"] as const;

/**
 * The knowledge view (design-spec §4.4): what replies are drafted from. The
 * header carries the site URL and the counts (KnowledgeStats); the body is the
 * crawl row, the page table and the staff facts.
 */
export function KnowledgeView({ innId, siteUrl, isDemo }: { innId: Id<"inns">; siteUrl: string; isDemo: boolean }) {
  const pages = useQuery(api.pages.list, { innId }) as PageSummary[] | undefined;
  const facts = useQuery(api.facts.list, { innId }) as StaffFact[] | undefined;
  const integrations = useQuery(api.integrations.status, { innId }) as IntegrationStatus | undefined;
  // Counts from the render that has both lists, not from this component's mount: until then only the spinner is on screen.
  const mounted = useMounted(pages !== undefined && facts !== undefined);

  if (pages === undefined || facts === undefined) return <Spinner label="Loading knowledge" />;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-[16px] leading-6 font-semibold text-balance text-ink-1">What replies are drafted from</h2>
        <p className="mt-0.5 max-w-[64ch] text-[13px] leading-5 text-ink-2">
          Pages captured from the inn's website, each with the version currently in use, plus facts staff have added that the website
          does not cover.
        </p>
      </div>

      <CrawlSection innId={innId} siteUrl={siteUrl} isDemo={isDemo} firecrawl={integrations?.firecrawl} />

      <section aria-labelledby="fd-pages-title" className={panelClass}>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <SectionLabel id="fd-pages-title" as="h3">
            Website pages
          </SectionLabel>
        </div>
        {pages.length === 0 ? (
          <div className="border-t border-border-1 px-4 py-10 text-center">
            <p className="text-[14px] leading-5 font-semibold text-ink-1">No pages captured yet</p>
            <p className="mx-auto mt-1 max-w-[52ch] text-[13px] leading-5 text-ink-2">
              The site crawl for {siteUrl} has not run. Crawl it above, or paste a page's text once a page exists.
            </p>
          </div>
        ) : (
          <>
            <div aria-hidden="true" className={cn(pageGridClass, "hidden border-t border-border-1 bg-bg-2 py-1.5 min-[901px]:grid")}>
              {COLUMNS.map((column) => (
                <span key={column} className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-ink-2 uppercase">
                  {column}
                </span>
              ))}
              <span />
            </div>
            <ul data-mounted={mounted || undefined} className="group/list border-t border-border-1">
              {pages.map((p) => (
                <PageRow key={p._id} page={p} />
              ))}
            </ul>
          </>
        )}
      </section>

      <FactsSection innId={innId} facts={facts} />
    </div>
  );
}
