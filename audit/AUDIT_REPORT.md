# Historical Audit Report and Verification Summary

This report is based on a fresh read of the codebase, focused commands, and read-only subagent audits. It is intentionally issue-oriented so future agents can fix one slice at a time.

## Executive Summary

The codebase is workable and the monorepo shape is mostly coherent: TanStack Start admin, Hono API Worker, Astro storefront, shared core/database/api-client packages, Cloudflare Workers runtime, D1, queues, KV/R2, and generated OpenAPI SDK.

The original highest risks were not "wrong stack" problems. They were boundary and workflow problems:

- Public or weakly authorized flows expose sensitive operations or data.
- Order/payment/delivery workflows have side effects before durable local claims or CAS updates.
- Some generated/runtime contracts drift because types, SDKs, migrations, and docs are not checked continuously.
- Full local verification is difficult, so the repo needs smaller reproducible verification loops per slice.

Current tracked remediation state: the original tracker items, the 2026-06-14 auth/payment/order/storefront/platform/cache follow-ups, `MEDIA-001`, the 2026-06-15 `ADMIN-009`, `ADMIN-010`, `ADMIN-011`, `ADMIN-012`, `ADMIN-013`, `ADMIN-014`, `RBAC-001`, `RBAC-002`, `STORE-007`, `PERF-004`, `PERF-005`, `PERF-006`, `PERF-007`, `STORE-008`, `AUTH-011`, `CACHE-006`, `CACHE-007`, `CACHE-008`, `CACHE-009`, `CACHE-010`, `CACHE-011`, `CACHE-012`, `CACHE-013`, `CACHE-014`, `CACHE-015`, and `DOC-002` slices, plus the 2026-06-18 `PERF-008` query-barrel/rich-preview follow-up, are marked `Verified` unless a newer row in `audit/REMEDIATION_TRACKER.md` says otherwise.

## Validation Performed

- Root `pnpm typecheck`: passed.
- `pnpm --filter @scalius/admin-v2 typecheck`: passed after the RBAC/account-context slice; admin server functions remain in typed domain slices under `api-functions/`.
- `pnpm --filter @scalius/api typecheck`: passed.
- `pnpm --filter @scalius/storefront typecheck`: passed.
- `pnpm exec drizzle-kit check --config packages/database/drizzle.config.ts`: passed.
- `pnpm check:env`: passed.
- `pnpm lint`: passed with no ESLint warnings across API, admin, storefront, api-client, core, database, and shared.
- `pnpm test`: passed 132 files and 827 tests after the admin query-barrel removal, customer dashboard invalidation guard, rich-preview guard, and `js-yaml` audit override.
- `pnpm build`, `pnpm check:env`, `pnpm check:dist-secrets`, `pnpm audit --audit-level moderate`, `pnpm peers check`, frozen install, and `pnpm --filter @scalius/database check:migrations`: passed. `pnpm audit` is clean after pinning transitive `js-yaml` to 4.2.0 for the OpenAPI generator path.
- Full deploy: latest query-barrel removal slice redeployed API `9f5132cd-7588-41a1-a464-f04965d0ed5e`, admin `77b5a8d1-4bbb-4e3a-b6b6-a8e4d9a20603`, and storefront `27b8201c-fb66-4cc2-8b57-c5ae9ed7f431`; follow-up admin deploys are analytics hydration `fb3dc516-8ae2-4d5f-ab95-1b337fc3c9a5` and rendered rich-preview/security-override `f4bf38a1-f285-4eb5-94e8-68fc60d5e7dd`.
- Live HTTP checks: API setup returned `adminExists: true`, storefront `/` returned 200 without an error shell, unauthenticated dashboard `/admin` returned `307 /auth/login`, demo sign-in returned 200 with a user/token, and authenticated dashboard `/admin` rendered without error markers. No production data was mutated.
- `/admin/orders`, drag-enabled `/admin/collections`, `/admin/discounts/:id/edit`, product forms, product-variant, collection/discount picker, and primary list-route local/live performance checks: plain orders page load made no initial `DateRangePickerWithPresets`, `react-day-picker`, `BulkShipDialog`, `DeleteOrderDialog`, `OrderItemsPopover`, `FraudCheckIndicator`, `SortableDataTableContent`, or `sortable.esm` module request. Local collections loaded `SortableDataTableContent.tsx` plus `@dnd-kit` deps on demand; live collections loaded sortable assets only for the sortable route. Local discount edit checks covered all three discount types and loaded only the matching form chunk; live discount edit checked the existing `amount_off_order` discount and loaded only `AmountOffOrderForm`. Product edit chunks keep `bulk-generator`, `VariantSortModal`, and `csvHelpers` as lazy/on-demand code paths. Collection forms now route-load only category options plus stored product summaries, discount selected product/collection labels resolve through targeted by-id endpoints instead of broad form-option/list payloads, the broad `api.queries.ts` file has been removed, and all route-facing query options now live under `apps/admin-v2/src/lib/api-query-options/`. Rich-text form previews now render saved content through sanitized `.rich-content` HTML while the ProseMirror/Tiptap editor remains absent until edit.
- The live storefront missing-image issue was traced to product content and fixed: the homepage no longer references `https://cloud.scalius.com/zLPBsNbtJCMxTkfPAPHcr.png`, and the replacement primary product image returns `200 image/png`.
- Focused API/payment tests run by subagents passed for queue consumer, Polar webhook, and COD service slices.
- Focused storefront Vitest now starts after adding the missing `happy-dom` dev dependency.

## Severity Guide

- P0: security/privacy or data mutation exposure that should be fixed before feature work.
- P1: high reliability, data integrity, deploy, or workflow correctness risk.
- P2: maintainability, verification, local dev, or contract drift that makes future work unsafe.
- P3: documentation, cleanup, or quality issue that should be batched.

## P0 Findings

### SEC-001: Admin API did not enforce 2FA verification at the API boundary

Original finding: `apps/api/src/middleware/admin-auth.ts` accepted a Better Auth session and set the admin user without checking whether a 2FA-enabled session had completed 2FA. Admin UI helpers redirected when 2FA was needed, but direct API access should not rely on UI-only enforcement.

Fix direction: enforce the 2FA-verified session state in the API admin middleware, then add route tests for unverified 2FA sessions.

Status: Verified on 2026-06-13 and tightened again on 2026-06-14. Admin API middleware now rejects unverified 2FA sessions before RBAC except exact 2FA info, verify, complete-verification, and method-completion endpoints, with focused API middleware tests. See `SEC-001` in `REMEDIATION_TRACKER.md`.

### AUTH-002: Direct 2FA mark endpoint could bypass the second factor

The re-audit found that `/api/v1/admin/auth/2fa/mark-verified` was exempted from the 2FA middleware gate and then blindly set `session.twoFactorVerified = true`. Any password-authenticated admin account with 2FA enabled could call that endpoint directly and unlock the admin API surface without proving possession of the second factor.

Fix direction: remove the blind mark endpoint. Complete 2FA only after Better Auth verifies a TOTP, email OTP, or backup code, and require a proof that is bound to the current session before setting the custom `twoFactorVerified` field.

Status: Verified on 2026-06-14. The old mark endpoint is no longer routed or exempted. The replacement `/2fa/complete-verification` endpoint requires the session token returned by successful Better Auth verification and checks it against the current session id and user id before setting `twoFactorVerified`. Focused API route/middleware tests, API/admin typechecks, root validation, full deploy, and live admin smoke checks pass.

### AUTH-003: Browser-callable setup helper could promote arbitrary emails to super-admin

The re-audit found `markFirstUserAsSuperAdmin` in the admin app as a browser-callable TanStack server function. It accepted only `{ email }` and updated `user.role = 'admin', is_super_admin = 1` without a session check, setup lock check, no-admin check, or proof that the email belonged to the guarded setup-created user.

Fix direction: delete the helper and keep first-admin promotion inside the guarded `/api/v1/setup` route, which already checks for existing admins and uses the shared D1 binding.

Status: Verified on 2026-06-14. The helper and setup-form call site are removed. Focused stale-reference scan, admin typecheck, root validation, full deploy, and live admin smoke checks pass.

### SEC-002: Scanner token minting bypassed inventory RBAC

Raw QR-token scanner bypass was already fixed during this audit: scanner sessions are exchanged into a cookie and limited to an allowlist in `packages/shared/src/scanner-auth.ts`. The remaining finding at the time was earlier in the flow: `apps/admin-v2/src/routes/api/scanner-token.tsx` minted scanner tokens for any authenticated admin session, without checking inventory/stock permissions.

Fix direction: require the same permission that allows stock lookup/adjust/set before minting a scanner token.

Status: Verified on 2026-06-13. Scanner token minting now requires inventory/product permissions or super-admin before writing the QR scanner token, with focused admin route tests. See `SEC-002` in `REMEDIATION_TRACKER.md`.

### SEC-003: Public checkout-language router exposes admin mutations

`apps/api/src/app.ts` mounts `checkoutLanguageRoutes` publicly at `/checkout-languages` and also under `/admin/settings/checkout-languages`. The router includes create, update, soft delete, hard delete, and restore handlers.

Fix direction: split public read routes from admin mutation routes, or mount mutation handlers only behind admin auth.

Status: Verified on 2026-06-13. Public checkout-language routes expose active reads only, while admin CRUD remains mounted behind admin auth; public mutation attempts are covered by route tests. See `SEC-003` in `REMEDIATION_TRACKER.md`.

### PRIV-001: Public order-success page leaks order PII by order ID

`apps/storefront/src/pages/order-success.astro` reads `?orderId=`, then server-fetches full order details with storefront service credentials. It renders customer name, phone, email, and address. Order IDs are short public IDs, so anyone with an ID can view receipt PII in a private browser.

Fix direction: replace public `orderId` lookup with a receipt token or checkout token, and return a minimal public receipt DTO.

Status: Verified on 2026-06-13. Order success now requires `orderId` plus a receipt token and renders a minimal receipt DTO without phone, email, customer ID, shipments, delivery providers, or notes. See `PRIV-001` in `REMEDIATION_TRACKER.md`.

### SEC-004: Checkout summary renders user-controlled session data with `innerHTML`

`apps/storefront/src/lib/checkout/index.ts` interpolates checkout form/session data into HTML for the summary. Customer fields can be controlled by the browser.

Fix direction: render summary data with DOM APIs/text nodes, or sanitize through a narrow allowlist with tests.

Status: Verified on 2026-06-13. Checkout summary customer fields render through DOM text nodes instead of `innerHTML`, with an injection regression test. See `SEC-004` in `REMEDIATION_TRACKER.md`.

## P1 Findings

### AUTH-009: Legacy 2FA verify route can fail as 500 or trust an unrelated session token

The legacy `/api/v1/admin/auth/2fa/verify` route still called Better Auth verification directly and only converted errors whose message included `Invalid` into validation errors. Other expected provider failures such as expired codes could surface as 500s. It also accepted a returned Better Auth session token by token alone instead of binding it to the current session and current user.

Fix direction: require an active current session, map any OTP/TOTP/backup-code verification failure to the standard invalid-or-expired validation response, and only mark a session verified when the proof belongs to the current session and user.

