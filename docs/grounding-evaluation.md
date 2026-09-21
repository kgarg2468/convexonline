# Front Desk grounding evaluation — aggregate summary

**Gate result: passed the unsafe-readiness gate** (no draft for an unanswerable or approval-only inquiry became ready, and no ready draft carried an unverified claim), with every fixture's drafter request observed reaching the real provider exactly once. This is not a claim of 100% task success: conservative holds are counted below as holds.

## Run

| field | value |
|---|---|
| harness | front-desk-live-eval |
| started (UTC) | 2026-09-21T22:42:13.332Z |
| report written (UTC) | 2026-09-21T22:47:16.731Z |
| frozen "today" for relative dates | 2026-09-21 |
| clock strategy | frozen `Date` from 2026-09-21T18:00:00.000Z, advanced 60 s per fixture (last fixture at 2026-09-21T18:39:00.000Z); real per-inn model budget limiter left live, never reset or bypassed |
| fixtures / ran / budget skips | 40 / 40 / 0 |
| fixtures whose drafter request reached the provider exactly once | 40 / 40 |
| wall-clock of the whole run (seeding + all fixtures, sequential) | 303 s |
| sum of per-fixture pipeline time (drafter call + quote check + judge call + persistence) | 303 s |
| wall-clock budget | 1800 s |

Token usage and cost were not measured by the harness, so none are reported.

## Provenance

| field | value |
|---|---|
| git revision | 0868cae512fbc0821ad17a40a6ac487420ea4fdc (kgarg2468/convex-hackathon-project-plan) |
| uncommitted product changes at run time | YES — 1 product/test-setup file(s) had uncommitted changes |
| oracle fixtures SHA-256 | 8444072a1faab1c97d187da0be43f6502dc0474bd5e25e53b51327f4a0d6995e |
| harness SHA-256 | e4b1a08695760a308ade30feaebbb2697ae687da1086b308b8a285f66cdaa3e0 |

The uncommitted file was `tests/browser/specs/correction-pagination.spec.ts`,
an additional browser regression being authored during this run. It was not
loaded by the evaluation and was subsequently committed as `add5501`.
Application code and the shared test setup matched the recorded revision.
The raw provenance flag is retained rather than relabeled as a clean worktree.

## Methodology

- Oracle: 40 hand-written guest inquiries across two real inns (20 each; ids `sg-*` and `sh-*`), each labelled `answerable`, `unanswerable` or `needs_approval` from the inns' scraped public pages before any model ran. Six carry an expected stay (dates / party) for extraction checking.
- Each fixture is run sequentially through the product's real generation action inside `convex-test` (snapshot → OpenAI drafter → mechanical quote check → independent judge → persisted draft and claims), with the inn's knowledge base seeded from the same scraped pages. One generation per fixture, no retries.
- Clock: only `Date` is frozen (timers and network stay real) and it is advanced by a fixed step per fixture, so all fixtures resolve relative dates against the same calendar day while the product's per-inn model budget (a real rate limiter that reads the clock) refills between generations exactly as it would in production. The limiter is not mocked, reset or bypassed; a fixture the limiter pauses is a hard error, not a hold.
- Provider-call coverage: a pass-through wrapper around the process's `fetch` (it always forwards to the real network call and never answers on the provider's behalf) counts, per fixture, the requests that reached the OpenAI Responses API and whether each was the drafter or the judge. Every fixture must show exactly one drafter request; the judge may run only for a non-abstaining answerable draft whose claims all verified.
- Hard failure ("unsafe-ready"): a `ready` draft for a non-answerable fixture, or a `ready` draft with an unverified/stripped claim, a missing or negative judge verdict, or a claim marked verified whose quote does not re-verify against the knowledge-base text. Every persisted claim is independently re-checked by the harness against the page text.
- Conservative outcomes (an answerable inquiry held for staff or escalated) are counted as holds, not as failures and not as successes.
- Answer wording is not self-graded by a model; no adjudicated pass score is published. Only raw outcome categories and counts appear here.

## Outcomes by bucket

| bucket | n |
|---|---|
| answerable: ready to send | 16 / 24 (67%) |
| answerable: answered but held by the verification gate | 2 |
| answerable: held conservatively (abstained or escalated to staff) | 6 |
| answerable: provider/harness error | 0 |
| answerable: cites an expected source page | 23 / 24 |
| unanswerable: abstained / asked staff for the fact | 8 / 10 |
| unanswerable: escalated to staff approval | 2 |
| unanswerable: answer attempted, held by gate | 0 |
| unanswerable: provider/harness error | 0 |
| needs_approval: escalated to staff | 6 / 6 |
| needs_approval: deferred as a staff fact | 0 |
| needs_approval: answer attempted, held by gate | 0 |
| needs_approval: provider/harness error | 0 |
| **unsafe-ready cases** | **0** |
| provider/harness errors (all buckets) | 0 |

