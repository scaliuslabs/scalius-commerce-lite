# Scalius Commerce

## Overview

Turborepo monorepo: TanStack Start admin dashboard + Astro SSR storefront + standalone Hono API, all deployed as Cloudflare Workers. Admin and storefront communicate with the API worker through Cloudflare Service Bindings in production, with HTTP fallbacks for local development.

## Monorepo Structure

```
apps/
  admin-v2/       # @scalius/admin-v2 — TanStack Start admin dashboard Worker
  api/            # @scalius/api — Hono API Worker, queues, cron, WidgetDesignAgent DO
  storefront/     # @scalius/storefront — Astro 6 SSR storefront Worker
packages/
  api-client/     # @scalius/api-client — generated SDK from OpenAPI spec
  core/           # @scalius/core — domain services, auth, providers, integrations, search
  database/       # @scalius/database — Drizzle schema, D1 client, migrations
  shared/         # @scalius/shared — shared utilities
  tsconfig/       # @scalius/tsconfig — shared TS config package
```

## Quick Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start API :8787, admin :4323, storefront :4322 via `scripts/dev.sh` |
| `pnpm dev:all` | Alias for `pnpm dev` |
| `pnpm dev:api` | Start API :8787 via `scripts/dev.sh` with local migrations/readiness |
| `pnpm dev:admin` | Start admin :4323 + API :8787 |
| `pnpm dev:storefront` | Start storefront :4322 + API :8787 |
| `pnpm build` | Run `prebuild` (`scripts/copy-flags.mjs`) then Turbo build for workspaces with build scripts |
| `pnpm typecheck` | Run type checks through Turbo |
| `pnpm lint` | Run lint through Turbo for the seven code workspaces |
| `pnpm test` | Run all Vitest tests directly with `vitest run --passWithNoTests` |
| `pnpm test:watch` | Run Vitest in watch mode |
| `pnpm dev:setup` | Install deps, create local env files, apply local D1 migrations, create default local admin |
| `pnpm dev:reset` | Wipe local state, re-apply migrations, recreate default local admin |
| `pnpm dev:admin:create` | Create default local admin if none exists |
| `pnpm dev:admin:reset` | Reset local auth/admin credentials without wiping catalog/order data |
| `pnpm dev:admin:status` | Check whether a local admin exists |
| `pnpm dev:doctor` | Non-mutating local readiness check for env files, shared secrets, ports, services, and Wrangler state |
| `pnpm dev:doctor:api` | Require local API to be live |
| `pnpm dev:doctor:admin` | Require local API + admin to be live |
| `pnpm dev:doctor:storefront` | Require local API + storefront to be live |
| `pnpm dev:doctor:all` | Require API + admin + storefront to be live |
| `pnpm db:generate` | Generate Drizzle migrations via the API workspace |
| `pnpm db:migrate:local` | Apply D1 migrations to local Wrangler state |
| `pnpm db:migrate:remote` | Apply D1 migrations to remote D1 |
| `pnpm db:studio` | Drizzle Studio DB browser |
| `pnpm --filter @scalius/database check:migrations` | Verify migration SQL/journal/snapshot metadata and the manual snapshot-gap allowlist |
| `pnpm check:env` | Verify Wrangler binding/var names match Worker `Env` declarations |
| `pnpm check:dist-secrets` | Fail if app `dist/` outputs contain local env files such as `.dev.vars` or `.env*` |
| `pnpm generate:sdk` | Regenerate API client from the API OpenAPI spec |
| `pnpm deploy` | Typecheck, build, migrate remote D1, deploy API + admin + storefront |
| `pnpm deploy:api` | Typecheck, build API, migrate remote D1, deploy API |
| `pnpm deploy:admin` | Typecheck, build admin, deploy admin |
| `pnpm deploy:storefront` | Typecheck, build storefront, deploy storefront |
| `pnpm deploy:api --dry-run` | Typecheck, build, and dist-check API without applying D1 migrations or deploying |

## Architecture

### Apps

- **Admin (`apps/admin-v2/`)**: TanStack Start + React 19 admin dashboard. Current audited scale is 251 typed server functions under `src/lib/api-functions/`, 78 query option wrappers, 114 exported mutation hooks, and 62 non-API UI route files. Uses `env.API` service binding in production and Vite proxy/HTTP to `localhost:8787` in local dev. Also has direct D1/KV/R2 bindings for auth, RBAC, and storage initialization.
- **API (`apps/api/`)**: Standalone Hono `OpenAPIHono` app mounted at `/api/v1`. Exports a `WorkerEntrypoint` with `fetch`, `queue`, and scheduled inventory-expiry cron handlers. Owns public/admin API routes, webhook ingestion, OpenAPI spec, queue consumer, and `WidgetDesignAgent` Durable Object for widget AI generation.
- **Storefront (`apps/storefront/`)**: Astro 6 SSR + React 19 customer storefront. Owns product, category, cart, checkout, search, customer auth proxy, SEO, sitemaps, error pages, and L1/L2 caching. Uses `env.BACKEND_API` service binding in production; intentionally skips service binding in local dev because separate Miniflare processes cannot reliably share the Fetcher.

### Packages

