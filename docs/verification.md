# Verification record

Verified on September 21 and 22, 2026 against the
[Convex-hosted app](https://outgoing-zebra-720.convex.site).
This record distinguishes production provider checks, isolated real-model
experiments and tests with mocked provider transport.

## Automated regression checks

- 386 offline tests passed across 33 files, with root and browser TypeScript
  checks, lint and the production build passing. Provider transport is mocked
  in the offline suite; component tests exercise the actual registered packages.
- All 29 browser scenarios passed against the deployed app. Two optional
  screenshot-capture cases were skipped. Coverage includes isolated demo sessions,
  staff onboarding and invitations, claims, follow-ups, website editing, precise
  validation recovery and loading multiple pages of correction controls.
- GitHub CI and Greptile reviewed each implementation PR. Findings were addressed
  before merging. The [deployed browser run](https://github.com/kgarg2468/convexonline/actions/runs/35664565718)
  tested application revision `e80454b`; subsequent changes at the time of the
  provider walkthrough were documentation only.
- On September 22 the current browser suite ran against the deployed app at
  revision `b10de58`: 44 scenarios passed and two optional screenshot captures
  were skipped. The one difference from a local run is that the host's edge
  refuses doubly encoded traversal paths with its own 400 page before the app
  loads; the hostile-id scenario accepts that refusal after checking that no
  payload is reflected.
- Interface revamp (September 22): after each of the shell, inbox, policy
  changes, knowledge, settings, security, overview and polish PRs, 437 offline
  tests, lint, both TypeScript projects and the build passed, and the browser
  suite (44 scenarios at 1440 by 900, 1000 by 800 and iPhone 13) passed against
  a local build before merge. Each PR had GitHub CI, a Greptile review and a
  separate taste review; a security pass typed injection payloads through every
  free-text field and checked ids, rate limits and response headers
  (`tests/browser/specs/security.spec.ts`, `tests/security.test.ts`).
- A production dependency audit reported zero known vulnerabilities at the time
  of the audit. This is an audit result, not a security guarantee.

## Actual source change and email delivery

A fresh fictional inn used four public HTML pages served from the same Convex
host as the staff workspace. Two owned provider inboxes supplied the guest and
inn sides of the demonstration. No real guest inbox was contacted.

1. The actual Firecrawl component captured all four pages with the original pet
   fee of $25 per dog per night.
2. Six guest emails arrived through signed AgentMail webhooks. All six were
   classified as stay inquiries, drafted with actual OpenAI calls and checked
   against the captured sources. Staff-authorized sends produced six delivered
   original replies. All six accepted inbound events and messages were present
   in the AgentMail component archive, with matching tenant and message identities.
3. After the crawl cooldown, the owner changed the fee to $40 through the app's
   website editor. The public pages changed immediately; captured source versions
   remained unchanged until the next crawl.
4. A second real Firecrawl crawl stored four pages. Rechecking produced four
   claim-level correction records across exactly three original replies. The
   other three original replies remained supported. The visible summary showed
   three replies needing review and three still true; all control pages were
   exhausted and no unchecked reply was counted as verified.
5. Staff claimed a thread, approved a generated correction checked against the
   current source, and sent it. The outbox and correction both recorded delivery
   and the provider placed the correction in the guest's existing thread.
6. A second invited staff account joined the same inn. Both staff sessions saw
   each other viewing the thread. Temporary memberships and claims were cleaned up.

The original verification script compared the provider's full email body against
only the approved answer. That check failed because the provider adds quoted
history and a `Sent via AgentMail` footer. The failed original report was retained.
A separate read-only recheck verifies exact stored text, provider message identity,
threading headers and the extracted new content, allowing only the observed fixed
branding suffix. Original replies and the correction are not sent again to repair
a verification report. All 29 read-only checks passed. A subsequent continuation
passed all 51 required checks, including the follow-up cases below, while retaining
the original report unchanged.

## Actual scheduled follow-ups

A fresh staff account joined the same inn through a one-use invitation. Two
previously answered control threads had no earlier follow-up approvals.

- Staff approved the exact server template for 90 seconds later. Convex's
  scheduler delivered it once, about 0.8 seconds after due. The provider message
  identity, original guest thread, headers and new content matched. One follow-up
  outbox row was sent, and the thread's original sent-reply count stayed at one.
- On another thread, staff approved a follow-up and the owned guest inbox replied
  to the previously delivered inn message. Signed inbound processing attached
  that reply to the same application thread and cancelled the follow-up before
  due. A check 30 seconds after due found no follow-up outbox row, no extra inn
  reply in the provider thread and no follow-up message.
- Temporary staff membership, invitation and claims were cleaned up. The delivered
  and cancelled records remain as evidence; no delivery was retried.

## Real-model evaluation

The [40-case report](grounding-evaluation.md) includes all original fixtures,
revision and fixture hashes, actual model-call coverage and the artificial clock
spacing used to stay within the configured rate limits. There were zero unsafe
ready outcomes, 51 verified quotes and no skipped fixtures. Sixteen of 24
answerable inquiries became ready; eight were held. Forty-six of 47 assertions
passed. The remaining party-size expectation was not stated in the guest message
and was not changed to make the test pass. No mail was sent by this experiment.

## Published demo video

The [video viewer](https://outgoing-zebra-720.convex.site/demo.html) serves a
150.27-second H.264/AAC video at 1280×900, with a linked exact narration transcript.
It uses narrated captures of the real fictional-inn run, with test inbox addresses
redacted. The video is 4,643,513 bytes; its published download matches SHA-256
`241dabc01dd744222732a0e77d16bea8c0fcbb4f3c099e7baf8801a5e958b3f4`.

Production verification found and fixed seeking snapping back to zero. The MP4
now resolves through an exact app route to managed Convex storage, which supports
byte ranges. The viewer uses a versioned URL to bypass the older cached proxy
response. All ten production Chromium checks passed: page and video availability,
duration, dimensions, format support, absence of media errors, actual playback,
seeking to 120 seconds and continuing playback, and no console or page errors.
Playback was muted for the automated check; the AAC track and its non-silent
audio levels were checked separately.

These checks ran with backend revision `7653f22` and frontend revision `b2f6538`.
The app health endpoint returned HTTP 200, and the published transcript matched
the committed text. No hackathon form or social post has been submitted.

## Limits and remaining external checks

- The anonymous public demo uses seeded sources, fixture-generated drafts and
  simulated email. It is deliberately isolated from live-mail authority.
- Live mail was verified between owned AgentMail inboxes. The Gmail walkthrough
  still requires the owner-confirmed test message; Gmail delivery is not claimed.
- The provider account is at its current inbox limit. Existing owned inboxes work,
  but provisioning another live property is blocked until capacity is available.
- This is a hackathon demonstration with small datasets, not a throughput test,
  independent security assessment or validation on real inn operations.
