# Historical Audit Report and Verification Summary

This report is based on a fresh read of the codebase, focused commands, and read-only subagent audits. It is intentionally issue-oriented so future agents can fix one slice at a time.

## Executive Summary

The codebase is workable and the monorepo shape is mostly coherent: TanStack Start admin, Hono API Worker, Astro storefront, shared core/database/api-client packages, Cloudflare Workers runtime, D1, queues, KV/R2, and generated OpenAPI SDK.

The original highest risks were not "wrong stack" problems. They were boundary and workflow problems:

- Public or weakly authorized flows expose sensitive operations or data.
- Order/payment/delivery workflows have side effects before durable local claims or CAS updates.
- Some generated/runtime contracts drift because types, SDKs, migrations, and docs are not checked continuously.
- Full local verification is difficult, so the repo needs smaller reproducible verification loops per slice.

Current tracked remediation state: the original tracker items are marked `Verified` as of 2026-06-13. A fresh focused re-audit on 2026-06-13 opened `PAY-003` and `ORDER-005`; both are now verified.

## Validation Performed

- Root `pnpm typecheck`: passed.
- `pnpm --filter @scalius/admin-v2 typecheck`: passed after the final widget extraction; the former `api.functions.ts` barrel no longer exists.
- `pnpm --filter @scalius/api typecheck`: passed.
- `pnpm --filter @scalius/storefront typecheck`: passed.
- `pnpm exec drizzle-kit check --config packages/database/drizzle.config.ts`: passed.
- `pnpm check:env`: passed.
- `pnpm lint`: passed with warnings.
- `pnpm test`: passed 93 test files and 556 tests.
- Focused API/payment tests run by subagents passed for queue consumer, Polar webhook, and COD service slices.
- Focused storefront Vitest now starts after adding the missing `happy-dom` dev dependency.

## Severity Guide

- P0: security/privacy or data mutation exposure that should be fixed before feature work.
- P1: high reliability, data integrity, deploy, or workflow correctness risk.
- P2: maintainability, verification, local dev, or contract drift that makes future work unsafe.
- P3: documentation, cleanup, or quality issue that should be batched.

## P0 Findings

### SEC-001: Admin API does not enforce 2FA verification at the API boundary

`apps/api/src/middleware/admin-auth.ts` accepts a Better Auth session and sets the admin user without checking whether a 2FA-enabled session has completed 2FA. Admin UI helpers redirect when 2FA is needed, but direct API access should not rely on UI-only enforcement.

Fix direction: enforce the 2FA-verified session state in the API admin middleware, then add route tests for unverified 2FA sessions.

Status: Verified on 2026-06-13. Admin API middleware now rejects unverified 2FA sessions before RBAC except exact 2FA info/verify/mark-verified endpoints, with focused API middleware tests. See `SEC-001` in `REMEDIATION_TRACKER.md`.

### SEC-002: Scanner token minting bypasses inventory RBAC

Raw QR-token scanner bypass appears fixed: scanner sessions are exchanged into a cookie and limited to an allowlist in `packages/shared/src/scanner-auth.ts`. The current problem is earlier: `apps/admin-v2/src/routes/api/scanner-token.tsx` mints scanner tokens for any authenticated admin session, without checking inventory/stock permissions.

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

### TEST-001: Root test suite failed widget script extraction

`pnpm test` previously failed `apps/admin-v2/src/components/admin/widgets/widget-form/widget-generation-content.test.ts`. The failing test expected local-safe `<script>` tags to be extracted into JS before preview, but the HTML still contained the script tag.

Status: Verified on 2026-06-13. `parseGeneratedWidgetContent()` now returns normalized widget parts so HTML-owned `<script>` blocks are moved into JS before preview. Root `pnpm test` passes.

Fix direction: fix parser behavior or update the test only if the intended contract changed.

## P2 Findings

### ADMIN-001: Admin API wrapper layer was too large and partially outside TypeScript

The legacy `apps/admin-v2/src/lib/api.functions.ts` barrel has been removed. Admin server functions now live in typed domain slices under `apps/admin-v2/src/lib/api-functions/`, currently 251 exported server functions. The final widget extraction also moved widget history/placement-target calls to generated SDK request/response types, stripped widget update path IDs from JSON bodies, and tightened widget OpenAPI schemas before regenerating the SDK.

