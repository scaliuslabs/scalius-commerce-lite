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
- `pnpm test` currently passes: 128 files and 802 tests.
- `pnpm --filter @scalius/database check:migrations` passes: 42 SQL files, 42 journal entries, 27 snapshots, and 15 allowed manual snapshot gaps.
- `pnpm outdated -r` reports only the intentional storefront Vite pin: `vite@7.3.5` versus latest Vite 8. Latest `astro@6.4.6` and `@astrojs/cloudflare@13.7.0` package metadata still depend on `vite@^7.3.2`.
- Current auth/cache/performance hardening gates pass: focused 2FA trusted-device/pending-method tests, focused cache-invalidation tests, API cache route tests, storefront purge-cache route tests, delivery-provider cache invalidation tests, order-detail prefetch resilience tests, ADMIN-013 mutation import-boundary scans, orders lazy interaction chunk scans, affected API/admin/storefront typechecks and lints, root tests/lint/typecheck/build, env checks, dist-secret checks, migration metadata, audit, peer checks, local browser smoke, and live browser smoke.
- Local stack smoke passed with API/admin/storefront dev servers: local migrations had no pending changes, `pnpm dev:doctor --require-running` passed after warmup, browser `/admin/settings/cache`, cache clear actions, storefront `/`, and storefront `/search` passed without recent console errors. The only local doctor warning was Node 24.13.1 versus the repo's Node 22 preference.
- Latest full `pnpm deploy` passed after the `PERF-003` orders delete-confirmation lazy-loading slice and redeployed API `5dced253-da48-43a2-ad55-c9b0a1364e09`, admin `bc5d7d25-e614-4a4d-9e51-222de052550f`, and storefront `3a7a38c6-b4b4-4a1c-873f-a965b13b81bc`.
- Live checks covered API setup, demo sign-in through `POST /api/auth/sign-in/email`, authenticated `/admin/settings/cache`, authenticated `/admin/orders`, storefront `/`, storefront `/search`, and direct storefront purge-cache GET checks. No checked page showed concrete error-boundary text or new console/runtime errors after the final deploy.
- Latest local and live performance smokes covered `/admin/orders`: plain page load made no initial `DateRangePickerWithPresets`, `react-day-picker`, `BulkShipDialog`, `DeleteOrderDialog`, `OrderItemsPopover`, or `FraudCheckIndicator` module request; first date-picker, item-popover, fraud-check, delete-confirmation, and selected-order bulk-ship interactions loaded their real modules on demand locally with no console/page errors; live first-click checks loaded `OrderItemsPopover-TGEk5ypy.js`, `FraudCheckIndicator-BGNu5eia.js`, and `DeleteOrderDialog-CLejLc-t.js` only after interaction.
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