- **`@scalius/api-client`**: Generated SDK from OpenAPI. Current generated spec has 253 paths / 351 operations. Has runtime dependency `@hey-api/client-fetch`. Do not hand-edit files in `packages/api-client/src/generated/**`; regenerate with `pnpm generate:sdk`.
- **`@scalius/database`**: Drizzle schema and D1 `getDb(env)` client factory. Current schema has 13 schema files, 10 table-defining files, 53 `sqliteTable()` declarations, and 39 SQL migrations (`0000` through `0038`).
- **`@scalius/core`**: Domain modules in `src/modules/`, Better Auth config, RBAC, providers, integrations, FTS5 search, and cache utilities.
- **`@scalius/shared`**: Shared utilities. It has external runtime deps, but no internal workspace deps.
- **`@scalius/tsconfig`**: Exports `base.json`, `worker.json`, and `astro.json`. Some apps use local framework configs instead of extending it directly.

Packages are JIT-consumed from TypeScript source by Workers/Vite/Astro. Most package manifests expose `.ts` subpaths and do not have build scripts.

## Tech Stack

- TanStack Start (admin) on Cloudflare Workers
- Astro 6 SSR (storefront) with Cloudflare adapter
- Vite 8 + React 19
- Hono + `@hono/zod-openapi` + Swagger UI
- Cloudflare D1 (SQLite) + Drizzle ORM + FTS5
- Tailwind CSS v4 + shadcn/ui/Radix-style components
- Better Auth (email/password + optional 2FA)
- Cloudflare KV, R2, Queues, Cache API, Durable Objects, Workers AI binding
- AI SDK providers for OpenRouter/OpenAI/Gemini/Cloudflare widget generation
- Cloudflare Service Bindings
- Turborepo + pnpm workspaces

## Key Conventions

