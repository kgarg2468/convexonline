import type { ReactNode } from "react";
import type { OverviewSummary } from "../types";
import { formatDuration, formatWhen, pathOf } from "../lib/format";
import { cn } from "@/lib/utils";
import { pathLinkClass, sectionHeadingClass } from "../corrections/styles";
import { wordDiff } from "../corrections/wordDiff";
import { cardClass, chartTitleClass } from "./styles";
import { plural } from "./metrics";

/** A = accent, B = secondary, everywhere (design-spec §4.1). */
type Side = "a" | "b";

const SIDE: Record<Side, { box: string; label: string; mark: string }> = {
  a: { box: "border-accent-9/30 bg-accent-2", label: "text-accent-10", mark: "bg-accent-3 text-accent-10" },
  b: { box: "border-secondary-9/30 bg-secondary-3/50", label: "text-secondary-10", mark: "bg-secondary-3 text-secondary-10" },
};

function ColumnLabel({ side, children }: { side: Side; children: ReactNode }) {
  return <p className={cn("text-[12px] leading-4 font-semibold tracking-[0.06em] uppercase", SIDE[side].label)}>{children}</p>;
}

/** One side of a comparison: a labelled column of rows, identical order on both sides; the two stack on a phone. */
function Column({ side, label, rows }: { side: Side; label: string; rows: { label: string; value: string }[] }) {
  return (
    <div className={cn("min-w-0 rounded-md border px-3 py-2", SIDE[side].box)}>
      <ColumnLabel side={side}>{label}</ColumnLabel>
      <dl className="mt-1 divide-y divide-border-1/70">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 py-1.5 text-[13px] leading-5">
            <dt className="text-ink-2">{r.label}</dt>
            <dd className={cn("shrink-0 text-ink-1 tabular-nums", side === "a" ? "font-semibold" : "font-medium")}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const ms = (v: number | null) => (v === null ? "—" : formatDuration(v));

function WeekOverWeek({ w }: { w: OverviewSummary["comparisons"]["weekOverWeek"] }) {
  const quiet =
    w.replies.a === 0 && w.replies.b === 0 && w.needsYouCreated.a === 0 && w.needsYouCreated.b === 0 && w.corrections.a === 0 && w.corrections.b === 0;
  return (
    <div className={cardClass}>
      <h3 className={chartTitleClass}>This week vs last week</h3>
      {quiet ? (
        <p className="mt-3 text-[13px] leading-5 text-ink-2">No activity in the last two weeks yet.</p>
      ) : (
        <div className="mt-3 grid gap-3 @md:grid-cols-2">
          <Column
            side="a"
            label="This week"
            rows={[
              { label: "Replies sent", value: String(w.replies.a) },
              { label: "Median first response", value: ms(w.medianFirstResponseMs.a) },
              { label: "Needed you", value: String(w.needsYouCreated.a) },
              { label: "Corrections sent", value: String(w.corrections.a) },
            ]}
          />
          <Column
            side="b"
            label="Last week"
            rows={[
              { label: "Replies sent", value: String(w.replies.b) },
              { label: "Median first response", value: ms(w.medianFirstResponseMs.b) },
              { label: "Needed you", value: String(w.needsYouCreated.b) },
              { label: "Corrections sent", value: String(w.corrections.b) },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/** A number inside the page-change sentence: ink-1, 600, tabular. */
function Count({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-ink-1 tabular-nums">{children}</strong>;
}

/**
 * The latest page change as one sentence: how many sent replies quoted the
 * page before it changed, and what became of them. The four numbers are one
 * set, not two columns, so nothing reads as a drop from one side to the other.
 */
function PageChange({ change, now }: { change: OverviewSummary["comparisons"]["latestPageChange"]; now: number }) {
  return (
    <div className={cardClass}>
      <h3 className={chartTitleClass}>Before vs after the latest page change</h3>
      {change === null ? (
        <p className="mt-3 text-[13px] leading-5 text-ink-2">
          No page has changed yet. When a page on the website changes, the replies that quoted it are compared here.
        </p>
      ) : (
        <>
          <p className="mt-0.5 truncate text-[12px] leading-4 text-ink-2">
            {change.pageTitle} · changed {formatWhen(change.changedAt, now)}
          </p>
          {/* Each figure is one unbreakable unit, so a wrap falls between items, never inside one. */}
          <p className="mt-3 text-[13px] leading-5 text-ink-2">
            <Count>{change.repliesQuotingBefore}</Count> sent {plural(change.repliesQuotingBefore, "reply", "replies")} quoted{" "}
            <a href={change.pageUrl} target="_blank" rel="noreferrer noopener" className={pathLinkClass}>
              {pathOf(change.pageUrl)}
            </a>{" "}
            before the change · <span className="whitespace-nowrap"><Count>{change.stillTrue}</Count> still true</span> ·{" "}
            <span className="whitespace-nowrap"><Count>{change.affected}</Count> affected</span> ·{" "}
            <span className="whitespace-nowrap">
              <Count>{change.correctionsSent}</Count> {plural(change.correctionsSent, "correction", "corrections")} sent
            </span>
          </p>
        </>
      )}
    </div>
  );
}

const textClass = "mt-1.5 text-[13px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-1";
const markClass = "rounded-[3px] px-0.5 [box-decoration-break:clone]";

/**
 * One edited reply: the model's draft (A) beside what staff sent (B), the
 * words that differ marked on each side with that side's colour.
 */
function DiffPair({ item, now }: { item: OverviewSummary["comparisons"]["draftedVsSent"][number]; now: number }) {
  const hunks = wordDiff(item.draftText, item.sentText);
  return (
    <li className="pt-3 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 truncate text-[13px] leading-5 font-medium text-ink-1">{item.subject || "(no subject)"}</span>
        <span className="shrink-0 text-[12px] leading-4 text-ink-3 tabular-nums">{formatWhen(item.sentAt, now)}</span>
      </div>
      <div className="mt-2 grid gap-3 @md:grid-cols-2">
        <div className={cn("min-w-0 rounded-md border px-3 py-2", SIDE.a.box)}>
          <ColumnLabel side="a">Drafted</ColumnLabel>
          <p className={textClass}>
            {hunks.map((h, i) =>
              h.kind === "same" ? (
                <span key={i}>{h.text}</span>
              ) : h.del ? (
                <span key={i} className={cn(markClass, SIDE.a.mark)}>
                  {h.del}
                </span>
              ) : null,
            )}
          </p>
        </div>
        <div className={cn("min-w-0 rounded-md border px-3 py-2", SIDE.b.box)}>
          <ColumnLabel side="b">Sent</ColumnLabel>
          <p className={textClass}>
            {hunks.map((h, i) =>
              h.kind === "same" ? (
                <span key={i}>{h.text}</span>
              ) : h.ins ? (
                <span key={i} className={cn(markClass, SIDE.b.mark)}>
                  {h.ins}
                </span>
              ) : null,
            )}
          </p>
        </div>
      </div>
    </li>
  );
}

/**
 * Drafted vs sent for the newest sent replies. Only edited replies are shown,
 * so no row needs an "edited" chip; replies sent as written are counted, not
 * repeated, and when none was edited the card says so in one line.
 */
function DraftedVsSent({ items, now }: { items: OverviewSummary["comparisons"]["draftedVsSent"]; now: number }) {
  const edited = items.filter((i) => i.edited);
  const n = items.length;
  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className={chartTitleClass}>
          Drafted vs sent{n === 0 ? "" : ` · last ${n} ${plural(n, "reply", "replies")}`}
        </h3>
        {edited.length > 0 && edited.length < n ? (
          <p className="text-[12px] leading-4 text-ink-2 tabular-nums">
            {n - edited.length} sent as written
          </p>
        ) : null}
      </div>
      {n === 0 ? (
        <p className="mt-3 text-[13px] leading-5 text-ink-2">No replies sent yet.</p>
      ) : edited.length === 0 ? (
        <p className="mt-3 text-[13px] leading-5 text-ink-2">
          Staff sent every draft as written · last {n} {plural(n, "reply", "replies")}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border-1">
          {edited.map((item) => (
            <DiffPair key={item.sentReplyId} item={item} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Comparisons (design-spec §4.1 item 5): week over week, before/after the latest page change, drafted vs sent. */
export function Comparisons({ comparisons, now }: { comparisons: OverviewSummary["comparisons"]; now: number }) {
  return (
    <section aria-labelledby="fd-overview-comparisons">
      <h2 id="fd-overview-comparisons" className={`${sectionHeadingClass} mb-2`}>
        Comparisons
      </h2>
      <div className="grid gap-3 @3xl:grid-cols-2">
        <WeekOverWeek w={comparisons.weekOverWeek} />
        <PageChange change={comparisons.latestPageChange} now={now} />
      </div>
      <div className="mt-3">
        <DraftedVsSent items={comparisons.draftedVsSent} now={now} />
      </div>
    </section>
  );
}
