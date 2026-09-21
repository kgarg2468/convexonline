import { v } from "convex/values";
import { query } from "./_generated/server";
import { liveMailDecision, requireInnAccess } from "./access";
import { integrationStatus, readEnv } from "./lib/env";

/** Which providers the deployment can reach. Booleans only; never key values. */
export const status = query({
  args: { innId: v.id("inns") },
  handler: async (ctx, { innId }) => {
    const access = await requireInnAccess(ctx, innId);
    const currentWebhookId = readEnv("AGENTMAIL_WEBHOOK_ID");
    return {
      ...integrationStatus(),
      inboxConfigured: access.inn.inboxId !== undefined,
      /**
       * True only when the inn's inbox was confirmed subscribed to the webhook
       * this deployment currently uses. `webhookSecret`/`webhookId` above say
       * the deployment is configured; this says *this inn* receives mail.
       */
      inboxWebhookReady:
        access.inn.inboxId !== undefined &&
        currentWebhookId !== undefined &&
        access.inn.inboxWebhookId === currentWebhookId,
      liveMail: liveMailDecision(access),
    };
  },
});
