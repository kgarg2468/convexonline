# Front Desk

The email front desk for independent inns that live in their inbox. Guest email
is classified, drafted from the inn's own website, verified claim-by-claim
against verbatim quotes, and sent by staff from a realtime workspace. When the
website changes, every reply already sent is re-checked and the ones whose cited
passage no longer holds are flagged for a correction in the guest's thread.

Try the [live app](https://outgoing-zebra-720.convex.site). Choose **Open the demo workspace**
to explore an isolated workspace with simulated email, then change the demo policy
to review three affected replies alongside three unaffected replies. Both the
frontend and backend are hosted on Convex.

The [walkthrough](docs/walkthrough.md) covers the isolated demo and the live
fictional-inn workflow, including staff invitations and approved follow-ups.

The [40-case grounding evaluation](docs/grounding-evaluation.md) records real
OpenAI calls through the app's generation pipeline. No unanswerable or
approval-only inquiry became ready; 16 of 24 answerable inquiries became ready
and eight were held. This is a small regression set, not a claim of perfect
answering or 40 production email deliveries.

## Stack

- Convex backend and realtime queries; the SPA is served from the same
  deployment through `@convex-dev/static-hosting` in app-owned root routing
  mode (see [HTTP routing](#http-routing)).
- Convex Auth: password sign-in for staff, anonymous sign-in for the judge demo.
  Demo visitors get a private seeded inn and can never send live mail.
- The AgentMail Convex component durably archives accepted inbound events and
  messages in the same transaction as the app receipt. Inbox provisioning and
  guarded outbound delivery use the direct AgentMail REST adapter.
- The Firecrawl Convex component performs live site mapping and fresh page
  scraping; app-owned validation and source-version tracking remain in place.
- React 19 + Vite + TypeScript frontend.
- Vitest + `convex-test` for backend tests.
- The Convex rate-limiter component shares an OpenAI operation budget across
  each inn's staff and incoming messages.
- The Convex aggregate component maintains per-inn queue counts, sent-reply
  totals, pending corrections, and median first-response time.

## Layout

| Path | What |
|---|---|
| `convex/schema.ts` | Tables and indexes (inns, memberships, pages, pageVersions, crawlRuns, threads, messages, webhookEvents, drafts, claims, outbox, sentReplies, staffFacts, corrections, followUps) |
| `convex/lib/` | Pure domain logic: quote verification, grounding decisions, send guards, tenant rules, claim locks, Standard-Webhooks signature check, inbound payload parsing, site page selection, product-webhook checks (`inboxWebhook.ts`) |
| `convex/providers/` | OpenAI (drafter + judge), Firecrawl (map/scrape), AgentMail (reply) adapters. No Convex imports; sanitized errors |
| `convex/access.ts` | Auth + tenant guards used by every query and mutation |
| `convex/http.ts` | Root HTTP router: `/api/health`, `POST /api/agentmail/webhook` (Svix-verified raw body), Convex Auth well-known routes, static SPA catch-all |
| `convex/inbound.ts`, `generation.ts` | Inbound dedupe/threading and the draft → quote verification → judge pipeline (stale completions are discarded) |
| `convex/drafts.ts`, `outbox.ts`, `corrections.ts` | Transactional send reservations, single-dispatch delivery, correction proposals/approval/sends |
| `convex/ingest.ts`, `pages.ts`, `crons.ts` | Site crawl (≤10 pages), page versions + sent-claim re-verification, hourly rescrape of watched pages |
| `convex/inbox.ts`, `integrations.ts`, `followUps.ts` | Inbox provisioning (server-controlled ids, appended to the product webhook), key-presence + readiness booleans, reminders and staff-approved follow-up emails |
| `convex/teams.ts`, `presence.ts` | One-use staff invitations, membership removal, authenticated thread presence |
| `convex/innWebsites.ts`, `lib/innWebsiteHtml.ts` | Owner-edited fictional inn websites, rendered as public HTML on Convex; edits become knowledge only after a crawl |
| `convex/threads.ts`, `facts.ts`, `inns.ts` | Staff workspace API (queue, detail, search, stats, staff facts) |
| `convex/demo.ts`, `demoContent.ts` | Per-visitor demo inn, fixture drafter, simulated sends, scripted policy change (3 affected / 3 control replies) |
| `src/` | App shell: sign-in, queue, thread detail, corrections review |
| `tests/` | Offline suites: auth/tenant, auth routing, claims, webhook, inbox webhook subscription, generation, send/outbox, corrections, demo loop, ingest, providers |

## Working with staff

Create a staff account and property, then open **Settings → Team** to create a
one-use invitation link. Share that link with a colleague, who signs in and
explicitly joins the named property. Links expire after seven days; owners can
revoke open links and remove staff. Removed staff lose workspace access and their
thread claims are released. Thread detail also shows current viewers using the
Convex presence component; viewing does not grant the claim lock. Sessions expire
within 25 seconds of leaving or hiding the thread. The anonymous demo remains
separate from real staff accounts and never sends mail.

## Email loop

1. AgentMail posts `message.received` to `/api/agentmail/webhook`. The raw body is
   verified against `AGENTMAIL_WEBHOOK_SECRET` (Standard Webhooks headers), the
   inbox id is mapped to its inn, and the event and message ids are deduped per
   inn. Accepted events are archived by `@agentmail/convex` with an inn-scoped
   event identity and bounded metadata; unknown and demo inboxes are excluded.
   The component archive is internal, with no public mail-reading endpoint.
   The message joins its thread (provider thread id, then `In-Reply-To`),
   and advances the current turn only when it is newer. Older deliveries remain
   in history; newer deliveries supersede unsent drafts, cancel follow-ups, and
   schedule generation.
2. `generation.generateForThread` snapshots the inn's pages and staff facts,
   asks the drafter for an answer with quoted claims, verifies every quote
   mechanically against the cited page version or fact, and only then asks the
   judge whether the exact text is entailed. A draft is `ready` only when all of
   that holds; otherwise it is `needs_edit` with a visible reason. Completions
   for a stale inbound or a changed page are discarded.
3. Staff edits invalidate the verdict; the exact edited text is re-judged. An
   unjudged edit can be sent only with `staffAuthored: true` and is labelled so.
4. `drafts.send` reserves an immutable `outbox` row in one transaction (claim,
   verification, latest inbound, current sources, no in-flight send) and
   schedules `outbox.deliver`, which re-checks the preconditions, flips the row
   to `sending`, calls AgentMail once, and records the reply. Ambiguous
   provider failures leave the row `unknown` and are never retried.
5. When a page version changes, every sent claim citing it is re-verified.
   Vanished quotes open a correction (drafter proposal grounded only in the new
   version, or staff text); approval requires the current version and the
   thread claim; sends go through the same outbox. A later change supersedes
   earlier proposals and approvals.

Demo inns run the same guards with a fixture drafter and simulated sends; no
provider is ever called for demo data and demo users never gain live authority.

## Drafting limits

Each inn shares a token bucket that refills at 10 model operations per minute,
with a burst capacity of 10, and a fixed limit of 60 operations per clock hour.
A draft and its independent judge count as one operation; re-judging an edit
or generating a correction each use one operation. Both limits must allow the
operation before either is charged.

Incoming mail is still stored when the budget is exhausted. Drafts and
corrections show a retry time, and staff can request another attempt when the
budget and existing redraft cooldown allow it. Throttling never schedules an
automatic retry loop. Demo work does not consume this provider budget.

## Inbox statistics

Four aggregate component instances update in the same transaction as thread,
sent-reply, and correction writes. Each inn has its own namespace. “Sent today”
uses the inn's local calendar day, including daylight-saving changes. Normal
replies and correction sends count; follow-up emails do not. Median first
response excludes threads that have not received a reply.

After first deploying the aggregate components, run
`npx convex run --prod migrations:runAggregateBackfill '{}'`. The internal
migration advances through the three source tables in batches of 100 and
persists progress. Live writes remain indexed throughout. Statistics continue
to read the source tables until all backfills finish, then switch to aggregates.
Re-running a completed backfill is a no-op; `{"restart":true}` safely walks the
tables again without clearing the component data.

## Follow-up emails

After replying to an open stay inquiry, claim the thread and review the full
message in **Follow-up email**. Choose a send time and explicitly approve it.
Times use your browser's time zone; the shown UTC offset follows the chosen date.
The default is 48 hours, with a range of one minute to 30 days. A reminder by
itself never authorizes email.

Cancel or reschedule while it is scheduled. A queued follow-up can still be
canceled until dispatch starts. A new guest reply, a closed thread, an inbox
change, or ended staff membership prevents sending. Re-inviting staff does
not restore their old approvals. Once a message is with the provider it cannot
be recalled; an unknown outcome stays blocked from automatic retry. Demo
follow-ups are clearly labeled simulated and never contact a mail provider.

## A fictional inn you can edit

When creating a property, choose **A fictional inn with a hosted example site**.
Front Desk publishes four clearly fictional pages on the same Convex deployment:
home, policies, rooms and notices. The owner can change their structured content
under **Settings → Public website**; invited staff can view the public pages.

**Save website** publishes the edits immediately. Open **Knowledge → Crawl the
website** to capture the new content through Firecrawl and review any sent replies
whose cited passages changed. Crawling and email use the configured providers;
set up the guest inbox in Settings when ready.

## Inbox setup (one webhook per deployment)

Each deployment owns exactly one AgentMail `message.received` webhook, scoped
to an explicit inbox list (an empty list would deliver organization-wide and is
refused everywhere). `scripts/register-webhook.mjs` creates or reuses it and
stores its id and signing secret on the deployment as `AGENTMAIL_WEBHOOK_ID`
and `AGENTMAIL_WEBHOOK_SECRET`. When an owner provisions an inn's inbox,
`inbox.provision`:

1. refuses with `webhook_not_configured` if the deployment has no hook id;
2. `GET /v0/webhooks/:id` and checks it is the product hook: url is
   `${CONVEX_SITE_URL}/api/agentmail/webhook`, `client_id` is
   `frontdesk-<site name>` (the same derivation as the script), enabled,
   subscribes to `message.received`, non-empty `inbox_ids` (`webhook_mismatch`
   otherwise, `webhook_not_found` on 404);
3. refuses with `webhook_full` when the hook already covers the provider's
   10-inbox limit, before minting an address;
4. creates the inbox (username and `client_id` derived from the inn id, so a
   retry cannot mint a second address) and records the binding;
5. `PATCH { add_inbox_ids: [inbox] }` (append, never a list replacement) and
   records `inboxWebhookId` only after the provider's 2xx.

A failure after step 4 leaves the inbox bound but unsubscribed
(`integrations.status` → `inboxConfigured: true, inboxWebhookReady: false`);
calling `inbox.provision` again skips creation and only completes the
subscription. `inboxWebhookReady` is true only when the inn's recorded hook is
the deployment's current `AGENTMAIL_WEBHOOK_ID`; the key-presence booleans
(`webhookSecret`, `webhookId`) say the deployment is configured, not that any
inbox is subscribed. The hook's signing secret is returned by the provider on
GET/PATCH and is never logged, stored or sent to a client.

## HTTP routing

The app owns the HTTP root of `<deployment>.convex.site`; the static-hosting
component is installed without an `httpPrefix` (`convex/convex.config.ts`) and
its catch-all is registered from `convex/http.ts` with `registerStaticRoutes`
after the app routes. Exact routes and the more specific hosted-inn prefix win over the catch-all.

| Path | Owner |
|---|---|
| `/.well-known/openid-configuration`, `/.well-known/jwks.json` | Convex Auth (`auth.addHttpRoutes`), must stay at the root |
| `/api/health`, `POST /api/agentmail/webhook` and future product endpoints | App routes, always under an explicit `/api/...` path |
| `/inn/<innId>/`, `/inn/<innId>/policies`, `/inn/<innId>/rooms`, `/inn/<innId>/notices` | Public fictional inn pages; bounded owner-authored content, escaped HTML and `no-store` responses |
| everything else (`/`, `/inns/...`, hashed assets) | Static SPA catch-all (`/*`) |

Add new product HTTP endpoints as exact `/api/...` routes in `convex/http.ts`
above the `registerStaticRoutes` call. `tests/authRouting.test.ts` checks the
real router: the well-known, health and webhook paths resolve to exact routes,
discovery advertises the root JWKS URL, and unknown paths fall through to the SPA.

## Scripts

```bash
npm run dev          # Vite dev server (run `npx convex dev` alongside)
npm run typecheck    # tsc -b (app, node, tests + convex)
npm run lint         # oxlint
npm test             # vitest (edge-runtime + convex-test)
npm run build        # tsc -b && vite build
npm run deploy       # convex deploy + static upload to prod
```

Operator scripts (never run by CI; they read `.env.local` via `process.loadEnvFile` only):

```bash
node scripts/configure-auth.mjs [--prod | --deployment X]          # JWT_PRIVATE_KEY + JWKS (idempotent, never rotates)
node scripts/configure-secrets.mjs [--prod | --deployment X]       # OPENAI_API_KEY, FIRECRAWL_API_KEY, AGENTMAIL_API_KEY only
node scripts/register-webhook.mjs --site-url https://<name>.convex.site --inbox <owned addr> [--inbox ...] [--prod | --deployment X]
                                                                   # create/reuse the product message.received webhook scoped to
                                                                   # the given owned inboxes; store AGENTMAIL_WEBHOOK_ID + _SECRET
npx convex run inbox:configureInbox '{"innId":"...","inboxId":"a@agentmail.to"}'   # bind an existing inbox (clears its recorded hook)
```

Setup order for a deployment: `configure-auth` → `configure-secrets` →
`register-webhook`. The webhook script needs at least one inbox this AgentMail
account already owns (the provider refuses an unscoped hook); it verifies
ownership with the provider, reuses a hook that already targets the deployment
only when its `client_id`, event and non-empty scope match, appends missing
inboxes, and never touches hooks with other urls. That initial inbox only
seeds the scope: every inn provisioned afterwards is appended to the same hook
by `inbox.provision`, so the script does not need to be re-run per inn.
`configure-secrets` deliberately does not manage the webhook id/secret.

Once the operator has registered the product hook, owner staff set up each inn
from the app: create the property (`inns.create`), crawl its website from the
Knowledge view (`ingest.crawlSite`), then provision the inbox from Settings
(`inbox.provision`, see [Inbox setup](#inbox-setup-one-webhook-per-deployment)).
There is no separate script for creating inn inboxes.

Environment variables on the deployment: `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`,
`AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_ID`, `AGENTMAIL_WEBHOOK_SECRET`, plus
the Convex Auth keys (`CONVEX_SITE_URL` is provided by Convex).
`FIRECRAWL_API_KEY` is required at deployment because it is passed through the
app's typed environment to the registered Firecrawl component. Configure the
real key before deploying; the component does not use a placeholder. Missing
OpenAI or AgentMail credentials make their matching features unavailable
(`integrations.status`). Staff authentication also requires its deployment keys.

## Deployment notes

- First push: `npx convex dev --once --configure=new --project <name>` writes
  `.env.local` (`CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`)
  and regenerates `convex/_generated/` with full component types.
- Convex Auth needs `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL` on every
  deployment: `node scripts/configure-auth.mjs` (dev) and again with `--prod`.
- `convex/auth.config.ts` uses the standard Convex Auth provider
  (`domain: CONVEX_SITE_URL`, `applicationID: "convex"`). Convex resolves the
  signing keys through OIDC discovery at the root, so the well-known routes
  must stay at the root (see [HTTP routing](#http-routing)). Do not switch to
  a `customJwt` provider: Convex Auth tokens carry no `kid` header and
  `customJwt` requires one, so the websocket rejects every token with
  "JWT may be missing a kid".
- After deploying the routing change, verify on the site URL:
  `/.well-known/openid-configuration` (root), `/.well-known/jwks.json`,
  `/api/health`, and that `/` still serves the SPA.
- Missing keys fail closed: the frontend shows an "unavailable" screen without a
  Convex URL, and no provider is called without its key.
