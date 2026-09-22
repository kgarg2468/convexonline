import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { ChevronDown } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAsyncAction } from "../lib/hooks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { InlineNotice } from "../inbox/primitives";
import { chipSelectClass, threadMainClass, threadPadClass } from "../inbox/styles";

/**
 * Seeded examples. The demo drafter answers from the stored pages when the
 * text mentions a fixture topic (dog, check-in, cancel, breakfast, rate) and
 * asks a knowledge-gap question otherwise (see convex/demoContent.ts).
 */
const DEMO_INQUIRIES: { key: string; label: string; guestEmail: string; subject: string; text: string }[] = [
  {
    key: "dog",
    label: "Dog-friendly rooms (answered from the policies page)",
    guestEmail: "ana.costa@example.com",
    subject: "Can our dog come along?",
    text: "Hello! We'd love to bring our dog for a long weekend in November. Is that possible?",
  },
  {
    key: "checkin",
    label: "Late check-in (answered from the policies page)",
    guestEmail: "r.hale@example.com",
    subject: "Arriving late",
    text: "Our train arrives at 6:45 PM; what time does check-in close?",
  },
  {
    key: "rates",
    label: "Midweek rate (answered from the rates page)",
    guestEmail: "wen.li@example.com",
    subject: "Rate for a Tuesday night",
    text: "How much is a Garden Room on a Tuesday night in March?",
  },
  {
    key: "gap",
    label: "Something the website does not cover (becomes a knowledge gap)",
    guestEmail: "j.nakamura@example.com",
    subject: "Bicycle storage",
    text: "We are cycling the coast. Is there somewhere secure to keep two bikes overnight?",
  },
];

const labelClass = "text-[13px] leading-5 font-medium text-ink-1";
const fieldClass = "mt-1 h-8 bg-bg-1 text-[14px] text-ink-1 md:text-[14px]";

/**
 * The demo's compose pane: a synthetic guest message into the demo inn. It
 * takes the thread column's classes so it sits in the inbox frame exactly
 * where a thread would (InboxView renders it beside the queue).
 */
export function DemoInbound({
  innId,
  onCreated,
  onCancel,
}: {
  innId: Id<"inns">;
  onCreated: (threadId: Id<"threads">) => void;
  onCancel: () => void;
}) {
  const simulate = useMutation(api.demo.simulateInbound);
  const action = useAsyncAction();
  const [example, setExample] = useState(DEMO_INQUIRIES[0]!.key);
  const [guestEmail, setGuestEmail] = useState(DEMO_INQUIRIES[0]!.guestEmail);
  const [subject, setSubject] = useState(DEMO_INQUIRIES[0]!.subject);
  const [text, setText] = useState(DEMO_INQUIRIES[0]!.text);

  function pick(key: string) {
    setExample(key);
    const found = DEMO_INQUIRIES.find((e) => e.key === key);
    if (!found) return;
    setGuestEmail(found.guestEmail);
    setSubject(found.subject);
    setText(found.text);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = (await action.run(() => simulate({ innId, guestEmail, subject, text }))) as
      | { threadId: Id<"threads"> }
      | undefined;
    if (result) onCreated(result.threadId);
  }

  return (
    <section className={cn(threadMainClass, threadPadClass, "py-4 pb-10")} aria-labelledby="fd-demo-inbound-title">
      <h2 id="fd-demo-inbound-title" className="text-[18px] leading-6 font-semibold text-balance text-ink-1">
        Simulate a guest inquiry
      </h2>
      <p className="mt-1 max-w-[60ch] text-[13px] leading-5 text-ink-2">
        Creates a synthetic guest message in this demo inn only. The fixture drafter answers from the stored pages or asks you
        for the missing fact. No email is received or sent.
      </p>
      <form onSubmit={submit} className="mt-4 flex max-w-[560px] flex-col gap-3 rounded-[10px] border border-border-1 bg-white p-4">
        <div>
          <label className={labelClass} htmlFor="fd-demo-example">
            Start from an example
          </label>
          <span className="relative mt-1 flex">
            <select
              id="fd-demo-example"
              value={example}
              onChange={(e) => pick(e.target.value)}
              className={cn(chipSelectClass, "h-8 w-full max-w-full truncate rounded-lg pr-8 pl-3 font-normal")}
            >
              {DEMO_INQUIRIES.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.label}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          </span>
        </div>
        <div>
          <label className={labelClass} htmlFor="fd-demo-email">
            Guest email
          </label>
          <Input
            id="fd-demo-email"
            type="email"
            required
            maxLength={200}
            value={guestEmail}
            onChange={(e) => setGuestEmail(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="fd-demo-subject">
            Subject
          </label>
          <Input id="fd-demo-subject" required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} className={fieldClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor="fd-demo-text">
            Message
          </label>
          <Textarea
            id="fd-demo-text"
            required
            maxLength={5000}
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-1 min-h-24 resize-y bg-bg-1 px-3 py-2 text-[14px] leading-[1.55] text-ink-1 md:text-[14px]"
          />
        </div>
        {action.error ? <InlineNotice tone="error">{action.error}</InlineNotice> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" className="text-[13px]" disabled={action.busy || !text.trim()}>
            {action.busy ? "Creating…" : "Create demo inquiry"}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="text-[13px] text-ink-2" disabled={action.busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
