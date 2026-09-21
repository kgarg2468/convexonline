# Hackathon log

- **Project:** Front Desk
- **Event:** Convex All Gas Hackathon
- **What it does:** A shared inn inbox that tracks the sources behind guest replies and flags cited passages that change.
- **Live app:** https://outgoing-zebra-720.convex.site
- **Repo:** https://github.com/kgarg2468/convexonline
- **Frontend:** Convex static hosting
- **Convex deployment:** https://outgoing-zebra-720.convex.cloud
- **Components:** @convex-dev/static-hosting, @convex-dev/presence, @convex-dev/rate-limiter, @convex-dev/aggregate
- **Convex features:** schema, indexes, queries, mutations, actions, HTTP actions, realtime queries, full-text search, scheduled functions, crons
- **Auth:** Convex Auth
- **AI models:** gpt-5.6-sol, gpt-6-astra
- **Started:** 2026-09-21T09:46:53Z
- **Last updated:** 2026-09-21T23:52:00Z

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

### 2026-09-21 - aedc595
Added owner-created, one-use staff invitations with seven-day expiry, hashed token storage, revocation and atomic membership acceptance. Removed members cannot reuse consumed links to regain access. Owners can remove staff; membership revocation is immediate and claim cleanup proceeds in indexed batches of 100, stopping if the member rejoins.
Automated review caught unbounded thread and invitation-history reads. Both were bounded before merge. Twenty-seven team integration tests and 255 total tests pass, including concurrent acceptance, tenant isolation, a 230-claim cleanup and rejoining during cleanup. CI and automated review passed; the backend is deployed on production Convex.
Evidence: `convex/teams.ts`, `convex/schema.ts`, `tests/teams.test.ts`.

### 2026-09-21 - 4170529
Added owner invitation and staff-removal controls, explicit invitation acceptance after sign-in, and clear refusal states for used, revoked and malformed links. The workspace handles access removal while a staff tab is open.
All six invitation browser flows passed, alongside the full 22-test desktop/mobile regression. PR CI now checks the standalone browser package's types. CI and automated review passed; the frontend is deployed on Convex.
Evidence: `src/workspace/settings/TeamSettings.tsx`, `src/workspace/onboarding/InvitationGate.tsx`, `src/workspace/lib/invitations.ts`, `tests/browser/specs/teams.spec.ts`, `.github/workflows/ci.yml`.

### 2026-09-21 - 8fd0f70
Added thread viewers using the registered Convex presence component. Reads and heartbeats check current membership, user identities come from auth, and removed staff disappear immediately. Multiple tabs count as one viewer; silent sessions expire after 25 seconds.
Eight tests exercise the actual component, including its expiry worker, tenant isolation and member removal. All 263 offline tests, CI and automated review passed. The frontend and backend are deployed on production Convex. A live two-staff browser check also verified mutual presence, exclusive claims and immediate removal; both test memberships were cleaned up.
Evidence: `convex/presence.ts`, `convex/convex.config.ts`, `src/workspace/inbox/ThreadPresence.tsx`, `tests/presence.test.ts`.

### 2026-09-21 - 1f11cde
Added explicitly approved, scheduled follow-up emails through the guarded outbox. Existing reminders never authorize mail. Guest replies, closure, inbox changes and ended memberships prevent dispatch; unknown provider outcomes are not retried. Approval is tied to the original membership, so removing and re-inviting staff cannot revive it.
Twenty-four integration tests cover scheduling, cancellation races, duplicate workers, simulated delivery and batched cleanup of 205 approvals. All 287 tests, CI and automated review passed; the backend is deployed on Convex. Provider transport is mocked in these tests; live follow-up delivery is not yet verified.
Evidence: `convex/followUps.ts`, `convex/outbox.ts`, `convex/teams.ts`, `tests/followUpEmails.test.ts`.

### 2026-09-21 - 4cd82d2
Added explicit follow-up approval, rescheduling and cancellation controls, with exact message text, approval history and delivery status. Reminder-only notices remain separate. The picker shows the selected date's time-zone offset and rejects local times skipped by daylight saving.
All 25 desktop/mobile browser tests passed against the production backend, including three new follow-up scenarios. CI and automated review passed; the frontend is deployed on Convex. These browser checks use simulated delivery.
Evidence: `src/workspace/inbox/FollowUpPanel.tsx`, `src/workspace/inbox/ThreadDetail.tsx`, `tests/browser/specs/followups.spec.ts`.