Non-answerable inquiries that became ready: 0 / 16.

## Provider-call coverage

| metric | n |
|---|---|
| drafter requests that reached the provider | 40 / 40 fixtures |
| fixtures with exactly one drafter request | 40 / 40 |
| judge requests | 18 (on 18 fixtures) |
| fixtures paused by the model budget (never reached the drafter) | 0 |
| unclassified Responses API requests | 0 |
| Responses API requests outside any fixture | 0 |

Every fixture's drafter request was observed leaving for the real provider exactly once; no fixture was starved by the model budget.

## Unsafe-ready cases

None.

## Provider / harness errors

None.

## Citation verification

| metric | n |
|---|---|
| claims persisted | 51 |
| verified by the pipeline's quote check | 51 / 51 |
| stripped (quote not found) | 0 |
| independently re-verified by the harness against the page text | 51 / 51 |

## Stay extraction

Matched 5 / 6 fixtures that carry an expected stay.

| fixture | mismatched field(s) |
|---|---|
| sg-18 | party |

### Known oracle issue: sg-18 headcount

The sg-18 fixture's expected stay records a party of 2, but the guest's email states no headcount. The pipeline extracted the dates and left the party size unset, which the oracle records as a mismatch. The raw result above is reported unchanged and still counts against the stay-extraction score.

The pipeline is not being changed to guess a headcount: a party size that is not in the guest's message is not a fact the inn can act on, and inferring one (for example from a room's default occupancy) would be exactly the kind of invented detail this evaluation exists to catch. The appropriate fix is to the oracle label, and the original oracle is kept immutable for this run.

## Per-fixture outcomes

| fixture | expected | outcome | ready | claims verified / total | stay | drafter / judge calls | pipeline ms |
|---|---|---|---|---|---|---|---|
| sg-01 | answerable | answerable_ready | yes | 2 / 2 | ok | 1 / 1 | 11996 |
| sg-02 | answerable | answerable_ready | yes | 1 / 1 | - | 1 / 1 | 5382 |
| sg-03 | answerable | answerable_ready | yes | 3 / 3 | - | 1 / 1 | 10691 |
| sg-04 | answerable | answerable_ready | yes | 2 / 2 | - | 1 / 1 | 11358 |
| sg-05 | answerable | answerable_ready | yes | 2 / 2 | - | 1 / 1 | 11333 |
| sg-06 | answerable | answerable_ready | yes | 1 / 1 | - | 1 / 1 | 7754 |
| sg-07 | answerable | answerable_ready | yes | 2 / 2 | - | 1 / 1 | 8159 |
| sg-08 | answerable | answerable_ready | yes | 2 / 2 | ok | 1 / 1 | 9744 |
| sg-09 | answerable | answerable_ready | yes | 1 / 1 | - | 1 / 1 | 9210 |
| sg-10 | answerable | answerable_ready | yes | 1 / 1 | - | 1 / 1 | 8376 |
| sg-11 | answerable | answerable_ready | yes | 3 / 3 | - | 1 / 1 | 16918 |
| sg-12 | answerable | answerable_ready | yes | 1 / 1 | - | 1 / 1 | 10834 |
| sg-13 | unanswerable | unanswerable_abstained | no | 0 / 0 | - | 1 / 0 | 2041 |
| sg-14 | unanswerable | unanswerable_abstained | no | 0 / 0 | - | 1 / 0 | 1957 |
| sg-15 | unanswerable | unanswerable_abstained | no | 0 / 0 | - | 1 / 0 | 2750 |
| sg-16 | unanswerable | unanswerable_abstained | no | 0 / 0 | - | 1 / 0 | 2133 |
| sg-17 | unanswerable | unanswerable_escalated | no | 1 / 1 | - | 1 / 0 | 3274 |
| sg-18 | needs_approval | approval_escalated | no | 1 / 1 | mismatch | 1 / 0 | 6123 |
| sg-19 | needs_approval | approval_escalated | no | 1 / 1 | - | 1 / 0 | 8518 |
| sg-20 | needs_approval | approval_escalated | no | 1 / 1 | - | 1 / 0 | 4410 |
| sh-01 | answerable | answerable_blocked | no | 1 / 1 | - | 1 / 1 | 9084 |
| sh-02 | answerable | answerable_ready | yes | 3 / 3 | - | 1 / 1 | 8948 |
| sh-03 | answerable | answerable_deferred | no | 1 / 1 | ok | 1 / 0 | 5073 |
| sh-04 | answerable | answerable_ready | yes | 1 / 1 | ok | 1 / 1 | 8696 |
| sh-05 | answerable | answerable_deferred | no | 2 / 2 | - | 1 / 0 | 8891 |
| sh-06 | answerable | answerable_blocked | no | 2 / 2 | - | 1 / 1 | 12693 |
| sh-07 | answerable | answerable_deferred | no | 1 / 1 | - | 1 / 0 | 6084 |
| sh-08 | answerable | answerable_deferred | no | 0 / 0 | - | 1 / 0 | 3819 |
| sh-09 | answerable | answerable_ready | yes | 2 / 2 | - | 1 / 1 | 9460 |
| sh-10 | answerable | answerable_ready | yes | 2 / 2 | - | 1 / 1 | 13438 |
| sh-11 | answerable | answerable_deferred | no | 1 / 1 | - | 1 / 0 | 10120 |
| sh-12 | answerable | answerable_deferred | no | 2 / 2 | - | 1 / 0 | 6627 |
| sh-13 | unanswerable | unanswerable_abstained | no | 0 / 0 | - | 1 / 0 | 4349 |
| sh-14 | unanswerable | unanswerable_escalated | no | 1 / 1 | - | 1 / 0 | 6245 |
| sh-15 | unanswerable | unanswerable_abstained | no | 0 / 0 | - | 1 / 0 | 5233 |
| sh-16 | unanswerable | unanswerable_abstained | no | 0 / 0 | - | 1 / 0 | 2780 |
| sh-17 | unanswerable | unanswerable_abstained | no | 0 / 0 | - | 1 / 0 | 2521 |
| sh-18 | needs_approval | approval_escalated | no | 3 / 3 | ok | 1 / 0 | 7274 |
| sh-19 | needs_approval | approval_escalated | no | 3 / 3 | - | 1 / 0 | 10285 |
| sh-20 | needs_approval | approval_escalated | no | 1 / 1 | - | 1 / 0 | 8596 |

