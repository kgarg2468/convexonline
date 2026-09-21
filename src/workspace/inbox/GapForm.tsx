import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Field, Notice } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";

/**
 * The knowledge-gap question. Answering stores a staff fact on this thread
 * and regenerates the reply: real inns schedule the drafter, demo inns build
 * a fixture draft citing the fact (facts.add does both on the server).
 */
export function GapForm({
  innId,
  threadId,
  question,
  canAnswer,
  isDemo,
}: {
  innId: Id<"inns">;
  threadId: Id<"threads">;
  question: string;
  canAnswer: boolean;
  isDemo: boolean;
}) {
  const addFact = useMutation(api.facts.add);
  const action = useAsyncAction();
  const [answer, setAnswer] = useState("");
  const [scope, setScope] = useState<"thread" | "general">("general");
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const id = await action.run(() =>
      addFact({ innId, threadId, question, answer, scope }),
    );
    if (id !== undefined) {
      setDone(true);
      setAnswer("");
    }
  }

  return (
    <section className="fd-gap" aria-labelledby="fd-gap-title">
      <h3 id="fd-gap-title" className="fd-small" style={{ fontWeight: 600 }}>
        The website does not answer this
      </h3>
      <p className="fd-gap__q">{question}</p>
      {done ? (
        <Notice tone="success">
          {isDemo
            ? "Saved. The demo builds a new draft that cites your answer."
            : "Saved. The thread is back in drafting; a new reply will use your answer once the drafter runs."}
        </Notice>
      ) : (
        <form onSubmit={submit}>
          <Field label="Your answer" htmlFor="fd-gap-answer">
            <textarea
              id="fd-gap-answer"
              className="fd-textarea"
              style={{ minHeight: 80 }}
              required
              maxLength={5000}
              value={answer}
              disabled={!canAnswer || action.busy}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </Field>
          <Field label="Remember this for" htmlFor="fd-gap-scope">
            <select
              id="fd-gap-scope"
              className="fd-select"
              value={scope}
              disabled={!canAnswer || action.busy}
              onChange={(e) => setScope(e.target.value as "thread" | "general")}
            >
              <option value="general">Every future guest</option>
              <option value="thread">This guest only</option>
            </select>
          </Field>
          {action.error ? <Notice tone="error">{action.error}</Notice> : null}
          <div className="fd-btn-row" style={{ marginTop: 8 }}>
            <button type="submit" className="fd-btn fd-btn--primary" disabled={!canAnswer || action.busy || !answer.trim()}>
              {action.busy ? "Saving…" : "Save answer"}
            </button>
            {!canAnswer ? <span className="fd-muted fd-small">Take the thread to answer.</span> : null}
          </div>
        </form>
      )}
    </section>
  );
}