### 2026-09-21 - 95f6f52
Added owner-edited fictional inn websites served as escaped public HTML on Convex. Real crawls are restricted to the inn's own pages and request fresh content; saving a website never directly changes source versions or sent claims.
Automated review caught a scope bypass through regular-property creation. Creation, ingestion and scheduled refresh now reject foreign deployment-hosted sites, including legacy records. All 309 tests, CI and the follow-up review pass; the backend is deployed. The change-to-correction tests mock provider transport; the hosted real-provider walkthrough is not yet verified.
Evidence: `convex/innWebsites.ts`, `convex/lib/innWebsiteHtml.ts`, `convex/ingest.ts`, `tests/innWebsites.test.ts`, `tests/ingest.test.ts`.

### 2026-09-21 - dfecb2c
Added fictional-inn onboarding and the owner website editor, with public-page links and a read-only staff view. Draft edits survive updates from another session; concurrent changes are disclosed and pending controls are locked.
Three website browser scenarios pass, including two-session draft preservation, discard, overwrite and pending-state checks. The earlier full 27-test browser suite also passed. CI and automated follow-up review passed; the frontend is deployed on Convex. These checks publish actual website HTML without calling mail, crawl or model providers.
Evidence: `src/workspace/onboarding/InnPicker.tsx`, `src/workspace/settings/InnWebsiteEditor.tsx`, `tests/browser/specs/inn-website.spec.ts`.

### 2026-09-21 - 2c6981f
Live correction probes exposed unsupported historical statements in generated notices. A server-selected drafting mode now states current published terms without repeating old values; the independent judge remains source-only. Automated review added a guard that holds non-answerable classifications for staff even when their quotes verify.
All 314 offline tests, CI and follow-up review passed. Three live OpenAI correction cases—pet fee, checkout time and breakfast hours—passed with verified new-value quotes and accepted independent verdicts. These probes ran the real model adapters with an isolated test database and sent no mail. The backend is deployed on Convex.
Evidence: `convex/corrections.ts`, `convex/providers/openai.ts`, `tests/corrections.test.ts`, `tests/providers.test.ts`.

### 2026-09-21 - 55fdd36
Added per-inn model budgets using the registered Convex rate-limiter component. Normal drafts, staff-edit verification and correction proposals share atomic burst and hourly limits. Denied operations show an inn-local retry time; incoming mail remains stored and no automatic model retry is scheduled. Demo, stale, missing-key and empty-source draft work consumes no budget.
All 327 offline tests pass, including 13 actual-component budget tests. Root and standalone browser type checks, lint and the production build pass. CI and automated review passed; the frontend and backend are deployed on Convex. These tests mock provider transport.
Evidence: `convex/modelBudget.ts`, `convex/generation.ts`, `convex/corrections.ts`, `tests/modelBudget.test.ts`, `src/workspace/inbox/ThreadDetail.tsx`.

### 2026-09-21 - 380e2bd
Added four inn-scoped aggregate instances for thread states, first-response times, sent replies and correction states. App mutations update them transactionally. A persistent, repeatable migration backfills 100 source rows per batch; statistics retain accurate table counts until every backfill finishes. “Sent today” now follows the inn's local calendar day and refreshes without requiring a database write.
All 341 offline tests pass, including interleaved writes during backfill, tenant isolation, normal and correction sends, medians, and daylight-saving boundaries. Root and standalone browser types, lint and build pass. The prior rate-limit deployment also passed 28 production browser scenarios; two optional screenshot tests were skipped.
CI and automated review passed, and both frontend and backend are deployed. Production backfill completed 1,672 threads, 1,304 sent replies and 171 corrections. A read-only audit found no count or namespace mismatches across all 207 stored inn namespaces, including isolated demo/test inns; the owned live inbox's statistics also matched its source rows. These counts describe verification data, not customer usage.
Evidence: `convex/aggregates.ts`, `convex/functions.ts`, `convex/migrations.ts`, `convex/lib/localDay.ts`, `tests/aggregates.test.ts`, `tests/localDay.test.ts`.

### 2026-09-21 - 7410274
Added an inbox statistics strip showing replies sent on the inn's local day, median first-response time and the open queue. Empty inns explicitly show no first responses yet; desktop and mobile layouts wrap the metrics.
Root and browser type checks, lint and build pass. Twelve targeted browser scenarios pass against the production backend, including the queue changing after a simulated send, empty-inn statistics, owner website editing and mobile navigation. An initial run encountered a local network disconnect; the unchanged rerun passed all twelve scenarios.
Automated review caught a live-midnight race in the browser count assertion. The browser now checks count rendering and the queue transition; controlled-clock backend tests retain exact daily-count coverage. All five targeted inbox browser flows pass after the fix. CI and follow-up automated review passed; the frontend is deployed on Convex.
Evidence: `src/workspace/inbox/InboxStats.tsx`, `tests/browser/specs/inbox.spec.ts`, `tests/browser/specs/inn-website.spec.ts`.

