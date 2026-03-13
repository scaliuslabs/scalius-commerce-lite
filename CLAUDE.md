# Scalius Commerce Lite

## Overview

Full-stack e-commerce admin dashboard + storefront API. Single Cloudflare Worker: Astro SSR (admin UI) + Hono (storefront API) + D1/KV/R2 bindings. No Docker, no external databases.

## Quick Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Astro dev server on port 4321 |
| `pnpm build` | `astro check && astro build && pnpm db:generate` |
| `pnpm dev:setup` | First-time local dev setup (deps, secrets, env files, migrations) |
| `pnpm dev:reset` | Wipe local DB and re-apply migrations |
| `pnpm db:migrate:local` | Apply pending migrations only |
| `pnpm db:studio` | Drizzle Studio DB browser |
| `pnpm deploy` | Build + migrate + deploy to Cloudflare Workers |

## Architecture

- **Admin UI**: `src/pages/admin/**` (Astro pages) + `src/components/admin/**` (React components)
- **Backend API**: `src/server/**` (Hono app at `/api/v1/**`), mounted via `src/integrations/hono-integration.ts`
- **Domain Services (DDD)**: `src/modules/**` — core business logic, decoupled from HTTP layer
- **Database**: `src/db/schema/` (11 domain files, barrel at `src/db/schema/index.ts`), Drizzle ORM + Cloudflare D1
- **Migrations**: `migrations/**`
- **UI Components**: `src/components/ui/**` (shadcn/ui + Tailwind CSS v4)
- **Auth**: Better Auth at `src/lib/auth.ts`, RBAC at `src/lib/rbac/`
- **Shared utilities**: `src/shared/**` (pure functions, no DB, no side effects)

## Tech Stack

- Astro 6 (SSR, Cloudflare adapter) + Vite 7 + React 19
- Hono (API framework with OpenAPI/Swagger)
- Cloudflare D1 (SQLite) + Drizzle ORM + FTS5 full-text search
- Tailwind CSS v4 + shadcn/ui
- Better Auth (email/password + optional 2FA)
- Cloudflare KV (caching), R2 (media), Queues (async processing)
- pnpm as package manager

## Key Conventions

- **Thin HTTP layer**: `src/server/routes/**` handles validation and auth, then delegates to `src/modules/**` services
- **Two env files**: `.dev.vars` (Cloudflare runtime bindings) and `.env.development` (Vite/Astro build-time vars)
- **wrangler.jsonc has production URLs**: `.dev.vars` overrides with `http://localhost:4321` for local dev
- **Port 4321**: Auth callbacks assume this port. Kill previous servers before starting new ones
- **RBAC auto-seed**: Permissions/roles auto-seed on first admin dashboard access
- **FTS5**: All text search uses SQLite FTS5, not LIKE scans. Helpers in `src/lib/search/fts5.ts`

## Key URLs (Local Dev)

- Admin UI: `/admin`
- API: `/api/v1/**`
- Swagger UI: `/api/v1/docs`
- OpenAPI spec: `/api/v1/openapi.json`

## Important File Paths

- Worker entry: `src/worker.ts`
- Hono app entry: `src/server/index.ts`
- Astro config: `astro.config.mjs`
- Wrangler config: `wrangler.jsonc`
- Drizzle config: `drizzle.config.ts`
- Middleware: `src/middleware.ts`
- Auth config: `src/lib/auth.ts`
- Auth client: `src/lib/auth-client.ts`

## Agent Team Guidelines

When working as part of an agent team on this codebase:

- **Avoid file conflicts**: coordinate so each teammate owns different files/modules
- **Domain boundaries**: the `src/modules/` directory is organized by domain — each teammate should own a complete domain when possible
- **Test changes**: run `pnpm build` (includes `astro check`) to verify TypeScript correctness
- **Don't touch env files**: `.dev.vars` and `.env.development` contain secrets
- **Schema changes need migrations**: after modifying `src/db/schema/`, run `pnpm db:generate`
