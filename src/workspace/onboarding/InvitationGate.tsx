import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Viewer } from "../types";
import { Notice, Spinner } from "../lib/ui";
import { Mark } from "../lib/Mark";
import { useAsyncAction } from "../lib/hooks";
import { formatStamp } from "../lib/format";

type Preview =
  | { state: "invalid" }
  | { state: "pending" | "used" | "revoked" | "expired"; innName: string; expiresAt: number; acceptedByYou: boolean };

/**
 * Shown to a signed-in staff account that opened an invitation link, before
 * any property is picked. Joining is always an explicit click: opening the
 * link only previews it. Every refused state is spelled out and can be
 * dismissed, which drops the token from this tab.
 */
export function InvitationGate({
  token,
  viewer,
  onJoined,
  onDismiss,
}: {
  token: string;
  viewer: Viewer;
  onJoined: (innId: Id<"inns">) => void;
  onDismiss: () => void;
}) {
  const { signOut } = useAuthActions();
  const preview = useQuery(api.teams.previewInvite, { token }) as Preview | undefined;
  const accept = useMutation(api.teams.acceptInvite);
  const action = useAsyncAction();

  async function join() {
    const result = (await action.run(() => accept({ token }))) as { innId: Id<"inns">; joined: boolean } | undefined;
    if (result) onJoined(result.innId);
  }

  const joinable = preview !== undefined && preview.state !== "invalid" && (preview.state === "pending" || preview.acceptedByYou);

  return (
    <div className="fd-center">
      <div className="fd-center__panel" aria-labelledby="fd-invite-title" role="region">
        <div className="fd-wordmark">
          <Mark size={26} />
          <span>Front Desk</span>
        </div>
        <h2 className="fd-h2" id="fd-invite-title">
          Staff invitation
        </h2>
        <p className="fd-lede">Signed in as {viewer.name ?? viewer.email ?? "staff"}.</p>

        {preview === undefined ? (
          <Spinner label="Checking the invitation" />
        ) : preview.state === "invalid" ? (
          <Notice tone="error">This invitation link is not valid. Ask the property owner for a new one.</Notice>
        ) : preview.state === "expired" ? (
          <Notice tone="error">
            The invitation to {preview.innName} expired on {formatStamp(preview.expiresAt)}. Ask the owner for a new one.
          </Notice>
        ) : preview.state === "revoked" ? (
          <Notice tone="error">The invitation to {preview.innName} was revoked by the owner.</Notice>
        ) : preview.state === "used" && !preview.acceptedByYou ? (
          <Notice tone="error">
            This invitation to {preview.innName} has already been used. Each link admits one person; ask the owner for
            your own.
          </Notice>
        ) : (
          <div className="fd-invite">
            <p className="fd-invite__lead">
              You are invited to join <strong>{preview.innName}</strong> as staff.
            </p>
            <p className="fd-muted fd-small">
              {preview.acceptedByYou
                ? "You already accepted this invitation; joining again simply opens the property."
                : `Nothing happens until you join. This link works once and expires ${formatStamp(preview.expiresAt)}.`}
            </p>
          </div>
        )}

        {action.error ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="error">{action.error}</Notice>
          </div>
        ) : null}

        <div className="fd-btn-row" style={{ marginTop: 16 }}>
          {joinable ? (
            <button type="button" className="fd-btn fd-btn--primary" disabled={action.busy} onClick={() => void join()}>
              {action.busy ? "Joining…" : `Join ${preview.innName}`}
            </button>
          ) : null}
          <button type="button" className={joinable ? "fd-btn fd-btn--quiet" : "fd-btn"} disabled={action.busy} onClick={onDismiss}>
            {joinable ? "Not now" : "Dismiss"}
          </button>
        </div>

        <div className="fd-divider" />
        <p className="fd-muted fd-small" style={{ marginBottom: 8 }}>
          Meant for a different account? The invitation stays in this tab while you switch.
        </p>
        <button type="button" className="fd-btn fd-btn--quiet fd-btn--small" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
