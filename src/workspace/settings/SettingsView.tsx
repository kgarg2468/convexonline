import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { InnDetail, IntegrationStatus, Viewer } from "../types";
import { ExternalLink, Notice, Pill } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { LIVE_MAIL_REASON } from "../lib/format";
import { TeamSettings } from "./TeamSettings";
import { InnWebsiteEditor } from "./InnWebsiteEditor";

/** Real values only: what the server knows about this inn, its staff and its providers. */
export function SettingsView({ viewer, detail }: { viewer: Viewer; detail: InnDetail }) {
  const { inn, liveMail, role } = detail;
  const integrations = useQuery(api.integrations.status, { innId: inn._id }) as IntegrationStatus | undefined;
  const provision = useAction(api.inbox.provision);
  const action = useAsyncAction();
  const [provisioned, setProvisioned] = useState<string | null>(null);

  const inboxConfigured = integrations?.inboxConfigured ?? inn.inboxAddress !== null;
  // Readiness is the server's confirmed subscription of this inn's inbox to the
  // deployment's webhook. Configured keys never stand in for it.
  const inboxReady = integrations?.inboxWebhookReady === true;
  const canProvision = !inn.isDemo && role === "owner" && !inboxConfigured && liveMail.allowed;
  // Repair re-runs the same server action: with an inbox already bound it skips
  // creation and only completes the webhook subscription. Offered only once the
  // server has answered and confirmed the inbox is not ready, and only when the
  // deployment has a registered webhook id: without one the server action
  // throws webhook_not_configured, so there is nothing to retry from here.
  const canRepair =
    !inn.isDemo &&
    role === "owner" &&
    inboxConfigured &&
    liveMail.allowed &&
    integrations !== undefined &&
    integrations.agentmail &&
    integrations.webhookId &&
    !inboxReady;

  async function runProvision() {
    const r = (await action.run(() => provision({ innId: inn._id }))) as { inboxAddress: string } | undefined;
    if (r) setProvisioned(r.inboxAddress);
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <h2 className="fd-h2">Property</h2>
      <p className="fd-lede">These values come from the inn record. Editing them is not available yet.</p>
      <div className="fd-card fd-section">
        <dl className="fd-kv">
          <dt>Name</dt>
          <dd>{inn.name}</dd>
          <dt>Website</dt>
          <dd>
            <ExternalLink href={inn.siteUrl}>{inn.siteUrl}</ExternalLink>
          </dd>
          <dt>Time zone</dt>
          <dd>{inn.timezone}</dd>
          <dt>Guest address</dt>
          <dd>
            {inn.inboxAddress ?? provisioned ?? (
              <span className="fd-muted">
                {inn.isDemo
                  ? "None. Demo inns never receive or send real email."
                  : inboxConfigured
                    ? "An inbox is bound, but its address is not stored yet."
                    : "Not set up yet."}
              </span>
            )}
          </dd>
          <dt>Workspace</dt>
          <dd>{inn.isDemo ? <Pill tone="caution">Demo</Pill> : <Pill tone="pine">Live property</Pill>}</dd>
        </dl>
      </div>

      {/* Only inns with a hosted website document render anything here. The
          owner-only query is requested solely for a real (non-anonymous) owner;
          everyone else reads the member view. Demo inns never have a site. */}
      {!inn.isDemo ? (
        <InnWebsiteEditor key={inn._id} innId={inn._id} canEdit={role === "owner" && !viewer.isAnonymous} />
      ) : null}

      <div className="fd-section">
        <p className="fd-section__title">Guest inbox</p>
        {inn.isDemo ? (
          <p className="fd-muted fd-small">Demo inns have no inbox. Use “Simulate a guest inquiry” in the Inbox instead.</p>
        ) : inboxConfigured ? (
          integrations === undefined ? (
            <p className="fd-muted fd-small">Checking whether the inbox is subscribed to this deployment…</p>
          ) : inboxReady ? (
            <Notice tone="success">
              Inbound mail is connected: the guest inbox for {inn.name} is subscribed to this deployment's webhook, so
              guest messages arrive here.
            </Notice>
          ) : (
            <>
              <Notice tone="caution">
                An inbox is bound to {inn.name}, but it is not subscribed to this deployment's webhook. Guest mail sent
                to it will not arrive here until the subscription is repaired
                {integrations.webhookId
                  ? "."
                  : "; this deployment has no registered webhook id, so deployment setup is needed before it can be repaired here."}
              </Notice>
              {action.error ? (
                <div style={{ marginTop: 8 }}>
                  <Notice tone="error">{action.error}</Notice>
                </div>
              ) : null}
              {canRepair ? (
                <div className="fd-btn-row" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="fd-btn fd-btn--primary"
                    disabled={action.busy}
                    onClick={() => void runProvision()}
                  >
                    {action.busy ? "Connecting…" : "Finish connecting inbox"}
                  </button>
                  <span className="fd-muted fd-small">
                    Retries the subscription for the existing inbox; no new inbox is created.
                  </span>
                </div>
              ) : null}
            </>
          )
        ) : (
          <>
            <p className="fd-field__hint" style={{ marginBottom: 8 }}>
              Front Desk creates a dedicated mailbox at the mail provider and binds it to this property. The
              server chooses the address; nothing is typed here.
            </p>
            {action.error ? (
              <div style={{ marginBottom: 8 }}>
                <Notice tone="error">{action.error}</Notice>
              </div>
            ) : null}
            <div className="fd-btn-row">
              <button
                type="button"
                className="fd-btn fd-btn--primary"
                disabled={
                  !canProvision ||
                  action.busy ||
                  integrations === undefined ||
                  !integrations.agentmail ||
                  !integrations.webhookId
                }
                onClick={() => void runProvision()}
              >
                {action.busy ? "Setting up…" : "Set up a guest inbox"}
              </button>
              <span className="fd-muted fd-small">
                {role !== "owner"
                  ? "Only the property owner can set up the inbox."
                  : integrations === undefined
                    ? "Checking providers…"
                    : !integrations.agentmail
                      ? "Mail provisioning is not configured on this deployment."
                      : !integrations.webhookId
                        ? "The inbound mail webhook is not registered for this deployment yet."
                        : !liveMail.allowed
                        ? LIVE_MAIL_REASON[liveMail.reason] ?? "Live mail is not available."
                        : ""}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="fd-section">
        <p className="fd-section__title">Sending email</p>
        {liveMail.allowed ? (
          inboxConfigured ? (
            <Notice tone="success">This account may send real replies for {inn.name} from its guest inbox.</Notice>
          ) : (
            <Notice tone="caution">This account may send real replies for {inn.name} once a guest inbox is set up.</Notice>
          )
        ) : (
          <Notice tone="caution">{LIVE_MAIL_REASON[liveMail.reason] ?? "Live mail is not available."}</Notice>
        )}
      </div>

      <div className="fd-section">
        <p className="fd-section__title">Providers on this deployment</p>
        {integrations === undefined ? (
          <p className="fd-muted fd-small">Checking…</p>
        ) : (
          <ul className="fd-staff">
            <ProviderRow name="Drafting and judging (OpenAI)" ok={integrations.openai} />
            <ProviderRow name="Website crawling (Firecrawl)" ok={integrations.firecrawl} />
            <ProviderRow name="Guest mail (AgentMail)" ok={integrations.agentmail} />
            <ProviderRow name="Inbound webhook secret" ok={integrations.webhookSecret} />
            <ProviderRow name="Inbound webhook registered" ok={integrations.webhookId} />
            <li>
              <span>This property's inbox subscribed</span>
              {inn.isDemo ? (
                <Pill tone="muted">No live inbox (demo)</Pill>
              ) : (
                <Pill tone={inboxReady ? "pine" : "caution"}>{inboxReady ? "Ready" : "Not ready"}</Pill>
              )}
            </li>
          </ul>
        )}
        <p className="fd-muted fd-small" style={{ marginTop: 8 }}>
          Provider rows show whether each key is configured on the server; key values are never sent to the browser.
          A configured key or secret is not proof that inbound mail is flowing. The only readiness check is the last
          row: it is Ready when the server confirmed this property's inbox is subscribed to this deployment's webhook.
          {inn.isDemo ? " Demo inns have no live inbox, so nothing is subscribed." : ""}
        </p>
      </div>

      <TeamSettings viewer={viewer} detail={detail} />
    </div>
  );
}

function ProviderRow({ name, ok }: { name: string; ok: boolean }) {
  return (
    <li>
      <span>{name}</span>
      <Pill tone={ok ? "pine" : "muted"}>{ok ? "Configured" : "Not configured"}</Pill>
    </li>
  );
}