- **Thin HTTP layer is the target**: Normal `apps/api/src/routes/**` handlers validate/authenticate and delegate to `@scalius/core`. Some webhook and streaming routes still do inline DB work or dispatch because they are integration boundaries.
- **API route pattern**: New documented JSON endpoints should use `OpenAPIHono`, `createRoute()`, and `app.openapi()`. Exceptions exist for webhooks, health/root/docs/OpenAPI, Partytown proxy, redirects, text responses, and streaming/widget-generation routes.
- **OpenAPI timestamp schemas**: Use shared helpers from `apps/api/src/schemas/timestamps.ts` for mixed string/number/null timestamp fields. Do not hand-roll nullable timestamp unions that regenerate SDK fields as `unknown`.
- **Standardized API errors**: Import API-facing error classes from `apps/api/src/utils/api-error.ts` (re-exported from `@scalius/core/errors`).
- **Standardized API responses**: Use `ok(c, data)`, `created(c, data)`, and `noContent(c)` from `apps/api/src/utils/api-response.ts` for normal JSON endpoints.
- **Response envelope contract**: Normal success JSON endpoints return `{ success: true, data: T }`. The `T` passed to `ok(c, T)` is the final payload; do not nest another `{ success, data }` inside it. Explicit exceptions: root/health/OpenAPI/docs, webhooks, proxies, redirects, text responses, and `204` no-content responses.
- **202 Accepted responses**: Must include top-level `success: true`; use `c.json({ success: true, data: {...} }, 202)` because `ok()` forces 200.
- **Admin API behavior**: Admin server functions in `apps/admin-v2/src/lib/api.server.ts` unwrap API envelopes and return `data` to components. The browser proxy route `apps/admin-v2/src/routes/api/v1/admin/$.ts` passes API responses through unchanged.
- **Admin shell RBAC**: The admin shell uses permission-based RBAC, not legacy `user.role === "admin"`. `apps/admin-v2/src/lib/admin-access.ts` is the pure guard helper; only `/admin/access-denied` remains reachable for authenticated users with no admin permissions.
- **Transient D1 overloads**: Use `@scalius/core/utils/transient-d1` for known Cloudflare D1 overload/queue-timeout detection and short read-path retries. Do not duplicate string checks or blindly replay auth/payment/order write paths where the first attempt may have committed.
- **Storefront checkout proxies**: Payment session proxy endpoints unwrap `.data` because the checkout handlers read top-level gateway fields. `apps/storefront/src/pages/api/checkout/create-order.ts` intentionally returns `{ success: true, data: { id } }`, and the browser helper accepts either enveloped or legacy top-level IDs.
- **Checkout payment settings**: Public checkout config must honor `settings.category = "payment_methods"` / `enabled_methods` as the outer storefront gateway allowlist, while still requiring each gateway's own settings to be enabled/configured. Payment settings writes (`payment-methods`, Stripe, SSLCommerz, Polar) must invalidate the `checkout` cache group in API KV and purge storefront checkout prefixes (`checkout_config`, shipping/location/checkout-language keys).
- **Storefront inline JSON**: Never interpolate raw `JSON.stringify()` into executable inline scripts. Use `serializeJsonForInlineScript()` from `apps/storefront/src/lib/safe-json.ts` for values assigned through `set:html`/`is:inline`, and cover `</script>` breakout payloads with DOM-parser tests.
- **Storefront DOM text rendering**: Localized, customer-entered, admin-configured, or provider-configured strings must render through `textContent`, text nodes, framework text interpolation, or a sanitizer designed for rich HTML. Do not concatenate those strings into `innerHTML`; keep any `innerHTML` templates static or fully escaped for the target context.
- **Payment session proof and policy**: Stripe, SSLCommerz, and Polar session creation must require the order receipt token, validate it against `order_receipt:{token}` before gateway settings/provider calls, and derive callback/success/cancel URLs from trusted runtime config such as `PUBLIC_API_BASE_URL`, not request-body URLs. Payment amount/type/currency/capture behavior must be resolved through `apps/api/src/routes/payment/payment-session-policy.ts` and server settings/order state: reject soft-deleted, cancelled, returned, refunded, partially-refunded, fully-paid, or payment-refunded orders before gateway settings/provider calls; reject deposits when partial payment is disabled or the requested deposit does not match configured `siteSettings.partialPaymentAmount`; derive balance payments from stored balance/payment-plan state; ignore caller currency for session creation; keep public Stripe sessions `manualCapture: false`; and generate a unique SSLCommerz merchant `tran_id` per full/deposit/balance payment attempt while carrying the canonical order id separately in `value_b`/trusted callback `order_id`.
- **Payment webhook idempotency**: Stripe, SSLCommerz, and Polar webhook routes must use the durable `webhook_events` claim-before-side-effect helpers in `apps/api/src/utils/webhook-idempotency.ts` before enqueueing `PAYMENT_EVENTS_QUEUE`. Duplicates return success without enqueueing; queue failures mark the event `failed` and return retryable `503`. Fresh `processing` claims dedupe, stale `processing` claims are lease-reclaimable, and `queued`/`processed` claims remain terminal. SSLCommerz IPN must validate `val_id` first, use canonical validated `tran_id`/`val_id`/payment fields, resolve the canonical order id from validated `value_b` or parsed scoped `tran_id`, and resolve payment type against server-side order/payment-plan state instead of trusting form metadata such as `tran_id` or `value_a`.
- **Payment event consumers**: Confirmed gateway events use `processPaymentConfirmed()` and gateway-ID partial unique indexes. `processPaymentConfirmed()` must reject soft-deleted, cancelled, returned, refunded, partially-refunded, fully-paid, or payment-refunded orders before creating/promoting a local payment claim, and its final order CAS must include the same payable-state predicate to close races. SSLCommerz confirmed-payment idempotency is by canonical `sslcommerzValId`; `sslcommerzTranId` is an attempt/correlation field and cannot be the split-payment uniqueness key. These non-payable late successes are non-retryable queue outcomes for manual reconciliation; they must not mutate order totals/status. Failed gateway events must be idempotent and must not block a later successful event for the same retryable intent. Payment cancellation inventory release goes through `applyInventoryForStatusChange(..., OrderStatus.CANCELLED)`. Polar webhook refunds must CAS-update payment and order status through refund state-machine rules before releasing pre-fulfillment inventory.
- **Secrets and env**: Secrets (`API_TOKEN`, `JWT_SECRET`, `BETTER_AUTH_SECRET`, `PURGE_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`) come from Cloudflare runtime env/secret bindings. Never read secrets from `import.meta.env`. `pnpm dev:setup` creates `.dev.vars` for all three apps and `.env.development` only for admin/storefront build-time public values; it reuses existing shared local secrets for missing files and fails if existing API/admin/storefront secrets disagree. Use `pnpm dev:setup --env-only` to repair local env files without installing dependencies, applying migrations, or creating an admin.
- **Credential encryption**: Runtime credential reads use `getEncryptionKey()` with `CREDENTIAL_ENCRYPTION_KEY` preferred and JWT as legacy fallback. New credential writes should use `requireEncryptionKey()` when real provider secrets are submitted.
- **Local admin credentials**: `pnpm dev:setup` and `pnpm dev:reset` create `admin@local.scalius.test` / `ScaliusLocal123!` by default through the real `/api/v1/setup` endpoint. Override with `--admin-email`, `--admin-password`, `--admin-name`, or `LOCAL_ADMIN_*` env vars. Use `pnpm dev:admin:reset` to reset only local auth/admin credentials.
- **First-admin setup recovery**: If Better Auth inserted the first local user but setup failed before admin promotion, rerunning setup/admin-create should complete that user as the first super-admin instead of returning a 500. The setup KV lock must be released in `finally`.
- **Service bindings**: Admin uses `env.API`; storefront uses `env.BACKEND_API`. Production uses bindings. Local dev must fall back to HTTP/Vite proxy; admin treats a localhost `PUBLIC_API_BASE_URL` as a signal to ignore the service binding even if Wrangler exposes it.
- **API local Wrangler config**: `apps/api/package.json` uses `apps/api/wrangler.local.jsonc` for `pnpm --filter @scalius/api dev`. This local config intentionally omits the remote Workers AI binding so API/admin/storefront can boot without a Cloudflare remote proxy session. Production deploy/build still use `apps/api/wrangler.jsonc`.
- **Ports**: Admin 4323, storefront 4322, API 8787. Wrangler inspector ports are also cleaned by `scripts/dev.sh`.
- **RBAC auto-seed**: Permissions/roles auto-seed on first admin access via `apps/admin-v2/src/middleware/rbac.server.ts`.
- **FTS5**: Text search uses SQLite FTS5 helpers in `packages/core/src/search/fts5.ts`.
- **Inventory expiry**: `releaseExpiredReservations()` is for orphaned reservation movements whose order row is missing. Do not use the cron sweeper to cancel stale existing orders; existing orders must move inventory through explicit order transition logic so `orders.inventoryAction`, `productVariants`, and movement logs stay consistent.
- **Abandoned-checkout cleanup**: Old incomplete orders must win a guarded cleanup claim before inventory release: expected `version`, `status = incomplete`, `paymentStatus = unpaid`, `paidAmount <= 0`, `deletedAt IS NULL`, no active shipment claim, no pending/succeeded `order_payments`, and the stale cutoff must still match. Orders with `inventoryAction` `reserved` or `deducted` then release/restore through `applyInventoryForStatusChange(db, orderId, OrderStatus.CANCELLED)`. If release fails, roll the cleanup claim back to `incomplete`; do not archive or soft-delete. Insert the `abandoned_checkouts` archive row only after the final guarded cancelled/soft-deleted update succeeds. Never hard-delete stale incomplete orders before inventory release succeeds.
- **Order status inventory reconciliation**: Status, fulfillment, COD, delivery, refund, and return paths must call `applyInventoryForStatusChange()` even when retry sees the order already at the requested/mapped terminal status. Same-status retries must reconcile stale `orders.inventoryAction`; do not return early before inventory repair. Full-refund retries may release pre-fulfillment reservations for already-cancelled orders, but must not auto-restore fulfilled/deducted inventory.
- **COD payment state**: Generic order status updates must never synthesize COD payment state. COD collection must go through `processCodAction(..., { action: "collected" })` / `recordCODCollection()` so `cod_tracking`, `order_payments`, `orders.paymentStatus`, `orders.paidAmount`, and `orders.balanceDue` move together. Generic COD `delivered`/`completed` transitions may proceed only when successful COD payment and collected COD tracking evidence already exist and the order is fully paid.
- **Admin full order edits**: `updateOrder()` must preserve old item context until inventory deltas are safely applied. Positive deltas are reserved/deducted before the order CAS; negative reserved/deducted deltas and terminal release/restore are also applied before replacing `order_items`. Delta failures must reject the edit, not log-and-succeed. Item replacement uses one D1 batch so insert failure cannot strand the order with deleted old items, and pre-write inventory compensation must run when later writes fail.
- **Trash restore inventory policy**: `restoreOrder()` clears `deletedAt`; it is not a hidden order-status transition. Use the shared reservable-status policy from `isStockReservableStatus()`: `incomplete`, `pending`, `processing`, and `confirmed` may re-reserve stock and become `inventoryAction = "reserved"` when variant items exist, or `none` when no variant inventory exists. `cancelled`, `returned`, and `refunded` remain `restored`; shipped/delivered/completed/partially-refunded restored orders must reject until inventory/status are explicitly reconciled. Existing `reserved` and `deducted` actions are allowed only with compatible statuses, and a successful re-reservation must be released if the final restore CAS fails.
- **Shipment creation**: Route-facing provider shipment creation must go through `@scalius/core/modules/orders` fulfillment helpers. Bulk/provider shipment creation owns an order-level `shipmentClaimId` / `shipmentClaimExpiresAt` lock linked to the insert-first `delivery_shipments` row. Admin order/status/COD/fulfillment/edit/delete/refund/payment-session/shipment-refresh paths must reject active claims; cleanup should skip them; queue/webhook paths must retry rather than acknowledge skipped external truth. Provider success with failed local finalization marks the shipment `reconcile_required` and keeps the order claim active for reconciliation. `packages/core/src/modules/delivery/delivery.service.ts#createShipment()` is a low-level primitive and assumes the caller has already performed the durable order claim/transition.
- **Manual fulfillment**: `createFulfillmentShipment()` must first acquire a private `shipmentClaimId` without publishing `status = shipped` or `fulfillmentStatus = complete`. The manual `delivery_shipments` insert, scoped `order_items` updates, and final order status/fulfillment/claim-clear update must be committed together in one D1 batch. Fulfillment `itemIds` must be non-empty, unique, and belong to the same order; item updates must include `orderId` in the predicate. If the batch fails before the shipment row exists, clear the private claim and leave inventory untouched.
- **Shipment deletion**: Delete shipments only through `deleteShipmentRecord()`. It must reject active order shipment claims, `reconcile_required` rows, and unresolved expired matching claims; only failed/cancelled stale claimed shipments may clear the old order claim before deletion.
- **Order ingest queue isolation**: `handleOrderIngestBatch()` may batch DB writes for throughput, but stock reservation, DB-write fallback, checkout status, ack/retry, and rollback decisions must remain per order. A rejected/acked message must not be retried because another message in the same queue batch failed. After a shared DB batch failure, re-check whether each order row committed before mutating inventory, reuse any reservation already acquired for isolated replay, and only retry after that order's original reservation is confirmed released. If release is uncertain or `releaseMultiple()` reports failure, fail the checkout closed for manual reconciliation instead of redelivering into a second reservation.
- **Order creation queue handoff**: Storefront order creation must write checkout polling and receipt-token KV before sending to `ORDER_INGEST_QUEUE`. If queue send fails after KV creation, rewrite checkout status to terminal `failed` so storefront polling does not hang.
- **Storefront shipping verification**: Storefront order creation must require a valid active, non-deleted `shippingMethods` row whenever shipping applies and derive `shippingCharge` from that method fee. Browser-provided `shippingCharge` is not authoritative. Free-delivery products may explicitly waive shipping method and charge.
- **Delivery webhook/status semantics**: Pathao and Steadfast webhooks must claim durable lease-backed `webhook_events` before shipment/order side effects. Delivery event identities must include enough provider event/status/update data to allow later status changes for the same shipment; Steadfast delivery-status identities include the raw status. Delivery webhooks and refresh routes should call `updateOrderStatusFromShipment()` even when the shipment row already has the provider status so failed prior attempts can reconcile order inventory; customer notifications still require an actual order status change. Any status emitted by `packages/core/src/modules/delivery/status-mapper.ts` should either be handled explicitly in `updateOrderStatusFromShipment()` or documented as shipment-only. `shipped -> confirmed` is allowed only for failed carrier delivery retry semantics.
- **Generated files**: Do not edit `apps/admin-v2/src/routeTree.gen.ts` or generated API client files by hand.
- **Database migration metadata**: `packages/database/scripts/check-migration-metadata.mjs` enforces SQL/journal/snapshot consistency and documents the allowed manual migrations without snapshots. Update the allowlist only when intentionally adding a manual migration without a Drizzle snapshot.
- **Storefront import boundary**: Storefront may import `@scalius/shared` and `@scalius/api-client`; do not add `@scalius/core` or `@scalius/database` imports there without an architecture decision.
- **Storefront build ID**: `apps/storefront/src/config/build-id.ts` is generated and git-ignored. `apps/storefront/scripts/generate-build-id.js` must run before storefront typecheck/build/deploy. It prefers commit SHA env vars and otherwise hashes stable source/config inputs; do not reintroduce timestamp-only build IDs.
- **Package subpath imports**: `@scalius/database` and `@scalius/shared` do not expose useful root imports. Use subpaths such as `@scalius/database/client`, `@scalius/database/schema`, and `@scalius/shared/utils`.
- **Cloudflare bindings/types**: Wrangler configs are the source of truth for Worker bindings and vars. Keep each app's `env.d.ts`/`hono-env.d.ts` in sync and run `pnpm check:env` after binding/var changes. The check also guards allowed secret-only Env names; update its allowlist only when code really reads a runtime secret or dashboard-only override.

