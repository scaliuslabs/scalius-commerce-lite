# Scalius Commerce

## Overview

Turborepo monorepo: Astro SSR admin dashboard (Cloudflare Worker) + standalone Hono API (Cloudflare Worker) + shared packages. The admin worker communicates with the API worker via Cloudflare Service Bindings.

## Monorepo Structure

```
apps/
  admin/          # @scalius/admin — Astro SSR admin dashboard (Cloudflare Worker)
  api/            # @scalius/api — Hono standalone API + queue consumer (Cloudflare Worker)
packages/
  core/           # @scalius/core — Domain modules, auth, integrations, search
  database/       # @scalius/database — Drizzle schema, client, migrations
  shared/         # @scalius/shared — Pure utility functions
  tsconfig/       # @scalius/tsconfig — Shared TypeScript configs
```

## Quick Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start both workers via Turbo |
| `pnpm build` | Build all workspaces |
| `pnpm dev:setup` | First-time local dev setup |
| `pnpm dev:reset` | Wipe local DB and re-apply migrations |
| `pnpm db:generate` | Generate Drizzle migrations |
| `pnpm db:migrate:local` | Apply pending migrations locally |
| `pnpm db:studio` | Drizzle Studio DB browser |
| `pnpm deploy` | Build + migrate + deploy all workers |

## Architecture

### Apps

- **Admin (`apps/admin/`)**: Astro SSR + React 19 admin dashboard. Owns pages, components, layouts, styles, hooks, middleware. Communicates with API via service binding.
- **API (`apps/api/`)**: Standalone Hono worker. Owns all API routes, queue consumer, OpenAPI spec. Exports `WorkerEntrypoint` with HTTP fetch + queue handler.

### Packages (JIT — no build step, consumed directly by bundler)

- **`@scalius/database`**: Drizzle schema (11 domain files), `getDb()` client factory, migrations
- **`@scalius/core`**: Domain services (`src/modules/`), Better Auth config (`src/auth/`), RBAC, integrations (email, storage, firebase, meta), FTS5 search, cache utils
- **`@scalius/shared`**: Pure utilities (currency, cors, image-optimizer, rate-limit, etc.)
- **`@scalius/tsconfig`**: Shared TypeScript configs (base, astro, worker)

## Tech Stack

- Astro 6 (SSR, Cloudflare adapter) + Vite 7 + React 19
- Hono (API framework with OpenAPI/Swagger)
- Cloudflare D1 (SQLite) + Drizzle ORM + FTS5 full-text search
- Tailwind CSS v4 + shadcn/ui
- Better Auth (email/password + optional 2FA)
- Cloudflare KV (caching), R2 (media), Queues (async processing)
- Cloudflare Service Bindings (admin→API communication)
- Turborepo + pnpm workspaces

## Key Conventions

- **Thin HTTP layer**: `apps/api/src/routes/**` handles validation and auth, then delegates to `@scalius/core` services
- **JIT packages**: No build step for packages — wrangler/esbuild bundles directly from TypeScript source
- **Two env files per app**: `.dev.vars` (Cloudflare runtime bindings) and `.env.development` (Vite/Astro build-time vars)
- **Service binding**: Admin fetches data from API via `env.API` binding (defined in `apps/admin/wrangler.jsonc`)
- **Port 4321**: Auth callbacks assume this port. Kill previous servers before starting new ones
- **RBAC auto-seed**: Permissions/roles auto-seed on first admin dashboard access
- **FTS5**: All text search uses SQLite FTS5. Helpers in `packages/core/src/search/fts5.ts`

## Import Conventions

```typescript
// From apps, import packages like:
import { getDb } from "@scalius/database/client";
import { products } from "@scalius/database/schema";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { createAuth } from "@scalius/core/auth";
import { ftsMatch } from "@scalius/core/search";
import { cn } from "@scalius/shared/utils";

// Within apps, use @/ alias for local files:
import { SomeComponent } from "@/components/SomeComponent";
```

## Key URLs (Local Dev)

- Admin UI: `http://localhost:4321/admin`
- API: `http://localhost:8787/api/v1/**` (or via admin service binding)
- Swagger UI: `/api/v1/docs`
- OpenAPI spec: `/api/v1/openapi.json`

## Important File Paths

- API Worker entry: `apps/api/src/worker.ts`
- Hono app entry: `apps/api/src/app.ts`
- Admin Worker entry: `apps/admin/src/worker.ts`
- Admin Astro config: `apps/admin/astro.config.mjs`
- API Wrangler config: `apps/api/wrangler.jsonc`
- Admin Wrangler config: `apps/admin/wrangler.jsonc`
- Drizzle config: `packages/database/drizzle.config.ts`
- Admin Middleware: `apps/admin/src/middleware.ts`
- Auth config: `packages/core/src/auth/auth.ts`
- Auth client: `apps/admin/src/lib/auth-client.ts`
- DB Schema: `packages/database/src/schema/`
- Migrations: `packages/database/migrations/`

## Dependency Graph

```
@scalius/shared          → (no deps)
@scalius/database        → drizzle-orm, @scalius/shared
@scalius/core            → @scalius/database, @scalius/shared, better-auth, zod, stripe, etc.
@scalius/api             → @scalius/core, @scalius/database, @scalius/shared, hono
@scalius/admin           → @scalius/core, @scalius/database, @scalius/shared, astro, react
```

## Agent Team Guidelines

When working as part of an agent team on this codebase:

- **Avoid file conflicts**: coordinate so each teammate owns different files/modules
- **Domain boundaries**: `packages/core/src/modules/` is organized by domain — each teammate should own a complete domain when possible
- **Test changes**: run `pnpm build` to verify both workers build correctly
- **Don't touch env files**: `.dev.vars` and `.env.development` contain secrets
- **Schema changes need migrations**: after modifying `packages/database/src/schema/`, run `pnpm db:generate`
- **Package changes**: when adding imports from a new package, ensure it's listed in the consuming workspace's `package.json`
