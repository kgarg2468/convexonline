import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ThreadDetail } from "./ThreadDetail";
import { Corrections } from "./Corrections";
import { describeError } from "../errors";

function ago(ts: number) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function Workspace({ innId }: { innId: Id<"inns"> }) {
  const inn = useQuery(api.inns.get, { innId });
  const queue = useQuery(api.threads.queue, { innId });
  const demoStatus = useQuery(api.demo.status, { innId });
  const changePolicy = useMutation(api.demo.changePolicyPage);
  const [selected, setSelected] = useState<Id<"threads"> | null>(null);
  const [view, setView] = useState<"queue" | "corrections">("queue");
  const [error, setError] = useState<string | null>(null);

  if (inn === undefined || queue === undefined) return <p className="muted">Loading…</p>;

  const liveMail = inn.liveMail;

  return (
    <>
      <div className={`banner ${liveMail.allowed ? "banner-ok" : ""}`}>
        <strong>{inn.inn.name}</strong>
        {" · "}
        {liveMail.allowed
          ? inn.inn.inboxAddress
            ? `Live mail via ${inn.inn.inboxAddress}`
            : "Live mail: inbox not connected yet"
          : inn.inn.isDemo
            ? "Demo inn: nothing here sends real email."
            : "Live mail unavailable for this account."}
        {inn.inn.isDemo && (
          <>
            {" "}
            <button onClick={() => changePolicy({ innId }).catch((e) => setError(describeError(e)))}>
              {demoStatus?.policyVersion === "changed" ? "Revert the policy page" : "Simulate: the inn edits its policy page"}
            </button>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row" style={{ marginBottom: 8 }}>
        <button onClick={() => setView("queue")} disabled={view === "queue"}>
          Queue ({queue.length})
        </button>
        <button onClick={() => setView("corrections")} disabled={view === "corrections"}>
          Corrections
        </button>
      </div>
      {view === "corrections" ? (
        <Corrections innId={innId} onOpenThread={(id) => { setSelected(id); setView("queue"); }} />
      ) : (
        <div className="layout">
          <section className="panel">
            {queue.length === 0 && <p className="muted">No guest threads yet.</p>}
            {queue.map((t) => (
              <button
                key={t._id}
                className={`queue-item ${selected === t._id ? "active" : ""}`}
                onClick={() => setSelected(t._id)}
              >
                <div>
                  <strong>{t.subject}</strong>
                  <span className="tag">{t.status.replace("_", " ")}</span>
                  {t.claim && <span className="tag tag-warn">{t.claim.name ?? "claimed"}</span>}
                </div>
                <small>
                  {t.guestEmail} · {ago(t.lastInboundAt)}
                </small>
              </button>
            ))}
          </section>
          <section className="panel">
            {selected ? <ThreadDetail threadId={selected} innId={innId} /> : <p className="muted">Select a thread.</p>}
          </section>
        </div>
      )}
    </>
  );
}
