import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Viewer } from "../types";
import { Button } from "@/components/ui/button";
import { Notice, Spinner } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { formatStamp } from "../lib/format";
import { AuthCard, AuthScreen, CardText, OrDivider, Wordmark } from "../auth/AuthCard";

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
    <AuthScreen>
      <AuthCard aria-labelledby="fd-invite-title" role="region">
        <Wordmark />
        <div>
          <h2 className="text-[18px] leading-6 font-semibold tracking-[-0.01em] text-balance text-ink-1" id="fd-invite-title">
            Staff invitation
          </h2>
          <CardText className="mt-1">Signed in as {viewer.name ?? viewer.email ?? "staff"}.</CardText>
        </div>

        {preview === undefined ? (
          <Spinner label="Checking the invitation" />
        ) : preview.state === "invalid" ? (
          <Notice tone="error" role="alert">
            This invitation link is not valid. Ask the property owner for a new one.
          </Notice>
        ) : preview.state === "expired" ? (
          <Notice tone="error" role="alert">
            The invitation to {preview.innName} expired on {formatStamp(preview.expiresAt)}. Ask the owner for a new one.
          </Notice>
        ) : preview.state === "revoked" ? (
          <Notice tone="error" role="alert">
            The invitation to {preview.innName} was revoked by the owner.
          </Notice>
        ) : preview.state === "used" && !preview.acceptedByYou ? (
          <Notice tone="error" role="alert">
            This invitation to {preview.innName} has already been used. Each link admits one person; ask the owner for
            your own.
          </Notice>
        ) : (
          <div className="rounded-[10px] border border-accent-9/30 bg-accent-2 p-4">
            <p className="text-[15px] leading-6 text-ink-1">
              You are invited to join <strong className="font-semibold">{preview.innName}</strong> as staff.
            </p>
            <CardText className="mt-1">
              {preview.acceptedByYou
                ? "You already accepted this invitation; joining again simply opens the property."
                : `Nothing happens until you join. This link works once and expires ${formatStamp(preview.expiresAt)}.`}
            </CardText>
          </div>
        )}

        {action.error ? (
          <Notice tone="error" role="alert">
            {action.error}
          </Notice>
        ) : null}

        <div className="flex flex-col gap-2">
          {joinable ? (
            <Button type="button" size="lg" className="w-full" disabled={action.busy} onClick={() => void join()}>
              {action.busy ? "Joining…" : `Join ${preview.innName}`}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={joinable ? "ghost" : "outline"}
            size="lg"
            className="w-full text-ink-1"
            disabled={action.busy}
            onClick={onDismiss}
          >
            {joinable ? "Not now" : "Dismiss"}
          </Button>
        </div>

        <OrDivider />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardText className="min-w-0 flex-1">Meant for a different account? The invitation stays in this tab while you switch.</CardText>
          <Button type="button" variant="ghost" size="sm" className="text-[13px] text-ink-2" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </AuthCard>
    </AuthScreen>
  );
}