Status: Verified on 2026-06-14. The route now requires an active session, converts verification failures to 400 validation errors, checks returned token proofs against `session.id`, `session.userId`, and `session.token`, and falls back to updating only the current session/user when Better Auth returns no token. Focused route tests cover success, expired-code mapping, and mismatched token rejection. Deployed to API version `76dee35f-507c-4654-a049-d8feb66d63ae`; live demo sign-in/session plus `/admin` and `/admin/orders` browser smoke passed.

### AUTH-010: Cross-worker Better Auth session rotation can drop replacement cookies

Read-only auth re-audit found that password change and first-time 2FA setup can call Better Auth through the API worker while the browser is on the dashboard/admin worker. When Better Auth rotates or replaces the current session and returns `Set-Cookie` from the API worker, the TanStack server-function API helper unwraps JSON and does not propagate that cookie back to the browser.

Fix direction: redesign these flows so session-rotating Better Auth calls happen same-origin on the admin worker/browser, or forward replacement cookies through every worker boundary. Prove the behavior with focused cookie-relay tests plus first-time email/TOTP setup tests.

Status: Verified on 2026-06-14. Password change now calls Better Auth with `returnHeaders: true`, forwards returned `Set-Cookie` headers from the API response, and does not leak replacement tokens in JSON. Admin server functions append API `Set-Cookie` values to the dashboard response before unwrapping envelopes. First-time email setup now proves the same-origin Better Auth `sessionToken` to `/2fa/method`; first-time TOTP and method-code changes verify the target-method code inside the API route, prefer the rotated cookie token when Better Auth returns a stale token, and forward the rotated cookie. Focused API/admin tests cover cookie propagation, code proof, same-origin session-token proof, stale-token rejection, password-change cookie forwarding, and the exact `/2fa/method` middleware exemption. Root tests/typechecks/lint/builds, local HTTP/browser smoke, full deploy to API `89316428-fc7f-4148-8f56-bb93c6b25c1b`, admin `c144655a-5f96-4741-b001-46926bdb7e2a`, storefront `4ab260a7-39ff-4489-9ef8-3f0370222d00`, and live admin/storefront smoke passed.

### AUTH-011: Preferred-login 2FA UX and trusted-device policy hardening

The auth re-audit found that after the security fixes, some convenience behavior remains deliberately conservative. Login 2FA uses `trustDevice: false` because Better Auth's trusted-device cookie is not yet synchronized with the custom `session.twoFactorVerified` API gate. The login method-selection UX can also still default to email in cases where a user prefers TOTP, because the pending-2FA login state is not the same as a fully verified admin session.

Fix direction: keep the trusted-device bypass disabled until it is deliberately reconciled with the custom API session gate, reject direct trusted-device attempts at both admin/API boundaries, and use Better Auth's pending-login method hints so the login 2FA screen does not guess email while the user is only partially authenticated.

Status: Verified on 2026-06-15 for the current conservative policy. Remembered-device login bypass remains disabled, so users must complete 2FA each login until a future policy intentionally changes that. The legacy `/api/v1/admin/auth/2fa/verify` path and same-origin Better Auth catch-all verification paths now reject caller-supplied `trustDevice: true` before verification. The admin login form stores Better Auth pending method hints in `sessionStorage`, chooses TOTP/email from those hints before falling back to authenticated 2FA info, avoids silent email fallback when that lookup is unavailable, and clears the pending hint after verification or sign-out. Verification: focused admin auth-server and pending-method tests, focused API auth-management tests, root gates, local running-stack smoke, full deploy, live demo sign-in API check, live trusted-device rejection checks for TOTP/email/backup-code, and live dashboard/storefront browser smoke. Future remembered-device support should open a new tracker item and prove TOTP-preferred login, email-preferred login, backup-code login, stale trusted-device cookies, and post-login admin API access before relaxing this behavior.

### CACHE-005: Settings and no-cache routes had stale or misleading cache behavior

The cache audit found that auth/checkout settings writes updated checkout behavior fields but only invalidated the site-settings cache, CSP/security settings writes updated raw KV without purging public CSP/layout caches, `CACHE_TTLS.NONE` still wrote API cache entries because the middleware clamped KV TTLs downstream, and storefront warm logging counted fulfilled HTTP 500/404 warm fetches as successful.

Fix direction: route settings writes through the existing cache invalidation groups, make zero/negative TTL bypass cache reads and writes, and count only fulfilled `true` warm responses.

Status: Verified on 2026-06-14. Auth settings now invalidate the `checkout` group, CSP/security settings invalidate the `layout` group, `cacheMiddleware({ ttl: 0 })` bypasses cache entirely, and purge warm logs count only successful responses. Verification included focused API cache/auth tests, API/storefront typechecks and builds, root tests/lint/env/dist-secret checks, API deploy `76dee35f-507c-4654-a049-d8feb66d63ae`, storefront deploy `e5765834-61cf-4d8a-80ec-eb70a0c9ad3b`, live API analytics no-cache header check, live CSP/API health checks, and live admin/storefront browser smoke.

### CACHE-006: Category and CMS page writes can leave fallback navigation stale

The cache re-audit found that storefront layout fallback navigation derives from public categories and pages when no explicit header navigation config exists, but category and CMS page writes did not invalidate the `layout` group. That could leave header/footer/navigation HTML stale after content edits even when the page/category-specific caches were purged.

Fix direction: include `layout` in category invalidation groups and page write invalidation groups, then prove the storefront purge payload contains both page/category-specific prefixes and layout/navigation prefixes.

Status: Verified on 2026-06-15. `CATALOG_CACHE_GROUPS.categories` and `/api/v1/admin/pages` invalidation now include `layout`; page writes pass both `pages` and `layout` to API KV invalidation and storefront purge. Focused cache-invalidation tests cover category layout prefixes and page-plus-layout purge payloads. Verification included API typecheck/lint, root gates, local running-stack smoke, full deploy to API `e6371993-57e5-4cca-8b06-ffa201b5f1a4`, admin `7d9f3990-6c55-4e16-b095-bc5a6adb2538`, storefront `c6e6eb39-1829-4070-a543-96a1b6e77f13`, and live storefront/dashboard smoke.

### CACHE-007: Storefront purge endpoint mutated state on GET

The cache re-audit found that authenticated `GET /api/purge-cache` bumped the storefront cache-version KV key, cleared L1 memory cache, and scheduled cache warming. The API worker already uses `POST` for purge calls, so the GET path was unnecessary mutation surface for crawlers, link prefetchers, and accidental browser visits.

Fix direction: keep `POST /api/purge-cache` as the only mutating purge method, make `GET` deterministic and non-mutating, preserve query-string credential rejection, and add route tests that prove GET does not touch KV/L1/warming while POST full and selective purges still work.

Status: Verified on 2026-06-15. `GET /api/purge-cache` now rejects `?token=` without mutation and otherwise returns `405 Allow: POST` with `Cache-Control: no-store`. Focused storefront route tests prove header-authenticated GET does not call `CACHE_CONTROL.get`, `CACHE_CONTROL.put`, L1 clear helpers, `waitUntil`, or warm `fetch`, while POST full and prefix-only purges still bump the version and warm only when HTML-affecting. The root test suite now covers 126 files / 795 tests. Full deploy completed to API `128ebde2-62df-4f03-98f6-e7fa0d37534b`, admin `1e80b617-bffc-46f4-8a7b-b2e0e23ae606`, and storefront `f767dd69-aa71-4470-b842-a250283d4b2b`; live GET and query-token checks returned the expected 405/400 no-store responses.

### CACHE-008 / ADMIN-011: Delivery-provider writes skipped checkout invalidation

Delivery-provider settings affect checkout delivery behavior, but the provider create/update/delete routes did not invalidate the API/storefront `checkout` cache group. The admin delivery-provider UI also updated only component-local state, leaving `queryKeys.settings.deliveryProviders()` stale for other prefetched admin consumers.

Fix direction: treat delivery providers as checkout-affecting settings, invalidate `["checkout"]` after successful provider writes, and invalidate the admin delivery-provider query key after successful UI saves/deletes.

Status: Verified on 2026-06-15. Delivery-provider create, update, update-as-create, and delete routes invalidate the checkout group; the current implementation uses `invalidateApiAndScheduleStorefrontGroups(["checkout"], c)` so API KV invalidation is awaited while storefront purge is scheduled. The admin delivery-provider container invalidates `queryKeys.settings.deliveryProviders()` after local state updates for successful saves/deletes. Focused route tests cover all provider write paths; API/admin typechecks and lints, root typecheck/lint/test/build/env/dist-secret/migration/audit/peer/diff gates, local `pnpm dev` plus browser smoke, full deploy to API `c2dbd146-3d1d-4907-a08c-6dd9f89df83d`, admin `1b04ca74-5c77-4423-ac15-600aee909650`, and storefront `420b911c-ea06-48c1-9812-2ee0ad67a90c`, and live `/admin/settings/delivery-providers` browser smoke passed.

### STORE-007: Storefront CSP middleware ignored enveloped settings responses

The storefront CSP middleware fetched `/api/v1/storefront/csp` but read the response as a top-level `{ cspAllowedDomains }` object. The API returns the standard success envelope, so refreshed security settings could be cached as empty even after the `layout` cache group was invalidated.

Fix direction: unwrap `data.cspAllowedDomains` while retaining compatibility with the legacy top-level shape, then prove the rendered CSP header includes the configured domains.

Status: Verified on 2026-06-15. `setPageCspHeader()` now accepts both response shapes, and a focused storefront test proves an enveloped CSP response is included in the header. Root warning-free lint/typecheck/test/build/safety gates passed, then full deploy completed to API `822d3968-ffc0-4280-9286-f161a4096525`, admin `a6701970-d938-4250-a483-3c6155ab0f89`, and storefront `9d6a9ea8-6258-487a-85e0-ed4e6f34d72d`. Live CSP endpoint and storefront browser smoke passed.

### PAY-006: Late gateway success can pay terminal orders

Fresh payment/order audits independently found that already-created gateway sessions or late webhooks can still mark cancelled, deleted, returned, or refunded orders as paid. This can create paid terminal orders without re-reserving inventory or moving the order through an explicit recovery transition.

Fix direction: add a shared payable-state guard for payment-session routes and `processPaymentConfirmed()`. Late successful captures for terminal orders should be surfaced for reconciliation/manual review without mutating order totals/status, then acknowledged so gateway retries stop.

Status: Verified on 2026-06-14. A shared payable-order policy now blocks soft-deleted, cancelled, returned, refunded, partially-refunded, fully-paid, and payment-refunded orders before public gateway-session calls and before confirmed gateway events can create/promote payment claims. The final order CAS also enforces the same payable-state predicate, and non-payable late-success queue outcomes are acknowledged as manual-reconciliation events instead of retried. Verification: focused core/API tests, core/API typechecks and lints, API dry-run build, dist/env checks, API deploy version `8253ac1e-0053-436e-a20d-d98503c96832`, live API health/OpenAPI checks, authenticated dashboard orders smoke, and storefront browser smoke.

### PAY-007: SSLCommerz deposit/balance attempts collide on `tran_id`

SSLCommerz currently sends `tran_id` as the order id. Deposit and balance attempts for the same order can therefore share the local idempotency key/index even though they are distinct captured payments.

Fix direction: generate a unique SSLCommerz transaction id per payment attempt/payment type and dedupe confirmed SSL payments by gateway validation id rather than order id alone.

