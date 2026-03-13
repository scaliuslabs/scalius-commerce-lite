<p align="center">
  <a href="https://scalius.com">
    <img alt="Scalius Commerce Lite" src="https://raw.githubusercontent.com/scaliuslabs/scalius-commerce-lite/refs/heads/master/src/assets/logo-dark.png" width="200" />
  </a>
</p>

<h1 align="center">
  Scalius Commerce Lite
</h1>

<h4 align="center">
  <a href="https://docs.scalius.com">Documentation</a> |
  <a href="https://scalius.com">Website</a>
</h4>

<p align="center">
  Full-stack e-commerce platform — admin dashboard, storefront, and API — Turborepo monorepo with Astro, Hono, and Cloudflare D1.
</p>

<p align="center">
  <!-- License: AGPL v3 -->
  <a href="https://github.com/scaliuslabs/scalius-commerce-lite/blob/master/LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL%20v3-blue.svg" alt="Scalius Commerce Lite is released under the AGPL v3 license." />
  </a>
  <!-- PRs Welcome -->
  <a href="https://github.com/scaliuslabs/scalius-commerce-lite/blob/master/CONTRIBUTING.md">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat" alt="PRs welcome!" />
  </a>
  <!-- Security Policy -->
  <a href="https://github.com/scaliuslabs/scalius-commerce-lite/blob/master/SECURITY.md">
    <img src="https://img.shields.io/badge/Security-Policy-red.svg" alt="Security Policy" />
  </a>
</p>

<p align="center">
  <!-- Twitter / X -->
  <a href="https://scalius.com/x">
    <img src="https://img.shields.io/twitter/follow/scaliuslabs.svg?label=Follow%20@scaliuslabs" alt="Follow @scaliuslabs" />
  </a>
  <!-- Discord -->
  <a href="https://scalius.com/discord">
    <img src="https://img.shields.io/badge/chat-on%20discord-7289DA.svg" alt="Discord Chat" />
  </a>
  <!-- Facebook -->
  <a href="https://scalius.com/facebook">
    <img src="https://img.shields.io/badge/Facebook-Follow-1877F2?logo=facebook" alt="Follow on Facebook" />
  </a>
</p>

## Get Started

Scalius Commerce Lite is a **Turborepo monorepo** containing three Cloudflare Workers and four shared packages:

- **Admin dashboard** (`apps/admin`) — Astro 6 SSR + React 19 admin UI
- **API worker** (`apps/api`) — Standalone Hono API + queue consumer
- **Storefront** (`apps/storefront`) — Astro 5 SSR + React 19 customer-facing store

Admin and storefront communicate with the API worker via **Cloudflare Service Bindings** (zero-latency, no network hop in production).

### Monorepo structure

```text
apps/
  admin/          # @scalius/admin — Astro 6 SSR admin dashboard (Cloudflare Worker)
  api/            # @scalius/api — Hono standalone API + queue consumer (Cloudflare Worker)
  storefront/     # @scalius/storefront — Astro 5 SSR customer store (Cloudflare Worker)
packages/
  core/           # @scalius/core — Domain modules, auth, integrations, search
  database/       # @scalius/database — Drizzle schema, client, migrations
  shared/         # @scalius/shared — Pure utility functions
  tsconfig/       # @scalius/tsconfig — Shared TypeScript configs
scripts/          # Dev setup, deploy, reset scripts
```

### Key URLs (local dev)

| URL | Service |
|-----|---------|
| `http://localhost:4321/admin` | Admin dashboard |
| `http://localhost:4321/auth/login` | Auth pages |
| `http://localhost:4322` | Storefront |
| `http://localhost:8787/api/v1/` | API root |
| `http://localhost:8787/api/v1/docs` | Swagger UI |
| `http://localhost:8787/api/v1/openapi.json` | OpenAPI spec |
| `http://localhost:8787/api/v1/health` | Health check |

### Tech stack

