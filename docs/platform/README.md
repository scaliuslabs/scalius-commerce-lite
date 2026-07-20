# Platform Engineering Notes

Last reviewed: 2026-07-14

This folder contains concise engineering context. Treat source code, tests, deployed behavior, fresh command output, and GitHub issues as the source of truth; older prose can be stale.

## Files

- `PLATFORM-GOAL.md` - product, architecture, and stable-release bar.
- `catalog/README.md` - current catalog hardening audit, evidence, decisions, and implementation order.
- `catalog/RICH-DEMO-STORE-BLUEPRINT.md` - exact rich-demo assortment and API-safe population/verification plan.
- `content/README.md` - Pages, Media, navigation/presentation, Theme, Analytics, Tax, and remaining settings hardening program.
- `content/NAVIGATION-AUTHORITY.md` - accepted reusable-menu, placement,
  publication, lifecycle, cache, migration, and rollback architecture for
  large-store navigation; normalized authority and cutover are implemented.
- `content/NAVIGATION-DRAG-INTERACTION.md` - accepted tree hitboxes, visual
  feedback, outdent/root behavior, exact Move dialog, and verification matrix.
- `INTERFACE-COPY-DENSITY.md` - accepted admin copy hierarchy, progressive
  disclosure, tooltip, helper-text, and density review contract.
- `ADMIN-ROUTE-STATE.md` - canonical URL-state, refresh/share/back-forward,
  sensitive-state exclusion, and global-search destination contract.
- `ADMIN-ROUTE-AUDIT.md` - adoption inventory for route-backed admin
  workspaces, deliberate transient-state exclusions, and remaining gaps.
- `GLOBAL-ADMIN-SEARCH.md` - research gate, deterministic local/API search
  architecture, ranking, performance, accessibility, and prototype criteria.
- `INVENTORY-ORDERS-COMPETITIVE-AUDIT.md` - verified Shopify, Medusa, and Adobe inventory/order benchmark with prioritized Scalius gaps.
- `ORDER-OPERATIONS-AUDIT.md` - code-backed order-admin workflow, domain, RBAC, failure-state, and implementation audit.
- `ITEM-LEVEL-RETURNS.md` - durable return lifecycle, inventory disposition, recovery, and deletion/status boundaries.
- `INVOICE-AUTHORITY.md` - explicit idempotent invoice issuance, atomic numbering, immutable historical snapshots, and draft/read rules.
- `CUSTOMER-REQUEST-POLICY.md` - merchant operational controls for buyer cancellation, return, and refund request visibility and eligibility.
- `TAX-LIFECYCLE-INVARIANTS.md` - authoritative enabled-tax readiness and the
  atomic D1 mutation boundary that preserves it across settings, class, and
  rate changes.
- `CHECKOUT-FLOW-CONTRACT.md` - checkout-setting authority, buyer/runtime
  effects, mandatory-phone and fail-closed invariants, admin interaction
  contract, and remaining release gaps.
- `PAYMENT-METHOD-READINESS.md` - COD, Stripe, SSLCommerz, and Polar
  setup/provider/environment/selection/flow/health/buyer projection matrix.
- `settings/PROVIDER-MARKS-AUDIT.md` - provider-by-provider official asset,
  trademark constraint, neutral fallback, code location, and adoption contract
  for payment, delivery, analytics, notification, SMS, and fraud settings.
- `settings/CACHE-INVALIDATION-AUDIT.md` - settings mutation dependency matrix
  for API/storefront cache groups, exact generations, HTML effects, warm paths,
  and focused proof.
- `COMMERCE-SETTINGS-BENCHMARK.md` - benchmark-backed replacement decisions,
  edge cases, UI information architecture, migration stance, and implementation
  order for Promotions, Tax, Checkout/Payments, Theme, and Account/Users.

## Toolchain Rules

- TypeScript 7 migration keeps root `typescript` on 6.x for JS compiler API consumers (`typescript-eslint`, Astro/Volar/`@astrojs/check`, `openapi-ts`/`tsx` as needed) and uses the root `typescript7` alias to `npm:typescript@7.0.2` as the stable TS7 compiler path.
- Non-Astro package `typecheck` scripts run `../../node_modules/typescript7/bin/tsc --noEmit`; storefront stays on `astro check` until embedded-language tooling supports TS7 programmatic APIs.
- Do not use `@typescript/native-preview`/`tsgo` for the stable path.

## Rules For Updating

- Update these notes after a meaningful codebase discovery, fix, deploy, or browser verification.
- Mark an issue as verified only after the relevant local or production browser/API flow has settled and been checked.
- Keep notes concise and factual. Link to code paths and commits instead of copying large implementation details.