Status: Verified on 2026-06-14. SSLCommerz sessions now create scoped attempt `tran_id` values while carrying the canonical order id separately, callbacks resolve trusted `order_id` with scoped-transaction fallback, IPN queueing uses canonical order id plus full attempt id, and confirmed SSLCommerz payment idempotency uses `sslcommerz_val_id`. Migration `0039_sslcommerz_val_id_idempotency.sql` moves the unique index to `(order_id, sslcommerz_val_id)` and normalizes old `payment_plans.status='fully_paid'` rows to `completed`. Verification: focused session/webhook/processor tests, API/core/database typechecks and lints, migration metadata check, root `pnpm test`, env/dist-secret checks, API deploy version `9a25a484-b501-4f84-88f5-f3bf4a0b0eba`, live API/OpenAPI/auth checks, authenticated dashboard `/admin` and `/admin/orders` browser smoke, and storefront browser smoke.

### ORDER-012: Abandoned cleanup can race with payment confirmation

The abandoned cleanup path can release inventory and then later mark/archive/delete by id while a payment confirmation interleaves. That can overwrite a now-paid order or leave an incomplete/restored order in a half-cleaned state.

Fix direction: claim cancellation with status/version/payment/payment-record guards before release, make final archive/delete conditional on the expected claimed state, roll back the claim if inventory release fails, and write the abandoned-checkout archive only after final soft-delete succeeds.

Status: Verified on 2026-06-14. `archiveStaleIncompleteOrders()` now guards the cleanup claim with expected order version/status/payment state, stale cutoff, no active shipment claim, and no pending/succeeded payment record. Cleanup releases inventory only after the claim wins, rolls the claim back if inventory release fails, finalizes soft-delete with another guard, and inserts the abandoned-checkout archive only after finalization succeeds. Focused tests cover release-before-finalize/archive ordering, release-failure rollback, claim loss to concurrent payment, and finalization guard loss. The admin abandoned-checkouts route also skips server-side prefetch for its browser-proxy-only relative fetch, fixing the live SSR 500 on `/admin/abandoned-checkouts`. Verification: focused API abandoned-checkout tests, API typecheck/lint/build, admin typecheck/lint/build, root `pnpm test`, env/dist-secret checks, API deploy version `1ab100f5-5e2b-4d8a-9fb3-c7ad0a4a3a07`, admin deploy version `af228559-8956-434c-bda7-88ae511cf4c9`, live API health/auth/session/admin route/proxy/storefront HTTP smoke, browser dashboard `/admin/abandoned-checkouts` smoke with no console errors, and storefront browser smoke.

### ORDER-013: Manual fulfillment can persist order status without shipment/items

Manual fulfillment updates order status/fulfillment before the shipment insert and item updates are batched. A later failure can leave shipped/complete order status without durable shipment rows or shipped items.

Fix direction: acquire a private fulfillment claim before visible order status changes, then batch the shipment insert, scoped item updates, and final order status/fulfillment update together; make retry idempotently repair inventory when shipment/items already committed.

Status: Verified on 2026-06-14. Manual fulfillment now acquires a private `shipmentClaimId` without publishing shipped/complete state, validates that selected item IDs are non-empty, unique, and owned by the order, scopes item updates by `orderId`, and commits the manual shipment row, item updates, and final order status/fulfillment/claim-clear update in one D1 batch. If the batch fails before a shipment row exists, the private claim is cleared and inventory is untouched. Verification: focused core fulfillment tests, core/API typechecks, core lint, API dry-run build, root `pnpm test`, env/dist-secret checks, API deploy version `37698b5e-89fe-4978-b8df-2e94145021c3`, live API health/OpenAPI/auth/admin/storefront HTTP smoke, dashboard orders browser smoke, and storefront browser smoke.

### ORDER-014: COD delivered/completed status can mark paid without ledger rows

Generic order status updates can set COD orders to `paymentStatus: paid` on delivered/completed transitions without creating `order_payments`, updating `paidAmount`/`balanceDue`, or updating `cod_tracking`.

Fix direction: route COD collection through `recordCODCollection()` or require collection details before marking COD paid.

Status: Verified on 2026-06-14. Generic order status updates no longer synthesize COD paid state. COD `delivered`/`completed` transitions through the generic status path require successful COD payment evidence, collected COD tracking, `paymentStatus = paid`, positive `paidAmount`, and no remaining `balanceDue`; otherwise callers must use the COD collection action, which records `cod_tracking`, `order_payments`, and order payment totals together. Verification: focused core fulfillment/COD status tests, core/API typechecks, core lint, API dry-run build, root `pnpm test`, env/dist-secret checks, API deploy version `37698b5e-89fe-4978-b8df-2e94145021c3`, live API health/OpenAPI/auth/admin/storefront HTTP smoke, dashboard orders browser smoke, and storefront browser smoke.

### BUILD-004: Storefront test file is bundled as a public Astro route

`apps/storefront/src/pages/seo-regressions.test.ts` lives under Astro pages and can be emitted as a public route/chunk.

Fix direction: move the test outside `src/pages`, then verify storefront build output has no `seo-regressions.test` route or chunk.

Status: Verified on 2026-06-14. The regression test now lives outside `src/pages`, focused Vitest passes, storefront typecheck/build pass, the rebuilt `dist` output has no `seo-regressions` route/chunk references, storefront-only deploy completed, and the live old route returns 404.

### ORDER-001: Expiry cron can release live order reservations

`apps/api/src/worker.ts` calls `releaseExpiredReservations(db, 30)`. The expiry query in `packages/core/src/modules/inventory/expiry.ts` releases old reserved movements without joining orders or updating `orders.inventoryAction`. A pending/confirmed order can remain marked reserved while its stock reservation is released.

Fix direction: limit expiry to checkout holds that are not attached to live orders, or transition the order and inventory state together.

Status: Verified on 2026-06-13. Expiry now releases only orphaned reservation movements whose order row is missing, with a second order-existence guard and focused inventory tests. See `ORDER-001` in `REMEDIATION_TRACKER.md`.

### ORDER-002: Fulfillment and COD side effects can occur before durable order state changes

Several order fulfillment paths call inventory, payment, or delivery side effects before the local order/shipment CAS or batch is committed:

- Bulk shipping calls provider shipment creation before claiming the order transition.
- Manual fulfillment applies inventory before shipment/order batch commit.
- COD collection and return tracking happen before delivered/returned CAS updates.

Fix direction: centralize order state transitions. Claim local state first, call providers second, complete or release claims third.

Status: Verified on 2026-06-13. Fulfillment, shipment, manual inventory, and COD paths now claim local state before external or inventory side effects, with focused fulfillment ordering tests. See `ORDER-002` in `REMEDIATION_TRACKER.md`.

### ORDER-003: Queue batch failures are not isolated enough

Order ingest batches can retry every message when one reservation fails. Discount DB triggers can also abort a batch under concurrency, causing unrelated orders in the same batch to fail or retry.

Fix direction: partition deterministic per-order failures from transient batch failures. Add tests for mixed-success batches.

Status: Verified on 2026-06-13. Order ingest now isolates reservation failures per order and falls back to isolated per-order reserve/write/ack handling after shared DB batch failures. See `ORDER-003` in `REMEDIATION_TRACKER.md`.

### ORDER-004: Storefront order creation enqueues before checkout KV is written

The API order route sends the queue message before writing checkout/token data to KV. If queue send succeeds and KV write fails, the client may receive a failure while order ingest may still happen.

Fix direction: create the idempotency/checkout record before enqueueing, or make post-enqueue KV failure non-fatal and recoverable.

Status: Verified on 2026-06-13. Order creation writes checkout polling and receipt-token KV before queue send, and rewrites checkout status to terminal `failed` if enqueue fails afterward. See `ORDER-004` in `REMEDIATION_TRACKER.md`.

### ORDER-005: Abandoned-checkout cleanup can strand reserved inventory

At re-audit time, the admin abandoned-checkout cleanup path could delete old incomplete orders directly while their reserved inventory movements still existed. Because movement rows can lose their order reference on delete, the orphan-expiry sweeper could then lack enough state to release stock or write a matching release movement.

Fix direction: route cleanup through the same explicit order/inventory transition used for cancellations, or make the cleanup path claim and release reserved inventory before deleting or anonymizing the incomplete order.

Status: Verified on 2026-06-13. Stale incomplete-order cleanup now calls the canonical inventory transition before archiving, leaves orders/items present until release succeeds, soft-deletes cancelled cleanup orders instead of hard-deleting them, and skips archive/delete when release fails. Focused API tests cover release-before-archive ordering, failure safety, and no-inventory cleanup.

### PAY-001: Stripe/SSL webhook idempotency is KV-only and recorded after queue send

Stripe and SSL webhooks enqueue payment messages before recording KV idempotency. Polar has a stronger DB claim pattern.

Fix direction: move Stripe/SSL to a durable claim-before-side-effect pattern, ideally shared with Polar.

Status: Verified on 2026-06-13. Stripe and SSLCommerz now use the shared durable `webhook_events` claim-before-enqueue path, and payment failed/canceled consumers have focused idempotency regression tests. See `PAY-001` in `REMEDIATION_TRACKER.md`.

### PAY-002: Polar full refunds update payment/inventory without order status transition

Full Polar refunds update payment state and apply cancellation-like inventory handling, but do not CAS-update `orders.status`.

Fix direction: route refunds through the order refund/state machine or perform an explicit status CAS before inventory transition.

Status: Verified on 2026-06-13. Polar webhook refunds now CAS-update payment and allowed order-status transitions before inventory release, with focused state-machine tests. See `PAY-002` in `REMEDIATION_TRACKER.md`.

### PAY-003: Payment session creation trusts caller-controlled checkout data

At re-audit time, public payment-session routes were reachable through storefront proxies and trusted request-body order identifiers, receipt tokens, and redirect/callback URLs too much. A caller could shape gateway session requests without proving possession of the checkout receipt token, and some callback/success URLs were derived from caller input instead of trusted storefront/runtime configuration.

Fix direction: require receipt-token or checkout-token proof for the target order before creating any external payment session, load the canonical order/checkout state server-side, and derive gateway callback/success/cancel URLs from trusted runtime settings.

Status: Verified on 2026-06-13. Stripe, SSLCommerz, and Polar payment-session routes now require receipt-token proof for the target order before gateway settings/provider calls, gateway request URLs are derived from trusted API runtime config instead of caller-provided URLs, and generated SDK request types require `receiptToken` without caller URL fields. Focused API route tests cover missing/foreign tokens and URL injection.

### DEL-001: Delivery webhook and shipment semantics are inconsistent

Steadfast webhook idempotency keys can treat later status changes as duplicates. Single shipment creation, bulk shipment creation, and delivery tracking map statuses differently. The delivery status mapper emits statuses the order updater ignores.

Fix direction: define one shipment/order state machine and make single, bulk, manual, and webhook paths use it.

Status: Verified on 2026-06-13 for the active webhook/tracking paths. Pathao and Steadfast now claim durable webhook events before side effects, Steadfast event identities include status/update data, and delivery tracking handles the canonical mapper statuses with focused tests. See `DEL-001` in `REMEDIATION_TRACKER.md`.

### STORE-001: Checkout/shipping cache invalidation can leave stale Cache API entries

Checkout invalidation does not bump HTML cache versions, while storefront purge clears L1 cache prefixes but does not delete matching Cache API entries. Checkout and shipping data use edge cache helpers.