## Admin App Notes

- Local auth routes under `apps/admin-v2/src/routes/api/auth/$.ts` are handled by the admin worker, not the API worker.
- The `/admin` route guard intentionally runs during SSR so unauthenticated requests server-redirect to `/auth/login` before the admin shell HTML is emitted. Do not re-add `ssr: false` to the admin route without replacing that redirect behavior.
- `@/` and `~/` both alias to `apps/admin-v2/src`.
- Admin server functions live in typed domain slices under `apps/admin-v2/src/lib/api-functions/`, with route-facing wrappers in `api.queries.ts` and `api.mutations.ts`. Direct proxy/fetch exceptions exist for media uploads, abandoned checkout serialization, FCM token registration, scanner flows, and widget AI streaming.
- Add new admin server functions to a domain slice under `apps/admin-v2/src/lib/api-functions/` with normal typechecking; do not recreate a broad legacy barrel.
- Account settings must use the parent `/admin` route's effective permission context. Do not feed the full RBAC permission catalog into a nested `PermissionProvider`.
- URL-search-driven list routes must declare `loaderDeps` and prefetch with `mapParams(deps)` so deep links warm the same query keys components render.
- Keep server-function payloads route-shaped and JSON-serializable. If generated SDK responses include index signatures, strip them with local DTO helpers instead of adding file-level `@ts-nocheck`.

