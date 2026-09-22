import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { ClipboardPaste, ExternalLink } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { PageSummary, RecordVersionResult } from "../types";
import { useAsyncAction } from "../lib/hooks";
import { formatStamp, pathOf, shortHash } from "../lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Chip, Hint, InlineNotice } from "../inbox/primitives";
import { ContentSheet } from "./ContentSheet";
import { WatchSwitch } from "./WatchSwitch";
import { CHANGE_STATUS, metaClass, pageGridClass, rowEnterClass } from "./styles";

/**
 * One row of the page table (design-spec §4.4): title + kind chip | path |
 * watched switch | hash · captured · change chip | actions. "Paste page text"
 * unfolds a form under the row; the stored result and any error stay under the
 * row too, so the table itself never reflows.
 */
export function PageRow({ page }: { page: PageSummary }) {
  const submitContent = useMutation(api.pages.submitContent);
  const setWatched = useMutation(api.pages.setWatched);
  const action = useAsyncAction();
  const watchAction = useAsyncAction();
  const [editing, setEditing] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [result, setResult] = useState<RecordVersionResult | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const r = (await action.run(() => submitContent({ pageId: page._id, markdown }))) as RecordVersionResult | undefined;
    if (r) {
      setResult(r);
      setEditing(false);
      setMarkdown("");
    }
  }

  const version = page.lastVersion;
  const below = watchAction.error || result || editing;

  return (
    <li className={cn(rowEnterClass, "border-b border-border-1 last:border-b-0")}>
      <div className={pageGridClass}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[14px] leading-5 font-medium text-ink-1">{page.title}</span>
          <Chip tone="muted">{page.kind}</Chip>
        </div>
        <a
          href={page.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-w-0 max-w-full items-center gap-1 self-start text-[13px] leading-5 text-accent-10 underline-offset-2 hover:underline min-[901px]:self-center"
        >
          <span className="truncate">{pathOf(page.url)}</span>
          <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-ink-3" />
        </a>
        <div className="flex items-center min-[901px]:justify-center">
          <WatchSwitch
            id={`fd-page-watch-${page._id}`}
            checked={page.watched}
            disabled={watchAction.busy}
            labelHidden
            onChange={(checked) => void watchAction.run(() => setWatched({ pageId: page._id, watched: checked }))}
          />
        </div>
        <div className={cn(metaClass, "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1")}>
          {version ? (
            <>
              <span className="font-mono">{shortHash(version.hash)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatStamp(version.scrapedAt)}</span>
              <span aria-hidden="true">·</span>
              <Chip tone={CHANGE_STATUS[version.changeStatus].tone}>{CHANGE_STATUS[version.changeStatus].label}</Chip>
            </>
          ) : (
            <span>No version captured yet</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 min-[901px]:justify-end">
          {version ? <ContentSheet page={page} version={version} /> : null}
          <Button type="button" variant="outline" size="sm" className="text-[13px]" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
            {editing ? null : <ClipboardPaste data-icon="inline-start" aria-hidden="true" className="text-ink-3" />}
            {editing ? "Cancel" : "Paste page text"}
          </Button>
        </div>
      </div>

      {below ? (
        <div className="flex flex-col gap-2.5 px-4 pb-3">
          {watchAction.error ? <InlineNotice tone="error">{watchAction.error}</InlineNotice> : null}
          {result ? (
            <InlineNotice tone={result.changeStatus === "changed" ? "caution" : "success"}>
              {result.changeStatus === "same"
                ? "That text matches the stored version. Nothing changed."
                : result.changeStatus === "new"
                  ? "First version stored."
                  : `Page changed. ${result.affectedReplies} sent ${result.affectedReplies === 1 ? "reply" : "replies"} now need review; ${result.unaffectedReplies} re-checked and still true.`}
            </InlineNotice>
          ) : null}
          {editing ? (
            <form
              onSubmit={submit}
              className="flex flex-col gap-2 rounded-md bg-bg-2 p-3 transition-[opacity,translate] duration-small ease-out starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0"
            >
              <label className="text-[13px] leading-5 font-medium text-ink-1" htmlFor={`fd-page-md-${page._id}`}>
                Current text of this page
              </label>
              <Hint className="-mt-1">
                Paste the page as plain text or markdown. It is stored as a new version and every sent reply that quoted this page is
                re-checked against it.
              </Hint>
              <Textarea
                id={`fd-page-md-${page._id}`}
                required
                rows={8}
                value={markdown}
                disabled={action.busy}
                onChange={(e) => setMarkdown(e.target.value)}
                className="min-h-40 resize-y bg-white px-3 py-2 font-mono text-[12.5px] leading-[1.5] text-ink-1 md:text-[12.5px]"
              />
              {action.error ? <InlineNotice tone="error">{action.error}</InlineNotice> : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" size="sm" className="text-[13px]" disabled={action.busy || !markdown.trim()}>
                  {action.busy ? "Storing…" : "Store as new version"}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
