# Scalius Commerce Audit Index

Date: 2026-04-22

This folder contains a full 13-slice audit of the Scalius Commerce monorepo, covering runtime architecture, database foundations, auth/RBAC, core order and payment logic, public and admin APIs, admin UI, storefront behavior, and shared contracts/tests.

## Coverage

- [01-repo-architecture-runtime.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/01-repo-architecture-runtime.md) reviews Turborepo task graph correctness, Worker runtime composition, bindings, deploy flow, and cache/runtime drift.
- [02-database-migrations.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/02-database-migrations.md) reviews Drizzle schema, replayed SQLite/D1 migration reality, constraints, defaults, and integrity drift.
- [03-auth-rbac-security.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/03-auth-rbac-security.md) reviews Better Auth, RBAC, scanner auth, customer auth, JWT/token flows, and security boundaries.
- [04-orders-inventory.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/04-orders-inventory.md) reviews order creation, queue ingest, inventory reservation/deduction/release, fulfillment, refunds, and CAS correctness.
- [05-payments-delivery-notifications.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/05-payments-delivery-notifications.md) reviews payment initiation, webhook processing, refund orchestration, delivery sync, and notification fan-out.
- [06-catalog-content.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/06-catalog-content.md) reviews products, categories, collections, pages, widgets, media, storefront composition, and content invalidation.
- [07-settings-integrations-analytics-ai.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/07-settings-integrations-analytics-ai.md) reviews settings storage, encryption/decryption paths, provider registries, analytics, and OpenRouter/AI config.
- [08-api-public.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/08-api-public.md) reviews the public API surface, auth exposure, cache behavior, schema/runtime mismatches, and proxy risks.
- [09-api-admin.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/09-api-admin.md) reviews the admin API route graph, RBAC coverage, route-layer business logic, and handler/runtime drift.
- [10-admin-shell-data.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/10-admin-shell-data.md) reviews TanStack Start shell behavior, auth context, query/mutation transport, and admin data-layer consistency.
- [11-admin-workflows.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/11-admin-workflows.md) reviews admin route workflows, 2FA gating, invoice/scanner access, workflow permissioning, and screen-to-API mismatches.
- [12-storefront-app.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/12-storefront-app.md) reviews SSR/runtime env wiring, storefront caching, cart/checkout/account flows, order-success privacy, logout, and SEO drift.
- [13-shared-contracts-tests.md](/Users/arob/Desktop/open/scalius-commerce-lite/audit/13-shared-contracts-tests.md) reviews shared helpers, SDK/OpenAPI contract edges, CORS helper behavior, rate limiting, and the real value of the current test suite.

## Highest-Priority Risks

1. Admin 2FA is not enforced at the real API boundary, so password-only admin sessions can call `/api/v1/admin/*` directly.
2. Scanner auth is effectively a bearer-token inventory admin path because the API worker does not enforce the device-binding claim.
3. The public `order-success` page can expose full order/customer details by `orderId` through the storefront's privileged service-auth path.
4. Public checkout-language mutation endpoints are mounted without auth, which exposes storefront-critical configuration changes to the internet.
5. Order, inventory, payment, COD, and refund flows still have several non-atomic side-effect paths that can diverge stock/payment state from order state.
6. The replayed D1 schema materially drifts from the current Drizzle schema, including timestamp defaults, missing foreign keys, and constraint mismatches.
7. Secret-handling is inconsistent across settings and runtime consumers, and several encrypted settings can break live email, SMS, AI, and delivery integrations after normal admin edits.
8. Homepage widgets bypass the sanitizer on the consolidated storefront path and are rendered with `set:html`, creating a live XSS path.
9. Admin RBAC coverage has drifted badly from the mounted route graph, leaving many endpoints protected only by the weak fallback gate.

## Verification Snapshot

- Root `pnpm typecheck` passed.
- Root `pnpm build` passed.
- Root `pnpm test` passed with 9 files and 143 tests, but the shared/tests audit concludes many of those tests are shadow-model tests rather than real implementation coverage.
- `pnpm lint` did not provide trustworthy full-repo coverage because admin is missing a lint script and API lint still failed.
- Slice-specific checks also passed where run, including storefront typecheck, shared/api-client typechecks, and a targeted Vitest pass in the orders/inventory slice.

## Recommended First Response

1. Lock down the active security/privacy issues first: admin 2FA enforcement, scanner token enforcement, order-success exposure, and public checkout-language CRUD.
2. Stabilize data integrity next: fix non-atomic inventory/payment/order paths and repair schema-vs-migration drift before more logic piles on top.
3. Repair trust boundaries and configuration safety after that: RBAC map coverage, secret encryption/decryption consistency, and storefront/widget cache/content safety.