- **Monorepo**: Turborepo + pnpm workspaces
- **Admin**: Astro 6 (SSR, Cloudflare adapter, Rust compiler) + Vite 7 + React 19
- **API**: Hono (Swagger UI + OpenAPI)
- **Database**: Cloudflare D1 (SQLite) + Drizzle ORM + FTS5 full-text search
- **UI**: Tailwind CSS v4 + shadcn/ui
- **Auth**: Better Auth (email/password + optional admin 2FA with TOTP/email OTP)
- **Caching**: Cloudflare KV (with in-memory fallback)
- **Storage**: Cloudflare R2 for media uploads
- **Notifications**: Firebase Cloud Messaging (configured via dashboard)
- **Email**: Resend API (configured via dashboard)
- **AI**: OpenRouter integration for widget/content generation (API key stored in DB)
- **Communication**: Cloudflare Service Bindings (admin→API)
- **Queues**: Cloudflare Queues for async processing
- **Deploy**: Cloudflare Workers via Wrangler

### Features

- **Commerce**: products (variants, images, rich content), categories, attributes, collections
- **Sales**: orders, customers, abandoned checkouts, discounts
- **Storefront content**: header/footer builders, navigation, pages, hero sliders, widgets
- **Operations**: shipping methods, delivery providers/shipments, fraud checker, cache management
- **Media**: R2-backed uploads + Cloudflare Image Resizing in production
- **Notifications**: admin push notifications for new orders (FCM)
- **AI**: OpenRouter-powered widget/content generation and prompt tooling
- **Security**: optional admin 2FA (authenticator app or email OTP), RBAC, rate limiting, CSP

---

## Architecture

```mermaid
flowchart TB
    subgraph Admin ["Admin Worker (Astro 6 SSR)"]
        AdminPages[Astro Pages /admin]
        AuthPages[Better Auth /api/auth/*]
    end

    subgraph Storefront ["Storefront Worker (Astro 5 SSR)"]
        StorefrontPages[Product/Cart/Checkout Pages]
        EdgeCache[L1 + L2 Edge Cache]
    end

    subgraph API ["API Worker (Hono)"]
        HonoApp[Hono App /api/v1/*]
        QueueConsumer[Queue Consumer]
    end

    subgraph Infra [Cloudflare Infrastructure]
        D1[(D1 Database)]
        KV[(KV Cache/Session)]
        R2[(R2 Media Storage)]
        Queues[Queues]
    end

    AdminPages -->|Service Binding env.API| HonoApp
    StorefrontPages -->|Service Binding env.BACKEND_API| HonoApp
    HonoApp --> D1
    HonoApp -->|Cache| KV
    HonoApp --> R2
    HonoApp -->|Enqueue| Queues
    Queues -->|Consume| QueueConsumer
```

### Admin Worker (`apps/admin`)

- Astro 6 SSR pages + React 19 components, hydrated with `client:*` directives
- Owns auth pages (`/api/auth/*` via Better Auth)
- Middleware handles session validation, RBAC, CSP headers
- Proxies `/api/v1/*` to the API worker via service binding (prod) or Vite proxy (dev)
- Has direct D1 access only for auth/session/RBAC (not for business data)

### Storefront Worker (`apps/storefront`)

- Astro 5 SSR + React 19 customer-facing store
- Product pages, cart, checkout, search, account, sitemaps
- Service binding `BACKEND_API` → API worker (0ms latency in prod)
- Two-tier caching: L1 in-memory + L2 Cloudflare Cache API with KV version control
- JWT authentication via API_TOKEN for server-side proxy routes
- Standalone codebase (does not import from `@scalius/*` packages)

### API Worker (`apps/api`)

- Standalone Hono app at `/api/v1/*`
- Exports `WorkerEntrypoint` with HTTP fetch + queue handler
- Owns all business logic routes: admin CRUD (`/api/v1/admin/*`) + storefront endpoints
- Thin HTTP layer delegates to `@scalius/core` domain services
- Queue consumer handles payment events, order notifications, OTP delivery, order ingestion

### Shared Packages (JIT — no build step)

All packages are consumed directly as TypeScript by the bundler (esbuild/wrangler). No compilation step needed.

- **`@scalius/database`**: Drizzle schema (11 domain files), `getDb()` client factory, migrations
- **`@scalius/core`**: Domain services (`src/modules/`), Better Auth config, RBAC, integrations (email, storage, firebase, meta), FTS5 search
- **`@scalius/shared`**: Pure utilities (currency, CORS, image-optimizer, rate-limit, etc.)
- **`@scalius/tsconfig`**: Shared TypeScript configs (base, astro, worker)

### Dependency graph