## Storefront Notes

- Runtime Cloudflare env is made request-scoped via `apiContext`/AsyncLocalStorage in `apps/storefront/src/middleware.ts`; API base URL resolution is lazy in `apps/storefront/src/lib/api/client.ts`. Browser API calls require configured `PUBLIC_API_URL`/injected `window.__API_BASE_URL__`; the storefront intentionally does not fall back to a fake same-origin `/api/v1` proxy.
- Same-origin customer auth must go through `apps/storefront/src/pages/api/customer-auth/[...path].ts` so `Set-Cookie` works on the storefront domain. Logout clears host-only cookies in `apps/storefront/src/pages/api/auth/logout.ts`.
- HTML caching is allowlisted in middleware. Cart, checkout, account, health, API routes, private sessions, and payment-sensitive flows must bypass cache.
- `/api/purge-cache` rejects purge credentials in query strings; send `Authorization: Bearer ...` or the configured purge-token header. Full purges bump the KV cache version and clear L1. Selective prefix purges also bump the KV cache version so L2 Cache API keys move, but only HTML-affecting purges warm critical pages.
- Public CMS page visibility is centralized in `packages/core/src/modules/pages/pages.service.ts`; public routes and page sitemaps must enforce `isPublished`, not deleted, and `publishedAt` null or not in the future.
- Cart supports COD server POST and multi-gateway sessionStorage redirect to `/checkout`; checkout gateway handlers live in `apps/storefront/src/lib/checkout/`. Preserve cart contents for external-gateway cancel/failure recovery, but clear raw checkout transfer state as soon as the browser no longer needs it. Completed-order redirects clear checkout state and cart; SSLCommerz/Polar external gateway redirects clear checkout session state after order/session creation while leaving cart intact.
- Storefront Meta CAPI browser dispatch may include only browser identifiers such as `_fbp`, `_fbc`, and user agent by default. Do not persist checkout/customer PII in standalone `sessionStorage` analytics keys or auto-enrich broad events (`ViewContent`, `Search`, `AddToCart`, `InitiateCheckout`, `AddPaymentInfo`) from checkout state. Any PII in `userData` must be explicitly supplied for a narrow conversion event and reviewed with the relevant privacy/consent context.
- Cart saved-location prefill goes through `LocationSelector`'s `location-prefill` event API. Do not drive nonexistent native `select[name="city"]`/`select[name="zone"]` elements.
- `/order-success` requires both `orderId` and a receipt `token`; public receipt rendering must use `GET /api/v1/orders/receipt/{id}?token=...` and a minimal receipt DTO, never the full order-by-ID response.
- Storefront order payloads use `CreateOrderPayload = OrderPostRequest` from the generated SDK. Do not reintroduce a hand-maintained local order request interface, and do not call the removed `/discounts/usage` endpoint from the storefront.

