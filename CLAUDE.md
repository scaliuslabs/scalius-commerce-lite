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
- **`@scalius/database`**: Drizzle schema (11 domain files), `getDb()` client factory, migrations
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
- **Response envelope contract**: ALL success responses return `{ success: true, data: T }`. The `T` passed to `ok(c, T)` must be the FINAL payload — never include redundant `success: true` or `data:` wrapping inside `T`. Storefront consumers read `json.data` to get `T`. The admin proxy unwraps this to `{ success: true, ...T }` for backward compat (only works when `T` is an object, not an array).
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
- Admin Middleware: `apps/admin/src/middleware.ts`
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
@scalius/database        → drizzle-orm, @scalius/shared
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

- **Codebase Hardening** (15 commits): Full spec at `docs/superpowers/specs/2026-03-16-codebase-hardening-design.md`
- **Payments**: atomic `processPaymentConfirmed()` via `db.batch()`, COD idempotency, refund amount validation, SSLCommerz redirect validation
- **Orders**: queue batch orderId bug fixed (per-item tracking), CANCELLED is terminal (no reactivation), order-notifications DLQ added
- **Inventory**: `stockVersion` column (separate from `version`) for stock-specific CAS, discount usage race condition narrowed
- **Delivery**: KV-based webhook replay protection (Pathao/Steadfast), insert-first shipment creation, AES-GCM credential encryption, unified provider interface
- **Customers**: phone normalization (E.164 format), OTP logging removed, stale discount applicability cache removed
- **API Standardization**: ALL routes use `ok()`/`created()`/`ApiError` (242 conversions), `CACHE_TTLS` constants, `paginated()` removed
- **Schema**: timestamp defaults standardized (`UNIX_NOW` constant), 8 FK indexes added, singleton constraints on `siteSettings`/`metaConversionsSettings`, collections enum `"manual"`/`"dynamic"`, `permissions.updatedAt` added
- **Admin Proxy**: unwraps `{ success, data: T }` → `{ success, ...T }` for admin components, flattens error objects to strings
- **Database**: 6 migrations total (0019-0024)

## Known Backlog

- **SDK needs regeneration**: `packages/api-client/openapi.json` has 60 paths from an old spec. Live API has 221+ paths. Run `pnpm generate:sdk` after starting API to update. Deferred until API surface stabilizes.
- **Major version upgrades pending**: TipTap 2->3, Firebase 11->12, Recharts 2->3, react-day-picker 8->9, @hookform/resolvers 3->5
- **ESLint not configured**: `.prettierrc.mjs` exists for formatting but no ESLint setup yet.
- **In-memory state**: Rate limiter and layout cache use in-memory Maps (reset on Worker isolate restart). Acceptable for single-tenant but needs KV migration for scale.

## Known Limitations / TODO

- **Scanner app**: needs rebuild as standalone `/scanner` route with QR-token auth (backend complete, frontend removed)
- **Large service files**: `products.service.ts` (~1600 lines) and `orders.service.ts` (~1400 lines) need splitting
- **Type safety**: ~250 `any` type usages remain across the admin app
- **Test coverage**: zero test coverage (private test suite planned, gitignored)
- **Permission query**: `getUserPermissions()` uses 3 queries — could be 1 JOIN

## Agent Team Guidelines

When working as part of an agent team on this codebase:

- **Avoid file conflicts**: coordinate so each teammate owns different files/modules
- **Domain boundaries**: `packages/core/src/modules/` is organized by domain — each teammate should own a complete domain when possible
- **Test changes**: run `pnpm typecheck` (NOT just `pnpm build` — esbuild strips types without checking them)
- **Don't touch env files**: `.dev.vars` and `.env.development` contain secrets
- **Schema changes need migrations**: after modifying `packages/database/src/schema/`, run `pnpm db:generate`
- **Package changes**: when adding imports from a new package, ensure it's listed in the consuming workspace's `package.json`
- **Storefront shared imports only**: storefront imports `@scalius/shared` and `@scalius/api-client` — don't add `@scalius/core` or `@scalius/database` imports without coordinating