Fix direction: version all relevant L2 keys consistently or implement real Cache API invalidation for selective purges.

Status: Verified on 2026-06-13. Selective prefix purges now bump the storefront KV cache version used by L2 Cache API keys, while critical-page warming remains limited to HTML-affecting purges. See `STORE-001` in `REMEDIATION_TRACKER.md`.

### OPS-001: Clean storefront typecheck/deploy can fail on ignored generated `BUILD_ID`

`apps/storefront/src/config/build-id.ts` is ignored but imported by runtime files. It is generated by a build script, while deploy typechecks before build. Build caching can also keep stale timestamp-based IDs.

Fix direction: track a fallback module, generate before typecheck, or derive the ID from commit/deploy env instead of an ignored source file.

Status: Verified on 2026-06-13. Storefront typecheck now generates the ignored module before `astro check`, and the generator produces deterministic commit/source-hash IDs instead of timestamp-only IDs. See `OPS-001` in `REMEDIATION_TRACKER.md`.

### OPS-002: Single-worker deploy scripts bypass full deploy safety gates

The full deploy script typechecks, builds, migrates remote D1, then deploys. Root `deploy:api`, `deploy:admin`, and `deploy:storefront` route through Turbo deploy tasks that depend on build but not typecheck or migrations.

Fix direction: create target-aware deploy scripts with focused typecheck and explicit migration gates.

Status: Verified on 2026-06-13. Root targeted deploy scripts now use `scripts/deploy.mjs --only ...`; targeted deploys typecheck first, build the selected app, and the API target applies remote D1 migrations before deploying.

### OPS-003: Deploy dry-run mode still mutates production

The targeted API deploy dry-run reached the API workspace build dry-run but then continued through remote D1 migration checks and the final Worker deploy because `scripts/deploy.mjs` did not parse dry-run as a top-level mode.

Status: Verified on 2026-06-13. `scripts/deploy.mjs --dry-run` now runs typecheck, build, and dist-secret checks, then skips D1 migrations and Worker deploys for full and targeted deploys. `--migrate-only --dry-run` reports the intended migration target without applying migrations.

### TEST-001: Root test suite failed widget script extraction

`pnpm test` previously failed `apps/admin-v2/src/components/admin/widgets/widget-form/widget-generation-content.test.ts`. The failing test expected local-safe `<script>` tags to be extracted into JS before preview, but the HTML still contained the script tag.

Status: Verified on 2026-06-13. `parseGeneratedWidgetContent()` now returns normalized widget parts so HTML-owned `<script>` blocks are moved into JS before preview. Root `pnpm test` passes.

Fix direction: fix parser behavior or update the test only if the intended contract changed.

### DEPLOY-001: Stale admin route chunks can strand `/admin` in the error boundary

A live post-deploy visit to `https://dashboard.scalius.com/admin` showed the generic 500 error boundary. Worker requests for the redeployed admin route and auth/session endpoints were successful, so the durable failure mode was a recoverable client route-load/chunk failure during or after deploy that left users stuck on the generic error screen.

Fix direction: detect known recoverable dynamic-import/chunk load errors, perform one bounded reload per route/error signature, and keep an explicit reload action for users if the automatic recovery already fired.

Status: Verified on 2026-06-13. The admin router now recognizes stale route-load/chunk failures and reloads once, with focused tests. Dashboard analytics filters also compare Unix timestamps against Unix timestamp columns. Verification included focused admin tests, admin/core typechecks, admin build, root `pnpm test`, root `pnpm lint`, full `pnpm run deploy`, live API/admin/storefront HTTP checks, browser checks, and `wrangler tail` confirmation that `/admin`, `_serverFn`, and `/api/auth/get-session` served without exceptions after redeploy. See `DEPLOY-001` in `REMEDIATION_TRACKER.md`.

### BUILD-003: Local env files can remain in app `dist/` outputs

Admin and storefront framework builds can leave local env files such as `.dev.vars` under `dist/server`. Wrangler dry-run packaging showed these files were not uploaded by the current redirected configs, but keeping local secret files in deploy output or Turbo cache scope is a fragile invariant and makes accidental packaging/archive leaks easier.

Fix direction: remove local env files after framework builds and fail deploy if any app `dist/` output still contains `.dev.vars`, `.env*`, or `*.vars`.

Status: Verified on 2026-06-13. Admin/storefront build scripts now clean dist env files, Turbo build outputs exclude local env files, package-local deploy scripts route through the root safety wrapper, `scripts/deploy.mjs` checks all target dist outputs before deploy, and `pnpm check:dist-secrets` exposes the guard directly. Verification covered script syntax, cleanup, check mode, focused Vitest for the cleanup script, admin/storefront builds, direct dist-secret checks, and a Turbo build dry-run showing secret-like files excluded from outputs. See `BUILD-003` in `REMEDIATION_TRACKER.md`.

### AUTH-001: Admin login/setup can fail from Better Auth schema drift and partial setup state

Local `/admin` verification exposed two admin-auth readiness failures: Better Auth session creation rejected the configured additional session field because `fieldName` used the physical SQL column name instead of the Drizzle schema key, and first-admin setup could return a 500 when Better Auth had already inserted the user but the route failed before promoting it to admin. The unauthenticated `/admin` SSR opt-out also caused a React hydration mismatch by rendering the admin pending shell before the client redirected to `/auth/login`.

Fix direction: align Better Auth additional-field mapping with the Drizzle schema key, make first-admin setup recover partially-created first users and release setup locks in `finally`, and let the `/admin` guard run during SSR so unauthenticated requests server-redirect before HTML is emitted.

Status: Verified on 2026-06-13. `twoFactorVerified` maps to the Drizzle `session.twoFactorVerified` field, setup recovers the partial first-admin state and releases the KV lock, unauthenticated `/admin` returns `307 /auth/login`, authenticated local browser login renders the dashboard, and chart containers start Recharts with a valid initial size. Full `pnpm run deploy` completed after typecheck/build/migration gates, and live browser checks confirmed `https://dashboard.scalius.com/admin` reaches the login page without console errors while `https://storefront.scalius.com/` renders successfully. See `AUTH-001` in `REMEDIATION_TRACKER.md`.

### PAY-004: Public payment sessions still trust caller-selected deposit/manual-capture fields

The prior `PAY-003` fix proved receipt-token ownership and trusted redirect URLs, but the public Stripe, SSLCommerz, and Polar session routes still accept caller-selected `paymentType` and `depositAmount`; Stripe also accepts `manualCapture`. A receipt token proves access to an order, not the right to choose a lower-than-policy deposit or capture mode.

Fix direction: derive payment mode, deposit amount, and capture behavior server-side from checkout/order/payment settings; reject deposit requests when partial payment is disabled or the amount does not match policy.

Status: Verified on 2026-06-13. Stripe, SSLCommerz, and Polar session creation now goes through a shared server-side policy that rejects disabled/mismatched deposits, derives balance payments from server state, ignores caller currency, and forces public Stripe sessions to `manualCapture: false`. Focused payment-session tests cover disabled deposits, mismatched deposits, server-derived gateway amounts/currency, and ignored manual capture. See `PAY-004` in `REMEDIATION_TRACKER.md`.

### PAY-005: SSLCommerz webhook uses form transaction metadata after validation

The SSLCommerz webhook validates `val_id`, then enqueues payment using form `tran_id` and `value_a`. If validation succeeds for one transaction but the form contains another order ID, the event can be applied to the wrong order.

Fix direction: use canonical validated transaction/order metadata after validation, require it to match the expected order/session, and do not trust form `value_a` for payment type.

Status: Verified on 2026-06-13. SSLCommerz IPN now validates `val_id` before durable claim, derives canonical transaction/payment data from the validation response, rejects inconsistent canonical identifiers, and resolves payment type from server-side order/payment-plan state instead of trusting form `value_a`. Focused webhook tests cover spoofed form fields, duplicate durability, queue failure, canonical mismatch, and payment-plan inference. See `PAY-005` in `REMEDIATION_TRACKER.md`.

### ORDER-006: Checkout shipping can be zeroed by missing or bogus shipping method

Storefront order creation accepts browser-provided shipping charge and optional `shippingMethodId`. Core order creation derives shipping from a method only when the ID resolves; otherwise it can fall back to the request body shipping charge.

Fix direction: when shipping applies, require a valid active non-deleted shipping method and derive the charge on the backend.

Status: Verified on 2026-06-13. Storefront order creation now requires an active, non-deleted shipping method when shipping applies and derives shipping charge from the method fee. Free-delivery products still waive shipping explicitly. Focused core tests cover caller-supplied zero shipping, missing/unknown methods, inactive/deleted methods, and free-delivery behavior. See `ORDER-006` in `REMEDIATION_TRACKER.md`.

### ORDER-007: Status changes are not resumable when inventory fails after order CAS

Some transitions persist order/payment status before applying inventory transitions. If inventory transition or `inventoryAction` persistence fails afterward, a retry can no-op because the order already has the target status.

Fix direction: make inventory reconciliation resumable even when status is already changed, or persist a durable transition/outbox state that retries until inventory state matches the order state.

Status: Verified on 2026-06-13. Status, fulfillment, COD, delivery, refund, return, and admin full-edit retries now reconcile inventory even when the order already has the requested or mapped status. Delivery webhooks and shipment refreshes invoke the order mapper even when the shipment row already stores the provider status, but notifications still require an actual order status change. Already-cancelled full-refund retries release only pre-fulfillment/non-deducted inventory and do not auto-restore fulfilled refunds. Focused core/API tests cover same-status admin status retries, bulk/manual shipment retries, COD delivered retries, delivery mapper retries, admin edit retries, Polar/admin refund retries, return retries, and fulfilled-refund non-restock guards. See `ORDER-007` in `REMEDIATION_TRACKER.md`.

### WEBHOOK-001: Durable webhook `processing` claims can black-hole events

Webhook claims insert as `processing`. If an isolate crashes before queue send or side effects complete, provider retry can be treated as a duplicate because only `failed` claims are reclaimable.

Fix direction: add processing leases/expiry or a durable outbox so stale processing events can be reclaimed and retried.

Status: Verified on 2026-06-13. Webhook `processing` claims now have a five-minute lease. Stale processing claims are atomically reclaimable by exactly one retry, fresh processing claims remain deduped, failed claims remain reclaimable, queued/processed claims remain terminal, and non-duplicate insert failures throw so providers retry instead of getting false duplicate acknowledgements. Focused helper and route tests cover the behavior. See `WEBHOOK-001` in `REMEDIATION_TRACKER.md`.

### ORDER-008: Bulk shipment claim is only a version bump before provider side effects

Bulk shipment creation bumps order version before calling the carrier, but concurrent admin updates can still use the new version before the final shipped CAS. If the carrier succeeds and final local CAS fails, an external shipment can exist for an order not marked shipped.

Fix direction: introduce an exclusive fulfillment claim or explicit in-progress state that all order mutations respect until shipment finalization or reconciliation.

Status: Verified on 2026-06-13. Bulk provider shipment creation now acquires a durable order-level shipment claim before carrier side effects, passes the claim id through to the insert-first `delivery_shipments` row, clears the claim only after local shipped state succeeds, and leaves `delivery_shipments.status = reconcile_required` plus an indefinite order claim when provider success cannot be finalized locally. Admin order/status/COD/fulfillment/edit/delete/refund/payment-session/shipment-refresh paths reject active claims; payment and delivery webhook/queue paths surface retryable failures instead of silently skipping external truth. Focused fulfillment, delivery tracking, payment-session, payment-queue, and order-edit tests cover the behavior. See `ORDER-008` in `REMEDIATION_TRACKER.md`.