```
@scalius/shared          → (no deps)
@scalius/database        → drizzle-orm, @scalius/shared
@scalius/core            → @scalius/database, @scalius/shared
@scalius/api             → @scalius/core, @scalius/database, @scalius/shared, hono
@scalius/admin           → @scalius/core, @scalius/database, @scalius/shared, astro, react
@scalius/storefront      → astro, react (standalone — no @scalius/* package deps)
```

---

## Scripts

All commands run from the repo root via Turborepo:

```bash
pnpm dev              # Start admin :4321 + API :8787
pnpm dev:storefront   # Start storefront :4322 + API :8787
pnpm dev:all          # Start all three workers
pnpm build            # Build all workspaces
pnpm deploy           # Build + migrate + deploy all workers
pnpm dev:setup        # First-time local setup (creates .dev.vars, applies migrations)
pnpm dev:reset        # Wipe local DB and re-apply migrations
pnpm db:generate      # Generate Drizzle migrations from schema changes
pnpm db:migrate:local # Apply pending migrations locally
pnpm db:studio        # Drizzle Studio DB browser
```

---

## Local Development

### 1) First-time setup

```bash
pnpm dev:setup
```

This creates `.dev.vars` in both `apps/admin/` and `apps/api/`, creates `apps/admin/.env.development`, and applies D1 migrations to the local database.

### 2) Start the app

```bash
pnpm dev
```

Turborepo starts the selected workers in parallel:
- **Admin** (`apps/admin`): Astro dev server on port 4321 with workerd runtime (D1/KV/R2 emulated)
- **API** (`apps/api`): Wrangler dev on port 8787
- **Storefront** (`apps/storefront`): Astro dev server on port 4322

In dev, the admin's Vite config proxies `/api/v1/*` requests to `http://localhost:8787`. The storefront's API client falls back to HTTP fetch to `http://localhost:8787` when the service binding isn't available.

### 3) Create the first admin account

Visit `http://localhost:4321/admin`. If no admin exists, middleware redirects to `/auth/setup`. The first account is created as super admin and RBAC roles/permissions are seeded automatically.

### 4) Reset commands

```bash
pnpm dev:reset        # Wipe .wrangler/state and re-apply all migrations
pnpm db:migrate:local # Apply pending migrations without wiping data
```

**Port note**: Auth callbacks assume the admin app runs on `http://localhost:4321`. Kill previous servers before starting new ones.

---

## Environment Variables

Each worker has its own configuration files:

### Configuration surfaces

1. **`wrangler.jsonc`** (per worker) — Cloudflare bindings (D1, KV, R2, Queues, service bindings) and non-secret production vars
2. **`.dev.vars`** (per worker) — Runtime secrets for local development
3. **`.env.development`** (`apps/admin/` only) — Vite/Astro build-time vars
4. **Admin dashboard settings** — Third-party providers stored in the database

### Runtime secrets (`.dev.vars`)

Both workers need identical secrets:

| Variable | Required | Purpose |
|----------|----------|---------|
| `BETTER_AUTH_SECRET` | Yes | Better Auth signing secret |
| `JWT_SECRET` | Yes | JWT signing for protected API flows |
| `API_TOKEN` | Yes | Machine-to-machine token for `/api/v1/auth/token` |
| `BETTER_AUTH_URL` | Yes | Auth callback origin (`http://localhost:4321` locally) |
| `PUBLIC_API_BASE_URL` | Yes | API base URL (`http://localhost:8787` locally) |
| `STOREFRONT_URL` | Yes | Storefront origin for redirects/payment callbacks |
| `R2_PUBLIC_URL` | No | Public base URL for uploaded media |
| `PURGE_TOKEN` | No | Bearer token for external storefront cache purge |

### Build-time vars (`apps/admin/.env.development`)

| Variable | Purpose |
|----------|---------|
| `PUBLIC_API_BASE_URL` | Used by Vite proxy and client-side fetch |

### Dashboard-configured integrations

| Integration | Where to configure |
|-------------|-------------------|
| Resend email key + sender | **Settings → Email** |
| Firebase public config + service account | **Settings → Notifications** |
| Stripe / SSLCommerz / Polar + payment methods | **Settings → Payments** |
| Delivery provider credentials | **Settings → Delivery Providers** |
| OpenRouter API key | Widget generator settings dialog |
| CSP allowed domains | **Settings → Security** |

---

## Cloudflare Bindings

