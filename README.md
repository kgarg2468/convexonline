# Front Desk

The email front desk for independent inns that live in their inbox. Guest email
is classified, drafted from the inn's own website, verified claim-by-claim
against verbatim quotes, and sent by staff from a realtime workspace. When the
website changes, every reply already sent is re-checked and the ones whose cited
passage no longer holds are flagged for a correction in the guest's thread.

## Stack

- Convex backend and realtime queries; the SPA is served from the same
  deployment through `@convex-dev/static-hosting` (app HTTP routes under `/api`).
- Convex Auth: password sign-in for staff, anonymous sign-in for the judge demo.
  Demo visitors get a private seeded inn and can never send live mail.
- React 19 + Vite + TypeScript frontend.
- Vitest + `convex-test` for backend tests.

## Layout

| Path | What |
|---|---|
| `convex/schema.ts` | Tables and indexes (inns, memberships, pages, pageVersions, threads, messages, drafts, claims, sentReplies, staffFacts, corrections, followUps) |
| `convex/lib/` | Pure domain logic: quote normalization/verification, tenant rules, claim locks, source-change partition |
| `convex/access.ts` | Auth + tenant guards used by every query and mutation |
| `convex/threads.ts`, `drafts.ts`, `facts.ts`, `pages.ts`, `corrections.ts`, `inns.ts` | Staff workspace API |
| `convex/demo.ts` | Per-visitor demo inn seeding and the scripted policy-page change |
| `convex/http.ts` | `/api/health` and Convex Auth well-known routes |
| `src/` | App shell: sign-in, queue, thread detail, corrections review |
| `tests/` | Auth denial, tenant isolation, claim races, quote verification, source-change controls |

## Scripts

```bash
npm run dev          # Vite dev server (run `npx convex dev` alongside)
npm run typecheck    # tsc -b (app, node, tests + convex)
npm run lint         # oxlint
npm test             # vitest (edge-runtime + convex-test)
npm run build        # tsc -b && vite build
npm run deploy       # convex deploy + static upload to prod
```

## Deployment notes

- First push: `npx convex dev --once --configure=new --project <name>` writes
  `.env.local` (`CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`)
  and regenerates `convex/_generated/` with full component types.
- Convex Auth needs `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL` on every
  deployment: run `npx @convex-dev/auth` (dev) and again with `--prod`.
- Because app routes are mounted under `/api`, `convex/auth.config.ts` points
  the JWKS URL at `/api/.well-known/jwks.json` explicitly (custom JWT provider).
- Missing keys fail closed: the frontend shows an "unavailable" screen without a
  Convex URL, and no provider is called without its key.