## P2 Findings

### PERF-003: Admin route chunks and dashboard loaders still have avoidable first-load cost

Read-only performance audit found several remaining admin hot-path costs: route code splitting is effectively off because generated route modules are statically imported, `api.queries.ts` imports query options for many domains, dashboard first paint blocks on daily activity chart data that renders later, customer daily activity lacks a matching `createdAt` index, the admin guard does repeated sequential work before child loaders, checkout settings prefetches inactive tabs and duplicates default-tab fetches, orders pays for DnD/date-picker code on initial render, and order detail had a post-render payments waterfall.

Fix direction: split this into small, measured slices. Dashboard activity separation, the matching customer activity index, order-detail payment/COD prefetching, checkout inactive-tab prefetch trimming, shell/settings query-options splitting, list-navigation warmups, mutation freshness, dashboard first-paint motion removal, route-facing mutation barrel splitting, orders interaction lazy-loading, shared DataTable sortable splitting, discount edit type-specific lazy-loading, media-picker lazy-loading, widget editor/prompt lazy-loading, rich-text editor deferral, product-form drag/additional-info deferral, product-variant interaction-tool deferral, General Settings Header/Footer hidden-subtab deferral, collection/discount picker targeted lookup loading, and full `api.queries.ts` removal are now done; remaining slices are broader route/component bundle slimming, repeated guard work, heavy chart/export chunks, and deeper route-specific chunk slimming.

Status: In Progress as of 2026-06-18. The first eight slices split dashboard summary/activity, indexed customer activity, warmed order-detail payment/COD data, trimmed checkout inactive-tab prefetching, moved hot shell query options to narrow modules, made common list client navigation non-blocking, tightened mutation invalidation freshness, removed dashboard first-paint motion runtime, and split route-facing mutation hooks by domain. The ninth through eleventh slices moved the orders date-range picker/calendar, bulk-shipping dialog, row item/fraud popovers, and delete confirmation dialog behind lazy interaction boundaries. The twelfth slice moved `@dnd-kit/*` and sortable row behavior out of the shared `DataTable` default path into lazy `SortableDataTableContent`. The thirteenth slice lazy-loads only the active discount edit form, warms product/collection selector data only for `amount_off_products`, and suppresses known SSR/client timezone drift on discount date text. The fourteenth slice lazy-loads the media dialog/page, widget fullscreen editor, widget history/paste modals, `prompt-helper-v2`, and standalone prompt wrapper behind explicit user actions. The fifteenth slice defers Tiptap/ProseMirror behind `DeferredTiptapEditor` while rendering saved read-only content through sanitized rich HTML; the sixteenth slice keeps product-form `AdditionalInfoManager`, `DraggableImageGallery`, and sortable dependencies out of first load until the relevant tab or images are used; the seventeenth slice keeps variant sort DnD, bulk generation, and CSV parsing/export code out of product edit first load until the matching action is clicked; the eighteenth slice keeps Header/Footer social, navigation menus, `NavigationBuilder`, and sortable navigation tooling out of the default General Settings builder chunks until the relevant subtab is selected; the nineteenth slice replaces broad collection form-options/list preloads with category-only and by-id lookup endpoints plus lazy paginated product search; and the twentieth slice removes the remaining broad query barrel entirely, keeps all route-facing query options in narrow domain modules, fixes customer form dashboard invalidation, and suppresses the analytics date hydration mismatch found during live verification. Verification includes focused dashboard/order-detail/checkout/auth/cache/picker-lookup/route-graph tests, mutation import-boundary/export-parity scans, broad query-barrel source/dist scans, affected workspace checks, root gates, production chunk scans, local browser detail/create route smokes, and live API/dashboard/storefront checks. The latest full deploy is API `9f5132cd-7588-41a1-a464-f04965d0ed5e`, admin `77b5a8d1-4bbb-4e3a-b6b6-a8e4d9a20603`, and storefront `27b8201c-fb66-4cc2-8b57-c5ae9ed7f431`, followed by admin hydration-fix redeploy `fb3dc516-8ae2-4d5f-ab95-1b337fc3c9a5` and final rich-preview/query-barrel redeploy `f4bf38a1-f285-4eb5-94e8-68fc60d5e7dd`.

### CACHE-012: Catalog writes could return 500 after a successful mutation when storefront purge failed

Local discount creation committed the row, then returned a 500 because `invalidateCatalogCaches()` awaited the downstream storefront purge while the storefront dev server was not running. The same pattern could turn a transient production purge/network failure into a false failed admin write after product/category/collection/discount data had already mutated.

Fix direction: keep API KV invalidation synchronous for local consistency, but move the cross-worker storefront purge to `executionCtx.waitUntil()` for catalog write routes. Routes that genuinely require immediate storefront purge success should call the explicit awaited helpers instead.

Status: Verified on 2026-06-15. `invalidateCatalogCaches()` now awaits `invalidateGroups()` for API KV and schedules `triggerStorefrontPurgeForGroups()` through `waitUntil()`. Focused tests prove product catalog purges are scheduled with the expected dependent groups and that rejected scheduled storefront purges are logged without rejecting the catalog write. Verification: focused cache-invalidation tests, API typecheck, root gates, local discount creation returning 201 with storefront absent, full deploy to API `f9597a03-f87b-4296-9966-cbfecb999c4c`, admin `0e960b5d-cde9-46a8-88ef-ba01fbd1211c`, storefront `862559f7-d881-4b78-b8a4-6b8a3a68d624`, and final live admin/storefront smoke after admin deploy `80104b0b-2d5c-47a1-a14f-baca5a6fa7e4`.

### CACHE-013: Hero slider writes could false-500 after successful mutation

After `CACHE-012`, the hero-slider routes still awaited or touched purge scheduling in a way that could fail outside a full Worker execution context. Local `/admin/settings/hero-sliders` exposed the risk: creating a slider could commit locally, then return 500 when storefront purge was unavailable.

Fix direction: keep API-side homepage KV invalidation synchronous, but schedule the storefront purge defensively with optional `ExecutionContext` access and do not let missing Hono test/local execution context fail the route.

Status: Verified on 2026-06-15. Hero slider create/update/delete now call `invalidateGroups(["homepage"], c.env.CACHE)` and then `triggerStorefrontPurgeForGroups(["homepage"], c.env, getOptionalExecutionContext(c))`. The shared helper catches Hono's "no ExecutionContext" test/local case and `triggerStorefrontPurgeForGroups()` only uses `waitUntil` when available. Verification: `pnpm --filter @scalius/api test -- src/routes/admin/settings/hero-sliders-cache-invalidation.test.ts src/utils/cache-invalidation.test.ts --reporter verbose`, API/root gates, full deploy to API `9988d1c2-6058-45f0-b691-acf56652ad60`, admin `166ff295-428e-41c3-b318-41dd296f08eb`, storefront `f886fcbf-7f1e-45b6-9701-d51c0e3a5961`, and local/live `/admin/settings/hero-sliders` custom media-trigger smoke.

### PERF-004: Admin list/media navigation and storefront product media had avoidable waits

The latest performance pass found that data tables forced a refetch on every remount, `/admin/media` blocked navigation on React Query prefetches that the media manager did not consume, query cache entries were collected after five minutes even during ordinary editing workflows, hidden product zoom modals requested 1400px images on initial product page load, and storefront Cache API metadata advertised SWR directives Cloudflare's Cache API does not honor for `cache.put()`.

Fix direction: let query `staleTime` drive data-table remount behavior, remove unused blocking media prefetches, retain admin caches longer without changing freshness, assign product zoom image `src` only when the modal opens, and keep L2 cache headers to supported max-age semantics.

Status: Verified on 2026-06-15. The changes are implemented, root warning-free lint/typecheck/test/build/env/migration/audit/diff gates passed, and full deploy completed to API `822d3968-ffc0-4280-9286-f161a4096525`, admin `a6701970-d938-4250-a483-3c6155ab0f89`, and storefront `9d6a9ea8-6258-487a-85e0-ed4e6f34d72d`. Live Chrome/CDP smoke covered dashboard `/admin`, `/admin/products`, `/admin/orders`, `/admin/media`, `/admin/settings/account`, and storefront `/`, `/search`, `/categories/men-clothing`, `/products/monster-energy-drink` with no console/runtime errors or error-boundary pages.

### PERF-005: Dashboard first paint imported a motion runtime for simple decoration

The dashboard landing path still imported `motion/react` through stat cards, the welcome banner gradient, and the word-flip text component. Those interactions were simple entrance/decorative effects on first paint, so paying the runtime cost on the main dashboard route was not a good tradeoff.

Fix direction: replace first-paint dashboard motion wrappers with CSS/Tailwind animation classes and stable layout dimensions, keep the visual affordance lightweight, and scan the built dashboard route assets for motion runtime markers.

Status: Verified on 2026-06-15. `DashboardStats`, `WelcomeBanner`, `BackgroundGradient`, and `ContainerTextFlip` no longer import `motion/react`. The stat cards use CSS entry animation delays, the gradient is static decorative CSS, and the flip text uses stable `ch` sizing plus CSS animation. Admin typecheck/lint, root gates, local/live dashboard browser smoke, full deploy to admin `1e80b617-bffc-46f4-8a7b-b2e0e23ae606`, and a dashboard dist scan for motion runtime markers passed.

### PERF-007: Primary admin list routes still imported the broad query barrel

After earlier shell/settings query splitting, everyday list routes such as products, orders, categories, customers, pages, collections, discounts, inventory, attributes, and abandoned checkouts still imported `api.queries.ts` for one or two small query wrappers. That kept the legacy query barrel in hot route graphs.

Fix direction: create narrow domain modules under `apps/admin-v2/src/lib/api-query-options/`, move primary list route/component imports to those modules, and add static guards so these hot surfaces cannot regress to the broad barrel.

Status: Verified on 2026-06-15. Primary list/default-form surfaces now import small domain query-option modules from `apps/admin-v2/src/lib/api-query-options/` instead of the broad `api.queries.ts` barrel. The guard test protects the moved routes/components and prevents narrow query-option modules from importing the broad barrel. Verification: focused route-graph tests, import scans, admin typecheck/lint/build, protected production manifest scan, root typecheck/lint/test/build/env/dist-secret/migration/audit/peer/frozen-install gates, local dev doctor plus local browser list-route/storefront smoke, full deploy to API `293bf435-7db5-4392-ace2-4960b87c1862`, admin `d057ea94-57d5-4334-8f8f-23da6e397d6c`, and storefront `7444afdf-b9cf-40e4-850b-fc3563070611`, and live demo sign-in, list-route HTTP checks, and browser smoke with no console errors. No production data was saved.

### PERF-008: Remaining admin routes still depended on the broad query barrel

After `PERF-007`, detail/edit/create routes and a few specialized managers still imported `apps/admin-v2/src/lib/api.queries.ts`. That meant the broad barrel still existed, could drift back into hot route graphs, and kept too many route-facing query wrappers coupled in one file. The customer form direct submit path also missed dashboard aggregate invalidation, so dashboard cards could stay stale after customer create/update outside the shared mutation hook path.

