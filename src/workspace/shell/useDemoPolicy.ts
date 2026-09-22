import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { DemoStatus, RecordVersionResult } from "../types";
import { useAsyncAction } from "../lib/hooks";

/**
 * The demo's scripted website edit, shared by the header control, the review
 * hero and the command palette: the workspace calls this once and hands the
 * result down, so busy and error state are the same everywhere and survive a
 * control unmounting (the palette closes as soon as something is picked).
 * `demo.changePolicyPage` toggles the policies page between its two stored
 * versions, so one action both makes the change and undoes it; `changed` says
 * which the next press will do.
 */
export function useDemoPolicy(innId: Id<"inns">, enabled = true) {
  const status = useQuery(api.demo.status, enabled ? { innId } : "skip") as DemoStatus | undefined;
  const change = useMutation(api.demo.changePolicyPage);
  const action = useAsyncAction();
  const { run: runAction } = action;
  const changed = status?.policyVersion === "changed";

  const run = useCallback(
    async (): Promise<RecordVersionResult | undefined> =>
      (await runAction(() => change({ innId }))) as RecordVersionResult | undefined,
    [runAction, change, innId],
  );

  return {
    /** Undefined until the first status arrives; controls stay disabled until then. */
    ready: status !== undefined,
    changed,
    busy: action.busy,
    error: action.error,
    label: changed ? "Restore original policy page" : "Change the policy page",
    description: changed
      ? "Restores the original policies page. Replies already reviewed stay reviewed."
      : "Edits the demo inn's policies page (pet fee and check-in window) as the website owner would.",
    run,
  };
}

/** What `useDemoPolicy` returns: one instance lives in the workspace and is passed to every control. */
export type DemoPolicy = ReturnType<typeof useDemoPolicy>;

/** The sentence shown after a scripted page edit; the result is owned by the workspace so it outlives the control that ran it. */
export function demoChangeNotice(last: RecordVersionResult): string {
  return last.changeStatus === "changed"
    ? `Policies page changed: ${last.affectedReplies} ${last.affectedReplies === 1 ? "reply" : "replies"} to review, ${last.unaffectedReplies} unaffected.`
    : "Policies page unchanged.";
}
