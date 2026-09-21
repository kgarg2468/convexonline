import type { ThreadStats } from "../types";
import { formatDuration } from "../lib/format";

/**
 * Short zone label for "today" so staff know the count follows the inn's
 * calendar day, not their browser's (e.g. "PDT", "GMT+1"). Null when the
 * zone name is unknown or unrecognised by this browser.
 */
function zoneLabel(timezone: string | undefined): string | null {
  if (!timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(
      Date.now(),
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The inbox statistics strip: replies sent today (inn-local day, decided by
 * the server), median first-response time, and the open queue. Values come
 * straight from threads.stats; nothing is computed here.
 */
export function InboxStats({ stats, timezone }: { stats: ThreadStats; timezone: string | undefined }) {
  const zone = zoneLabel(timezone);
  const median = stats.medianFirstResponseMs;
  return (
    <ul className="fd-stats" aria-label="Inbox statistics">
      <li className="fd-stats__item">
        <strong>{stats.sentToday}</strong> {plural(stats.sentToday, "reply", "replies")} today
        {zone ? <span className="fd-stats__note"> (inn time, {zone})</span> : null}
      </li>
      <li className="fd-stats__item">
        {median === null ? (
          "No first responses yet"
        ) : (
          <>
            Median first response <strong>{formatDuration(median)}</strong>
          </>
        )}
      </li>
      <li className="fd-stats__item">
        <strong>{stats.open}</strong> open
        {stats.open > 0 ? (
          <span className="fd-stats__note">
            {" "}
            ({stats.needsStaff} need you, {stats.ready} ready)
          </span>
        ) : null}
      </li>
    </ul>
  );
}