Fix direction: move the remaining query options into domain modules under `api-query-options/`, delete `api.queries.ts`, strengthen the route-graph guard to scan all admin runtime source, and protect direct form dashboard invalidation.

Status: Verified on 2026-06-18. The broad `api.queries.ts` file has been deleted. Products, orders, categories, collections, customers, discounts, pages, widgets, analytics, and checkout-language query options now live in narrow domain modules. The source guard scans all admin runtime source for broad-barrel imports, customer form writes invalidate `queryKeys.dashboard.all`, analytics date cells suppress expected server/client timezone text drift, and rich-text previews render sanitized `.rich-content` HTML while the ProseMirror editor remains deferred until edit. Verification: focused route-graph/order-detail tests (`10` tests), source/dist scans for `api.queries`, form chunk scans proving no eager Tiptap internals, admin typecheck/lint/build, root typecheck/lint/test/build/env/dist-secret/migration/audit/peer/frozen-install gates, `pnpm audit --audit-level moderate` after the `js-yaml` 4.2.0 override, local dev doctor plus local browser dashboard/create/detail/list/storefront smokes, full deploy to API `9f5132cd-7588-41a1-a464-f04965d0ed5e`, admin `77b5a8d1-4bbb-4e3a-b6b6-a8e4d9a20603`, storefront `27b8201c-fb66-4cc2-8b57-c5ae9ed7f431`, admin follow-up deploys `fb3dc516-8ae2-4d5f-ab95-1b337fc3c9a5` and `f4bf38a1-f285-4eb5-94e8-68fc60d5e7dd`, live demo sign-in, live authenticated dashboard/create/analytics/product-edit rich-preview/storefront browser sweep with zero fresh console errors, and unauthenticated `/admin` returning `307 /auth/login`. No production data was saved.

### ORDER-009: Admin full order edits can lose inventory-delta retry context

Admin full order edits can replace order/item rows before inventory deltas are fully and durably applied. If release/restore fails or only logs an error after item replacement, the old item context needed for safe retry can be lost.

Fix direction: fail closed on inventory delta failures, apply deltas before replacing item rows or through a transaction/outbox, and preserve enough old item state for retry.

Status: Verified on 2026-06-13. Admin full order edits now apply reserved/deducted negative deltas and terminal release/restore before item replacement, reject instead of logging through failed deltas, use the central shipped/delivered inventory predicate, batch item delete+insert so insert failure preserves old rows, and compensate pre-write inventory deltas when later writes fail. Focused `updateOrder()` tests cover release/restore failures, CAS failures, item replacement failure, shipment-claim blocking, and same-status shipped reconciliation. See `ORDER-009` in `REMEDIATION_TRACKER.md`.

### ORDER-010: Order-ingest fallback can double-reserve after uncertain rollback

When a shared order-ingest DB batch fails after reservations, rollback release is best-effort. The isolated fallback can then reserve the same order again even if the first reservation was not fully released.

Fix direction: track rollback success per order and only isolated-retry orders whose previous reservations were fully released; longer term, make reserve/release idempotent by order movement identity.

Status: Verified on 2026-06-13 and deployed to API version `b361f707-6450-42f0-9f88-a80d0b799d14`. The shared-batch-failure fallback now re-checks whether the order committed, reuses the reservation already acquired for isolated replay, releases only the failed order's original reservation, treats `releaseMultiple()` failure results as rollback failures, and fails checkout closed instead of retrying when release is uncertain. Focused queue tests cover isolated replay success, isolated replay failure, release failure, and ambiguous commit detection; root tests pass, and live dashboard/storefront browser checks completed without console errors. See `ORDER-010` in `REMEDIATION_TRACKER.md`.

### ORDER-011: Restoring trashed orders can revive invalid inventory/status combinations

`deleteOrder()` applies a cancelled inventory transition and soft-deletes the row while leaving the original status. `restoreOrder()` can then re-reserve inventory and set `inventoryAction = "reserved"` without reconciling terminal, deducted, cancelled, refunded, shipped, or delivered status semantics.

Fix direction: make restore either reject unsafe terminal/deducted/restored statuses or atomically choose a valid status/inventory pair. Add focused tests for restored `delivered/deducted` and `cancelled/restored` orders so no order can end as `delivered + reserved` or `cancelled + reserved`.

Status: Verified on 2026-06-13 and deployed to API version `c36bc4ca-bccf-4276-9be9-5c0f86e562ea`. Trash restore now applies an explicit inventory/status policy: incomplete/pending/processing/confirmed restored orders re-reserve variant stock or become `none` when no variant inventory exists, cancelled/returned/refunded remain restored, invalid existing reserved/deducted pairs reject, and shipped/delivered/completed/partially-refunded restored orders reject until reconciled. Successful re-reservations are compensated if the final restore CAS fails. The central inventory transition helper also re-reserves only `isStockReservableStatus()` statuses. Focused tests cover the restore matrix, CAS compensation, reservation failure preserving `deletedAt`, and non-reservable central transition behavior; root `pnpm test` passed at the then-current suite size. Live checks passed for API health, dashboard login/admin/orders, demo email sign-in, and storefront with no browser console errors. See `ORDER-011` in `REMEDIATION_TRACKER.md`.

### DEL-002: Shipment deletion can erase reconciliation evidence while a claim remains active

`deleteShipmentRecord()` blocks only `status = "creating"` and then hard-deletes the shipment row. It does not check whether the linked order has an active `shipmentClaimId` or an indefinite `shipmentClaimExpiresAt = null` claim, and it does not protect `reconcile_required` shipments. Deleting that row can leave the order blocked by an active claim with no reconciliation evidence.

Fix direction: shipment deletion should load the linked order claim and block active claimed shipments, especially `reconcile_required`. Only non-claimed terminal/failed shipment rows should be deletable.

Status: Verified on 2026-06-13 and deployed to API version `5a206ef1-adf4-42f3-bcab-ffe13c7d1e40`. `deleteShipmentRecord()` now loads the linked order claim before deletion, rejects active claims, rejects `reconcile_required`, rejects unresolved expired matching claims for nonterminal shipments, and clears stale failed/cancelled matching claims before deleting. Focused tests cover creating/reconciliation rows, future and indefinite active claims, expired matching nonterminal claims, unclaimed failed deletion, stale failed claim cleanup, and unrelated expired claims; root `pnpm test` passed at the then-current suite size. Live checks passed for API health, dashboard login/admin/orders, demo email sign-in, and storefront with no browser console errors. See `DEL-002` in `REMEDIATION_TRACKER.md`.

### ADMIN-001: Admin API wrapper layer was too large and partially outside TypeScript

The legacy `apps/admin-v2/src/lib/api.functions.ts` barrel has been removed. Admin server functions now live in typed domain slices under `apps/admin-v2/src/lib/api-functions/`. Use fresh `rg` scans for volatile function/query counts instead of copying old audit numbers. The final widget extraction also moved widget history/placement-target calls to generated SDK request/response types, stripped widget update path IDs from JSON bodies, and tightened widget OpenAPI schemas before regenerating the SDK.

Fix direction: keep new admin data access in domain-specific server-function slices with generated SDK request types or shared schemas. Do not reintroduce a broad barrel or file-level `@ts-nocheck`.

Status: Verified on 2026-06-13. Cache, analytics-script, navigation item/preview, fraud-checker, abandoned-checkout delete, RBAC role/permission, auth/admin-users/2FA/setup, settings, shipping methods, checkout languages, delivery, hero sliders, AI/Firebase, dashboard, inventory, media, attributes, pages, discounts, categories, collections, products/variants, orders/shipments, customers, and widgets were extracted to `apps/admin-v2/src/lib/api-functions/` without file-level `@ts-nocheck`.

### ADMIN-002: Admin UI RBAC can disagree with API RBAC

The admin shell allows users with `role: "admin"` even when they lack RBAC permissions. The API requires mapped permissions and fails closed for missing route mappings. Users created as admin without a role ID can enter the shell and then hit 403s on API-backed screens.

Fix direction: align admin route guard behavior with API RBAC, or enforce role assignment during user creation.

Status: Verified on 2026-06-13, with a 2026-06-15 hardening slice verified on deploy/live smoke. Admin shell access now uses pure permission-based helpers, no longer grants access from legacy `role="admin"` alone, and redirects permissionless users to `/admin/access-denied` while keeping that page reachable. The hardening slice now uses the shared page-permission map for deep-link checks, denies unmapped admin pages for non-super-admins, and redirects `/admin` users without `dashboard.view` to their first accessible page.

### ADMIN-009: Admin page deep links can bypass page-level RBAC

The admin shell previously checked only whether the user had any admin permission before rendering `/admin/*` children. Sidebar links were filtered, but direct deep links such as create/edit pages could still mount for a user with an unrelated permission until an API call failed.

Fix direction: enforce the shared admin page-permission map in the TanStack `/admin` route guard, keep `/admin/access-denied` and own account settings reachable, fail closed for unmapped pages, and route `/admin` to the first accessible page when the user lacks `dashboard.view`.

Status: Verified on 2026-06-15. Focused `admin-access` tests cover product view/create/edit, own account, `/admin` fallback, unmapped paths, and super-admin mapped access. Root warning-free lint/typecheck/test/build/env/migration/audit/diff gates passed, full deploy completed to API `822d3968-ffc0-4280-9286-f161a4096525`, admin `a6701970-d938-4250-a483-3c6155ab0f89`, and storefront `9d6a9ea8-6258-487a-85e0-ed4e6f34d72d`, and live dashboard route smoke passed.

### ADMIN-010: Product list SSR hydration could mismatch on first render

The product list loader fired category-form and product-stats prefetches without awaiting them even though the route UI could consume those query results during first render. On a fresh deployment this could produce a different dehydrated query cache between SSR and hydration. Shared date cells also render localized timestamp text that can differ across the server/client boundary.

Fix direction: await query data that the first render can consume, avoid fire-and-forget prefetches for hydration-visible data, and suppress hydration warnings only for known timestamp text drift.

Status: Verified on 2026-06-15. `/admin/products` now awaits product list, category form options, and product stats together before SSR hydration, while shared date-cell text uses `suppressHydrationWarning`. Admin typecheck/lint passed, full root gates passed, admin deployed as `a6701970-d938-4250-a483-3c6155ab0f89`, and live `/admin/products` Chrome/CDP smoke had a 200 document response with no console/runtime errors or error-boundary page.

### RBAC-001: Permission revocations can stay stale across isolates

RBAC permission reads used a five-minute in-memory cache before checking KV. If a role or override was changed in another isolate, the local memory cache could continue authorizing revoked access. Some RBAC mutation routes also cleared only local memory or omitted the KV namespace when calling helper invalidators.

Fix direction: treat KV as the cross-isolate permission-cache source of truth when available, force a DB refresh on KV misses, pass KV through API RBAC reads/mutations, and clear every assigned user's cache after role permission edits.

Status: Verified on 2026-06-15. Focused core and API middleware tests cover KV-backed permission resolution and stale local memory after KV invalidation. Root warning-free lint/typecheck/test/build/env/migration/audit/diff gates passed, API deployed as `822d3968-ffc0-4280-9286-f161a4096525`, and live auth/API/dashboard smoke passed.

