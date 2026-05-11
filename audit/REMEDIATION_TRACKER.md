# Scalius Commerce Remediation Tracker

Date started: 2026-04-22
Owner: Codex + subagent team
Source: full audit set in [`audit/`]( /Users/arob/Desktop/open/scalius-commerce-lite/audit )

## Mission

Turn the audit into a fix-and-verify campaign that improves:

- production safety
- business-logic correctness
- local developer experience
- end-to-end reliability across admin, API, and storefront

This is not a paper exercise. Every fix batch should end with:

1. targeted tests
2. typecheck/build where appropriate
3. local flow verification
4. Computer Use validation for admin/storefront UX where the flow is browser-visible

## Operating Rules

1. Fix the highest-risk trust-boundary and data-integrity issues before lower-severity cleanup.
2. Prefer code changes that reduce whole classes of bugs over narrow patches.
3. Keep local dev reliable while fixing product logic. If a fix makes local run worse, stop and correct that first.
4. Use runtime env and official framework/runtime guidance when the code touches Cloudflare Workers, Hono, TanStack Start, Astro SSR, Drizzle, or Turborepo behavior.
5. Do not trust passing tests alone. The current suite includes many shadow-model tests; browser and route-level verification are required.
6. Use deployed testing only when a third-party integration cannot be meaningfully exercised locally.

## Required Skills By Area

- Monorepo / scripts / task graph: `turborepo`
- Admin route/data architecture: `tanstack-start`
- API / route contracts / middleware: `hono-cf`
- Database / schema / migrations: `drizzle`
- Worker runtime / bindings / config: `workers-best-practices`

If a subagent is assigned a slice that touches one of these areas, explicitly remind it to use the matching skill before concluding its work.

## Priority Order

### Wave 0: Reproduce and stabilize local development

Goal:

- `pnpm dev` should boot reliably
- admin, storefront, and API should load locally without manual rescue steps
- known local blockers should be documented and then fixed

Target areas:

- dev scripts and process cleanup
- wrangler/env typing drift
- service-binding local fallback behavior
- local auth/token flows
- cache and session behavior in local mode

### Wave 1: Active security and privacy risks

Fix first:

1. Admin API 2FA bypass
2. Scanner bearer-token/device-binding gap
3. Public `order-success` order-detail exposure
4. Public checkout-language CRUD exposure
5. Homepage widget sanitizer bypass/XSS path
6. RBAC unmapped-route fallback behavior

### Wave 2: Data integrity and business-logic correctness

Fix next:

1. non-atomic order/inventory/payment/COD/refund transitions
2. queue reservation/orphan-hold issues
3. payment confirmation lost-update races
4. refund orchestration errors for split payments
5. failed-payment/successful-confirmation suppression
6. admin GET endpoints with hidden destructive behavior

### Wave 3: Schema and configuration trustworthiness

Fix next:

1. Drizzle schema vs replayed migration drift
2. missing FK / delete-behavior enforcement
3. timestamp default mismatches
4. contradictory nullability / FK semantics
5. secrets encryption/decryption mismatches across settings consumers
6. plaintext storage of high-value credentials

### Wave 4: Storefront/admin product correctness and cache invalidation

Fix next:

1. content writes not purging storefront caches
2. `publishedAt` ignored in public publishing paths
3. category/search/product drift in storefront queries
4. admin shell permission-context inconsistencies
5. multi-gateway checkout/cart handoff drift
6. logout/session-clearing correctness

### Wave 5: Contract, testing, and maintainability hardening

Fix next:

1. stale response-envelope tests
2. fragmented SDK/manual/fetch contract surface
3. wildcard CORS overmatch
4. non-atomic rate limiting
5. route-level typing escapes and `any` holes
6. missing admin lint coverage and weak integration coverage

## Current Backlog

### P0 / P1 candidates to resolve before broader cleanup

- Admin API accepts sessions without checking `twoFactorVerified`
- Scanner token device binding is not enforced by API middleware
- `/order-success` exposes order/customer data via privileged SSR fetch
- Public checkout-language create/update/delete routes are exposed
- Homepage consolidated widget path bypasses sanitizer and renders raw HTML/CSS
- RBAC route map drift leaves many admin endpoints on weak fallback auth
- Order/inventory/payment/refund side effects are not reliably atomic
- Queue ingest can reserve stock for rejected/non-persisted orders
- D1 migration replay does not match current Drizzle schema
- Settings encryption/decryption mismatches break runtime integrations

## Implementation Pattern Per Fix Batch

For each issue or small cluster:

1. Reproduce the bug locally if possible.
2. Add or adjust the narrowest meaningful test coverage first.
3. Fix the code.
4. Run the smallest relevant test slice.
5. Re-run the local user flow in browser.
6. Capture what was fixed and any remaining risk in this tracker or the matching audit file if needed.

## Status Ledger

Use this section as the running ledger for future turns.

### Not started

- Wave 0 local-dev reproduction
- Wave 1 security/privacy fixes
- Wave 2 data-integrity fixes
- Wave 3 schema/configuration fixes
- Wave 4 product/cache/admin/storefront fixes
- Wave 5 contract/test hardening

### In progress

- creating persistence docs for continuation and compaction safety

### Completed

- full 13-slice audit written
- root audit index written

## Local Commands To Reuse

- `pnpm dev`
- `pnpm dev:admin`
- `pnpm dev:storefront`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm --filter @scalius/storefront typecheck`
- `pnpm --filter @scalius/database typecheck`
- `pnpm exec drizzle-kit check --config packages/database/drizzle.config.ts`

## Deploy Policy

Use `pnpm run deploy` only when a scenario truly requires remote validation:

- hosted payment gateway callback loops
- provider webhooks that cannot be simulated locally with confidence
- remote-only service binding or domain/cookie behavior
- third-party admin/provider settings verification that depends on production-like origins

When remote validation is needed, test locally first, then deploy, then verify the exact remote-only flow.
