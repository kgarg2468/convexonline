import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { HEARTBEAT_INTERVAL_MS } from "../../../convex/lib/presenceTiming";

/**
 * "Who else has this thread open" — distinct from the claim lock, which says
 * who may act on it. Mount one per open thread and per signed-in user (the
 * parent keys on both), so every mount is its own presence session: it
 * heartbeats at once, then every interval, and simply stops when unmounted or
 * hidden. The server drops a silent session after its TTL; there is no
 * explicit leave.
 */
export function ThreadPresence({ threadId }: { threadId: Id<"threads"> }) {
  const [clientSessionId] = useState(newSessionId);
  const [unavailable, setUnavailable] = useState(false);
  const heartbeat = useMutation(api.presence.heartbeat);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const beat = () => {
      if (stopped) return;
      heartbeat({ threadId, clientSessionId }).catch(() => {
        // Access revoked, offline, or the component is missing: go quiet
        // rather than retrying forever. The list query reports on its own.
        stopped = true;
        stop();
        setUnavailable(true);
      });
    };
    const start = () => {
      if (stopped || timer !== null) return;
      beat();
      timer = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [heartbeat, threadId, clientSessionId]);

  const viewers = useQuery(api.presence.list, unavailable ? "skip" : { threadId });

  if (unavailable) {
    return <div className="fd-presence fd-presence--off">Presence unavailable.</div>;
  }
  if (viewers === undefined) return null;

  const others = viewers.filter((v) => !v.isYou);
  return (
    <div className="fd-presence" aria-live="polite">
      <span className="fd-presence__dot" aria-hidden="true" />
      {others.length === 0 ? (
        <span>Only you are viewing this thread.</span>
      ) : (
        <span>
          Viewing now: <strong>You</strong>
          {others.map((v) => (
            <span key={v.userId}>
              , <strong>{v.name}</strong>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** A fresh random id for this mount; the server namespaces it under the thread and user. */
function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