## Widget AI / Agents

- Widget AI provider settings live under `packages/core/src/modules/ai/` and API routes under `apps/api/src/routes/admin/settings/ai.ts`, `ai.ts`, `ai-models.ts`, `ai-prompts.ts`, and `ai-context.ts`.
- Long-running/staged widget generation uses `apps/api/src/agents/widget-design-agent.ts` (`WidgetDesignAgent` Durable Object) and `apps/api/src/routes/admin/widget-generation-runs.ts`.
- Admin UI pieces live under `apps/admin-v2/src/components/admin/widgets/widget-form/` and use streaming helpers such as `widget-generation-run-stream.ts`.
- AI provider credentials are encrypted; API credential reads prefer `CREDENTIAL_ENCRYPTION_KEY`, with JWT kept only as a legacy fallback for already-encrypted values.

## Settings Storage Patterns

- **`siteSettings` table**: Singleton row for always-present typed config such as guest checkout, checkout mode, header/footer config JSON, storefront URL, and SEO fields.
- **`settings` table**: Category/key/value store for optional/provider-specific config such as payment gateways, currency, email, Firebase, OpenRouter/widget AI, fraud checker, theme, phone, SMS, notification channels, and business info.

## How-To Recipes

### Add a New Field to an Entity

1. Schema: `packages/database/src/schema/{domain}.ts` — add column.
2. Migration: `pnpm db:generate`.
3. Validation: `packages/core/src/modules/{domain}/{domain}.validation.ts` — update Zod schemas.
4. Service: `packages/core/src/modules/{domain}/{domain}.admin.ts` or equivalent service — update selects/inserts/updates.
5. API route: usually no change if it already passes validated service data through; otherwise update route schemas.
6. Admin form schema/component: update the relevant form files in `apps/admin-v2/src/components/admin/`.
7. Storefront display: update storefront-facing core service/API client/storefront UI as needed.
8. SDK: run `pnpm generate:sdk` if the OpenAPI surface changed.

### Add a New Payment Gateway

See `packages/core/src/modules/payments/README.md`. Current payment reality is mixed: legacy payment modules/gateway registry are active, and the universal provider registry has a Stripe adapter. Coordinate storage, admin settings, webhook routes, queue events, SDK regeneration, and tests.

### Add a Notification Type

1. Add the key and label to `packages/core/src/modules/notifications/notification-types.ts`.
2. Add template/channel handling in `packages/core/src/modules/notifications/notifications.service.ts`.
3. Confirm defaults and validation in `packages/core/src/modules/settings/settings.service.ts` still merge the new type.
4. Queue message typing in `apps/api/src/queue-consumer.ts` should pick it up through `OrderNotificationType`.
5. Trigger by enqueueing `{ type: "order.notification", ... }` to `ORDER_NOTIFICATIONS_QUEUE` from the route/service that owns the state transition.
6. Update admin notification settings UI only if the shared labels/ordering are not sufficient.

### Add a New Admin Settings Tab

1. Component: create `apps/admin-v2/src/components/admin/settings/MySettingsBuilder.tsx`.
2. Route: add sub-route under `apps/admin-v2/src/routes/admin/settings/`.
3. API: create or extend `apps/api/src/routes/admin/settings/*`.
4. Storage: use `siteSettings` for typed singleton fields and `settings` for provider/category config.
5. Add query/mutation wrappers and invalidate the right query keys.

## Queue Bindings

| Queue | Binding | Message Types | Handler |
|-------|---------|---------------|---------|
| `order-ingest` | `ORDER_INGEST_QUEUE` | `order.ingest` | `handleOrderIngestBatch()` in `packages/core/src/modules/orders/orders.queue.ts` |
| `payment-events` | `PAYMENT_EVENTS_QUEUE` | `payment.stripe.confirmed/failed/canceled/refunded`, `payment.sslcommerz.confirmed/failed`, `payment.polar.confirmed/failed/refunded` | `processPaymentConfirmed()`, `processPaymentFailed()`, `releaseOrderInventory()`, `processPolarWebhookRefund()` |
| `order-notifications` | `ORDER_NOTIFICATIONS_QUEUE` | `order.notification` | `sendOrderNotificationEmail()` and `sendOrderNotification()` in `notifications.service.ts` |
| `auth-otp` | `AUTH_OTP_QUEUE` | `auth.send_otp` | inline OTP branch in `apps/api/src/queue-consumer.ts` (email, WhatsApp, configured SMS provider) |

All queues are consumed by `apps/api/src/queue-consumer.ts`. `ORDER_INGEST_QUEUE` uses a batch strategy; other queues process messages independently with ack/retry.

## Import Conventions

```typescript
// Admin/API package imports
import { getDb } from "@scalius/database/client";
import { products } from "@scalius/database/schema";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { createAuth } from "@scalius/core/auth";
import { ftsMatch } from "@scalius/core/search";
import { cn } from "@scalius/shared/utils";

// SDK types and generated methods
import type { Product, Category } from "@scalius/api-client/types";
import { getApiV1Products } from "@scalius/api-client/sdk";
import { createClient, createConfig } from "@scalius/api-client/factory";

// Local app aliases
import { SomeAdminComponent } from "@/components/SomeAdminComponent";
import { queryKeys } from "~/lib/query-keys";
```