### STORE-008: Widget homepage content links to nonexistent collection routes

Local storefront smoke found stored/generated widget HTML linking to `/collections` and `/collections/all`, but the storefront does not currently expose those collection-list routes. The links caused user-visible 404 navigation from the homepage.

Fix direction: keep stored widget content portable, but normalize known storefront-only link targets at render time so generated/stored widgets do not need to be rewritten in the database.

Status: Verified on 2026-06-15. Storefront widget content now rewrites internal `/collections` and `/collections/all` hrefs to `/search`, preserving query strings and hashes while leaving product and external links alone. A shared widget-rendering test covers the rewrite, root gates passed, storefront deployed as `9d6a9ea8-6258-487a-85e0-ed4e6f34d72d`, and live storefront route smoke confirmed no bad collection links on the checked pages.

### ADMIN-003: Admin list loaders do not track search params

Several routes validate search params but do not use `loaderDeps`; loaders prefetch default query keys while components refetch with URL-derived params.

Fix direction: add a list-route helper that ties `validateSearch`, `loaderDeps`, param mapping, and query options together.

Status: Verified on 2026-06-13. Products, orders, categories, customers, pages, discounts, collections, attributes, widgets, and widget trash loaders now declare `loaderDeps` and prefetch with the validated URL search deps.

### ADMIN-004: Admin has duplicate API transports

Server functions unwrap envelopes and forward selected headers. The browser proxy forwards all headers/body and passes responses through. Exceptions exist for abandoned checkouts, uploads, scanner flows, widget streaming, and other flows.

Fix direction: create one shared transport policy and document intentional exceptions.

Status: Verified on 2026-06-13. Transport behavior is documented in `AGENTS.md`; server functions unwrap API envelopes, the browser proxy intentionally passes responses through, and exceptions are documented. See `ADMIN-004` in `REMEDIATION_TRACKER.md`.

### ADMIN-005: Dynamic navigation product preview route was missing

The admin dynamic navigation dialog called `/admin/navigation/preview-products`, but the API did not register that route. Preview counts for category/filter links therefore failed even though the UI path existed.

Status: Verified on 2026-06-13. `GET /api/v1/admin/navigation/preview-products` now validates `categoryId`, ignores reserved list params when building attribute filters, delegates count logic to storefront product filtering through `getNavigationPreviewProductCount()`, enforces `products.view` via API RBAC, and is included in the regenerated SDK.

### ADMIN-006: RBAC permission override payload drift

The admin user permission editor sent `{ permissionId }` to `/admin/rbac/user-permissions`, while the API requires `{ permission, granted }` for writes and `{ permission }` for deletes. Type casts in the admin RBAC wrappers hid the mismatch.

Status: Verified on 2026-06-13. RBAC server functions are typed in `apps/admin-v2/src/lib/api-functions/rbac.ts`, and the UI sends the API contract directly.

### ADMIN-007: Account settings nested permission provider used the permission catalog

`/admin/settings/account` fetched all RBAC permission definitions and passed their names into a nested `PermissionProvider`. Inside the account settings subtree, this could make a non-superadmin appear to have every permission.

Status: Verified on 2026-06-13. Account settings now uses the parent `/admin` route's effective user/permission context and only overlays account-security fields that are not present in that context.

### ADMIN-008: Admin invite email failure was hidden in the UI

The API can create an admin user while returning `emailFailed: true` when the invite email provider fails. The admin UI ignored that response and always showed that the email was sent.

Status: Verified on 2026-06-13 and rechecked in docs on 2026-06-14. The typed auth-management wrapper exposes `emailFailed`, and the team-member hook shows the API message as a warning when invite delivery fails. The API no longer returns the generated temp password when invite delivery fails; admins should fix email settings or use password reset.

### STORE-002: Storefront browser `/api/v1` fallback is not a real proxy

The browser client fallback is `/api/v1`, but the storefront app has only specific proxy routes, not a catch-all API proxy. Missing `PUBLIC_API_URL` can make browser search/auth config calls hit storefront 404s.

Fix direction: require a configured public API URL, add an intentional proxy, or make every browser API call use explicit storefront endpoints.

Status: Verified on 2026-06-13. Browser API URL resolution now requires configured `PUBLIC_API_URL`/injected `window.__API_BASE_URL__` and fails loudly if missing; AuthModal/search use the shared URL helper.

### STORE-003: External gateway checkout clears cart before payment completion

SSLCommerz and Polar handlers return redirect URLs immediately. Checkout clears cart/session data when a redirect is returned, even though payment can still be abandoned or fail.

Fix direction: preserve a recoverable checkout session until webhook/return confirmation.

Status: Verified on 2026-06-13. Redirect gateways now preserve cart/session state unless the handler explicitly marks the redirect as a completed-order path; the protected order-success page clears the cart after a valid receipt loads.

### STORE-004: Cart location prefill does not match rendered controls

Cart prefill looks for `select[name="city"]` and `select[name="zone"]`, while `LocationSelector` renders hidden inputs and custom dropdowns.

Fix direction: drive location state through the component API or hidden inputs consistently.

Status: Verified on 2026-06-13. Cart prefill now dispatches a `location-prefill` event that `LocationSelector` handles through React state, resolving saved IDs or display names against the real city/zone/area options.

### STORE-005: Checkout config inline script allows stored script breakout

`checkout.astro` serialized gateway/runtime checkout config directly into an executable inline script with raw `JSON.stringify()`. Admin/provider-controlled values containing `</script>` could terminate the script block and inject HTML.

Fix direction: use a script-safe JSON serializer for executable inline-script assignments and prove the serialized output stays inert when parsed as HTML.

Status: Verified on 2026-06-14. Checkout config now uses `serializeJsonForInlineScript()`, which escapes script-breaking characters while preserving JSON round-trip behavior. The regression test parses the inline assignment inside a `<script>` element and confirms a malicious `</script><img ...>` payload leaves exactly one script and no injected element. Deployed to storefront version `3215e5be-1237-47bd-a2b1-ac92c3805a58`; live `/checkout` HTML contains the expected `window.__CHECKOUT_CONFIG__` assignment, and browser/Worker-tail smoke was clean.

### STORE-006: Empty-cart language strings render through `innerHTML`

The storefront cart empty state interpolated active checkout-language strings into an `innerHTML` template. A malicious or compromised language/config value could inject markup when the cart was empty.

Fix direction: render localized/admin-configured text with DOM text nodes or framework text interpolation, not HTML string concatenation.

Status: Verified on 2026-06-14. The empty-cart renderer is isolated in `apps/storefront/src/lib/cart/empty-state.ts` and assigns `emptyCartText`/`continueShoppingText` with `textContent`/text nodes. A happy-dom regression test feeds malicious language strings and confirms no `img`/`script` nodes are created. Deployed to storefront version `3215e5be-1237-47bd-a2b1-ac92c3805a58`; live browser inspection of `#cartItems` showed the empty-cart renderer with no `img` or `script` nodes and no console errors.

### PRIV-002: Checkout PII persisted and enriched broad Meta CAPI events

Cart saved standalone `scalius_user_*` sessionStorage keys for Meta CAPI matching, and the Meta CAPI dispatcher merged those keys into every server-side event. That expanded checkout/customer PII processing to product, search, cart, checkout-initiation, and payment-info events.

Fix direction: keep browser-default CAPI data to non-PII attribution signals, remove standalone PII capture, clear legacy keys, and scope any CAPI PII to explicit narrow conversion events.

Status: Verified on 2026-06-14. Cart no longer writes standalone `scalius_user_*` analytics keys, `sendServerEvent()` defaults to `_fbp`, `_fbc`, and user agent plus explicit caller-provided `userData`, and `clearCheckoutSession()` removes both checkout transfer keys and legacy PII keys. SSLCommerz and Polar external redirects now clear raw checkout transfer state after order/session creation while preserving cart contents for cancel/failure recovery. Verification included focused Meta CAPI/session/redirect tests, storefront typecheck/build/lint, root `pnpm test`, deployed asset scans, live HTTP checks, browser smoke with no console errors, and storefront deploy version `4391b4cd-7a08-438c-be2e-193d8df7a79e`.

### CACHE-001: Payment settings saves leave checkout caches stale

Payment-method, Stripe, SSLCommerz, and Polar settings writes invalidated gateway credential caches but not the public checkout config cache or storefront checkout cache prefixes. Public checkout config also ignored the aggregate `payment_methods.enabled_methods` allowlist, so admin method toggles could be stale or ineffective for the storefront until unrelated changes rebuilt config.

Fix direction: route payment settings writes through the checkout cache group, purge storefront checkout prefixes, and make checkout config treat `payment_methods.enabled_methods` as the outer allowlist while still validating each gateway's own enabled/configured state.

Status: Verified on 2026-06-14. The API payment settings routes now invalidate `["checkout"]` in API KV and call the storefront purge helper after successful payment-method, Stripe, SSLCommerz, and Polar saves. The checkout invalidation group includes `api:checkout:config:` and `/api/v1/admin/settings/polar`; the dormant core helper copy is aligned. Public checkout config now filters registered gateways through `payment_methods.enabled_methods` before applying individual gateway and checkout-mode rules. Verification included focused API route/cache tests, focused core checkout-config tests, API/core typechecks and lints, root `pnpm test`, env/dist-secret checks, API deploy version `22831cca-fe5d-4df0-a6d7-96bf3237a0ab`, live API checkout-config smoke, and storefront browser smoke with no console errors.

### CONTENT-001: Scheduled publishing is not enforced publicly

Pages store and validate `publishedAt`, but public page queries and sitemap generation only check `isPublished`/`deletedAt`.

Fix direction: include `publishedAt <= now` in public content queries and sitemap generation.

Status: Verified on 2026-06-13. Public page ID, slug, list, and sitemap reads share a visibility predicate requiring not-deleted, published, and `publishedAt` null or not in the future.

### CONTENT-002: Cart is listed in sitemap and lacks noindex

`/cart` is included in static sitemap output and the cart page does not pass `noindex` to the layout.

Fix direction: centralize sitemap/noindex policy and exclude transactional/private pages.

Status: Verified on 2026-06-13. Static sitemap excludes `/cart`, and the cart page passes `noindex` through the shared layout.

### NOTIF-001: Notification type contracts drift

Notification services/settings support nine order notification types, but `apps/api/src/queue-consumer.ts` has a narrower queue message union.

Fix direction: define notification queue types once and import them in service, settings, and queue consumer.

Status: Verified on 2026-06-13. `ORDER_NOTIFICATION_TYPES` is now centralized in core and used by order fulfillment, queue messages, settings defaults, notification service code, and admin notification-channel UI.

### NOTIF-002: Order SMS notifications may not receive the credential encryption key

The notification service calls `getActiveSmsProvider(db)` without the encryption key, while OTP queue handling passes the key.

Fix direction: thread runtime encryption key into order notification processing and add an encrypted-provider test.

Status: Verified on 2026-06-13. The order-notification queue branch passes the runtime encryption key into customer notification dispatch, and SMS provider resolution receives that key even when the customer has no email address.

### CONF-001: Credential encryption helper key priority is risky

Original issue: `apps/api/src/utils/encryption-key.ts` had a helper that preferred `JWT_SECRET` before `CREDENTIAL_ENCRYPTION_KEY`, while stricter helpers required the credential key. This could break credential rotation or decryption consistency.

