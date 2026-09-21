# Hackathon log

- **Project:** Front Desk
- **Event:** Convex All Gas Hackathon
- **What it does:** A shared inn inbox that tracks the sources behind guest replies and flags cited passages that change.
- **Live app:** https://outgoing-zebra-720.convex.site
- **Repo:** https://github.com/kgarg2468/convexonline
- **Frontend:** Convex static hosting
- **Convex deployment:** https://outgoing-zebra-720.convex.cloud
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, indexes, queries, mutations, actions, HTTP actions, realtime queries, full-text search, scheduled functions, crons
- **Auth:** Convex Auth
- **AI models:** gpt-5.6-sol, gpt-6-astra
- **Started:** 2026-09-21T09:46:53Z
- **Last updated:** 2026-09-21T16:35:00Z

## Log

### 2026-09-21 - d1f108c
Built the shared queue, staff claim locks, source versions and correction review API.
Anonymous visitors receive isolated demo inns; live-mail permission requires staff membership in a real inn.
Source changes flag sent claims whose quotes disappear while preserving unaffected controls.
Added provider adapters and GitHub CI with offline tenant, claim, source-change and provider tests.
Evidence: `convex/access.ts`, `convex/threads.ts`, `convex/pages.ts`, `convex/providers/`, `tests/`, `.github/workflows/ci.yml`.

### 2026-09-21 - e999223
Added mechanical source-quote validation to the OpenAI adapter, including escaped HTML entities.
Staff-fact citations must quote the answer itself. Pinned CI actions to commit SHAs.
The development frontend and backend are hosted on Convex. Browser verification established anonymous authentication and live workspace queries using root OIDC discovery routes.
Evidence: `convex/providers/openai.ts`, `convex/lib/quotes.ts`, `tests/providers.test.ts`, `tests/quotes.test.ts`.

### 2026-09-21 - d196256
Separated provider-key setup from webhook registration so syncing provider credentials cannot overwrite an existing webhook signing secret.
Setup scripts accept the Convex CLI's deployment selector and provision an actual auth signing-key pair without exposing its values.
Evidence: `scripts/configure-auth.mjs`, `scripts/configure-secrets.mjs`.

### 2026-09-21 - 251c7a3
Implemented signed incoming-mail webhooks, per-inn deduplication and threading, site ingestion, grounded draft generation with an independent judge, staff facts, guarded send reservations and correction review.
Added isolated demo sends and a policy-change fixture with three affected replies and three unaffected controls.
The integration has 188 passing offline tests. All 16 browser scenarios pass against the production deployment, covering simulated replies, correction approval and delivery, staff facts, isolated sessions and mobile layouts. Production frontend and backend are deployed on Convex.
Evidence: `convex/inbound.ts`, `convex/generation.ts`, `convex/ingest.ts`, `convex/outbox.ts`, `convex/corrections.ts`, `convex/demo.ts`, `tests/`.

### 2026-09-21 - 0f55ba9
Rejected scraped target error pages before storing source versions and preserved the current email turn when delayed older webhooks arrive. Added regression coverage; 192 offline tests pass.
Production verification completed a real Firecrawl crawl, signed AgentMail inbound delivery, OpenAI draft and independent judge, staff-authorized send, and threaded reply between owned test inboxes. The run reused an existing project inbox because the provider account had no capacity for another inbox.
An unsupported question correctly asked for a staff fact. Regeneration introduced an unsupported inference, which the judge blocked; removing that inference through staff editing passed re-verification. The second reply was left unsent.
Evidence: `convex/providers/firecrawl.ts`, `convex/inbound.ts`, `tests/providers.test.ts`, `tests/ingest.test.ts`, `tests/webhook.test.ts`, `tests/send.test.ts`, `convex/generation.ts`, `convex/drafts.ts`.

### 2026-09-21 - 0aef0be
Property creation now rejects unusable website URLs and time zones before inserting records. HTTPS scheme matching accepts either case in the browser.
Validation passed locally and in PR CI; the browser pattern was corrected after automated review.
Evidence: `convex/inns.ts`, `src/workspace/onboarding/InnPicker.tsx`, `tests/access.test.ts`.

### 2026-09-21 - 6e8ea99
Email dispatch rechecks the reserving staff member's current authority and the captured inbox immediately before contacting AgentMail. Removed staff and changed inbox bindings cannot authorize a reserved send. Accepted deliveries retain their actual sender in history.
Sixteen integration tests cover dispatch authority and changes during delivery. PR CI and automated review passed before merge.
Evidence: `convex/outbox.ts`, `tests/dispatchAuthority.test.ts`.

### 2026-09-21 - 26ca371
Reply-parent lookup now uses an inn-scoped Message-ID index. Messages written by every app path carry the owning inn, and a batched internal migration fills that field on older rows.
Automated review caught an unbounded scan; it was replaced with an indexed lookup. Tests cover foreign copies, duplicate IDs, and paginated, repeatable backfill.
Evidence: `convex/inbound.ts`, `convex/schema.ts`, `convex/migrations.ts`, `tests/webhook.test.ts`, `tests/messageBackfill.test.ts`.

### 2026-09-21 - deed589
Owners can retry an incomplete guest inbox connection from Settings. Initial setup and repair require a configured provider and registered webhook, and readiness still comes from the server.
Type checking and lint passed. Review identified and prompted the missing-webhook guard.
Evidence: `src/workspace/settings/SettingsView.tsx`, `convex/inbox.ts`.

### 2026-09-21 - 3f175d5
Normal drafting and staff-edit verification now give the independent judge the original guest email as bounded, untrusted context. It may support acknowledgment of personal travel details, but cannot establish an inn policy, price, availability or staff approval. Correction judging remains source-only.
Validation: 228 offline tests pass. Five real-model probes accepted faithful acknowledgments and rejected forged approval, injected instructions and an unsupported price claim. The unchanged 40-fixture replay had zero unsafe-ready cases, six of six approval requests escalated, and 52 of 52 citations matched to source text. Sixteen of 24 answerable cases were ready; eight were held for staff. The raw harness passed 46 of 47 assertions: one fixture expects two guests from an email that states no headcount. The app leaves that count unknown.
Evidence: `convex/providers/openai.ts`, `convex/generation.ts`, `tests/providers.test.ts`, `tests/generation.test.ts`.

### 2026-09-21 - de145cd
Deployed the merged audit fixes to the production Convex backend and frontend. Backfilled 507 existing messages with their owning inn using bounded, repeatable batches; no orphaned threads were found.
Evidence: `convex/migrations.ts`, `convex/http.ts`, `convex/convex.config.ts`.
