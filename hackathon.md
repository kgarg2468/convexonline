# Hackathon log

- **Project:** Front Desk
- **Event:** Convex All Gas Hackathon
- **What it does:** A shared inn inbox that tracks the sources behind guest replies and flags cited passages that change.
- **Live app:** https://cheery-egret-460.convex.site
- **Repo:** https://github.com/kgarg2468/convexonline
- **Frontend:** Convex static hosting
- **Convex deployment:** https://cheery-egret-460.convex.cloud
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, indexes, queries, mutations, actions, HTTP actions, realtime queries, full-text search, scheduled functions, crons
- **Auth:** Convex Auth
- **AI models:** gpt-5.6-sol, gpt-6-astra
- **Started:** 2026-09-21T09:46:53Z
- **Last updated:** 2026-09-21T10:42:00Z

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

### 2026-09-21 - working tree
Implemented signed incoming-mail webhooks, per-inn deduplication and threading, site ingestion, grounded draft generation with an independent judge, staff facts, guarded send reservations and correction review.
Added isolated demo sends and a policy-change fixture with three affected replies and three unaffected controls.
The integration has 188 passing offline tests. All 16 browser scenarios pass against the development backend, covering simulated replies, correction approval and delivery, staff facts, isolated sessions and mobile layouts. Production provider verification remains pending.
Evidence: `convex/inbound.ts`, `convex/generation.ts`, `convex/ingest.ts`, `convex/outbox.ts`, `convex/corrections.ts`, `convex/demo.ts`, `tests/`.
