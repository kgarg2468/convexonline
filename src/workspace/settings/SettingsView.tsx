import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { InnDetail, IntegrationStatus, Viewer } from "../types";
import { Button } from "@/components/ui/button";
import { ExternalLink, Notice } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { LIVE_MAIL_REASON } from "../lib/format";
import { Chip, Hint } from "../inbox/primitives";
import { TeamSettings } from "./TeamSettings";
import { InnWebsiteEditor } from "./InnWebsiteEditor";
import { ActionRow, KeyValue, KeyValueList, Row, RowList, SettingsSection } from "./primitives";

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
    <div className="w-full max-w-[760px]">
      <SettingsSection
        id="fd-settings-property"
        title="Property"
        description="These values come from the inn record. Editing them is not available yet."
      >
        <KeyValueList>
          <KeyValue term="Name">{inn.name}</KeyValue>
          <KeyValue term="Website">
            <ExternalLink href={inn.siteUrl}>{inn.siteUrl}</ExternalLink>
          </KeyValue>
          <KeyValue term="Time zone">{inn.timezone}</KeyValue>
          <KeyValue term="Guest address">
            {inn.inboxAddress ?? provisioned ?? (
              <span className="text-ink-2">
                {inn.isDemo
                  ? "None. Demo inns never receive or send real email."
                  : inboxConfigured
                    ? "An inbox is bound, but its address is not stored yet."
                    : "Not set up yet."}
              </span>
            )}
          </KeyValue>
          <KeyValue term="Workspace">
            {inn.isDemo ? <Chip tone="warning">Demo</Chip> : <Chip tone="success">Live property</Chip>}
          </KeyValue>
        </KeyValueList>
      </SettingsSection>

      {/* Only inns with a hosted website document render anything here. The
          owner-only query is requested solely for a real (non-anonymous) owner;
          everyone else reads the member view. Demo inns never have a site. */}
      {!inn.isDemo ? (
        <InnWebsiteEditor key={inn._id} innId={inn._id} canEdit={role === "owner" && !viewer.isAnonymous} />
      ) : null}

      <SettingsSection id="fd-settings-inbox" title="Guest inbox">
        {inn.isDemo ? (
          <Hint>Demo inns have no inbox. Use “Simulate a guest inquiry” in the Inbox instead.</Hint>
        ) : inboxConfigured ? (
          integrations === undefined ? (
            <Hint>Checking whether the inbox is subscribed to this deployment…</Hint>
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
              {action.error ? <Notice tone="error">{action.error}</Notice> : null}
              {canRepair ? (
                <ActionRow>
                  <Button type="button" disabled={action.busy} onClick={() => void runProvision()}>
                    {action.busy ? "Connecting…" : "Finish connecting inbox"}
                  </Button>
                  <Hint>Retries the subscription for the existing inbox; no new inbox is created.</Hint>
                </ActionRow>
              ) : null}
            </>
          )
        ) : (
          <>
            <Hint>
              Front Desk creates a dedicated mailbox at the mail provider and binds it to this property. The
              server chooses the address; nothing is typed here.
            </Hint>
            {action.error ? <Notice tone="error">{action.error}</Notice> : null}
            <ActionRow>
              <Button
                type="button"
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
              </Button>
              <Hint>
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
              </Hint>
            </ActionRow>
          </>
        )}
      </SettingsSection>

      <SettingsSection id="fd-settings-sending" title="Sending email">
        {liveMail.allowed ? (
          inboxConfigured ? (
            <Notice tone="success">This account may send real replies for {inn.name} from its guest inbox.</Notice>
          ) : (
            <Notice tone="caution">This account may send real replies for {inn.name} once a guest inbox is set up.</Notice>
          )
        ) : (
          <Notice tone="caution">{LIVE_MAIL_REASON[liveMail.reason] ?? "Live mail is not available."}</Notice>
        )}
      </SettingsSection>

      <SettingsSection id="fd-settings-providers" title="Providers on this deployment">
        {integrations === undefined ? (
          <Hint>Checking…</Hint>
        ) : (
          <RowList>
            <ProviderRow name="Drafting and judging (OpenAI)" ok={integrations.openai} />
            <ProviderRow name="Website crawling (Firecrawl)" ok={integrations.firecrawl} />
            <ProviderRow name="Guest mail (AgentMail)" ok={integrations.agentmail} />
            <ProviderRow name="Inbound webhook secret" ok={integrations.webhookSecret} />
            <ProviderRow name="Inbound webhook registered" ok={integrations.webhookId} />
            <Row>
              <span>This property's inbox subscribed</span>
              {inn.isDemo ? (
                <Chip tone="muted">No live inbox (demo)</Chip>
              ) : (
                <Chip tone={inboxReady ? "success" : "warning"}>{inboxReady ? "Ready" : "Not ready"}</Chip>
              )}
            </Row>
          </RowList>
        )}
        <Hint className="max-w-[64ch]">
          Provider rows show whether each key is configured on the server; key values are never sent to the browser.
          A configured key or secret is not proof that inbound mail is flowing. The only readiness check is the last
          row: it is Ready when the server confirmed this property's inbox is subscribed to this deployment's webhook.
          {inn.isDemo ? " Demo inns have no live inbox, so nothing is subscribed." : ""}
        </Hint>
      </SettingsSection>

      <TeamSettings viewer={viewer} detail={detail} />
    </div>
  );
}

function ProviderRow({ name, ok }: { name: string; ok: boolean }) {
  return (
    <Row>
      <span>{name}</span>
      <Chip tone={ok ? "success" : "muted"}>{ok ? "Configured" : "Not configured"}</Chip>
    </Row>
  );
}
