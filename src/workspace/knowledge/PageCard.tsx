import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { PageSummary, RecordVersionResult } from "../types";
import { ExternalLink, Notice, Pill } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { formatStamp, pathOf, shortHash } from "../lib/format";
import { VersionPane } from "./VersionPane";

const CHANGE_LABEL = { new: "First capture", same: "Unchanged", changed: "Changed" } as const;

export function PageCard({ page }: { page: PageSummary }) {
  const submitContent = useMutation(api.pages.submitContent);
  const setWatched = useMutation(api.pages.setWatched);
  const action = useAsyncAction();
  const watchAction = useAsyncAction();
  const [showContent, setShowContent] = useState(false);
  const [editing, setEditing] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [result, setResult] = useState<RecordVersionResult | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const r = (await action.run(() => submitContent({ pageId: page._id, markdown }))) as
      | RecordVersionResult
      | undefined;
    if (r) {
      setResult(r);
      setEditing(false);
      setMarkdown("");
    }
  }

  return (
    <li className="fd-page">
      <div className="fd-page__row">
        <div style={{ minWidth: 0 }}>
          <div className="fd-page__title">
            {page.title} <Pill tone="muted">{page.kind}</Pill>
          </div>
          <div className="fd-page__meta">
            <ExternalLink href={page.url}>{pathOf(page.url)}</ExternalLink>
            <label className="fd-page__watch">
              <input
                type="checkbox"
                checked={page.watched}
                disabled={watchAction.busy}
                onChange={(e) => void watchAction.run(() => setWatched({ pageId: page._id, watched: e.target.checked }))}
              />
              {page.watched ? "Watched for changes" : "Not watched"}
            </label>
            {page.lastVersion ? (
              <span className="fd-mono">
                {shortHash(page.lastVersion.hash)} · {formatStamp(page.lastVersion.scrapedAt)} ·{" "}
                {CHANGE_LABEL[page.lastVersion.changeStatus]}
              </span>
            ) : (
              <span>No version captured yet</span>
            )}
          </div>
        </div>
        <div className="fd-page__actions">
          {page.lastVersion ? (
            <button
              type="button"
              className="fd-btn fd-btn--small"
              aria-expanded={showContent}
              onClick={() => setShowContent((s) => !s)}
            >
              {showContent ? "Hide content" : "View content"}
            </button>
          ) : null}
          <button
            type="button"
            className="fd-btn fd-btn--small"
            aria-expanded={editing}
            onClick={() => setEditing((e) => !e)}
          >
            {editing ? "Cancel" : "Paste page text"}
          </button>
        </div>
      </div>

      {watchAction.error ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="error" role="alert">
            {watchAction.error}
          </Notice>
        </div>
      ) : null}

      {showContent && page.lastVersion ? (
        <VersionPane versionId={page.lastVersion._id} label="Latest version" />
      ) : null}

      {result ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone={result.changeStatus === "changed" ? "caution" : "success"} role="status">
            {result.changeStatus === "same"
              ? "That text matches the stored version. Nothing changed."
              : result.changeStatus === "new"
                ? "First version stored."
                : `Page changed. ${result.affectedReplies} sent ${result.affectedReplies === 1 ? "reply" : "replies"} now need review; ${result.unaffectedReplies} re-checked and still true.`}
          </Notice>
        </div>
      ) : null}

      {editing ? (
        <form className="fd-page__edit" onSubmit={submit}>
          <label className="fd-field__label" htmlFor={`fd-page-md-${page._id}`}>
            Current text of this page
          </label>
          <p className="fd-field__hint" style={{ marginBottom: 6 }}>
            Paste the page as plain text or markdown. It is stored as a new version and every sent reply
            that quoted this page is re-checked against it.
          </p>
          <textarea
            id={`fd-page-md-${page._id}`}
            className="fd-textarea fd-textarea--mono"
            required
            value={markdown}
            disabled={action.busy}
            onChange={(e) => setMarkdown(e.target.value)}
          />
          {action.error ? (
            <div style={{ marginTop: 8 }}>
              <Notice tone="error" role="alert">
                {action.error}
              </Notice>
            </div>
          ) : null}
          <div className="fd-btn-row" style={{ marginTop: 10 }}>
            <button type="submit" className="fd-btn fd-btn--primary fd-btn--small" disabled={action.busy || !markdown.trim()}>
              {action.busy ? "Storing…" : "Store as new version"}
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
