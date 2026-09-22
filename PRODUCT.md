# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Front-desk and reservation staff at small inns and bed-and-breakfasts (1–10 staff), and the owner who
manages the property website. They work between phone calls and check-ins, often on a shared desktop at the
desk and sometimes on a phone. Their job: answer guest email quickly and accurately without contradicting the
inn's own website, and never leave a guest holding wrong information.

(Inferred from the deployed product, demo content and hackathon log; the user directed the session to proceed
without an interview.)

## Product Purpose

Front Desk is a shared inn inbox. Guest emails arrive, a grounded draft reply is written from the inn's own
website and staff-added facts, an independent judge checks that every claim is quoted from a source, and staff
claim, edit and send. When a page on the website changes, every sent reply that quoted it is re-checked and
the affected replies are surfaced for a correction. Success: guests get correct answers fast, staff never
have to re-read the website, and a policy change never silently leaves a guest with stale information.

## Positioning

Answer provenance. Every claim in a reply is tied to the exact passage it came from, and that link stays live
after sending: a website change flags the replies it invalidates. A generic AI email assistant cannot
truthfully claim that.

## Operating Context

- Convex hosts both frontend and backend. Real email flows through AgentMail; website capture through
  Firecrawl; drafting and judging through OpenAI.
- Views: Inbox (queue + thread + draft + sources), Policy changes (correction review), Knowledge (captured
  pages, versions, staff facts), Settings (property, providers, team, hosted website editor), Auth/Onboarding
  (sign in, invitations, property picker), and an Overview dashboard (needs action, analytics, comparisons).
- Anonymous visitors get a private seeded demo inn that never sends real email. Real inns require staff
  membership; the owner invites staff with one-use links.
- Several staff can be in the inbox at once: presence shows who is viewing a thread; claim locks prevent two
  people sending the same reply.
- Convex All Gas Hackathon submission. Public repository; `hackathon.md` is the public build log.

## Capabilities and Constraints

- Thread statuses: new, drafting, needs you (knowledge gap or judge block), ready to send, sent, waiting on
  guest, closed. Draft states: ready, blocked by judge, missing facts.
- Correction review: affected replies (quoted passage changed) versus re-checked and still true controls;
  each correction is drafted, judged and sent into the guest's existing thread.
- Follow-ups: scheduled follow-up emails with staff approval, cancelled if the guest replies.
- Rate limiting, aggregates (thread status counts, sent replies by time, first response times) and presence
  are Convex components already in the backend.
- Terminology to keep: "thread", "claim" (of a thread), "draft", "judge", "source", "passage", "staff fact",
  "policy change", "correction", "follow-up", "property"/"inn".
- 386 offline tests and 29 deployed browser scenarios exist and must keep passing; the browser specs select
  by role and visible text, so user-visible strings are part of the contract.
- No em-dash-heavy or marketing copy in the product; short, plain, specific.

## Brand Commitments

- Name: Front Desk. Mark: a small bell/desk glyph (src/workspace/lib/Mark.tsx).
- Voice: calm, concrete, staff-facing. Says what happened and what to do next.
- Accent colour family stays teal-green (hospitality, trust). Secondary hue is the accent rotated 137.5°.
  Semantic colours (caution, error, success) stay separate from accent.

## Evidence on Hand

- Seeded demo inn "Harbor Light Inn" with eight guest threads, three captured pages, one staff fact and a
  scripted policy change (pet fee $25 → $40) producing three affected replies and three controls.
- Real provider walkthrough and a 2½-minute demo video recorded against production (docs/verification.md,
  docs/walkthrough.md). No customer testimonials, logos or pricing exist; do not invent any.

## Product Principles

1. What needs action is visible before anything else, on every screen.
2. Every number and claim shown has a source the staff member can open.
3. Speed of triage beats richness: a staff member should clear the queue with the keyboard.
4. Multi-staff safety is visible: who has it, who is looking, what was already sent.
5. Nothing is sent, changed or promised without a staff action, and the interface says so.

## Accessibility & Inclusion

WCAG 2.2 AA: 4.5:1 body contrast, visible focus, full keyboard operation of list, thread and dialogs,
reduced-motion support, 44px touch targets on mobile. Shared desk screens may be older 1366×768 laptops.
