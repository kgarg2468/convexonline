import { useState } from "react";
import { useQuery } from "convex/react";
import { ChevronDown } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PageSummary, RecordVersionResult } from "../types";
import { VersionPane } from "../knowledge/VersionPane";
import { useIsNarrow } from "../lib/hooks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { demoChangeNotice, type DemoPolicy } from "./useDemoPolicy";

/**
 * The demo's scripted website edit. The mutation and its status live in the
 * workspace's `useDemoPolicy` instance (`demo`, shared with the command
 * palette); this is the control.
 *
 * `variant="compact"` is the header control. `variant="hero"` is the
 * zero-state panel on the review screen: it explains what the edit will do
 * and lets the visitor read the page as it is now before anything changes.
 *
 * The result notice is controlled by the parent (`last` / `onResult`): the
 * hero unmounts as soon as corrections exist, so the sentence has to live in
 * a component that survives that swap.
 */
export function DemoActions({
  innId,
  demo,
  last,
  onResult,
  variant = "compact",
}: {
  innId: Id<"inns">;
  demo: DemoPolicy;
  last: RecordVersionResult | null;
  onResult: (result: RecordVersionResult) => void;
  variant?: "compact" | "hero";
}) {
  const narrow = useIsNarrow();

  async function run() {
    const r = await demo.run();
    if (r) onResult(r);
  }

  // In the 56px header the sentence truncates rather than wrapping; in the
  // narrow strip and the review page it may take its own line.
  const feedbackClass = cn("fd-small min-w-0", variant === "compact" && !narrow && "truncate");
  const feedback = demo.error ? (
    <span className={feedbackClass} role="alert" style={{ color: "var(--fd-error)" }}>
      {demo.error}
    </span>
  ) : last ? (
    <span className={cn(feedbackClass, "fd-muted")} role="status">
      {demoChangeNotice(last)}
    </span>
  ) : null;

  // The edit is the primary action; the restore is an outline button. In the
  // header it matches the small buttons beside it; on the review page's hero
  // it is the page's one call to action and takes the default size.
  const button = (
    <Button
      type="button"
      variant={demo.changed ? "outline" : "default"}
      size={variant === "hero" ? "default" : "sm"}
      className={cn("shrink-0", variant === "hero" ? "text-[14px]" : "text-[13px]", demo.changed && "bg-white text-ink-1")}
      disabled={demo.busy || !demo.ready}
      onClick={() => void run()}
      title={demo.description}
    >
      {demo.busy ? "Updating page…" : demo.label}
    </Button>
  );

  if (variant === "compact") {
    return (
      <div className={cn("flex min-w-0 items-center justify-end gap-2", narrow && "flex-wrap")}>
        {feedback}
        {button}
      </div>
    );
  }

  return (
    <section className="fd-hero" aria-labelledby="fd-hero-title">
      <p className="fd-hero__eyebrow">Demo walkthrough</p>
      <h3 id="fd-hero-title" className="fd-hero__title">
        Nothing needs a second look yet. Change the policy page to see what happens.
      </h3>
      <p className="fd-hero__body">
        Every reply in this inbox was drafted from the inn's website and each claim is tied to the exact
        passage it quoted. When you press the button, the demo edits the policies page the way the website
        owner would:
      </p>
      <ul className="fd-hero__list">
        <li>
          the pet fee moves from <strong>$25</strong> to <strong>$40</strong> per night, limited to one dog per room,
        </li>
        <li>
          the check-in window, cancellation rule and smoking rule stay word for word the same.
        </li>
      </ul>
      <p className="fd-hero__body">
        Front Desk then re-checks every sent reply that quoted the page. The three replies that quoted the pet
        fee are listed here with what the page says now and a correction to send. The three that quoted
        untouched passages are listed as re-checked and still true. Nothing is edited until you press the button.
      </p>
      <PolicyPreview innId={innId} />
      <div className="fd-hero__actions">
        {button}
        {feedback}
      </div>
    </section>
  );
}

/** The stored policies page as it is right now, so the visitor can compare before and after. */
function PolicyPreview({ innId }: { innId: Id<"inns"> }) {
  const pages = useQuery(api.pages.list, { innId }) as PageSummary[] | undefined;
  const [open, setOpen] = useState(false);
  const policies = pages?.find((p) => p.kind === "policies");
  if (!policies?.lastVersion) return null;
  return (
    <div className="fd-version-toggle">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 text-[13px] text-ink-2"
        aria-expanded={open}
        onClick={() => setOpen((s) => !s)}
      >
        {open ? "Hide the policies page as it is now" : "Read the policies page as it is now"}
        <ChevronDown
          data-icon="inline-end"
          aria-hidden="true"
          className={cn("text-ink-3 transition-transform duration-small ease-out", open && "rotate-180")}
        />
      </Button>
      {open ? (
        <div className="fd-diff">
          <VersionPane versionId={policies.lastVersion._id} label="Policies page now" highlight="$25 per night pet fee" />
        </div>
      ) : null}
    </div>
  );
}
