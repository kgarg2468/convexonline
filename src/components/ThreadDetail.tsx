import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { describeError } from "../errors";

export function ThreadDetail({ threadId, innId }: { threadId: Id<"threads">; innId: Id<"inns"> }) {
  const data = useQuery(api.threads.get, { threadId });
  const viewer = useQuery(api.users.viewer);
  const claim = useMutation(api.threads.claim);
  const release = useMutation(api.threads.release);
  const editDraft = useMutation(api.drafts.edit);
  const addFact = useMutation(api.facts.add);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  if (data === undefined) return <p className="muted">Loading thread…</p>;
  const { thread, messages, draft, claims, facts, corrections } = data;
  const mine = thread.claim?.userId === viewer?._id;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function submitFact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const target = e.currentTarget;
    await run(async () => {
      await addFact({
        innId,
        threadId,
        question: draft?.gapQuestion ?? String(form.get("question") ?? ""),
        answer: String(form.get("answer") ?? ""),
        scope: form.get("scope") === "thread" ? "thread" : "general",
      });
      target.reset();
    });
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{thread.subject}</h2>
        <div className="row">
          {thread.claim ? (
            <>
              <span className="tag tag-warn">{mine ? "You have this" : `${thread.claim.name ?? "Someone"} has this`}</span>
              {mine && <button onClick={() => void run(() => release({ threadId }))}>Release</button>}
            </>
          ) : (
            <button onClick={() => void run(() => claim({ threadId }))}>Claim</button>
          )}
        </div>
      </div>
      <p className="muted">
        {thread.guestEmail}
        {thread.stay?.checkIn && ` · ${thread.stay.checkIn} → ${thread.stay.checkOut ?? "?"}`}
        {thread.stay?.party && ` · party of ${thread.stay.party}`}
        {thread.stay && ` · ${thread.stay.status}`}
      </p>
      {error && <p className="error">{error}</p>}

      <h3>Conversation</h3>
      {messages.map((m) => (
        <div key={m._id} className={`message ${m.direction}`}>
          <small className="muted">
            {m.direction === "in" ? m.from : `To ${m.to}`} · {new Date(m.at).toLocaleString()}
          </small>
          <div>{m.text}</div>
        </div>
      ))}

      {draft && (
        <>
          <h3>
            Draft <span className="tag">{draft.class.replaceAll("_", " ")}</span>
            <span className="tag">{draft.status.replace("_", " ")}</span>
          </h3>
          {draft.abstain ? (
            <div className="panel">
              <p>
                <strong>Knowledge gap:</strong> {draft.gapQuestion}
              </p>
              <form onSubmit={submitFact}>
                <label>
                  Your answer
                  <textarea name="answer" required rows={3} />
                </label>
                <label>
                  Scope
                  <select name="scope" defaultValue="general">
                    <option value="general">General (reuse for future guests)</option>
                    <option value="thread">This guest only</option>
                  </select>
                </label>
                <button type="submit" style={{ marginTop: 6 }}>
                  Save fact
                </button>
              </form>
            </div>
          ) : editing !== null ? (
            <div>
              <textarea rows={6} value={editing} onChange={(e) => setEditing(e.target.value)} />
              <div className="row">
                <button
                  onClick={() =>
                    void run(async () => {
                      await editDraft({ draftId: draft._id, answer: editing });
                      setEditing(null);
                    })
                  }
                >
                  Save
                </button>
                <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ whiteSpace: "pre-wrap" }}>{draft.answer}</p>
              {draft.status !== "sent" && (
                <button onClick={() => setEditing(draft.answer)} disabled={!mine}>
                  {mine ? "Edit draft" : "Claim to edit"}
                </button>
              )}
            </div>
          )}
          {claims.length > 0 && (
            <>
              <h4>Citations</h4>
              {claims.map((c) => (
                <div key={c._id} className="claim">
                  <div>
                    {c.statement}
                    <span className={`tag ${c.status === "ok" ? "tag-ok" : c.status === "needs_review" ? "tag-warn" : "tag-bad"}`}>
                      {c.status === "ok" ? `verified (${c.verifyMethod})` : c.status.replace("_", " ")}
                    </span>
                  </div>
                  <blockquote>“{c.quote}”</blockquote>
                  <small className="muted">{c.url}</small>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {corrections.length > 0 && (
        <>
          <h3>Corrections</h3>
          {corrections.map((c) => (
            <div key={c._id} className="claim">
              <span className="tag tag-warn">{c.status.replace("_", " ")}</span> The cited passage “{c.oldQuote}” no longer
              appears on the page.
            </div>
          ))}
        </>
      )}

      {facts.length > 0 && (
        <>
          <h3>Facts from staff</h3>
          <ul>
            {facts.map((f) => (
              <li key={f._id}>
                <strong>{f.question}</strong> — {f.answer} <small className="muted">({f.authorName})</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
