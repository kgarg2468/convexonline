import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { StaffFact } from "../types";
import { Field, Notice } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { formatStamp } from "../lib/format";

/** General staff facts: things the website does not say that drafts may use. */
export function FactsSection({ innId, facts }: { innId: Id<"inns">; facts: StaffFact[] }) {
  const addFact = useMutation(api.facts.add);
  const action = useAsyncAction();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [open, setOpen] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const id = await action.run(() => addFact({ innId, question, answer, scope: "general" }));
    if (id !== undefined) {
      setQuestion("");
      setAnswer("");
      setOpen(false);
    }
  }

  return (
    <div className="fd-section">
      <div className="fd-btn-row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <p className="fd-section__title" style={{ margin: 0 }}>
          Staff facts
        </p>
        <button type="button" className="fd-btn fd-btn--small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Add a fact"}
        </button>
      </div>
      {open ? (
        <form className="fd-card" style={{ marginBottom: 12 }} onSubmit={submit}>
          <Field label="Question guests ask" htmlFor="fd-fact-q">
            <input id="fd-fact-q" className="fd-input" required maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} />
          </Field>
          <Field label="Answer" htmlFor="fd-fact-a" hint="Drafts may quote this as a staff-provided fact.">
            <textarea id="fd-fact-a" className="fd-textarea" style={{ minHeight: 80 }} required maxLength={5000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </Field>
          {action.error ? <Notice tone="error">{action.error}</Notice> : null}
          <div className="fd-btn-row" style={{ marginTop: 8 }}>
            <button type="submit" className="fd-btn fd-btn--primary" disabled={action.busy || !question.trim() || !answer.trim()}>
              {action.busy ? "Saving…" : "Save fact"}
            </button>
          </div>
        </form>
      ) : null}
      {facts.length === 0 ? (
        <p className="fd-muted fd-small">No staff facts yet. Gap questions answered from a thread with “every future guest” land here.</p>
      ) : (
        <ul className="fd-facts">
          {facts.map((f) => (
            <li key={f._id} className="fd-fact">
              <span className="fd-fact__q">{f.question}</span>
              <span>{f.answer}</span>
              <span className="fd-fact__meta">
                {f.authorName} · {formatStamp(f.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
