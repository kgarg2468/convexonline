import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAsyncAction } from "../lib/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Hint, InlineNotice } from "../inbox/primitives";

/**
 * "Add a fact" as a popover form anchored to its button. Closing the popover
 * (Cancel, Escape, outside click) keeps typed text for the next open; a saved
 * fact clears it. Facts saved here are general: every future draft may use them.
 */
export function AddFactPopover({ innId }: { innId: Id<"inns"> }) {
  const addFact = useMutation(api.facts.add);
  const action = useAsyncAction();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

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
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) action.clear();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="text-[13px]">
          <Plus data-icon="inline-start" aria-hidden="true" className="text-ink-3" />
          Add a fact
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        collisionPadding={16}
        className="w-[400px] max-w-[calc(100vw-2rem)] gap-0 rounded-[12px] p-4 shadow-pop ring-border-1 duration-(--dur-small) ease-out-expo"
      >
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <label className="text-[13px] leading-5 font-medium text-ink-1" htmlFor="fd-fact-q">
              Question guests ask
            </label>
            <Input
              id="fd-fact-q"
              required
              maxLength={2000}
              value={question}
              disabled={action.busy}
              onChange={(e) => setQuestion(e.target.value)}
              className="mt-1 bg-white px-3 text-[14px] text-ink-1 md:text-[14px]"
            />
          </div>
          <div>
            <label className="text-[13px] leading-5 font-medium text-ink-1" htmlFor="fd-fact-a">
              Answer
            </label>
            <Textarea
              id="fd-fact-a"
              required
              rows={3}
              maxLength={5000}
              value={answer}
              disabled={action.busy}
              onChange={(e) => setAnswer(e.target.value)}
              className="mt-1 min-h-20 resize-y bg-white px-3 py-2 text-[14px] leading-[1.55] text-ink-1 md:text-[14px]"
            />
            <Hint className="mt-1">Drafts may quote this as a staff-provided fact.</Hint>
          </div>
          {action.error ? <InlineNotice tone="error">{action.error}</InlineNotice> : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" className="text-[13px] text-ink-2" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" className="text-[13px]" disabled={action.busy || !question.trim() || !answer.trim()}>
              {action.busy ? "Saving…" : "Save fact"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
