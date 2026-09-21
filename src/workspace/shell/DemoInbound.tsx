import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Field, Notice } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";

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
    <section className="fd-thread__main" aria-labelledby="fd-demo-inbound-title">
      <h2 id="fd-demo-inbound-title" className="fd-h2">
        Simulate a guest inquiry
      </h2>
      <p className="fd-lede">
        Creates a synthetic guest message in this demo inn only. The fixture drafter answers from the stored pages
        or asks you for the missing fact. No email is received or sent.
      </p>
      <form onSubmit={submit} className="fd-card">
        <Field label="Start from an example" htmlFor="fd-demo-example">
          <select id="fd-demo-example" className="fd-select" value={example} onChange={(e) => pick(e.target.value)}>
            {DEMO_INQUIRIES.map((e) => (
              <option key={e.key} value={e.key}>
                {e.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Guest email" htmlFor="fd-demo-email">
          <input
            id="fd-demo-email"
            className="fd-input"
            type="email"
            required
            maxLength={200}
            value={guestEmail}
            onChange={(e) => setGuestEmail(e.target.value)}
          />
        </Field>
        <Field label="Subject" htmlFor="fd-demo-subject">
          <input id="fd-demo-subject" className="fd-input" required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message" htmlFor="fd-demo-text">
          <textarea
            id="fd-demo-text"
            className="fd-textarea"
            required
            maxLength={5000}
            style={{ minHeight: 100 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        {action.error ? <Notice tone="error">{action.error}</Notice> : null}
        <div className="fd-btn-row" style={{ marginTop: 10 }}>
          <button type="submit" className="fd-btn fd-btn--primary" disabled={action.busy || !text.trim()}>
            {action.busy ? "Creating…" : "Create demo inquiry"}
          </button>
          <button type="button" className="fd-btn fd-btn--quiet" disabled={action.busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
