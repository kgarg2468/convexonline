import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { describeError } from "../errors";

export function Corrections({
  innId,
  onOpenThread,
}: {
  innId: Id<"inns">;
  onOpenThread: (threadId: Id<"threads">) => void;
}) {
  const corrections = useQuery(api.corrections.list, { innId });
  const controls = useQuery(api.corrections.unaffectedControls, { innId });
  const review = useMutation(api.corrections.review);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (corrections === undefined || controls === undefined) return <p className="muted">Loading…</p>;

  const pending = corrections.filter((c) => c.status === "needs_review");
  const done = corrections.filter((c) => c.status !== "needs_review");

  return (
    <div className="two-col">
      <section className="panel">
        <h2>Affected replies ({pending.length})</h2>
        {pending.length === 0 && <p className="muted">Every sent reply still matches its source.</p>}
        {error && <p className="error">{error}</p>}
        {pending.map((c) => (
          <div key={c._id} className="claim">
            <div>
              <strong>{c.subject}</strong> <small className="muted">{c.guestEmail}</small>{" "}
              <button onClick={() => onOpenThread(c.threadId)}>Open thread</button>
            </div>
            <div>{c.statement}</div>
            <div className="two-col">
              <div>
                <small className="muted">Cited then</small>
                <pre className="passage">{c.oldQuote}</pre>
              </div>
              <div>
                <small className="muted">Page now</small>
                <pre className="passage">{c.newPassage ?? "(passage removed)"}</pre>
              </div>
            </div>
            <textarea
              rows={3}
              placeholder="Correction to send in the guest's thread"
              value={drafts[c._id] ?? c.proposedText ?? ""}
              onChange={(e) => setDrafts({ ...drafts, [c._id]: e.target.value })}
            />
            <div className="row">
              <button
                onClick={() =>
                  review({ correctionId: c._id, decision: "approve", proposedText: drafts[c._id] ?? c.proposedText ?? undefined })
                    .then(() => setError(null))
                    .catch((e) => setError(describeError(e)))
                }
              >
                Approve correction
              </button>
              <button
                onClick={() =>
                  review({ correctionId: c._id, decision: "dismiss" })
                    .then(() => setError(null))
                    .catch((e) => setError(describeError(e)))
                }
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
        {done.length > 0 && (
          <>
            <h3>Reviewed</h3>
            {done.map((c) => (
              <div key={c._id} className="claim">
                <span className="tag">{c.status}</span> {c.subject}: {c.statement}
              </div>
            ))}
          </>
        )}
      </section>
      <section className="panel">
        <h2>Unaffected controls ({controls.length})</h2>
        <p className="muted">Sent claims re-checked against the latest page version and still verified.</p>
        {controls.map((c) => (
          <div key={c.claimId} className="claim">
            <div>
              <strong>{c.subject}</strong> <span className="tag tag-ok">still true</span>{" "}
              <button onClick={() => onOpenThread(c.threadId)}>Open</button>
            </div>
            <div>{c.statement}</div>
            <blockquote>“{c.quote}”</blockquote>
          </div>
        ))}
      </section>
    </div>
  );
}
