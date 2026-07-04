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
- `pnpm test` currently passes: 321 files and 2162 tests.
- `pnpm --filter @scalius/database check:migrations` passes: 76 SQL files, 76 journal entries, 32 snapshots, and 44 allowed manual snapshot gaps.
- Current frontend/runtime toolchain baseline is Astro `^7.0.0`, `@astrojs/cloudflare` `^14.0.0`, Vite `^8.1.0`, and Wrangler `4.104.0`. Use a fresh `pnpm outdated -r` plus peer/typecheck/build/dev smoke evidence before dependency sweeps.
- Current auth/cache/performance hardening gates pass: focused 2FA trusted-device/pending-method tests, focused cache-invalidation tests, API cache route tests, storefront purge-cache route tests, delivery-provider cache invalidation tests, order-detail prefetch resilience tests, ADMIN-013 mutation import-boundary scans, RBAC/account-context tests, orders lazy interaction chunk scans, DataTable sortable chunk scans, discount edit type-specific chunk smokes, media/widget/rich-editor/product-form/product-variant/settings lazy chunk smokes, collection/discount picker targeted-lookup tests, affected API/admin/storefront typechecks and lints, root tests/lint/typecheck/build, env checks, dist-secret checks, migration metadata, audit, peer checks, frozen install, local browser smoke, and live browser smoke.
- Latest local stack smoke used API/admin/storefront dev servers: `/admin/settings/account` rendered `Account Settings`, Security/Password/Team/Roles were visible to the verified admin context, the Team tab opened without console errors, storefront `/` rendered without an error shell, and `pnpm dev:doctor --require-running` passed with only the local Node 24 versus `.nvmrc` Node 22 warning.
- Latest OPS-006 local post-sale smoke uses `scripts/dev-postsale.mjs` against disposable Wrangler state only. It verifies fixture seeding, cart validation, COD order creation, idempotent replay, receipt read, support-request creation, bounded COD order load (`50/50` `201`, concurrency `5`, p95 `181.5ms`), OTP fail-closed readiness with zero pending challenges when delivery credentials are dummy/unconfigured, and online gateway readiness fail-closed behavior (`503` for unconfigured Stripe/SSLCommerz/Polar with zero `payment_plans` or `payment_session_attempts`). Expected readiness failures now log as compact one-line `[api-error]` warnings instead of stack traces. Production mutation smokes remain disallowed; live checks stay read-only.
- Latest API runtime deploy is `3a023022-ad7a-410f-9351-730b7e2efbdb` from the INV-003 admin manual-order rollback follow-up. Cloudflare reported Worker startup time `147ms`; live read-only checks passed for API health, `/readyz` (`ready`, all checks ok), and OpenAPI (`269` paths / `367` operations, `POST /api/v1/orders` and `POST /api/v1/admin/orders` present). The previous PERF-011 deploy `a410bbc6-0eb7-4b69-8cd5-3e8b2d7208c1` remains the latest public search/cache-cost policy proof, the PERF-010 deploy `f9cdb388-9e46-4e52-890e-0db1752dcea4` remains the latest remote D1 product-listing plan proof for the storefront listing indexes, and the earlier OPS-006/PERF-012 deploy `da0da14c-9c9e-4f00-9595-1f1a26fa07b6` remains the latest disposable local post-sale smoke evidence.
- Latest full deploy passed after the scheduled cache-purge reliability slice, redeploying API `7f1ad12c-4ae5-49be-8828-d614f1ba139a`, admin `9311b19c-bad9-466a-8fd8-9aa04e758ae7`, and storefront `14cef7ec-a259-4a44-84f3-f44459682787`.
- Live checks after the latest deploy covered API setup, OpenAPI (`257` paths / `355` operations), unauthenticated dashboard `/admin/settings/account` redirect, demo sign-in through `POST /api/auth/sign-in/email` with `Set-Cookie`, authenticated dashboard `/admin/settings/account`, storefront `/`, and storefront HTML/error-string checks. No checked production dashboard/storefront page captured fresh error markers. No production data was saved.
- Latest local and live performance smokes covered `/admin/orders`, drag-enabled `/admin/collections`, discount editing, media pickers, widget create, rich-text form editors, product-form image/additional-info sections, product-variant interaction tools, General Settings Header/Footer hidden subtabs, and collection/discount picker targeted lookups. Plain orders page load made no initial `DateRangePickerWithPresets`, `react-day-picker`, `BulkShipDialog`, `DeleteOrderDialog`, `OrderItemsPopover`, `FraudCheckIndicator`, `SortableDataTableContent`, or `sortable.esm` module request. Local drag-enabled collections loaded `SortableDataTableContent.tsx` plus `@dnd-kit` deps on demand; live drag-enabled collections loaded `SortableDataTableContent-BdEuf433.js` and `sortable.esm-CsHTWzZ-.js` only on that route. Local discount edit smoke covered `amount_off_order`, `free_shipping`, and `amount_off_products`; each loaded only its matching form, product/collection selectors loaded only for `amount_off_products`, and selected IDs now resolve through targeted by-id endpoints. Collection create/edit now preloads category options plus stored product summaries only; product pickers lazy-load paginated search on open. Media picker smokes covered `/admin/products/new`, `/admin/media`, and `/admin/settings/hero-sliders`; widget smokes covered paste, preview iframe, and copy-prompt without saving production data. Rich-text smokes proved product/category/page forms initially load `DeferredTiptapEditor` only. Product-form smokes prove `AdditionalInfoManager` and `sortable.esm` load only after `Additional Sections`; `DraggableImageGallery` is not in the initial live product-form assets. Product-variant smokes prove `BulkVariantGenerator`, `VariantSortModal`, and CSV helpers are lazy/on-demand rather than static product edit imports. Settings chunk scans prove `HeaderBuilder`/`FooterBuilder` do not statically import hidden social/navigation sections, `NavigationBuilder`, or sortable navigation tooling.
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
