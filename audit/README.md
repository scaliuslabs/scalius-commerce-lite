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
- `pnpm test` currently passes: 129 files and 808 tests.
- `pnpm --filter @scalius/database check:migrations` passes: 42 SQL files, 42 journal entries, 27 snapshots, and 15 allowed manual snapshot gaps.
- `pnpm outdated -r` reports only the intentional storefront Vite pin: `vite@7.3.5` versus latest Vite 8. Latest `astro@6.4.6` and `@astrojs/cloudflare@13.7.0` package metadata still depend on `vite@^7.3.2`.
- Current auth/cache/performance hardening gates pass: focused 2FA trusted-device/pending-method tests, focused cache-invalidation tests, API cache route tests, storefront purge-cache route tests, delivery-provider cache invalidation tests, order-detail prefetch resilience tests, ADMIN-013 mutation import-boundary scans, orders lazy interaction chunk scans, DataTable sortable chunk scans, discount edit type-specific chunk smokes, media/widget/rich-editor/product-form/product-variant/settings lazy chunk smokes, affected API/admin/storefront typechecks and lints, root tests/lint/typecheck/build, env checks, dist-secret checks, migration metadata, audit, peer checks, local browser smoke, and live browser smoke.
- Local stack smoke passed with API/admin/storefront dev servers: local migrations had no pending changes, `pnpm dev:doctor --require-running` passed after warmup, browser `/admin/settings` rendered General Settings, opened Header `Contact & Social`, Header `Navigation`, Footer default Branding, and Footer `Navigation Menus`, and storefront `/` loaded with no captured console errors. The only local doctor warning was Node 24.13.1 versus the repo's Node 22 preference.
- Latest full `pnpm deploy` passed after the General Settings Header/Footer hidden-subtab deferral slice, redeploying API `121e0a9b-ac03-4e97-a7d4-604f171a6e28`, admin `62110591-ee90-4074-b2f9-09c523280b09`, and storefront `83a51690-c5b9-4ca5-af4f-2a0125518a85`.
- Live checks after the latest deploy covered API setup, public product list, unauthenticated dashboard redirect, `POST /api/auth/sign-in/email` returning 403 without `Origin` and 200 with dashboard `Origin` plus session cookie for `demo@scalius.com`, authenticated `/admin/settings` Header `Contact & Social`, Header `Navigation`, Footer default Branding, Footer `Navigation Menus`, and storefront `/`. No checked page captured fresh console errors. No production settings/storefront data was saved.
- Latest local and live performance smokes covered `/admin/orders`, drag-enabled `/admin/collections`, discount editing, media pickers, widget create, rich-text form editors, product-form image/additional-info sections, product-variant interaction tools, and General Settings Header/Footer hidden subtabs. Plain orders page load made no initial `DateRangePickerWithPresets`, `react-day-picker`, `BulkShipDialog`, `DeleteOrderDialog`, `OrderItemsPopover`, `FraudCheckIndicator`, `SortableDataTableContent`, or `sortable.esm` module request. Local drag-enabled collections loaded `SortableDataTableContent.tsx` plus `@dnd-kit` deps on demand; live drag-enabled collections loaded `SortableDataTableContent-BdEuf433.js` and `sortable.esm-CsHTWzZ-.js` only on that route. Local discount edit smoke covered `amount_off_order`, `free_shipping`, and `amount_off_products`; each loaded only its matching form, and product/collection selectors loaded only for `amount_off_products`. Live discount edit smoke covered the existing `amount_off_order` discount and loaded only `AmountOffOrderForm`. Media picker smokes covered `/admin/products/new`, `/admin/media`, and `/admin/settings/hero-sliders`; widget smokes covered paste, preview iframe, and copy-prompt without saving production data. Rich-text smokes proved product/category/page forms initially load `DeferredTiptapEditor` only. Product-form smokes prove `AdditionalInfoManager` and `sortable.esm` load only after `Additional Sections`; `DraggableImageGallery` is not in the initial live product-form assets. Product-variant smokes prove `BulkVariantGenerator`, `VariantSortModal`, and CSV helpers are lazy/on-demand rather than static product edit imports. Settings chunk scans prove `HeaderBuilder`/`FooterBuilder` do not statically import hidden social/navigation sections, `NavigationBuilder`, or sortable navigation tooling.
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
