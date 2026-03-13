# Scalius Commerce

## Overview

Turborepo monorepo: Astro SSR admin dashboard + Astro SSR storefront + standalone Hono API — all deployed as Cloudflare Workers. Admin and storefront communicate with the API worker via Cloudflare Service Bindings.

## Monorepo Structure

```
apps/
  admin/          # @scalius/admin — Astro 6 SSR admin dashboard (Cloudflare Worker)
  api/            # @scalius/api — Hono standalone API + queue consumer (Cloudflare Worker)
  storefront/     # @scalius/storefront — Astro 5 SSR customer-facing store (Cloudflare Worker)
packages/
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
| `pnpm deploy` | Build + migrate + deploy all workers |

## Architecture

### Apps

- **Admin (`apps/admin/`)**: Astro 6 SSR + React 19 admin dashboard. Owns pages, components, layouts, styles, hooks, middleware. Communicates with API via service binding (`env.API`).
- **API (`apps/api/`)**: Standalone Hono worker. Owns all API routes, queue consumer, OpenAPI spec. Exports `WorkerEntrypoint` with HTTP fetch + queue handler.
- **Storefront (`apps/storefront/`)**: Astro 5 SSR + React 19 customer-facing store. Owns product pages, cart, checkout, search. Communicates with API via service binding (`env.BACKEND_API`). Has its own L1 (in-memory) + L2 (Cloudflare Cache API + KV versioning) caching layer.

### Packages (JIT — no build step, consumed directly by bundler)

- **`@scalius/database`**: Drizzle schema (11 domain files), `getDb()` client factory, migrations
- **`@scalius/core`**: Domain services (`src/modules/`), Better Auth config (`src/auth/`), RBAC, integrations (email, storage, firebase, meta), FTS5 search, cache utils
- **`@scalius/shared`**: Pure utilities (currency, cors, image-optimizer, rate-limit, etc.)
- **`@scalius/tsconfig`**: Shared TypeScript configs (base, astro, worker)

## Tech Stack

- Astro 6 (admin) + Astro 5 (storefront) — SSR, Cloudflare adapter
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
- **JIT packages**: No build step for packages — wrangler/esbuild bundles directly from TypeScript source
- **Two env files per app**: `.dev.vars` (Cloudflare runtime bindings) and `.env.development` (Vite/Astro build-time vars)
- **Service bindings**: Admin uses `env.API`, storefront uses `env.BACKEND_API` — both point to the API worker
- **Port 4321**: Admin dashboard. Port 4322: Storefront. Port 8787: API worker.
- **RBAC auto-seed**: Permissions/roles auto-seed on first admin dashboard access
- **FTS5**: All text search uses SQLite FTS5. Helpers in `packages/core/src/search/fts5.ts`
- **Storefront is standalone**: Does not import from `@scalius/*` packages (has its own API client layer, utils, types)

## Import Conventions

```typescript
// From admin/api apps, import packages like:
import { getDb } from "@scalius/database/client";
import { products } from "@scalius/database/schema";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { createAuth } from "@scalius/core/auth";
import { ftsMatch } from "@scalius/core/search";
import { cn } from "@scalius/shared/utils";

// Within apps, use @/ alias for local files:
import { SomeComponent } from "@/components/SomeComponent";

// Storefront uses its own API client (not @scalius packages):
import { fetchWithRetry } from "@/lib/api/client";
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
- DB Schema: `packages/database/src/schema/`
- Migrations: `packages/database/migrations/`

## Dependency Graph

```
@scalius/shared          → (no deps)
@scalius/database        → drizzle-orm, @scalius/shared
@scalius/core            → @scalius/database, @scalius/shared, better-auth, zod, stripe, etc.
@scalius/api             → @scalius/core, @scalius/database, @scalius/shared, hono
@scalius/admin           → @scalius/core, @scalius/database, @scalius/shared, astro, react
@scalius/storefront      → astro, react (standalone — no @scalius/* package deps yet)
```

## Production Domains

```
dashboard.scalius.com  → scalius-admin (Admin Worker)
api.scalius.com        → scalius-api (API Worker)
storefront.scalius.com → scalius-storefront (Storefront Worker)
cloud.scalius.com      → R2 bucket (CDN + Image Resizing)
```

## Agent Team Guidelines

When working as part of an agent team on this codebase:

- **Avoid file conflicts**: coordinate so each teammate owns different files/modules
- **Domain boundaries**: `packages/core/src/modules/` is organized by domain — each teammate should own a complete domain when possible
- **Test changes**: run `pnpm build` to verify all workers build correctly
- **Don't touch env files**: `.dev.vars` and `.env.development` contain secrets
- **Schema changes need migrations**: after modifying `packages/database/src/schema/`, run `pnpm db:generate`
- **Package changes**: when adding imports from a new package, ensure it's listed in the consuming workspace's `package.json`
- **Storefront is standalone**: it has its own utils, API client, and types — don't add `@scalius/*` imports without coordinating
