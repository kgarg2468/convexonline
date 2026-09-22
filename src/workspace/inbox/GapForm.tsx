import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { ChevronDown } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAsyncAction } from "../lib/hooks";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Hint, InlineNotice } from "./primitives";
import { chipSelectClass } from "./styles";

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
    const id = await action.run(() => addFact({ innId, threadId, question, answer, scope }));
    if (id !== undefined) {
      setDone(true);
      setAnswer("");
    }
  }

  const disabled = !canAnswer || action.busy;

  return (
    <section aria-labelledby="fd-gap-title" className="rounded-[10px] border border-warning-10/20 bg-warning-3 p-4">
      <h3 id="fd-gap-title" className="text-[14px] leading-5 font-semibold text-ink-1">
        The website does not answer this
      </h3>
      <p className="mt-1 font-serif text-[15px] leading-[1.55] text-ink-1 italic">{question}</p>
      {done ? (
        <InlineNotice tone="success" className="mt-3 bg-white">
          {isDemo
            ? "Saved. The demo builds a new draft that cites your answer."
            : "Saved. The thread is back in drafting; a new reply will use your answer once the drafter runs."}
        </InlineNotice>
      ) : (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
          <div>
            <label className="text-[13px] leading-5 font-medium text-ink-1" htmlFor="fd-gap-answer">
              Your answer
            </label>
            <Textarea
              id="fd-gap-answer"
              required
              rows={3}
              maxLength={5000}
              value={answer}
              disabled={disabled}
              onChange={(e) => setAnswer(e.target.value)}
              className="mt-1 min-h-20 resize-y bg-white px-3 py-2 text-[14px] leading-[1.55] text-ink-1 disabled:bg-white/60 md:text-[14px]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <label className="text-[13px] leading-5 font-medium text-ink-1" htmlFor="fd-gap-scope">
              Remember this for
            </label>
            <span className="relative inline-flex">
              <select
                id="fd-gap-scope"
                value={scope}
                disabled={disabled}
                onChange={(e) => setScope(e.target.value as "thread" | "general")}
                className={chipSelectClass}
              >
                <option value="general">Every future guest</option>
                <option value="thread">This guest only</option>
              </select>
              <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-ink-3" />
            </span>
          </div>
          {action.error ? <InlineNotice tone="error">{action.error}</InlineNotice> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" className="text-[13px]" disabled={disabled || !answer.trim()}>
              {action.busy ? "Saving…" : "Save answer"}
            </Button>
            {!canAnswer ? <Hint>Take the thread to answer.</Hint> : <Hint>Saved as a staff fact; the reply is redrafted to cite it.</Hint>}
          </div>
        </form>
      )}
    </section>
  );
}
