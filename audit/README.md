# Scalius Commerce Audit

Audit refresh date: 2026-06-15, workspace timezone.

This folder is the working audit system for slice-by-slice remediation. It replaces the older broad report set because several prior findings had become stale, partially remediated, or too vague to hand to future agents safely.

## Files

- [AUDIT_REPORT.md](AUDIT_REPORT.md) - historical findings, evidence, stale-claim corrections, and simplification themes. Use the tracker for current open work.
- [REMEDIATION_TRACKER.md](REMEDIATION_TRACKER.md) - current actionable issue list for future fixing agents.
- [VERIFICATION_PLAYBOOK.md](VERIFICATION_PLAYBOOK.md) - commands and manual flows to verify fixes when full local dev is difficult.
- [PORTION_REWRITE_CHECKLIST.md](PORTION_REWRITE_CHECKLIST.md) - the checklist to use when rewriting one portion at a time.
- [AGENT_HANDOFFS.md](AGENT_HANDOFFS.md) - recommended ownership slices and prompts for future agents.
- [STALE_OR_SUPERSEDED_CLAIMS.md](STALE_OR_SUPERSEDED_CLAIMS.md) - old audit claims that should not be repeated without fresh evidence.

## Current Validation Snapshot

- `CI=true pnpm install --frozen-lockfile` passes with pnpm 11.6.0.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check:env`, and `pnpm check:dist-secrets` pass at the repo root. Root ESLint is warning-free across the seven code workspaces.
- `pnpm test` currently passes: 127 files and 800 tests.
- `pnpm --filter @scalius/database check:migrations` passes: 42 SQL files, 42 journal entries, 27 snapshots, and 15 allowed manual snapshot gaps.
- `pnpm outdated -r` reports only the intentional storefront Vite pin: `vite@7.3.5` versus latest Vite 8. Latest `astro@6.4.6` and `@astrojs/cloudflare@13.7.0` package metadata still depend on `vite@^7.3.2`.
- Current auth/cache/performance hardening gates pass: focused 2FA trusted-device/pending-method tests, focused cache-invalidation tests, storefront purge-cache route tests, delivery-provider cache invalidation tests, order-detail prefetch resilience tests, affected API/admin/storefront typechecks and lints, root tests/lint/typecheck/build, env checks, dist-secret checks, migration metadata, audit, peer checks, and live browser smoke.
- Local stack smoke passed with API/admin/storefront dev servers: local migrations had no pending changes, `pnpm dev:doctor --require-running` passed after warmup, browser `/admin`, browser `/admin/orders/T1TNN3`, browser storefront `/`, and HTTP API/admin/storefront probes returned 200. The only local doctor warning was Node 24.13.1 versus the repo's Node 22 preference.
- Latest full `pnpm deploy` passed after the `ADMIN-012` order-detail provider-warmup slice and redeployed API `dac019eb-05ed-4471-a000-a3a0ec545748`, admin `abc5d3fa-dfb2-4d1d-b75a-64088fffbfb2`, and storefront `8e8ce72f-9cd7-46ed-8713-16304fef2028`.
- Live checks covered API setup, dashboard login page, authenticated `/admin`, `/admin/orders`, `/admin/orders/P8RI6O`, storefront `/`, storefront `/search`, and direct storefront purge-cache GET checks. No checked page showed concrete error-boundary text or new console/runtime errors.
- The live storefront missing-image issue was fixed after the smoke pass: the homepage no longer references `https://cloud.scalius.com/zLPBsNbtJCMxTkfPAPHcr.png`, and the replacement primary product image returns `200 image/png`.
- Several hard-to-run flows still require Wrangler, queues, Cache API behavior, service bindings, provider sandboxes, or deployed Worker testing.

## How To Use This Folder

1. Pick one tracker item or one coherent domain slice.
2. Read the relevant section in [AUDIT_REPORT.md](AUDIT_REPORT.md).
3. Use [PORTION_REWRITE_CHECKLIST.md](PORTION_REWRITE_CHECKLIST.md) before editing.
4. Add or update focused tests before changing behavior when feasible.
5. Run the smallest meaningful verification from [VERIFICATION_PLAYBOOK.md](VERIFICATION_PLAYBOOK.md).
6. Update [REMEDIATION_TRACKER.md](REMEDIATION_TRACKER.md) with status, owner, commit/PR, and verification evidence.
7. Update `AGENTS.md` only when the fix changes a real convention, architecture rule, command, or limitation.

## Ground Rules

- Do not hand-edit generated files: `apps/admin-v2/src/routeTree.gen.ts` or `packages/api-client/src/generated/**`.
- Do not read or print real `.dev.vars` or `.env.development` contents.
- Preserve unrelated dirty work.
- Treat every old finding as a hypothesis until re-verified against current code.
- Prefer focused remediation over broad refactors. The goal is a codebase that becomes more reliable after each slice.
