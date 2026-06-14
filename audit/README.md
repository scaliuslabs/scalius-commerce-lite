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
- `pnpm test` currently passes: 115 files and 748 tests.
- `pnpm --filter @scalius/database check:migrations` passes: 41 SQL files, 41 journal entries, 26 snapshots, and 15 allowed manual snapshot gaps.
- Current auth/dashboard hardening gates pass: admin/API/api-client/root typechecks, focused API auth-management tests, dashboard chart-data test, root tests/lint/build, migration metadata check, audit, peers, frozen install, and dist-secret checks.
- Local stack smoke passed after `pnpm dev`: local migration `0040`, `pnpm dev:doctor --require-running`, storefront `/`, `/cart`, `/checkout`, direct local admin sign-in, browser `/admin`, and `/admin/orders`.
- Full `pnpm deploy` passed and redeployed API `4e191a10-8a56-4f60-83c7-ebdd9e431e5e`, admin `1fa6e70f-df67-4282-be0a-dd5abb2aecfa`, and storefront `6f5c4744-9fba-4185-8571-9c37140289eb`; remote D1 migration `0040` was already applied and the final redeploy reported no pending migrations.
- Live dashboard login with `demo@scalius.com` succeeded and browser `/admin` plus `/admin/orders` loaded with no captured console errors.
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
