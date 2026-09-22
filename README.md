# Front Desk

Answer guest email from the inn's own sources. Know when those sources change.

Front Desk is a shared email workspace for independent inns. It drafts replies
from the property's website and staff knowledge, checks every factual claim
against the exact source passage, and keeps that connection after the message is
sent. When the website changes, Front Desk finds the guests whose replies may no
longer be true and brings those conversations back for review.

[Live app](https://outgoing-zebra-720.convex.site) ·
[2:30 demo](https://outgoing-zebra-720.convex.site/demo.html) ·
[Hackathon build log](hackathon.md) ·
[Source](https://github.com/kgarg2468/convexonline)

[![Front Desk reviewing replies affected by a policy change](public/front-desk-demo-poster.png)](https://outgoing-zebra-720.convex.site/demo.html)

## The problem

Small hospitality teams answer the same kinds of questions every day: pet fees,
check-in times, breakfast hours, room details, and special requests. The answers
usually live across a website, staff memory, and an overflowing inbox.

An ordinary AI draft can save typing, but it cannot tell staff which exact
passage supports an answer or which past guests need an update after a policy
changes. Front Desk treats the source as part of the reply, not as disposable
prompt context.

## How it works

1. A guest message enters the shared inbox and becomes a thread staff can claim.
2. Front Desk drafts a reply from captured website pages and staff-added facts.
3. Every quoted claim is matched mechanically to its source, then checked by an
   independent model. Unsupported answers stop for staff review.
4. Staff edit and send from a realtime workspace. Presence and claim locks keep
   two people from answering the same guest at once.
5. When a captured page changes, sent claims are checked again. Affected replies
   become correction tasks in the original guest threads; replies that are still
   supported remain visible as controls.

Staff can also schedule explicitly approved follow-up emails. A new guest reply,
a closed thread, or lost staff access cancels the authorization before delivery.
Nothing is sent merely because a model produced it.

## Built on Convex

Convex is the application backend and the frontend host, not a thin database
behind the demo.

- Realtime queries keep the queue, drafts, corrections, statistics, and staff
  presence synchronized.
- Convex Auth separates real staff workspaces from isolated anonymous demos.
- Scheduled functions and crons run approved follow-ups and source refreshes.
- Transactions protect thread claims, send reservations, source versions, and
  correction state.
- The Presence, Rate Limiter, Aggregate, AgentMail, Firecrawl, and Static Hosting
  components power collaborative editing, model budgets, inbox statistics,
  durable inbound mail, website capture, and the deployed React app.

AgentMail carries email, Firecrawl captures the inn's public pages, and OpenAI
drafts and judges answers. Provider calls sit behind server-side adapters and
demo visitors never receive live-mail authority.

## Try the demo

Open the [live app](https://outgoing-zebra-720.convex.site) and choose
**Open the demo workspace**. Each visitor receives a private Harbor Light Inn
workspace with simulated email, so exploring the product cannot contact a real
guest.

For the shortest path through the core idea:

1. Open a ready guest thread and inspect the cited source passages.
2. Send the simulated reply.
3. Run the demo policy change.
4. Review the three affected replies beside the three replies that remain true.
5. Approve a correction and see it return to the original thread.

The [demo video](https://outgoing-zebra-720.convex.site/demo.html) uses captures
from a real provider-backed fictional-inn run. The public workspace deliberately
uses simulated delivery. The full implementation record, evidence, and known
limits are in the [hackathon build log](hackathon.md).

## Project structure

| Path | Purpose |
| --- | --- |
| `convex/` | Schema, auth, realtime APIs, source ingestion, grounded generation, email delivery, corrections, follow-ups, and scheduled work |
| `convex/lib/` | Source matching, send guards, tenant rules, signatures, parsing, and other domain logic |
| `convex/providers/` | Server-side OpenAI, AgentMail, and Firecrawl adapters |
| `src/workspace/` | Shared inbox, thread and draft views, policy review, knowledge, settings, onboarding, and navigation |
| `src/components/ui/` | Reusable interface primitives |
| `tests/` | Backend, domain, integration, routing, and browser coverage |
| `public/` | Product marks and the narrated demo assets |
| `hackathon.md` | Public build log with implementation and verification evidence |

## Run locally

Requires a current Node.js release and a Convex account.

```bash
git clone https://github.com/kgarg2468/convexonline.git
cd convexonline
npm install
npx convex dev
```

In a second terminal:

```bash
npm run dev
```

`npx convex dev` creates the local Convex deployment configuration. The UI can
run without live provider credentials, but real drafting, crawling, and email
need their matching server-side OpenAI, Firecrawl, and AgentMail keys. Never put
provider secrets in client-side `VITE_` variables or commit local environment
files.

## Development

```bash
npm run typecheck  # TypeScript across the app, tests, and Convex
npm run lint       # oxlint
npm test           # Vitest and convex-test
npm run build      # production frontend build
npm run deploy     # Convex backend and static frontend
```

The test suite exercises tenant isolation, signed webhooks, grounded generation,
send races, source changes, corrections, follow-ups, rate limits, aggregates,
presence, and the anonymous demo. See [hackathon.md](hackathon.md) for the dated
build record rather than relying on a test-count badge that will go stale.

## Hackathon

Front Desk is a real product built during the Convex All Gas Hackathon. The
hackathon set the delivery window; it does not define the product's intended
lifetime. The repository keeps a public [build log](hackathon.md) so judges can
move from a product claim to the commit, test, deployment, or provider-backed run
that supports it.

This is still early software. It is not a booking engine or payment system, and
staff remain responsible for every message sent to a guest.

## License

No open-source license has been published for Front Desk.
