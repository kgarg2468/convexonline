# Front Desk

**An email front desk that remembers the sources behind its answers.**

An inn changes its pet policy after staff have already answered several guests.
Front Desk traces the changed passage back to those sent replies, separates the
affected replies from those still supported, and lets staff review and send a
correction in the guest's original thread.

Guest email reaches a shared queue through AgentMail. OpenAI drafts from the
inn's Firecrawl-captured website; mechanical quote checks and an independent
model verify the answer. Missing information goes to staff. Claim locks, live
presence and invitations support a shared desk. Staff control sends and separately
approve scheduled follow-ups, which are cancelled when a guest writes back.

Convex hosts both frontend and backend, including authentication, source versions,
realtime state, send reservations and scheduled work. Its static hosting,
presence, rate-limiter and aggregate components support the workspace. The
AgentMail component archives accepted incoming deliveries, and the Firecrawl
component maps and scrapes pages. Guarded outbound mail uses AgentMail's REST API.

- [Live app](https://outgoing-zebra-720.convex.site)
- [Demo video — 2 minutes 30 seconds](https://outgoing-zebra-720.convex.site/demo.html)
- [Public repository](https://github.com/kgarg2468/convexonline)
- [Walkthrough](walkthrough.md)
- [Verification record](verification.md)
- [40-case grounding evaluation](grounding-evaluation.md)
- [Hackathon build log](../hackathon.md)

Choose **Open the demo workspace** for an isolated, simulated-mail walkthrough.
The video uses narrated captures from the actual fictional-inn provider run,
including the policy change, correction delivery and follow-up behavior. Mail
actions in that run use authenticated app calls; the website edit uses the UI.
Test inbox addresses are redacted. It is not a Gmail delivery demonstration.

This is a working hackathon prototype, not a booking or payment system. The
verification record documents held answers, the remaining Gmail check and the
provider account's inbox-capacity limit.