Fix direction: keep new admin data access in domain-specific server-function slices with generated SDK request types or shared schemas. Do not reintroduce a broad barrel or file-level `@ts-nocheck`.

Status: Verified on 2026-06-13. Cache, analytics-script, navigation item/preview, fraud-checker, abandoned-checkout delete, RBAC role/permission, auth/admin-users/2FA/setup, settings, shipping methods, checkout languages, delivery, hero sliders, AI/Firebase, dashboard, inventory, media, attributes, pages, discounts, categories, collections, products/variants, orders/shipments, customers, and widgets were extracted to `apps/admin-v2/src/lib/api-functions/` without file-level `@ts-nocheck`.

### ADMIN-002: Admin UI RBAC can disagree with API RBAC

The admin shell allows users with `role: "admin"` even when they lack RBAC permissions. The API requires mapped permissions and fails closed for missing route mappings. Users created as admin without a role ID can enter the shell and then hit 403s on API-backed screens.

Fix direction: align admin route guard behavior with API RBAC, or enforce role assignment during user creation.

Status: Verified on 2026-06-13. Admin shell access now uses pure permission-based helpers, no longer grants access from legacy `role="admin"` alone, and redirects permissionless users to `/admin/access-denied` while keeping that page reachable.

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

Status: Verified on 2026-06-13. The typed auth-management wrapper exposes `emailFailed`, and the team-member hook shows the API message as a warning when invite delivery fails.

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

### TEST-002: Storefront focused tests are blocked by missing `happy-dom`

Storefront Vitest config requires `happy-dom`, but the storefront package does not declare it.

Fix direction: add the test environment dependency or change the test environment to one that is already declared.

Status: Verified on 2026-06-13. `happy-dom` is now declared in the storefront package, and focused storefront Vitest slices start successfully.

## P3 Findings

### DOC-001: Generated package docs are stale

`packages/api-client/README.md` and `packages/database/README.md` contain stale counts and dependency claims.

Fix direction: remove volatile counts from prose or generate them automatically.

Status: Verified on 2026-06-13. The API-client README now points to `openapi.json` and generated files as the source of truth, avoids endpoint/method line counts, and correctly lists `@hey-api/client-fetch` as a runtime dependency. The database README now avoids fragile column counts, documents `widgetPlacements`, updates migration notes through `0037`, and removes a stale singleton-constraint limitation.

### CLEAN-001: Route directory contains `.DS_Store`

`apps/admin-v2/src/routes/.DS_Store` exists under a generated route root.

Fix direction: remove the file and ensure `.DS_Store` is globally ignored.

Status: Verified on 2026-06-13. The file was removed, and root `.gitignore` already ignores `.DS_Store`.

### UI-001: Empty dashboard can emit Recharts zero-size warnings

The disposable local dashboard can load with no daily activity data, which allowed Recharts to mount into a zero-size container and emit width/height warnings.

Status: Verified on 2026-06-13. `DashboardChart` now renders a fixed-height empty state until client mount and non-empty daily activity data are available, with focused data-helper tests.

## Stale Or Corrected Old Findings

- API RBAC for unmapped admin routes now appears fail-closed. Do not repeat "RBAC fallback allows unknown admin routes" without new evidence.
- Raw scanner QR-token bearer bypass and scanner token mint RBAC are remediated. Do not repeat scanner-token claims without checking the current route and tests.
- D1 migration drift was not confirmed by `drizzle-kit check`; metadata/generation risk remains.
- Widget sanitizer bypass was not re-confirmed in this pass. The confirmed widget issue is the failing script-extraction test.

## Simplification Themes

- Make state transitions explicit and shared: order, inventory, payment, delivery, and notification should not each implement their own partial transition rules.
- Put durable idempotency before side effects for webhooks, queues, and provider calls.
- Keep admin API wrappers domain-sliced and typed with generated SDK payloads or shared schemas.
- Use generated SDK types or shared Zod schemas where app-local payload types currently drift.
- Generate Cloudflare Env types from Wrangler configs.
- Make local verification smaller and reliable instead of relying on one fragile full-stack run.
