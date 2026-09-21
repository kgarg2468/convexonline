import { useRef, useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { InnDetail, Viewer } from "../types";
import { Field, Notice, Pill } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { formatStamp } from "../lib/format";
import { inviteLink } from "../lib/invitations";

type InviteState = "pending" | "used" | "revoked" | "expired";

type InviteRow = {
  _id: Id<"teamInvites">;
  label: string | null;
  state: InviteState;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByName: string | null;
  revokedAt: number | null;
};

/** The link the owner just minted. Held in component state only: the server never returns it again. */
type FreshLink = { link: string; label: string | null; expiresAt: number };

const STATE_LABEL: Record<InviteState, { label: string; tone: "pine" | "caution" | "error" | "muted" }> = {
  pending: { label: "Open", tone: "pine" },
  used: { label: "Used", tone: "muted" },
  revoked: { label: "Revoked", tone: "error" },
  expired: { label: "Expired", tone: "caution" },
};

/**
 * Who works on this property, and (for its owner) the one-use invitation
 * links that bring more staff in. Everything shown comes from the server;
 * only the freshly created link lives here, because the server returns it
 * exactly once and stores only its hash.
 */
export function TeamSettings({ viewer, detail }: { viewer: Viewer; detail: InnDetail }) {
  const { inn, role, liveMail } = detail;
  const canManage = !inn.isDemo && role === "owner" && liveMail.allowed;

  return (
    <div className="fd-section">
      <p className="fd-section__title">Team</p>
      <MemberList viewer={viewer} detail={detail} canManage={canManage} />
      <p className="fd-muted fd-small" style={{ marginTop: 8 }}>
        Your role: {role}.{" "}
        {inn.isDemo
          ? "Invitations are not available on the demo property; a real property lets its owner create one-use invitation links."
          : canManage
            ? "As the owner you can invite staff with a one-use link and remove staff members."
            : "Only the property owner can invite or remove staff."}
      </p>
      {canManage ? <Invitations innId={inn._id} /> : null}
    </div>
  );
}

function MemberList({ viewer, detail, canManage }: { viewer: Viewer; detail: InnDetail; canManage: boolean }) {
  const { inn, staff } = detail;
  const removeStaff = useMutation(api.teams.removeStaff);
  const action = useAsyncAction();
  const [confirming, setConfirming] = useState<Id<"users"> | null>(null);

  async function remove(userId: Id<"users">) {
    const done = await action.run(() => removeStaff({ innId: inn._id, userId }));
    if (done !== undefined) setConfirming(null);
  }

  return (
    <>
      <ul className="fd-staff fd-team__members" aria-label="Team members">
        {staff.map((member) => {
          const isSelf = member.userId === viewer._id;
          const removable = canManage && member.role === "staff" && !isSelf;
          const isConfirming = confirming === member.userId;
          return (
            <li key={member.userId}>
              <span>
                {member.name}
                {isSelf ? <span className="fd-muted"> (you)</span> : null}
              </span>
              <span className="fd-team__actions">
                <span className="fd-muted">{member.role}</span>
                {removable && !isConfirming ? (
                  <button
                    type="button"
                    className="fd-btn fd-btn--small fd-btn--quiet fd-btn--danger"
                    disabled={action.busy}
                    onClick={() => {
                      action.clear();
                      setConfirming(member.userId);
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </span>
              {removable && isConfirming ? (
                <div className="fd-team__confirm" role="group" aria-label={`Remove ${member.name}`}>
                  <span>
                    Remove {member.name} from {inn.name}? They lose access immediately and any threads they are
                    working on are released.
                  </span>
                  <span className="fd-btn-row">
                    <button
                      type="button"
                      className="fd-btn fd-btn--small fd-btn--danger"
                      disabled={action.busy}
                      onClick={() => void remove(member.userId)}
                    >
                      {action.busy ? "Removing…" : "Yes, remove"}
                    </button>
                    <button
                      type="button"
                      className="fd-btn fd-btn--small fd-btn--quiet"
                      disabled={action.busy}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {action.error ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="error">{action.error}</Notice>
        </div>
      ) : null}
    </>
  );
}

function Invitations({ innId }: { innId: Id<"inns"> }) {
  const invites = useQuery(api.teams.listInvites, { innId }) as InviteRow[] | undefined;
  const createInvite = useAction(api.teams.createInvite);
  const revokeInvite = useMutation(api.teams.revokeInvite);
  const create = useAsyncAction();
  const revoke = useAsyncAction();
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<FreshLink | null>(null);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = label.trim();
    const result = (await create.run(() => createInvite({ innId, label: trimmed || undefined }))) as
      | { inviteId: Id<"teamInvites">; token: string; expiresAt: number }
      | undefined;
    if (!result) return;
    setFresh({ link: inviteLink(result.token), label: trimmed || null, expiresAt: result.expiresAt });
    setCopied(null);
    setLabel("");
  }

  function selectLink() {
    const input = linkInput.current;
    if (!input) return;
    input.focus();
    input.select();
  }

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.link);
      setCopied("done");
    } catch {
      setCopied("failed");
      selectLink();
    }
  }

  return (
    <div className="fd-team__invites">
      <p className="fd-section__title" style={{ marginTop: 20 }}>
        Invitations
      </p>
      <form onSubmit={(e) => void submit(e)} className="fd-team__form">
        <Field
          label="Label (optional)"
          htmlFor="fd-invite-label"
          hint="A note for you, such as who the link is for. It is never shown to the recipient."
        >
          <input
            id="fd-invite-label"
            className="fd-input"
            maxLength={120}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        {create.error ? (
          <div style={{ marginBottom: 8 }}>
            <Notice tone="error">{create.error}</Notice>
          </div>
        ) : null}
        <div className="fd-btn-row">
          <button type="submit" className="fd-btn fd-btn--primary" disabled={create.busy}>
            {create.busy ? "Creating…" : "Create invitation link"}
          </button>
          <span className="fd-muted fd-small">One person can use each link, within seven days.</span>
        </div>
      </form>

      {fresh ? (
        <div className="fd-team__fresh" role="status">
          <p className="fd-team__fresh-title">
            New invitation link{fresh.label ? ` for ${fresh.label}` : ""}. Copy it now: it is shown only once.
          </p>
          <div className="fd-team__link">
            <input
              ref={linkInput}
              className="fd-input fd-team__link-input"
              aria-label="Invitation link"
              readOnly
              value={fresh.link}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="fd-btn" onClick={() => void copy()}>
              {copied === "done" ? "Copied" : "Copy link"}
            </button>
          </div>
          <p className="fd-muted fd-small">
            {copied === "failed"
              ? "The browser did not allow copying. The link is selected above; copy it by hand."
              : `Expires ${formatStamp(fresh.expiresAt)}. Send it to the person you are inviting; anyone who opens it and signs in can join.`}
          </p>
        </div>
      ) : null}

      {revoke.error ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="error">{revoke.error}</Notice>
        </div>
      ) : null}

      {invites === undefined ? (
        <p className="fd-muted fd-small">Loading invitations…</p>
      ) : invites.length === 0 ? (
        <p className="fd-muted fd-small">No invitations yet.</p>
      ) : (
        <ul className="fd-staff fd-team__list" aria-label="Invitations">
          {invites.map((invite) => {
            const state = STATE_LABEL[invite.state];
            return (
              <li key={invite._id}>
                <span className="fd-team__invite">
                  <span>
                    {invite.label ?? <span className="fd-muted">No label</span>}{" "}
                    <Pill tone={state.tone}>{state.label}</Pill>
                  </span>
                  <span className="fd-muted fd-small">
                    Created {formatStamp(invite.createdAt)}
                    {invite.state === "used"
                      ? ` · used${invite.usedByName ? ` by ${invite.usedByName}` : ""}${invite.usedAt ? ` ${formatStamp(invite.usedAt)}` : ""}`
                      : invite.state === "revoked"
                        ? ` · revoked${invite.revokedAt ? ` ${formatStamp(invite.revokedAt)}` : ""}`
                        : invite.state === "expired"
                          ? ` · expired ${formatStamp(invite.expiresAt)}`
                          : ` · expires ${formatStamp(invite.expiresAt)}`}
                  </span>
                </span>
                {invite.state === "pending" ? (
                  <button
                    type="button"
                    className="fd-btn fd-btn--small fd-btn--quiet fd-btn--danger"
                    disabled={revoke.busy}
                    aria-label={`Revoke invitation${invite.label ? ` ${invite.label}` : ""}`}
                    onClick={() => void revoke.run(() => revokeInvite({ inviteId: invite._id }))}
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="fd-muted fd-small" style={{ marginTop: 8 }}>
        Links are never stored or listed here. Front Desk does not send invitation email; share the link yourself.
      </p>
    </div>
  );
}