### API Worker (`apps/api/wrangler.jsonc`)

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1Database | Primary SQLite database |
| `CACHE` | KVNamespace | API response cache |
| `SESSION` | KVNamespace | Session storage |
| `SHARED_AUTH_CACHE` | KVNamespace | Auth/RBAC cache |
| `BUCKET` | R2Bucket | Media file storage |
| `PAYMENT_EVENTS_QUEUE` | Queue | Payment webhook processing |
| `ORDER_NOTIFICATIONS_QUEUE` | Queue | Order push notifications |
| `AUTH_OTP_QUEUE` | Queue | Async email/OTP delivery |
| `ORDER_INGEST_QUEUE` | Queue | High-concurrency order creation |

### Admin Worker (`apps/admin/wrangler.jsonc`)

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1Database | Better Auth session/user tables + RBAC |
| `CACHE` | KVNamespace | CSP domain cache, RBAC permission cache |
| `SESSION` | KVNamespace | Astro session storage |
| `SHARED_AUTH_CACHE` | KVNamespace | Auth token cache |
| `BUCKET` | R2Bucket | R2 storage (initialized for shared core modules) |
| `API` | Service Binding | Routes requests to the API worker |
| `ASSETS` | Fetcher | Static asset serving |

### Storefront Worker (`apps/storefront/wrangler.jsonc`)

| Binding | Type | Purpose |
|---------|------|---------|
| `CACHE_CONTROL` | KVNamespace | Cache version control for L2 invalidation |
| `BACKEND_API` | Service Binding | Routes API calls to the API worker |
| `ASSETS` | Fetcher | Static asset serving |

---

## Database & Migrations

- **Schema**: `packages/database/src/schema/` (11 domain files)
- **Client**: `packages/database/src/client.ts` (`getDb()` factory)
- **Migrations**: `packages/database/migrations/`
- **Drizzle config**: `packages/database/drizzle.config.ts`

```bash
pnpm db:generate        # Generate migration from schema changes
pnpm db:migrate:local   # Apply to local D1
pnpm db:studio          # Drizzle Studio browser
```

The deploy script (`scripts/deploy.mjs`) handles migrations automatically.

### Full-text search (FTS5)

All text search uses **SQLite FTS5** with external content tables (no data duplication). INSERT/UPDATE/DELETE triggers keep indexes in sync automatically.

- FTS5 tables: `products_fts`, `product_variants_fts`, `categories_fts`, `pages_fts`, `orders_fts`, `customers_fts`, `discounts_fts`, `abandoned_checkouts_fts`
- Query helpers: `packages/core/src/search/fts5.ts`

---

## Authentication