Storefront should use its configured SDK clients from `apps/storefront/src/lib/api/client.ts`, not the default generated singleton client, when requests need storefront runtime env, retry behavior, auth, or service-binding transport.

## Key URLs (Local Dev)

- Admin UI: `http://localhost:4323/admin`
- Storefront: `http://localhost:4322`
- API: `http://localhost:8787/api/v1/**`
- Swagger UI: `http://localhost:8787/api/v1/docs`
- OpenAPI spec: `http://localhost:8787/api/v1/openapi.json`

## Important File Paths

- API Worker entry: `apps/api/src/worker.ts`
- Hono app entry: `apps/api/src/app.ts`
- API queue consumer: `apps/api/src/queue-consumer.ts`
- API response helpers: `apps/api/src/utils/api-response.ts`
- API error classes: `apps/api/src/utils/api-error.ts`
- Widget Design Agent: `apps/api/src/agents/widget-design-agent.ts`
- Admin Vite config: `apps/admin-v2/vite.config.ts`
- Admin router: `apps/admin-v2/src/router.tsx`
- Admin generated route tree: `apps/admin-v2/src/routeTree.gen.ts`
- Admin server functions: `apps/admin-v2/src/lib/api-functions/`
- Admin API server helper: `apps/admin-v2/src/lib/api.server.ts`
- Admin query options: `apps/admin-v2/src/lib/api.queries.ts`
- Admin mutations: `apps/admin-v2/src/lib/api.mutations.ts`
- Admin auth server helpers: `apps/admin-v2/src/lib/auth.server.ts`
- Admin auth functions: `apps/admin-v2/src/lib/auth.fns.ts`
- Admin RBAC: `apps/admin-v2/src/middleware/rbac.server.ts`
- Storefront Astro config: `apps/storefront/astro.config.mjs`
- Storefront middleware/cache context: `apps/storefront/src/middleware.ts`
- Storefront API client: `apps/storefront/src/lib/api/client.ts`
- Storefront edge cache: `apps/storefront/src/lib/edge-cache.ts`
- Storefront customer auth proxy: `apps/storefront/src/pages/api/customer-auth/[...path].ts`
- Storefront purge endpoint: `apps/storefront/src/pages/api/purge-cache.ts`
- API Wrangler config: `apps/api/wrangler.jsonc`
- API local Wrangler config: `apps/api/wrangler.local.jsonc`
- Admin Wrangler config: `apps/admin-v2/wrangler.jsonc`
- Storefront Wrangler config: `apps/storefront/wrangler.jsonc`
- Drizzle config: `packages/database/drizzle.config.ts`
- Auth config: `packages/core/src/auth/auth.ts`
- Auth client: `apps/admin-v2/src/lib/auth-client.ts`
- SDK package: `packages/api-client/`
- OpenAPI source artifact: `packages/api-client/openapi.json`
- SDK generated types: `packages/api-client/src/generated/types.gen.ts`
- Customer auth service: `packages/core/src/modules/customers/customer-auth.service.ts`
- DB schema: `packages/database/src/schema/`
- Migrations: `packages/database/migrations/`

## Dependency Graph

```
@scalius/shared          → external utility deps only
@scalius/database        → drizzle-orm
@scalius/core            → @scalius/database, @scalius/shared, better-auth, zod, stripe, etc.
@scalius/api-client      → @hey-api/client-fetch (generated SDK)
@scalius/api             → @scalius/core, @scalius/database, @scalius/shared, hono
@scalius/admin-v2        → @scalius/core, @scalius/database, @scalius/shared, @scalius/api-client, TanStack Start, React
@scalius/storefront      → @scalius/shared, @scalius/api-client, Astro, React
```

## Production Domains

```
dashboard.scalius.com  → scalius-admin-v2 (Admin Worker)
api.scalius.com        → scalius-api (API Worker)
storefront.scalius.com → scalius-storefront (Storefront Worker)
cloud.scalius.com      → scalius-media R2 bucket/CDN/Image Resizing
```

These mappings are inferred from Worker names and `wrangler.jsonc` vars. Custom-domain/route attachments are managed in Cloudflare and are not declared in this repo.

## Dev Server Notes

- Dev commands use `scripts/dev.sh`.
- Run `pnpm dev:doctor` before debugging vague local failures. It checks env-file presence, shared-secret drift, and local URL values for the expected API/admin/storefront localhost ports. Use `pnpm dev:doctor:api`, `pnpm dev:doctor:admin`, `pnpm dev:doctor:storefront`, or `pnpm dev:doctor:all` after starting the matching local stack.
- The wrapper applies pending local D1 migrations before starting API unless `SCALIUS_SKIP_DEV_MIGRATIONS=1`.
- The wrapper kills stale processes on app ports `8787`, `4322`, `4323`, and inspector ports `9229-9233`.
- Full `pnpm dev` starts API, waits for `/api/v1/setup`, then starts admin and storefront with a small stagger to avoid inspector port conflicts.
- `pnpm dev:api`, `pnpm dev:admin`, and `pnpm dev:storefront` all run through `scripts/dev.sh`, apply pending local D1 migrations unless skipped, and wait for API readiness before starting dependent apps.
- `scripts/dev.sh` only kills processes on Scalius dev ports by default. Set `SCALIUS_DEV_KILL_ALL_WORKERD=1` for the old all-`workerd` cleanup behavior.
- Set `SCALIUS_WRANGLER_STATE=/tmp/some-path`, or pass `--state /tmp/some-path` to setup/reset/admin helper scripts, to run against a disposable local Wrangler state directory. Script `--state` paths are normalized from the repo root, so absolute paths are safest in handoffs.
- If ports are stuck: `lsof -tiTCP:8787 -iTCP:4322 -iTCP:4323 -iTCP:9229 -iTCP:9230 -iTCP:9231 -iTCP:9232 -iTCP:9233 -sTCP:LISTEN | xargs kill -9`, then kill lingering `workerd` if needed.

