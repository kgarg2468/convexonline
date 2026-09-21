import type { ThreadDetail } from "../types";
import { ExternalLink, Pill } from "../lib/ui";
import { CLAIM_STATUS_LABEL, pathOf } from "../lib/format";

/**
 * Every claim the draft makes, with the verbatim quote it rests on. Page
 * claims link to the page; fact claims name the staff fact (their `url` is an
 * internal `staff:` reference, never rendered as a link).
 */
export function SourcePanel({ detail }: { detail: ThreadDetail }) {
  const { claims, facts } = detail;
  return (
    <aside className="fd-thread__side" aria-labelledby="fd-sources-title">
      <div className="fd-section">
        <p className="fd-section__title" id="fd-sources-title">
          Sources for this draft
        </p>
        {claims.length === 0 ? (
          <p className="fd-muted fd-small">
            {detail.draft ? "This draft makes no claims about the website." : "No draft yet."}
          </p>
        ) : (
          <ul className="fd-cite">
            {claims.map((c) => {
              const fact = c.source === "fact" ? facts.find((f) => f._id === c.staffFactId) ?? null : null;
              return (
                <li key={c._id} className={`fd-cite__item${c.status === "ok" ? "" : " fd-cite__item--bad"}`}>
                  <div className="fd-cite__head">
                    <span>{c.statement}</span>
                    <span className="fd-btn-row">
                      <Pill tone={c.status === "ok" ? "pine" : c.status === "corrected" ? "muted" : c.status === "needs_review" ? "caution" : "error"}>
                        {c.status === "ok"
                          ? c.verifyMethod === "strict"
                            ? "Exact"
                            : "Verified"
                          : CLAIM_STATUS_LABEL[c.status] ?? c.status}
                      </Pill>
                      {c.status === "ok" ? (
                        <Pill tone={c.currentSource ? "muted" : "caution"}>
                          {c.currentSource ? (c.source === "fact" ? "Fact current" : "Page current") : c.source === "fact" ? "Fact superseded" : "Page changed"}
                        </Pill>
                      ) : null}
                    </span>
                  </div>
                  <div className="fd-cite__quote">“{c.quote}”</div>
                  <div className="fd-small">
                    {c.source === "fact" ? (
                      <span className="fd-muted">
                        Staff fact{fact ? ` · ${fact.authorName}` : ""}
                        {fact ? ` · “${fact.question}”` : ""}
                      </span>
                    ) : (
                      <ExternalLink href={c.url}>{pathOf(c.url)}</ExternalLink>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="fd-section">
        <p className="fd-section__title">Staff facts on this thread</p>
        {facts.length === 0 ? (
          <p className="fd-muted fd-small">None yet.</p>
        ) : (
          <ul className="fd-facts">
            {facts.map((f) => (
              <li key={f._id} className="fd-fact">
                <span className="fd-fact__q">{f.question}</span>
                <span>{f.answer}</span>
                <span className="fd-fact__meta">{f.authorName}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
