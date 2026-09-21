# Front Desk walkthrough

[Open Front Desk](https://outgoing-zebra-720.convex.site). Front Desk is a shared
email workspace for independent inns. Its main demonstration starts after a
published policy changes: staff can see which previously sent replies cited the
old policy and decide whether to correct them.

## Explore without connecting an inbox

1. Choose **Open the demo workspace**. Each visitor receives a separate fictional
   inn with seeded conversations. Demo email is simulated; nothing is sent to a
   real guest and provider credentials are not needed.
2. Open a thread and inspect its answer and quoted source. Claim the thread to
   edit or send. Editing an answer invalidates its previous verification.
3. Use the demo policy-change control, then open **Policy changes**. Three sent
   replies need review and three remain supported. Counts refer to distinct
   original replies; a reply can contain several cited passages.
4. Compare what the guest was told, the old quote and the current page. Review
   the proposed correction, claim its thread, approve the exact text and send.
   Approval alone does not send an email.
5. Return to the thread to inspect the simulated correction in its history.
   Unchanged replies remain available for comparison. Larger histories load in
   pages; partial results are labeled and are not presented as a complete count.

The demo uses fixture-generated answers. It exercises the workspace and send
permission checks, but does not demonstrate live model or provider execution.
The [grounding evaluation](grounding-evaluation.md) separately reports measured
real-model behavior and limitations.

## Walk through a live fictional inn

This path requires a staff account and working provider configuration. The
hosted account currently has no capacity to provision another AgentMail inbox;
new live properties may stop at inbox setup until capacity becomes available.
The anonymous demo remains available.

1. Create a staff account and a property with **A fictional inn with a hosted
   example site**. Its four public pages and the workspace are hosted on Convex.
2. Under **Settings**, set up the guest inbox. Under **Knowledge**, crawl the
   website. Firecrawl captures the published content as versioned evidence.
3. Send an inquiry from an inbox you control. Signed AgentMail delivery creates
   the thread. OpenAI drafts against the sources, mechanical checks verify the
   quotes, and an independent model checks whether the answer is supported.
4. Inspect the draft and citations. Claim the thread and send only the answer
   you intend the guest to receive. Held answers require attention; Front Desk
   does not guess missing policies or automatically grant special approval.
5. In **Settings → Team**, create a one-use invitation for a colleague. The
   colleague signs in and explicitly joins the inn. Both staff can view a thread;
   presence shows viewers, while the claim lock determines who may act.
6. In **Settings → Public website**, change a policy such as the pet fee and save.
   Saving publishes the website; it does not rewrite the inbox's captured sources.
7. After the crawl cooldown, crawl again in **Knowledge**. Open **Policy changes**
   to inspect replies whose cited passages changed. Review the old and current
   evidence, approve a correction and send it in the existing guest thread.
8. For an eligible open stay inquiry with a sent reply, claim the thread and
   review **Follow-up email**. Approve its exact message and send time. A guest
   reply before dispatch cancels it. Cancellation cannot recall a message already
   handed to the provider, and an unknown delivery outcome is never auto-retried.

Use only inboxes you control for a demonstration. A fictional property does not
imply a room booking, payment or reservation-system integration.

## What is running where

The React frontend is served by Convex static hosting. Convex runs staff auth,
realtime queries, claims, scheduled work, tenant checks and send reservations.
Its presence, rate-limiter and aggregate components support the shared workspace.
The AgentMail component archives accepted inbound deliveries; the direct REST
adapter provisions inboxes and sends guarded replies. The Firecrawl component
maps and scrapes source pages. OpenAI drafts and independently checks answers.

See the [build log](../hackathon.md), [setup instructions](../README.md) and
[measured grounding results](grounding-evaluation.md) for implementation evidence.
