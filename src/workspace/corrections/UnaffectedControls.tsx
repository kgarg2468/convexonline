import type { Id } from "../../../convex/_generated/dataModel";
import type { UnaffectedControl } from "../types";
import { ExternalLink } from "../lib/ui";
import { pathOf } from "../lib/format";

/** Sent claims re-checked against the latest page version and still true. */
export function UnaffectedControls({
  controls,
  onOpenThread,
}: {
  controls: UnaffectedControl[];
  onOpenThread: (threadId: Id<"threads">) => void;
}) {
  return (
    <ul className="fd-controls">
      {controls.map((c) => (
        <li key={c.claimId} className="fd-control">
          <span className="fd-control__check" aria-hidden="true">
            ✓
          </span>
          <div style={{ minWidth: 0 }}>
            <div>{c.statement}</div>
            <div className="fd-control__meta">
              <span>
                <button type="button" className="fd-btn fd-btn--quiet fd-btn--small" onClick={() => onOpenThread(c.threadId)}>
                  {c.subject}
                </button>
              </span>
              <span>
                still on <ExternalLink href={c.pageUrl}>{pathOf(c.pageUrl)}</ExternalLink>
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
