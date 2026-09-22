import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PageVersion } from "../types";
import { formatStamp, shortHash } from "../lib/format";
import { Spinner } from "../lib/ui";
import { cn } from "@/lib/utils";

/**
 * Loads one stored page version and renders its markdown source verbatim,
 * highlighting `highlight` (a cited quote) when it still appears. The
 * `fd-version-pane` class and the `mark` stay: the browser specs read them.
 * `className` lets a host (the knowledge content sheet) drop the boxed look.
 */
export function VersionPane({
  versionId,
  label,
  highlight,
  className,
}: {
  versionId: Id<"pageVersions">;
  label: string;
  highlight?: string;
  className?: string;
}) {
  const version = useQuery(api.pages.getVersion, { pageVersionId: versionId }) as PageVersion | undefined;
  if (version === undefined) return <Spinner label={`Loading ${label.toLowerCase()}`} />;
  const body = highlightPassage(version.markdown, highlight);
  return (
    <div className={cn("fd-version-pane", className)}>
      <div className="fd-version-pane__head">
        <strong className="fd-small">{label}</strong>
        <span className="fd-mono">
          {shortHash(version.hash)} · captured {formatStamp(version.scrapedAt)}
        </span>
      </div>
      <pre>{body}</pre>
    </div>
  );
}

function highlightPassage(markdown: string, needle: string | undefined) {
  if (!needle) return markdown;
  const index = markdown.indexOf(needle);
  if (index < 0) return markdown;
  return (
    <>
      {markdown.slice(0, index)}
      <mark>{needle}</mark>
      {markdown.slice(index + needle.length)}
    </>
  );
}
