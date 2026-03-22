# Scalius Commerce

## Overview

Turborepo monorepo: Astro SSR admin dashboard + Astro SSR storefront + standalone Hono API — all deployed as Cloudflare Workers. Admin and storefront communicate with the API worker via Cloudflare Service Bindings.

## Monorepo Structure

```
apps/
  admin/          # @scalius/admin — Astro 6 SSR admin dashboard (Cloudflare Worker)
  api/            # @scalius/api — Hono standalone API + queue consumer (Cloudflare Worker)
  storefront/     # @scalius/storefront — Astro 6 SSR customer-facing store (Cloudflare Worker)
packages/
  api-client/     # @scalius/api-client — Generated SDK from OpenAPI spec
  core/           # @scalius/core — Domain modules, auth, integrations, search
  database/       # @scalius/database — Drizzle schema, client, migrations
  shared/         # @scalius/shared — Pure utility functions
  tsconfig/       # @scalius/tsconfig — Shared TypeScript configs
```

## Quick Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start admin :4321 + API :8787 |
| `pnpm dev:storefront` | Start storefront :4322 + API :8787 |
| `pnpm dev:all` | Start all three workers |
| `pnpm build` | Build all workspaces |
| `pnpm dev:setup` | First-time local dev setup |
| `pnpm dev:reset` | Wipe local DB and re-apply migrations |
| `pnpm db:generate` | Generate Drizzle migrations |
| `pnpm db:migrate:local` | Apply pending migrations locally |
| `pnpm db:studio` | Drizzle Studio DB browser |
| `pnpm test` | Run all tests via vitest |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm generate:sdk` | Regenerate API client from OpenAPI spec |
| `pnpm deploy` | Build + migrate + deploy all workers |

## Architecture

### Apps

- **Admin (`apps/admin/`)**: Astro 6 SSR + React 19 admin dashboard. Owns pages, components, layouts, styles, hooks, middleware. Communicates with API via service binding (`env.API`).
- **API (`apps/api/`)**: Standalone Hono worker. Owns all API routes, queue consumer, OpenAPI spec. Exports `WorkerEntrypoint` with HTTP fetch + queue handler.
- **Storefront (`apps/storefront/`)**: Astro 6 SSR + React 19 customer-facing store. Owns product pages, cart, checkout, search. Communicates with API via service binding (`env.BACKEND_API`). Has its own L1 (in-memory) + L2 (Cloudflare Cache API + KV versioning) caching layer. Imports `@scalius/shared` and `@scalius/api-client`.

### Packages (JIT — no build step, consumed directly by bundler)

- **`@scalius/api-client`**: Generated SDK from OpenAPI spec — typed API client and response types used by admin and storefront
- **`@scalius/database`**: Drizzle schema (13 files, 52 tables across 10 domains), `getDb()` client factory, 33 migrations
- **`@scalius/core`**: Domain services (`src/modules/`), Better Auth config (`src/auth/`), RBAC, integrations (email, storage, firebase, meta), FTS5 search, cache utils
- **`@scalius/shared`**: Pure utilities (currency, cors, image-optimizer, rate-limit, etc.)
- **`@scalius/tsconfig`**: Shared TypeScript configs (base, astro, worker)

## Tech Stack

- Astro 6 (admin + storefront) — SSR, Cloudflare adapter
- Vite 7 + React 19
- Hono (API framework with OpenAPI/Swagger)
- Cloudflare D1 (SQLite) + Drizzle ORM + FTS5 full-text search
- Tailwind CSS v4 + shadcn/ui
- Better Auth (email/password + optional 2FA)
- Cloudflare KV (caching), R2 (media), Queues (async processing)
- Cloudflare Service Bindings (admin→API, storefront→API)
- Turborepo + pnpm workspaces

## Key Conventions

- **Thin HTTP layer**: `apps/api/src/routes/**` handles validation and auth, then delegates to `@scalius/core` services
- **API routes use OpenAPIHono**: All routes in `apps/api/src/routes/` use `createRoute()` from `@hono/zod-openapi`. OpenAPI spec is auto-generated at `/api/v1/openapi.json`.
- **Standardized API errors**: Use `ApiError` classes from `apps/api/src/utils/api-error.ts` (ValidationError, NotFoundError, etc.)
- **Standardized API responses**: Use helpers from `apps/api/src/utils/api-response.ts` (ok, created, noContent)
- **Response envelope contract**: ALL success responses return `{ success: true, data: T }`. The `T` passed to `ok(c, T)` must be the FINAL payload — never include redundant `success: true` or `data:` wrapping inside `T`. All consumers (admin, storefront) read `json.data` to get `T`. The admin proxy passes responses through unchanged.
- **202 Accepted responses**: Must ALSO include `success: true` at top level (storefront checks it). Use `c.json({ success: true, data: {...} }, 202)` — not `ok()` (which forces 200).
- **Storefront proxy endpoints** (`apps/storefront/src/pages/api/checkout/*.ts`): Must unwrap `.data` before returning to browser — the checkout page reads top-level fields.
- **Never use `import.meta.env` for secrets**: Secrets (`API_TOKEN`, `JWT_SECRET`, `PURGE_TOKEN`) come ONLY from Cloudflare runtime (`env.*` via `wrangler secret put`). Build-time `import.meta.env` bakes `.dev.vars` values into production bundles.
- **JIT packages**: No build step for packages — wrangler/esbuild bundles directly from TypeScript source
- **Two env files per app**: `.dev.vars` (Cloudflare runtime bindings) and `.env.development` (Vite/Astro build-time vars)
- **Service bindings**: Admin uses `env.API`, storefront uses `env.BACKEND_API` — both point to the API worker
- **Port 4321**: Admin dashboard. Port 4322: Storefront. Port 8787: API worker.
- **RBAC auto-seed**: Permissions/roles auto-seed on first admin dashboard access
- **FTS5**: All text search uses SQLite FTS5. Helpers in `packages/core/src/search/fts5.ts`
- **SDK types**: Both admin and storefront use `@scalius/api-client` for API types
- **Storefront shared imports**: Storefront imports `@scalius/shared` (utilities) and `@scalius/api-client` (types). It does NOT import `@scalius/core` or `@scalius/database` directly.

## Settings Storage Patterns

- **`siteSettings` table**: Singleton row for site-wide typed config (guestCheckoutEnabled, checkoutMode, headerConfig JSON, footerConfig JSON, storefrontUrl, SEO fields). Use for always-present, typed boolean/string fields.
- **`settings` table**: Key-value store with `category` + `key` + `value` columns for extensible config (payment gateways, currency, email, Firebase, OpenRouter, fraud checker, theme, phone). Use for optional, category-grouped, provider-specific config.

## How-To Recipes

### Add a New Field to an Entity
1. Schema: `packages/database/src/schema/{domain}.ts` — add column
2. Migration: `pnpm db:generate` to create SQL migration
3. Validation: `packages/core/src/modules/{domain}/{domain}.validation.ts` — add to Zod schema
4. Service: `packages/core/src/modules/{domain}/{domain}.admin.ts` — add to select/insert/update
5. API route: `apps/api/src/routes/admin/{domain}.ts` — usually no change (passes validated data through)
6. Admin form: `apps/admin/src/components/admin/{domain}-form/types.ts` — add to form schema
7. Admin component: Add input field in the appropriate section component
8. Storefront (if displayed): `packages/core/src/modules/{domain}/{domain}.storefront.ts` — add to select

### Add a New Payment Gateway
See `packages/core/src/modules/payments/README.md` for provider details, key patterns, and API endpoints.

### Add a Notification Type
1. Template: `packages/core/src/modules/notifications/notifications.service.ts` — add case to `sendOrderNotificationEmail()`
2. Queue: The queue consumer at `apps/api/src/queue-consumer.ts` already dispatches generically by `order.notification` type
3. Trigger: In the API route that changes status, enqueue `{ type: "order.notification", ... }` to `ORDER_NOTIFICATIONS_QUEUE`

### Add a New Admin Settings Tab
1. Component: Create `apps/admin/src/components/admin/settings/MySettingsBuilder.tsx`
2. Tab: In `apps/admin/src/components/admin/settings/GeneralSettingsPage.tsx`, add to the tabs array with `React.lazy(() => import("./MySettingsBuilder"))`
3. API route: Create or extend a route in `apps/api/src/routes/admin/settings/`
4. Storage: Use `siteSettings` for typed fields, `settings` table for KV config (see Settings Storage Patterns above)

## Queue Bindings

| Queue | Binding | Message Types | Handler |
|-------|---------|---------------|---------|
| `ORDER_INGEST_QUEUE` | Cloudflare Queue | `order.ingest` | `handleOrderIngestBatch()` in `orders.queue.ts` |
| `PAYMENT_EVENTS_QUEUE` | Cloudflare Queue | `payment.stripe.confirmed/failed/canceled/refunded`, `payment.sslcommerz.confirmed/failed`, `payment.polar.confirmed/failed/refunded` | `processPaymentConfirmed()`, `processPaymentFailed()`, `releaseOrderInventory()` in `process-payment.ts` |
| `ORDER_NOTIFICATIONS_QUEUE` | Cloudflare Queue | `order.notification`, `auth.send_otp` | `sendOrderNotificationEmail()` + `sendOrderNotification()` (FCM) in `notifications.service.ts` |

All queues are consumed by `apps/api/src/queue-consumer.ts`.

## Import Conventions

```typescript
// From admin/api apps, import packages like:
import { getDb } from "@scalius/database/client";
import { products } from "@scalius/database/schema";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { createAuth } from "@scalius/core/auth";
import { ftsMatch } from "@scalius/core/search";
import { cn } from "@scalius/shared/utils";

// Import SDK types:
import type { Product, Category } from "@scalius/api-client/types";

// Import SDK client:
import { client } from "@scalius/api-client";

// Within apps, use @/ alias for local files:
import { SomeComponent } from "@/components/SomeComponent";
```

## Key URLs (Local Dev)

- Admin UI: `http://localhost:4321/admin`
- Storefront: `http://localhost:4322`
- API: `http://localhost:8787/api/v1/**`
- Swagger UI: `http://localhost:8787/api/v1/docs`
- OpenAPI spec: `http://localhost:8787/api/v1/openapi.json`

## Important File Paths

- API Worker entry: `apps/api/src/worker.ts`
- Hono app entry: `apps/api/src/app.ts`
- API Response Helpers: `apps/api/src/utils/api-response.ts`
- API Error Classes: `apps/api/src/utils/api-error.ts`
- Admin Worker entry: `apps/admin/src/worker.ts`
- Admin Astro config: `apps/admin/astro.config.mjs`
- Storefront Astro config: `apps/storefront/astro.config.mjs`
- API Wrangler config: `apps/api/wrangler.jsonc`
- Admin Wrangler config: `apps/admin/wrangler.jsonc`
- Storefront Wrangler config: `apps/storefront/wrangler.jsonc`
- Drizzle config: `packages/database/drizzle.config.ts`
- Admin Middleware: `apps/admin/src/middleware/index.ts`
- Storefront Middleware: `apps/storefront/src/middleware.ts`
- Auth config: `packages/core/src/auth/auth.ts`
- Auth client: `apps/admin/src/lib/auth-client.ts`
- Storefront API client: `apps/storefront/src/lib/api/client.ts`
- SDK Package: `packages/api-client/`
- SDK Generated Types: `packages/api-client/src/generated/types.gen.ts`
- Customer Auth Service: `packages/core/src/modules/customers/customer-auth.service.ts`
- DB Schema: `packages/database/src/schema/`
- Migrations: `packages/database/migrations/`

## Dependency Graph

```
@scalius/shared          → (no deps)
@scalius/database        → drizzle-orm
@scalius/core            → @scalius/database, @scalius/shared, better-auth, zod, stripe, etc.
@scalius/api-client      → (generated, no runtime deps)
@scalius/api             → @scalius/core, @scalius/database, @scalius/shared, hono
@scalius/admin           → @scalius/core, @scalius/database, @scalius/shared, @scalius/api-client, astro, react
@scalius/storefront      → @scalius/shared, @scalius/api-client, astro, react
```

## Production Domains

```
dashboard.scalius.com  → scalius-admin (Admin Worker)
api.scalius.com        → scalius-api (API Worker)
storefront.scalius.com → scalius-storefront (Storefront Worker)
cloud.scalius.com      → R2 bucket (CDN + Image Resizing)
```

## Dev Server Notes

- Dev commands (`pnpm dev`, `pnpm dev:all`) use `scripts/dev.sh` wrapper
- The wrapper auto-kills stale processes from previous runs on startup
- Apps start with staggered delays to prevent Vite inspector port conflicts
- If ports are stuck: `lsof -ti :8787,:4321,:4322 | xargs kill -9`

## Recent Changes

- **Monorepo Migration** (March 14): Refactored from monolith to Turborepo with 3 apps + 5 packages
- **Codebase Hardening** (March 16): 33 commits. Full spec at `docs/superpowers/specs/2026-03-16-codebase-hardening-design.md`
- **Admin Refactoring** (March 16-18): Component splitting, proxy simplification, Vite proxy root cause fix
- **Multi-Session Audit + Fix** (March 20): 25-agent audit + 8-agent fix team, ~130 fixes across entire codebase
- **SDK Generation** (March 20): Generated SDK from OpenAPI spec (245 paths, 27k+ types), integrated into admin + storefront
- **Comprehensive Audit + Fix** (March 22): 10-agent audit + fix team. CAS on all status-change paths, 9 notification types, SMS channel dispatch, business/invoice settings, Bengali FTS5
- **Payments**: atomic `processPaymentConfirmed()` via `db.batch()`, COD idempotency, refund amount validation, SSLCommerz redirect validation, payment idempotency indexes (migration 0030), refund now updates `orders.status` to REFUNDED/PARTIALLY_REFUNDED via state machine
- **Orders**: queue batch orderId bug fixed, CANCELLED allows admin reactivation, order routes split into 3 files (orders.ts, orders-refund.ts, orders-status.ts), CAS on `processCodAction()` and `bulkShipOrders()`, notification enqueue on all 9 status changes
- **Inventory**: `stockVersion` column for stock-specific CAS, inventory transitions module, restore logic, CAS correctly ordered (version bump before inventory) in all paths including tracking.ts
- **Delivery**: KV-based webhook replay protection (Pathao/Steadfast), insert-first shipment creation, AES-GCM credential encryption, CAS in `updateOrderStatusFromShipment()` (admin changes take priority)
- **Customers**: phone normalization (E.164 format), OTP logging removed, SMS OTP delivery via 4 providers
- **Notifications**: 9 notification types (added order_completed, order_returned, order_refunded), SMS channel dispatch via 4 providers (smsnetbd, bdbulksms, mimsms, gennet), per-status channel independence
- **Settings**: business info settings (company name, TIN, logo, address), invoice prefix/counter, SMS provider settings, admin notification channels
- **API Standardization**: ALL routes use `ok()`/`created()`/`ApiError`, `CACHE_TTLS` constants, centralized entity schemas (`apps/api/src/schemas/entities.ts`)
- **Schema**: 33 migrations (0000-0032), 52 tables across 13 schema files, timestamp defaults standardized, FK indexes added, singleton constraints, Bengali FTS5 tokenizer (migration 0031)
- **Admin**: unified PaymentGatewaysManager, NotificationChannelsBuilder, media manager rewrite, error pages (404/500)
- **Storefront**: L1+L2 caching layer, response unwrapping utilities, error pages (404/500), SEO (JSON-LD, OG tags, canonical URLs)
- **Shared Utilities**: css-scope, html-escape, html-sanitize, status-badges (all 11 statuses), timestamps modules added

## Known Backlog

- **`publishedAt` field unused**: Pages store `publishedAt` but it's never used for scheduled publishing.
- **Dual provider systems**: Universal provider registry exists (email + payment + SMS migrated) but delivery has type definitions with zero registered implementations in the new system. Legacy interfaces still in use.
- **In-memory state**: Rate limiter and layout cache use in-memory Maps (reset on Worker isolate restart). Acceptable for single-tenant but needs KV migration for scale.
- **Delivery webhook notifications**: `notifyShipmentStatusChange()` in tracking.ts is a placeholder (logs only). Should enqueue to ORDER_NOTIFICATIONS_QUEUE.
- **Bulk ship notifications**: `bulkShipOrders()` does not enqueue "order_shipped" notifications.

## Known Limitations / TODO

- **Scanner app**: standalone `/scanner` route exists with QR-token auth — needs testing and polish
- **Type safety**: ~30 `any` type usages remain across the admin app (mostly Cloudflare env probing, debounce utils, and window globals)
- **Test coverage**: 9 test files in `tests/` (payments, inventory, orders, discounts, response envelope)
- **Widget history**: API endpoints exist (GET/POST/DELETE `/admin/widgets/{id}/history/*`) — needs UI testing

## Agent Team Guidelines

When working as part of an agent team on this codebase:

- **Avoid file conflicts**: coordinate so each teammate owns different files/modules
- **Domain boundaries**: `packages/core/src/modules/` is organized by domain — each teammate should own a complete domain when possible
- **Test changes**: run `pnpm typecheck` (NOT just `pnpm build` — esbuild strips types without checking them)
- **Don't touch env files**: `.dev.vars` and `.env.development` contain secrets
- **Schema changes need migrations**: after modifying `packages/database/src/schema/`, run `pnpm db:generate`
- **Package changes**: when adding imports from a new package, ensure it's listed in the consuming workspace's `package.json`
- **Storefront shared imports only**: storefront imports `@scalius/shared` and `@scalius/api-client` — don't add `@scalius/core` or `@scalius/database` imports without coordinating