### 2026-09-21 - c237533
Registered the AgentMail Convex component for durable inbound event and message archival, in the same transaction as the app receipt. Only verified deliveries for owned live inboxes are archived after tenant-scoped deduplication. Archive bodies and metadata are bounded; oversized provider identities use collision-resistant hashes while app reply identities remain unchanged. Provisioning and guarded sending retain the direct REST adapter.
All 353 offline tests pass, including 12 archive tests exercising the actual component, signed webhooks, tenant isolation, duplicate deliveries, oversized identities and transaction rollback. Types, lint and build pass; the production dependency audit reports zero vulnerabilities. Provider transport is mocked in these tests. CI and automated review passed, and the backend is deployed on Convex. The preceding inbox-statistics deployment passed 28 production browser scenarios, with two optional screenshot captures skipped.
Evidence: `convex/agentmailArchive.ts`, `convex/inbound.ts`, `convex/convex.config.ts`, `tests/agentmailArchive.test.ts`.

### 2026-09-21 - 8ee612b
Improved staff-facing validation and claim feedback. An explicit set of property validation failures shows the backend's bounded explanation; a missing active claim no longer incorrectly blames another staff member. Named claim holders and explicit server guidance remain visible.
All 353 offline tests, root and browser types, lint and build pass. Three website browser flows pass against production, including submitting an invalid time zone, reading the precise error and successfully correcting the same form.
Automated review caught generic validation errors carrying internal details and Unicode controls bypassing the text guard. Both are fixed; ten disclosure/control-boundary tests pass, and the browser validation/recovery flow passes again. CI and follow-up automated review passed; the frontend is deployed on Convex.
Evidence: `src/workspace/lib/format.ts`, `tests/uiErrors.test.ts`, `tests/browser/specs/inn-website.spec.ts`.

### 2026-09-21 - 4b82d6f
Registered the Firecrawl Convex component and routed manual mapping, page scraping and scheduled refreshes through it. Typed environment binding supplies the existing deployment key; app-owned source validation, inn scope, fresh-fetch settings, page budgets and change tracking remain enforced. Component errors are sanitized before staff see them.
All 370 offline tests pass, including seven actual-component cases covering request attribution, source-error rejection, retry exhaustion, error sanitization, tenant isolation and changed-source correction creation. Types, lint and build pass; the production dependency audit reports zero vulnerabilities. These tests mock external HTTP transport; CI and automated review passed, and the component is deployed on production Convex. Live component crawling remains to be verified.
Evidence: `convex/firecrawlClient.ts`, `convex/providers/firecrawl.ts`, `convex/ingest.ts`, `convex/convex.config.ts`, `tests/firecrawlComponent.test.ts`.

### 2026-09-21 - add5501
Correction summaries and the navigation badge now count distinct sent replies rather than claim records or threads. Replies with any unresolved claim are excluded from the unchanged controls; corrected evidence stays associated with its original reply. Individual evidence cards and approval decisions remain separate, with passage counts shown when useful.
Automated review identified an unbounded history scan. Unchanged controls now page through inn-scoped sent replies with server-owned scan caps and bounded claim/correction-history reads. Partial results are labeled, older replies can be loaded, and unchecked replies never count as verified controls.
All 380 offline tests pass. Regression scenarios cover multiple claims per reply, separate replies in one thread, approval without sending, correction delivery, restored evidence, pagination, tenant isolation and overflow accounting. Root and browser types, lint and build pass. CI and follow-up automated review passed; the frontend and backend are deployed on Convex. All 29 deployed browser scenarios pass, including a new regression that creates 26 simulated sent replies and loads the second page; two optional screenshot captures were skipped. Offline provider transport is mocked.
Evidence: `convex/corrections.ts`, `src/workspace/corrections/CorrectionsView.tsx`, `src/workspace/FrontDeskWorkspace.tsx`, `tests/corrections.test.ts`.

### 2026-09-21 - 41871c5
Replayed all 40 original grounding fixtures through the completed generation pipeline with real OpenAI calls and isolated test databases. The clock advances between fixtures so the real per-inn limiter refills; all 40 drafting calls and 18 judge calls were observed, with no budget pauses or provider errors. No mail was sent.
There were zero unsafe-ready outcomes, 51 independently verified quotes and six of six approval-only requests escalated. Sixteen of 24 answerable inquiries became ready; two were held by verification and six deferred. Stay extraction matched five of six original expectations. The sole failing assertion expects a party size not stated in the guest message; it remains unchanged and documented. All other 46 assertions passed. The published aggregate report preserves exact revision, hashes, methodology and limitations.
Evidence: `docs/grounding-evaluation.md`, `convex/generation.ts`, `convex/providers/openai.ts`, `convex/modelBudget.ts`.