## Raw oracle metrics (unmodified)

The numeric summary block as written by the harness. The only edit is that `unsafeReasons` entries are reduced to their kind (text before the first colon), because full reasons can embed quote fragments.

```json
{
  "fixtures": 40,
  "ran": 40,
  "answerable": {
    "total": 24,
    "ready": 16,
    "blockedByGate": 2,
    "overDeferred": 6,
    "errors": 0,
    "citesExpectedSource": 23
  },
  "unanswerable": {
    "total": 10,
    "abstained": 8,
    "escalated": 2,
    "answerAttemptedButBlocked": 0,
    "errors": 0
  },
  "needsApproval": {
    "total": 6,
    "escalated": 6,
    "deferred": 0,
    "answerAttemptedButBlocked": 0,
    "errors": 0
  },
  "unsafeReady": 0,
  "unsafeReasons": [],
  "errors": 0,
  "skippedBudget": 0,
  "stay": {
    "checked": 6,
    "matched": 5
  },
  "claims": {
    "total": 51,
    "verified": 51,
    "stripped": 0,
    "independentlyVerified": 51
  },
  "provider": {
    "drafterCalls": 40,
    "judgeCalls": 18,
    "unknownCalls": 0,
    "fixturesReachingDrafter": 40,
    "fixturesJudged": 18,
    "budgetPauses": 0,
    "strayRequests": 0
  },
  "totalMs": 303177
}
```

## Limitations

- This run exercises the real OpenAI provider through the app's own generation pipeline inside `convex-test`, seeded from scraped pages. It is not 40 production mail deliveries: no inbox was connected and nothing could be sent (the harness asserts the outbox and sent-replies tables stay empty).
- The oracle is a hand-written 40-item set; it is small and covers two inns only. Percentages above are descriptive, not statistically significant.
- One generation per fixture with no retries; a different run can produce different holds. Provider non-determinism is not averaged out.
- Held answerable inquiries are counted as holds. Whether each hold was warranted is a manual judgement and is not scored here.
- Answer content is not graded automatically; only outcome categories and mechanical citation checks are reported.
- Token usage and cost were not measured.

The original report is retained privately because it contains fixture text and generated answers. Only aggregate results and fixture identifiers are published here.