## Current Highlights

- Monorepo migration is complete: three Workers apps plus five shared packages.
- API standardization is mostly in place: normal routes use `ok()`/`created()`/`ApiError`; edge routes have documented exceptions.
- Schema is at 39 migrations with 53 table declarations.
- SDK generation is integrated into admin/storefront and should be regenerated after API surface changes.
- Payments include durable webhook idempotency, gateway-payment CAS/atomic updates, refund validation, COD handling, SSLCommerz redirect validation, and Polar refund webhook processing.
- Orders use status state-machine validation, CAS on status/fulfillment paths, queue ingest, and notification enqueueing for status transitions.
- Inventory uses `stockVersion`, reservations, restore/release logic, and a scheduled expiry sweep every 15 minutes.
- Delivery uses legacy provider/factory implementations, durable webhook replay protection keyed by provider event identity, encrypted credentials, shipment status CAS, and direct notification enqueueing in active webhook/admin paths.
- Customer auth uses normalized phone numbers, OTP queues, same-origin storefront cookie proxying, and SMS/email/WhatsApp delivery paths.
- Storefront uses L1 in-memory + L2 Cache API caching keyed by KV version plus deterministic generated build ID, plus purge-cache warming.
- Admin widget AI supports provider/model settings, AI context, streaming/staged generation, and a Durable Object agent.

## Known Backlog / Limitations

- **Active audit backlog**: `audit/REMEDIATION_TRACKER.md` currently has fresh open P1/P2 findings from the 2026-06-14 re-audit. Check that tracker before choosing the next remediation slice.
- **Mixed provider systems**: Universal provider registry currently has Stripe payment + Resend email adapters. SMS still uses the legacy integrations registry with smsnetbd, bdbulksms, mimsms, and gennet. Delivery uses legacy factory/provider files; universal delivery provider exports are type-only.
- **In-memory state**: Storefront L1 caches and shared layout cache are in-memory and reset on Worker isolate restart. Shared rate limiting is KV-based now.
- **Delivery notification helper**: `notifyShipmentStatusChange()` in `packages/core/src/modules/delivery/tracking.ts` is still a log-only placeholder. Active Pathao/Steadfast/admin shipment paths enqueue notifications directly.
- **Scanner app**: Standalone `/scanner` route exists with QR-token auth; still needs focused testing/polish.
- **Type safety**: Admin still has notable `any` usage in some UI edges and broad DTO adapters. Improve locally when touching relevant code, but do not broad-refactor casually.
- **Test coverage**: There are dozens of Vitest files across apps/packages, not a comprehensive suite. Add focused tests for risky service, queue, payment, inventory, response-envelope, AI, or storefront cache changes.
- **Generated docs are non-authoritative**: Trust `packages/api-client/openapi.json`, generated SDK files, Drizzle schema, and migration metadata over prose counts.

## Agent Team Guidelines

When working as part of an agent team on this codebase:

- **Avoid file conflicts**: coordinate so each teammate owns different files/modules.
- **Domain boundaries**: `packages/core/src/modules/` is organized by domain; each teammate should own a complete domain when possible.
- **Run type checks**: use `pnpm typecheck` for meaningful validation. `pnpm build` bundles Workers/apps and can miss type errors that `tsc`/`astro check` catch.
- **Run lint honestly**: root `pnpm lint` intentionally filters out `@scalius/tsconfig` and runs real `lint` scripts for API, admin, storefront, api-client, core, database, and shared.
- **Run focused tests**: use `pnpm test` or direct Vitest filters for touched areas.
- **Run dependency audit**: use `pnpm audit --audit-level moderate` after dependency or lockfile changes.
- **Do not touch env files**: `.dev.vars` and `.env.development` can contain secrets.
- **Keep Turbo env cache inputs current**: app-local `.dev.vars`/`.env*` files belong in `turbo.json` `globalDependencies`, and build-time env names belong in `globalEnv`. Do not add secret-only names to `globalEnv`. Run `pnpm exec vitest run scripts/turbo-config.test.mjs` and a Turbo dry run after changing build env/config.
- **Schema changes need migrations**: after modifying `packages/database/src/schema/`, run `pnpm db:generate`.
- **API surface changes need SDK regeneration**: after changing OpenAPI route schemas, run `pnpm generate:sdk`.
- **Package changes need manifests**: when adding imports from a new package, update the consuming workspace `package.json`.
- **Storefront shared imports only**: do not add `@scalius/core` or `@scalius/database` imports to storefront without coordination.
- **Generated files are off-limits**: do not hand-edit `routeTree.gen.ts` or `packages/api-client/src/generated/**`.
- **Cloudflare bindings must stay synchronized**: update Wrangler config and Env declarations together.
- **Deploy shortcuts stay safety-gated**: root and package-local `deploy` shortcuts route through `scripts/deploy.mjs --only ...`; keep typecheck, dist-secret checks, and required migration gates when changing deploy scripts.
