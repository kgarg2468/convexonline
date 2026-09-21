import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { DemoStatus, PageSummary, RecordVersionResult } from "../types";
import { useAsyncAction } from "../lib/hooks";
import { VersionPane } from "../knowledge/VersionPane";

/** The sentence shown after a scripted page edit; the result is owned by the workspace so it outlives the control that ran it. */
function demoChangeNotice(last: RecordVersionResult): string {
  return last.changeStatus === "changed"
    ? `Policies page changed: ${last.affectedReplies} ${last.affectedReplies === 1 ? "reply" : "replies"} to review, ${last.unaffectedReplies} unaffected.`
    : "Policies page unchanged.";
}

/**
 * The demo's scripted website edit. `demo.changePolicyPage` toggles the
 * policies page between its two stored versions, so the same button resets
 * the demo once the change has been made.
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
  last,
  onResult,
  variant = "compact",
}: {
  innId: Id<"inns">;
  last: RecordVersionResult | null;
  onResult: (result: RecordVersionResult) => void;
  variant?: "compact" | "hero";
}) {
  const status = useQuery(api.demo.status, { innId }) as DemoStatus | undefined;
  const change = useMutation(api.demo.changePolicyPage);
  const action = useAsyncAction();
  const changed = status?.policyVersion === "changed";

  async function run() {
    const r = (await action.run(() => change({ innId }))) as RecordVersionResult | undefined;
    if (r) onResult(r);
  }

  const feedback = action.error ? (
    <span className="fd-small" role="alert" style={{ color: "var(--fd-error)" }}>
      {action.error}
    </span>
  ) : last ? (
    <span className="fd-small fd-muted" role="status">
      {demoChangeNotice(last)}
    </span>
  ) : null;

  const button = (
    <button
      type="button"
      className={`fd-btn${changed ? "" : " fd-btn--primary"}${variant === "hero" ? " fd-btn--large" : ""}`}
      disabled={action.busy || status === undefined}
      onClick={() => void run()}
      title={
        changed
          ? "Restores the original policies page. Replies already reviewed stay reviewed."
          : "Edits the demo inn's policies page (pet fee and check-in window) as the website owner would."
      }
    >
      {action.busy ? "Updating page…" : changed ? "Restore original policy page" : "Change the policy page"}
    </button>
  );

  if (variant === "compact") {
    return (
      <div className="fd-header__actions">
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
      <div className="fd-btn-row" style={{ marginTop: 18 }}>
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
      <button
        type="button"
        className="fd-btn fd-btn--quiet fd-btn--small"
        aria-expanded={open}
        onClick={() => setOpen((s) => !s)}
      >
        {open ? "Hide the policies page as it is now" : "Read the policies page as it is now"}
      </button>
      {open ? (
        <div className="fd-diff">
          <VersionPane versionId={policies.lastVersion._id} label="Policies page now" highlight="$25 per night pet fee" />
        </div>
      ) : null}
    </div>
  );
}
