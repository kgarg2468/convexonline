# Hackathon log

- **Project:** Front Desk
- **Event:** Convex All Gas Hackathon
- **What it does:** A shared inn inbox that tracks the sources behind guest replies and flags cited passages that change.
- **Live app:** not deployed
- **Repo:** https://github.com/kgarg2468/convexonline
- **Frontend:** Convex static hosting
- **Convex deployment:** not deployed
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, indexes, queries, mutations, HTTP actions, realtime queries, full-text search
- **Auth:** Convex Auth
- **AI models:** gpt-5.6-sol, gpt-6-astra (provider adapters; live drafting integration pending)
- **Started:** 2026-09-21T09:34:00Z
- **Last updated:** 2026-09-21T09:46:00Z

## Log

### 2026-09-21 - working tree
Built the shared queue, staff claim locks, source versions and correction review API.
Anonymous visitors receive isolated demo inns; live-mail permission requires staff membership in a real inn.
Source changes flag sent claims whose quotes disappear while preserving unaffected controls.
Added offline provider adapters and GitHub CI; 85 local tests pass, including tenant isolation, claim contention, source changes and provider failure handling.
Evidence: `convex/access.ts`, `convex/threads.ts`, `convex/pages.ts`, `convex/providers/`, `tests/`, `.github/workflows/ci.yml`.
