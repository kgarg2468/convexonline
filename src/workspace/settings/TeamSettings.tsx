import { useRef, useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, Copy } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { InnDetail, Viewer } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Field, Notice } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { formatStamp } from "../lib/format";
import { inviteLink } from "../lib/invitations";
import { Chip, Hint, type ChipTone } from "../inbox/primitives";
import { ActionRow, Row, RowList, SettingsSection, SubHeading } from "./primitives";

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

const STATE_LABEL: Record<InviteState, { label: string; tone: ChipTone }> = {
  pending: { label: "Open", tone: "success" },
  used: { label: "Used", tone: "muted" },
  revoked: { label: "Revoked", tone: "danger" },
  expired: { label: "Expired", tone: "warning" },
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
    <SettingsSection id="fd-settings-team" title="Team">
      <MemberList viewer={viewer} detail={detail} canManage={canManage} />
      <Hint>
        Your role: {role}.{" "}
        {inn.isDemo
          ? "Invitations are not available on the demo property; a real property lets its owner create one-use invitation links."
          : canManage
            ? "As the owner you can invite staff with a one-use link and remove staff members."
            : "Only the property owner can invite or remove staff."}
      </Hint>
      {canManage ? <Invitations innId={inn._id} /> : null}
    </SettingsSection>
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
      <RowList aria-label="Team members">
        {staff.map((member) => {
          const isSelf = member.userId === viewer._id;
          const removable = canManage && member.role === "staff" && !isSelf;
          return (
            <Row key={member.userId}>
              <span className="min-w-0 break-words">
                {member.name}
                {isSelf ? <span className="text-ink-2"> (you)</span> : null}
              </span>
              <span className="inline-flex items-center gap-2">
                <Chip tone={member.role === "owner" ? "accentOutline" : "muted"}>{member.role}</Chip>
                {removable ? (
                  <Popover
                    open={confirming === member.userId}
                    onOpenChange={(open) => {
                      if (open) {
                        action.clear();
                        setConfirming(member.userId);
                      } else if (!action.busy) {
                        setConfirming(null);
                      }
                    }}
                  >
                    <PopoverTrigger asChild>
                      <Button type="button" variant="ghost" size="sm" className="text-[13px] text-danger-10 hover:text-danger-10" disabled={action.busy}>
                        Remove
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-80 rounded-[12px] p-4 shadow-pop ring-border-1">
                      <div role="group" aria-label={`Remove ${member.name}`} className="flex flex-col gap-3">
                        <p className="text-[13px] leading-5 text-ink-1">
                          Remove {member.name} from {inn.name}? They lose access immediately and any threads they are
                          working on are released.
                        </p>
                        <ActionRow className="gap-2">
                          <Button type="button" variant="destructive" size="sm" disabled={action.busy} onClick={() => void remove(member.userId)}>
                            {action.busy ? "Removing…" : "Yes, remove"}
                          </Button>
                          <Button type="button" variant="ghost" size="sm" className="text-ink-1" disabled={action.busy} onClick={() => setConfirming(null)}>
                            Cancel
                          </Button>
                        </ActionRow>
                      </div>
                    </PopoverContent>
                  </Popover>
                ) : null}
              </span>
            </Row>
          );
        })}
      </RowList>
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
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
    <div className="mt-3 flex flex-col gap-3 border-t border-border-1 pt-5" aria-labelledby="fd-invites-title" role="group">
      <SubHeading id="fd-invites-title">Invitations</SubHeading>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <Field
          label="Label (optional)"
          htmlFor="fd-invite-label"
          hint="A note for you, such as who the link is for. It is never shown to the recipient."
          className="max-w-[480px]"
        >
          <Input id="fd-invite-label" maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {create.error ? <Notice tone="error">{create.error}</Notice> : null}
        <ActionRow>
          <Button type="submit" disabled={create.busy}>
            {create.busy ? "Creating…" : "Create invitation link"}
          </Button>
          <Hint>One person can use each link, within seven days.</Hint>
        </ActionRow>
      </form>

      {fresh ? (
        <div
          className="flex flex-col gap-2 rounded-[10px] border border-success-10/20 bg-success-3 p-4 text-success-10 animate-in fade-in-0 slide-in-from-top-1 duration-small ease-out"
          role="status"
        >
          <p className="text-[14px] leading-5 font-semibold">
            New invitation link{fresh.label ? ` for ${fresh.label}` : ""}. Copy it now: it is shown only once.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={linkInput}
              className="min-w-0 flex-1 bg-white font-mono text-[13px] text-ink-1 md:text-[13px]"
              aria-label="Invitation link"
              readOnly
              value={fresh.link}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" className="shrink-0 bg-white text-ink-1" onClick={() => void copy()}>
              {copied === "done" ? <Check data-icon="inline-start" aria-hidden="true" /> : <Copy data-icon="inline-start" aria-hidden="true" />}
              {copied === "done" ? "Copied" : "Copy link"}
            </Button>
          </div>
          <p className="text-[13px] leading-5">
            {copied === "failed"
              ? "The browser did not allow copying. The link is selected above; copy it by hand."
              : `Expires ${formatStamp(fresh.expiresAt)}. Send it to the person you are inviting; anyone who opens it and signs in can join.`}
          </p>
        </div>
      ) : null}

      {revoke.error ? <Notice tone="error">{revoke.error}</Notice> : null}

      {invites === undefined ? (
        <Hint>Loading invitations…</Hint>
      ) : invites.length === 0 ? (
        <Hint>No invitations yet.</Hint>
      ) : (
        <RowList aria-label="Invitations">
          {invites.map((invite) => {
            const state = STATE_LABEL[invite.state];
            return (
              <Row key={invite._id} className="flex-nowrap items-start">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="break-words">{invite.label ?? <span className="text-ink-2">No label</span>}</span>
                    <Chip tone={state.tone}>{state.label}</Chip>
                  </span>
                  <span className="text-[12px] leading-4 text-ink-3 tabular-nums">
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-[13px] text-danger-10 hover:text-danger-10"
                    disabled={revoke.busy}
                    aria-label={`Revoke invitation${invite.label ? ` ${invite.label}` : ""}`}
                    onClick={() => void revoke.run(() => revokeInvite({ inviteId: invite._id }))}
                  >
                    Revoke
                  </Button>
                ) : null}
              </Row>
            );
          })}
        </RowList>
      )}
      <Hint>Links are never stored or listed here. Front Desk does not send invitation email; share the link yourself.</Hint>
    </div>
  );
}
