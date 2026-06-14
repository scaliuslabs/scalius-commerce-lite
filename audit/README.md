# Scalius Commerce Audit

Audit refresh date: 2026-06-14, workspace timezone.

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
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check:env`, and `pnpm check:dist-secrets` pass at the repo root. Lint still reports warnings only.
- `pnpm test` currently passes: 119 files and 764 tests.
- `pnpm --filter @scalius/database check:migrations` passes: 42 SQL files, 42 journal entries, 27 snapshots, and 15 allowed manual snapshot gaps.
- `pnpm outdated -r` reports only the intentional storefront Vite pin: `vite@7.3.5` versus latest Vite 8 while Astro 6.4.x remains on the Vite 7 line.
- Current auth/dashboard hardening gates pass: admin/API/api-client/root typechecks, focused API auth-management tests, dashboard chart-data test, root tests/lint/build, migration metadata check, audit, peers, frozen install, and dist-secret checks.
- Local stack smoke passed with API/admin/storefront dev servers: local migration `0041`, `pnpm dev:doctor:all`, browser `/admin` using split dashboard summary/activity calls, and browser storefront `/`.
- Full `pnpm deploy` passed after the dashboard split/index slice and redeployed API `d25ebe15-971e-409e-bcfd-b5d15c6702e6`, admin `3af1362d-cfe5-4722-94f6-0a3c44a5f6ae`, and storefront `8976c406-b367-40d8-a39c-a795bd5d6862`; remote D1 migration `0041` is applied and `customers_dashboard_activity_idx` exists remotely.
- Live dashboard login with `demo@scalius.com` succeeded. Browser `/admin`, browser `/admin/orders`, live storefront `/`, and authenticated dashboard summary/activity/legacy API endpoints all loaded with no captured console errors or 500 pages.
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