Fix direction: make credential encryption use `CREDENTIAL_ENCRYPTION_KEY` first and treat JWT fallback as an explicit migration path only if needed.

Status: Verified on 2026-06-13. `getEncryptionKey()` now prefers `CREDENTIAL_ENCRYPTION_KEY`, keeps JWT only as a legacy fallback, and SMS secret writes require the dedicated credential key for new secrets.

### CONTRACT-001: Storefront discount usage endpoint is stale

Storefront still calls `POST /discounts/usage` after order creation, but the API discounts router exposes `/validate`; backend queue logic now owns discount usage inserts.

Fix direction: remove the stale storefront call or intentionally add a supported endpoint if still needed.

Status: Verified on 2026-06-13. The storefront no longer calls `/discounts/usage`; discount usage remains owned by backend order creation/ingest.

### CONTRACT-002: Storefront order payload types drift from generated SDK

Storefront hand-maintains `CreateOrderPayload` instead of using the generated SDK request body. The original `polar` omission subclaim has since been fixed, but local type drift can still hide schema changes.

Fix direction: alias or derive storefront payload types from generated SDK types or a shared validation schema.

Status: Verified on 2026-06-13. Storefront `CreateOrderPayload` is now an alias of generated `OrderPostRequest`, and checkout/COD builders satisfy that contract.

### CONTRACT-003: API timestamp schemas generate weak SDK types

Some OpenAPI schemas generate `string | number | unknown` timestamp unions, encouraging local type duplication.

Fix direction: standardize timestamp schemas and regenerate the SDK.

Status: Verified on 2026-06-13. API timestamp schemas now use shared helpers, API-client spec generation normalizes malformed nullable `anyOf` branches, and the regenerated SDK emits `string | number | null` timestamp fields instead of weak `unknown` unions.

### DB-001: Migration metadata snapshots appear incomplete

The Drizzle journal lists later migrations, including `0036` and `0037`, while snapshot metadata appears incomplete. `drizzle-kit check` currently passes, so this is a generation-risk item rather than a confirmed runtime schema failure.

Fix direction: make manual migrations explicit and add a metadata/journal check or allowlist.

Status: Verified on 2026-06-13. Added `packages/database/scripts/check-migration-metadata.mjs` with an explicit allowlist for manual snapshot gaps; the guard and `drizzle-kit check` both pass.

### PLAT-001: Cloudflare Env types are duplicated and drifting

Wrangler configs and handwritten Env types do not match perfectly. API type declarations include or omit bindings inconsistently across `env.d.ts` and `hono-env.d.ts`.

Fix direction: generate per-app Wrangler types and keep only Hono context augmentation by hand.

Status: Verified on 2026-06-13. Added `pnpm check:env`, which reads API/admin/storefront Wrangler JSONC configs as the source of truth and checks each Worker `Env` declaration for missing or stale binding/var names. Removed stale API/admin `EMAIL` Env declarations, stale API `ASSETS` in `hono-env.d.ts`, and the unused API `SESSION` KV binding from both API Wrangler configs.

### DEV-001: Local dev scripts/docs are inconsistent

Docs and setup output mention old or nonexistent commands/ports. `scripts/dev.sh` also kills all `workerd` processes, which can terminate unrelated local Worker projects.

Fix direction: update docs/setup output, add compatibility aliases if desired, and scope cleanup to owned processes.

Status: Verified on 2026-06-13. Local dev commands, setup/reset/admin helpers, doctor checks, ports, disposable Wrangler state, and scoped cleanup behavior are documented; `scripts/dev.sh` now kills only Scalius dev ports by default. See `DEV-001` in `REMEDIATION_TRACKER.md`.

### DEV-002: Root lint gives false confidence

Root lint runs through Turbo, but admin has no lint script and Turbo dry runs include nonexistent lint tasks.

Fix direction: add real lint scripts or make root lint explicitly report covered workspaces.

Status: Verified on 2026-06-13. Root `pnpm lint` now filters out the config-only package and runs real ESLint scripts for API, admin, storefront, api-client, core, database, and shared.

### BUILD-001: Turbo build inputs omit public assets and helper scripts

Turbo build inputs do not include all `public/**` or build helper scripts, while root prebuild copies flags and copied flags are ignored.

Fix direction: add relevant inputs or move generated static assets into an explicit package prebuild/output model.

Status: Verified on 2026-06-13. Turbo build inputs now include workspace `public/**`, workspace `scripts/**`, Wrangler configs, and global dependencies on `eslint.config.js`, `pnpm-lock.yaml`, and `scripts/copy-flags.mjs`.

### BUILD-002: Flag prebuild depends on a transitive dependency

The flag copy script uses `country-flag-icons`, but no workspace declares it directly. The fallback message is misleading because runtime expects local `/flags/{XX}.svg` assets.

Fix direction: declare the dependency directly and fail prebuild when required flags cannot be copied.

Status: Verified on 2026-06-13. `country-flag-icons` is a direct root dev dependency, and `scripts/copy-flags.mjs` now fails the build if the package, source SVG set, or required copied flags are missing.

### BUILD-005: Turbo build cache omits app env inputs

Turbo build hashes did not include app-local `.dev.vars`/`.env*` files or build-time env variables read by Vite/Astro/TanStack Start configuration. That could let admin/storefront/API builds reuse stale cached output after changing API URLs, CDN/media URLs, Better Auth URL, or Firebase public build config.

Fix direction: keep app-local env files in Turbo global file inputs and declare build-time env names in Turbo global env inputs. Do not add secret-only variable names to `globalEnv`.

Status: Verified on 2026-06-14. `turbo.json` now includes the app env file globs in `globalDependencies` and the build-time env names in `globalEnv`; `scripts/turbo-config.test.mjs` guards the config. Turbo dry-run JSON shows app env files under `globalCacheInputs.files` and declared env names under `globalCacheInputs.environmentVariables.specified.env`; env values set for the dry run appear in `configured`.

### SDK-001: Generated SDK runtime package is deprecated

`@scalius/api-client` still depended on deprecated `@hey-api/client-fetch`, even though current `@hey-api/openapi-ts` bundles the Fetch client generator directly. The package also had a post-generation shim that rewrote generated imports to a custom `client-core.ts`, making SDK regeneration more fragile than necessary.

Fix direction: update to the latest compatible `@hey-api/openapi-ts`, remove the deprecated runtime package and post-generation shim, point custom factories at the generated bundled client, regenerate the SDK, and typecheck API-client consumers.

Status: Verified on 2026-06-14. Npm reports `@hey-api/openapi-ts` 0.98.2 as current and `@hey-api/client-fetch` as deprecated. The API client now uses `@hey-api/openapi-ts` 0.98.2, has no `@hey-api/client-fetch` runtime dependency, deletes `scripts/post-generate.mjs` and `src/generated/client-core.ts`, and imports `./generated/client` directly. Verification covered SDK regeneration from a live local API worker, API-client/admin/storefront focused typechecks, root typecheck, root tests, root lint, dependency audit, and diff checks.

### TEST-002: Storefront focused tests are blocked by missing `happy-dom`

Storefront Vitest config requires `happy-dom`, but the storefront package does not declare it.

Fix direction: add the test environment dependency or change the test environment to one that is already declared.

Status: Verified on 2026-06-13. `happy-dom` is now declared in the storefront package, and focused storefront Vitest slices start successfully.

## P3 Findings

### DOC-001: Generated package docs are stale

`packages/api-client/README.md` and `packages/database/README.md` contain stale counts and dependency claims.

Fix direction: remove volatile counts from prose or generate them automatically.

Status: Verified on 2026-06-14. The API-client README points to `openapi.json` and generated files as the source of truth, avoids endpoint/method line counts, and documents the bundled generated Fetch client instead of the deprecated `@hey-api/client-fetch` runtime package. The database README avoids fragile column counts, documents `widgetPlacements`, updates migration notes through `0041`, and removes a stale singleton-constraint limitation.

### CLEAN-001: Route directory contains `.DS_Store`

`apps/admin-v2/src/routes/.DS_Store` exists under a generated route root.

Fix direction: remove the file and ensure `.DS_Store` is globally ignored.

Status: Verified on 2026-06-13. The file was removed, and root `.gitignore` already ignores `.DS_Store`.

### CACHE-009: Admin cache-management wording was misleading

The `/admin/settings/cache` UI described storefront purge actions in a way that suggested all groups warm pages or fully purge HTML, even though some groups only clear API/KV prefixes and only selected HTML-affecting groups warm critical storefront pages.

Status: Verified on 2026-06-15. The cache settings UI now labels groups with `Warms HTML` or `Prefix only`, and an invalid nested Badge container was corrected to avoid hydration warnings. Local and live `/admin/settings/cache` browser smoke checks passed after redeploy.

### CACHE-010: Cache settings refetched data outside TanStack Query

`CacheManager` mounted direct server-function calls for stats, last-cleared timestamps, and group metadata even though the route already warmed cache query options. That duplicated work on first render and bypassed the app's normal invalidation path.

Status: Verified on 2026-06-15. `CacheManager` now consumes the shared cache query options and uses domain mutation hooks from `api-mutations/cache.ts`. Local request capture showed the page loading without duplicate decoded cache server-function fanout, and live browser checks showed no browser `/api/v1/cache` calls or error-boundary state.

### CACHE-011: Clear-all cache timestamps were UI-only

The admin clear-all action could make every group appear freshly cleared in local component state, while the API only persisted the generic clear operation. A refresh could therefore lose per-group "last cleared" state even though the UI had reported success.

Status: Verified on 2026-06-15. `POST /api/v1/cache/clear` now persists `sc:_last_cleared:<group>` for every invalidation group. Focused API route tests verify API cache deletion, group timestamp persistence, and `/last-cleared` reads. The same slice also fixed storefront purge warming to use `url.origin`, preserving local/staging ports.

### UI-001: Empty dashboard can emit Recharts zero-size warnings

The disposable local dashboard can load with no daily activity data, which allowed Recharts to mount into a zero-size container and emit width/height warnings.

Status: Verified on 2026-06-13. `DashboardChart` now renders a fixed-height empty state until client mount and non-empty daily activity data are available, with focused data-helper tests.

## Stale Or Corrected Old Findings

- API RBAC for unmapped admin routes now appears fail-closed. Do not repeat "RBAC fallback allows unknown admin routes" without new evidence.
- Raw scanner QR-token bearer bypass and scanner token mint RBAC are remediated. Scanner auth now uses a scanner session cookie restricted to exact allowlisted endpoints. Do not repeat scanner-token claims without checking the current route and tests.
- D1 migration drift was not confirmed by `drizzle-kit check`; metadata/generation risk remains.
- Widget sanitizer bypass was not re-confirmed in this pass. Previously confirmed widget script-extraction and target-aware cache-invalidation issues are remediated; repeat widget claims should cite fresh evidence and current tests.

## Simplification Themes

- Make state transitions explicit and shared: order, inventory, payment, delivery, and notification should not each implement their own partial transition rules.
- Put durable idempotency before side effects for webhooks, queues, and provider calls.
- Keep admin API wrappers domain-sliced and typed with generated SDK payloads or shared schemas.
- Use generated SDK types or shared Zod schemas where app-local payload types currently drift.
- Generate Cloudflare Env types from Wrangler configs.
- Make local verification smaller and reliable instead of relying on one fragile full-stack run.