Uses [Better Auth](https://better-auth.com):

- Email/password with secure hashing
- Optional admin 2FA: authenticator app (TOTP), email OTP, backup codes
- Rate limiting on auth flows
- Session management with 7-day expiry and automatic refresh
- Auth endpoints live on the **admin worker** (`/api/auth/*`) for cookie domain alignment
- The API worker validates sessions independently via shared D1 + Better Auth secret

### First-time setup

1. Navigate to `/admin` → redirects to `/auth/setup`
2. Create the first admin account
3. Account is promoted to super admin, RBAC seeded automatically

---

## API Usage

### Hono API — `http://localhost:8787/api/v1/**`

- **Routes**: `apps/api/src/routes/` (thin HTTP layer) → `packages/core/src/modules/` (business logic)
- **Docs**: `/api/v1/docs` (Swagger UI) and `/api/v1/openapi.json`
- **CORS**: configured in `apps/api/src/app.ts` using `@scalius/shared/cors-helper`

**Route namespacing:**
- Admin routes (session/JWT + RBAC): `/api/v1/admin/**`
- Storefront protected (JWT): `/api/v1/orders/**`, `/api/v1/cache/**`
- Storefront public (no auth): `/api/v1/products`, `/api/v1/categories`, `/api/v1/storefront/*`, etc.

**Consolidated endpoints** (reduce client round-trips):
- `GET /api/v1/storefront/homepage` — hero sliders, widgets, collections, SEO
- `GET /api/v1/storefront/layout` — header/footer, navigation, analytics scripts

### Machine-to-machine auth

```bash
# 1. Get JWT
curl -sS -H "X-API-Token: $API_TOKEN" "http://localhost:8787/api/v1/auth/token"

# 2. Use JWT
curl -sS -H "Authorization: Bearer <JWT>" "http://localhost:8787/api/v1/cache/stats"
```

---

## Queues

The API worker uses Cloudflare Queues for async processing:

| Queue | Purpose |
|-------|---------|
| `payment-events` | Payment gateway webhook events (Stripe, SSLCommerz, Polar) |
| `order-notifications` | Push notifications for new orders |
| `auth-otp` | Async email/OTP delivery |
| `order-ingest` | High-concurrency order creation with batched inventory |

Queue consumer: `apps/api/src/queue-consumer.ts`

---

## Cache Invalidation

Two complementary mechanisms:

- **Module-level**: Domain services invalidate specific KV cache keys after writes
- **Middleware-level**: `apps/admin/src/lib/middleware-helper/hono-cache-invalidator.ts` watches admin write responses and triggers KV invalidation + optional external storefront purge (`PURGE_URL` + `PURGE_TOKEN`)

---

## Media Uploads (R2)

- Upload endpoint: `POST /api/v1/admin/media/upload` (multipart field `files`)
- Storage: `packages/core/src/integrations/storage.ts` (native R2 binding)
- Dev media server: `GET /api/v1/media/:key` (serves files from local R2 in dev)
- Set `R2_PUBLIC_URL` to the public base URL of your bucket/CDN domain

---

## Deployment

```bash
pnpm deploy
```

Runs `scripts/deploy.mjs` which:
1. Applies D1 migrations (remote)
2. Builds both workers
3. Deploys to Cloudflare Workers via Wrangler

Worker configs: `apps/admin/wrangler.jsonc` and `apps/api/wrangler.jsonc`.

---

## Key File Paths

| File | Purpose |
|------|---------|
| `apps/api/src/worker.ts` | API Worker entry (WorkerEntrypoint) |
| `apps/api/src/app.ts` | Hono app entry |
| `apps/api/wrangler.jsonc` | API Worker Cloudflare config |
| `apps/admin/src/worker.ts` | Admin Worker entry |
| `apps/admin/astro.config.mjs` | Astro config |
| `apps/admin/wrangler.jsonc` | Admin Worker Cloudflare config |
| `apps/admin/src/middleware.ts` | Auth + RBAC + CSP middleware |
| `packages/core/src/auth/auth.ts` | Better Auth config |
| `apps/admin/src/lib/auth-client.ts` | Better Auth React client |
| `apps/storefront/astro.config.mjs` | Storefront Astro config |
| `apps/storefront/wrangler.jsonc` | Storefront Cloudflare config |
| `apps/storefront/src/middleware.ts` | Storefront caching + context middleware |
| `apps/storefront/src/lib/api/client.ts` | Storefront API client (JWT + service binding) |
| `packages/database/src/schema/` | Drizzle schema (11 files) |
| `packages/database/migrations/` | SQL migrations |
| `packages/database/drizzle.config.ts` | Drizzle config |
| `packages/core/src/middleware-helper/csp-handler.ts` | CSP header assembly |

---

## Troubleshooting

- **"CRITICAL SECURITY ERROR: Using default JWT secret"** — Set `JWT_SECRET` in `.dev.vars` or production secrets.
- **"BETTER_AUTH_SECRET is not set"** — Set in `.dev.vars`. Generate: `openssl rand -base64 32`
- **Auth sign-in loops** — Ensure admin runs on `http://localhost:4321`. Run `pnpm dev:setup --force` to regenerate env files.
- **API logs not showing** — API worker logs appear under the `@scalius/api:dev:` prefix in the Turbo output.
- **CSP blocking images/scripts** — Platform URLs (`PUBLIC_API_BASE_URL`, `R2_PUBLIC_URL`, etc.) are auto-allowed. For third-party domains, add them in **Settings → Security**.
- **CORS issues** — Set `PUBLIC_API_BASE_URL` and (if needed) `CSP_ALLOWED` / `CDN_DOMAIN_URL` in `.dev.vars`.
- **D1 errors in dev** — Run `pnpm db:migrate:local` or `pnpm dev:reset` for a clean database.
- **Email 2FA not working** — Configure Resend in **Settings → Email**. Use authenticator app for local dev.
- **Firebase notifications not working** — Configure in **Settings → Notifications**.