### 2026-09-21 - d538ebf
Verified the production fictional-inn loop: two real Firecrawl component crawls, six signed inbound deliveries archived by the AgentMail component, six model-grounded staff sends, an owner website edit from a $25 to $40 fee, exactly three affected replies and three unchanged replies, and a delivered correction in the original provider thread. Two staff sessions saw each other's presence.
The original receipt checker failed on provider-added quoted history and branding. Its failed report remains unchanged. A separate read-only recheck passed all 29 checks using exact message identities, threading and new content, allowing only the observed fixed branding suffix. No original message was resent.
A continuation passed all 51 required checks. One explicitly approved follow-up was delivered by the scheduler; another was cancelled on an actual guest reply, with no send 30 seconds past due. Temporary staff access and claims were cleaned up. Gmail verification and additional inbox capacity remain external requirements; neither is claimed complete.
Evidence: `docs/verification.md`, `docs/walkthrough.md`, `convex/ingest.ts`, `convex/inbound.ts`, `convex/corrections.ts`, `convex/followUps.ts`.

### 2026-09-21 - a5a607f
Added a 150.27-second narrated demo from actual production-run captures: source capture, grounded replies, shared presence, an owner website edit, affected-reply review, delivered correction, and approved follow-up delivery and cancellation. Test inbox addresses are redacted. The video distinguishes the real owned-inbox run from the anonymous simulated demo and describes authenticated app calls used for mail actions.
The MP4 is H.264/AAC, 1280×900, about 4.6 MB. Duration, audio level and rendered frames were checked. Added a public submission overview and links to measured verification; no form or social post has been submitted.
Evidence: `public/front-desk-demo.mp4`, `public/front-desk-demo-poster.png`, `docs/submission.md`. Video URL: https://outgoing-zebra-720.convex.site/demo.html

### 2026-09-21 - 47566d3
Published the reviewed MP4 and poster on Convex; the downloaded video matches the committed SHA-256 and remains 150.27 seconds. The app, health endpoint and poster return HTTP 200.
The static host serves MP4 with a generic binary content type, so added a standalone viewer with native playback controls, an explicit video source type and a download fallback. Ten local Chromium checks passed, including metadata, playback, seeking to two minutes, and no console or page errors. Updated submission links to the viewer. Automated review identified the missing text alternative; the viewer now links the exact narration transcript. Production viewer playback is checked after deployment.
Evidence: `public/demo.html`, `public/front-desk-demo.mp4`, `public/front-desk-demo-transcript.txt`, `docs/submission.md`.

### 2026-09-21 - fcea99f
Production viewer checks established playback but exposed seeking snapping back to the start. The static-hosting proxy omits range support; the underlying managed Convex storage URL correctly returns 206 responses for byte ranges.
Added an exact route for the demo MP4 that resolves only that current public asset and redirects to its storage URL with no-store caching. Missing files return 404 without SPA fallback. Six actual-component regression tests cover route precedence, redirect behavior, replacement uploads, missing assets and unchanged root routes. All 386 offline tests, types, lint and build pass. Production seeking will be rechecked after deploying the reviewed route.
Evidence: `convex/http.ts`, `tests/videoRouting.test.ts`.

### 2026-09-21 - f17df04
Deployed the reviewed range-support route. A fresh MP4 request redirects to Convex storage and returns the requested 1,024-byte range with HTTP 206. An older cached response still serves the unversioned URL, so the viewer's source and download links now share a version query to bypass that response. The video and transcript bytes are unchanged.
Evidence: `public/demo.html`, `convex/http.ts`.

### 2026-09-21 - working tree
Final production viewer verification passed all ten Chromium checks, including actual playback and seeking to two minutes, with no media, console or page errors. The published video is 150.27 seconds, below three minutes; its bytes match the reviewed artifact. The narration transcript is published and matches the committed text. The app health endpoint returns HTTP 200.
The frontend and backend remain hosted on Convex. Source-change, delivery, follow-up and model-evaluation evidence are documented, including the retained failed receipt check and party-size assertion. Gmail confirmation and additional inbox capacity remain external requirements. Submission materials and social copy are prepared; no form or social post has been sent.
Evidence: `docs/verification.md`, `docs/submission.md`, `public/demo.html`, `public/front-desk-demo-transcript.txt`.
