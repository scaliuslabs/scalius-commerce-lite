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
  Full-stack e-commerce admin dashboard + storefront API built on Astro, Hono, and Turso.
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
  <a href="https://x.com/scaliuslabs">
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

## Scalius Commerce Lite

Scalius Commerce Lite is a full-stack **e-commerce admin dashboard** + **storefront API** built on **Astro** and **Hono**, backed by **Turso (libSQL)** via **Drizzle ORM**. The admin side ships as Astro pages with React components; the storefront API ships as a Hono app mounted under `/api/v1`.

### What’s in this repo

- **Admin dashboard (UI)**: `src/pages/admin/**` (Astro pages) + `src/components/admin/**` (React components).
- **Admin CRUD APIs (Astro API routes)**: `src/pages/api/**` (file-based endpoints, protected by Clerk via `src/middleware.ts`).
- **Storefront API (Hono)**: `src/server/**` (Hono app + routes), mounted at `/api/v1/**` via the custom Astro integration in `src/integrations/hono-integration.ts`.
- **Database (Drizzle + Turso)**: schema in `src/db/schema.ts`, connection in `src/db/index.ts`, migrations in `migrations/**`.

### Key URLs

- **Admin UI**: `/admin`
- **Admin API (Astro endpoints)**: `/api/**`
- **Storefront API (Hono)**: `/api/v1/**`
- **Swagger UI**: `/api/v1/docs`
- **OpenAPI JSON**: `/api/v1/openapi.json`
- **Health**: `/health` (Astro) and `/api/v1/health` (Hono)

### Tech stack

- **Runtime / framework**: Astro (SSR, Cloudflare adapter) + React
- **Storefront API**: Hono (Swagger UI + OpenAPI)
- **Database**: Turso/libSQL + Drizzle ORM
- **UI**: Tailwind CSS v4 + shadcn/ui (`src/components/ui/**`)
- **Auth**: Clerk (`@clerk/astro`)
- **Caching**: Upstash Redis (with in-memory fallback) for Hono API response caching
- **Storage**: Cloudflare R2 (S3-compatible) for media uploads
- **Notifications**: Firebase Cloud Messaging (admin push notifications)
- **AI tooling**: OpenRouter integration for widget/content generation (API key stored in DB settings)
- **Deploy**: Cloudflare Pages/Workers via Wrangler

### Features (high level)

- **Commerce**: products (including variants, images, rich content), categories, attributes, collections
- **Sales**: orders, customers, abandoned checkouts, discounts
- **Storefront content**: header/footer builders, navigation, pages, hero sliders, widgets
- **Operations**: shipping methods, delivery providers/shipments, fraud checker, cache management
- **Media**: R2-backed uploads + Cloudflare Image Resizing optimization in production
- **Notifications**: admin push notifications for new orders (Firebase Cloud Messaging)
- **AI**: OpenRouter-powered widget/content generation and prompt tooling

### Architecture overview

#### Admin (Astro pages + React)

- Admin pages live in `src/pages/admin/**` and render through `src/layouts/AdminLayout.astro`.
- Most interactive UI is React (hydrated with `client:*` directives).
- Authentication + org gating is enforced by `src/middleware.ts` using Clerk.

#### Admin CRUD APIs (Astro API routes)

- Admin CRUD endpoints are Astro API routes under `src/pages/api/**` (e.g. products, categories, collections, orders, media, widgets, settings).
- These routes use Drizzle (`src/db`) for reads/writes and are protected by middleware route matching (see `isProtectedApiRoute` in `src/middleware.ts`).

#### Storefront API (Hono)

- Hono app entry: `src/server/index.ts`
- Astro integration injects `/api/v1/[...slug]` and forwards requests to Hono via `src/server/astro-handler.ts`.
- Route handlers live in `src/server/routes/**`.
- API docs:
  - Swagger UI is served at `/api/v1/docs`
  - OpenAPI spec is served at `/api/v1/openapi.json`

### Project structure (high level)

```text
src/                     # App code (Astro UI + APIs + Hono)
  pages/
    admin/               # Admin dashboard pages (Astro)
    api/                 # Admin CRUD endpoints (Astro API routes)
    health.ts            # App health endpoint
  components/
    admin/               # Admin React components
    ui/                  # shadcn/ui components
  server/
    index.ts             # Hono app (storefront API)
    astro-handler.ts     # Astro → Hono bridge for /api/v1/*
    routes/              # Hono route modules
    middleware/          # Hono middleware (auth + caching)
    openapi/             # OpenAPI spec builder
    utils/               # Redis/JWT/etc
  db/
    schema.ts            # Drizzle schema (SQLite/libSQL)
    index.ts             # getDb() (Turso/libSQL)
migrations/              # Drizzle migration SQL + snapshots
```

### Scripts

From `package.json`:

```bash
pnpm dev          # astro dev --host
pnpm build        # astro check && astro build && pnpm db:generate &&  
pnpx astro check  # Type check 
pnpm start        # wrangler pages dev ./dist  (run built output; run pnpm build first)
pnpm deploy       # wrangler pages deploy ./dist

pnpm db:generate  # drizzle-kit generate
pnpm db:sync      # tsx src/scripts/sync-migrations.ts
pnpm db:studio    # drizzle-kit studio

pnpm generate:sdk # tsx src/scripts/generate-openapi-json.ts && openapi-ts
```

### Environment variables

This project runs locally via `.env` (loaded by `dotenv/config`) and in production via Cloudflare Pages/Workers environment variables + bindings.

#### Core (required)

- **Database**
  - `TURSO_DATABASE_URL`: Turso/libSQL database URL (required by `src/db/index.ts`)
  - `TURSO_AUTH_TOKEN`: Turso auth token
- **Clerk**
  - `PUBLIC_CLERK_PUBLISHABLE_KEY`
  - `CLERK_SECRET_KEY`
  - `CLERK_ALLOWED_ORG_ID`: optional org allow-list for admin + admin APIs
- **Hono auth**
  - `API_TOKEN`: machine-to-machine token (used by `/api/v1/auth/token`)
  - `JWT_SECRET`: JWT signing secret (required in production; defaults are blocked by code)
- **Base URL (recommended)**
  - `PUBLIC_API_BASE_URL`: canonical site origin used by the Hono layer (CORS, proxy headers, notifications links, CSP helpers)
  - `PUBLIC_API_URL`: optional override for the full Hono API base (some admin cache routes will use this if set)

#### Caching (recommended for production)

- `UPSTASH_REDIS_REST_URL` (or `UPSTASH_REDIS_URL` / `REDIS_URL`)
- `UPSTASH_REDIS_REST_TOKEN` (or `UPSTASH_REDIS_TOKEN`)
- `PROJECT_CACHE_PREFIX`: prefixes all cache keys (multi-project safety; defaults to `default_project`)
- `REDIS_CACHE_TTL`: default cache TTL in seconds (optional)

#### Media uploads (Cloudflare R2)

Required if you use `/api/media/upload`:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_URL` (public base URL used to construct file URLs)

Optional:

- `CDN_DOMAIN_URL`: used for CSP and image allow-listing

#### Content Security Policy / CORS

- `CSP_ALLOWED`: comma-separated additional allowed domains (used by CSP + CORS helpers)

#### Storefront cache purge (optional)

If you have a separate storefront that exposes a purge endpoint, the backend can trigger it after admin writes:

- `PURGE_URL`
- `PURGE_TOKEN`

#### Admin notifications (Firebase Cloud Messaging)

- **Server**
  - `FIREBASE_SERVICE_ACCOUNT_CRED_JSON`: service account JSON (stringified)
  - `PROJECT_CACHE_PREFIX`: reused for KV cache keys
  - `SHARED_AUTH_CACHE` (Cloudflare KV binding): used to cache Firebase access tokens
- **Client (public)**
  - `PUBLIC_FIREBASE_API_KEY`
  - `PUBLIC_FIREBASE_AUTH_DOMAIN`
  - `PUBLIC_FIREBASE_PROJECT_ID`
  - `PUBLIC_FIREBASE_STORAGE_BUCKET`
  - `PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
  - `PUBLIC_FIREBASE_APP_ID`
  - `PUBLIC_FIREBASE_MEASUREMENT_ID`
  - `PUBLIC_VAPID_FIREBASE`

#### Search reindex auth (optional)

Some reindex endpoints expect a bearer secret in production:

- `SERVICE_PASSWORD_MEILISEARCH`

#### AI / OpenRouter (optional)

OpenRouter API key is stored in the DB settings table (`key=openrouter_api_key`, `category=integrations`), not in env.

Optional env vars used for OpenRouter request metadata:

- `OPENROUTER_BASE_URL`
- `PUBLIC_SITE_URL`
- `SITE_TITLE`

### Local development

#### 1) Install dependencies

```bash
pnpm install
```

#### 2) Configure env

Create a `.env` file with at least the required variables (Turso + Clerk). Add Redis/R2/Firebase/OpenRouter settings depending on which features you plan to use.

#### 3) Run the dev server

```bash
pnpm dev
```

Astro defaults to port `4321` unless configured otherwise.

If you want Cloudflare runtime parity (Workers execution context, KV bindings, etc.), run the built output with Wrangler:

```bash
pnpm build
pnpm start
```

### Database & migrations (Drizzle + Turso)

- Drizzle config: `drizzle.config.ts`
- Schema: `src/db/schema.ts`
- Migrations: `migrations/**`

Recommended workflow for this repo:

```bash
pnpm db:generate
pnpm db:sync
```

`db:sync` runs `src/scripts/sync-migrations.ts` to keep the `__drizzle_migrations` history table aligned with your migration files and database state (helpful when switching between `db:push` and `db:migrate` workflows).

### API usage

#### Admin API (Astro) — `/api/**`

- Source: `src/pages/api/**`
- Auth: protected by Clerk middleware route matching in `src/middleware.ts`
- Example: products CRUD lives in:
  - `src/pages/api/products/index.ts` (`GET`, `POST`)
  - `src/pages/api/products/[id].ts` (`PUT`, `DELETE`)

#### Storefront API (Hono) — `/api/v1/**`

- Source: `src/server/**`
- Docs: `/api/v1/docs` and `/api/v1/openapi.json`
- CORS: configured in `src/server/index.ts` using `src/lib/cors-helper.ts`
- Caching: many GET routes use `cacheMiddleware` (`src/server/middleware/cache.ts`)
- Public vs protected:
  - **Public (no JWT)**: most read-only storefront data (products, categories, collections, pages, layout data, etc.)
  - **Protected (JWT required)**: `/api/v1/orders/**` and `/api/v1/cache/**`

##### Storefront “single-call” endpoints

To reduce client round-trips, the Hono API exposes consolidated endpoints:

- `GET /api/v1/storefront/homepage`: homepage data (hero sliders, widgets, collections + products, SEO)
- `GET /api/v1/storefront/layout`: layout data (header/footer config, navigation fallback, analytics scripts)

##### Machine-to-machine auth (for protected routes)

Some routes (notably `/api/v1/orders/*` and `/api/v1/cache/*`) require a short-lived JWT.

1) Obtain a JWT using your `API_TOKEN`:

```bash
curl -sS \
  -H "X-API-Token: $API_TOKEN" \
  "http://localhost:4321/api/v1/auth/token"
```

2) Use the JWT to call protected endpoints:

```bash
curl -sS \
  -H "Authorization: Bearer <JWT_FROM_STEP_1>" \
  "http://localhost:4321/api/v1/cache/stats"
```

### Cache invalidation (how freshness is maintained)

There are two complementary mechanisms:

- **Hono-side invalidation for Hono writes**: `src/server/astro-handler.ts` can invalidate related cache keys after successful `/api/v1` write requests.
- **Admin-side invalidation for Astro admin writes**: `src/lib/middleware-helper/hono-cache-invalidator.ts` watches successful writes to admin endpoints like `/api/products`, `/api/categories`, `/api/collections`, etc. and triggers:
  - backend cache invalidation (Upstash/in-memory)
  - optional external storefront purge (if `PURGE_URL` + `PURGE_TOKEN` are set)

In Cloudflare Workers, invalidations are scheduled via `ctx.waitUntil()` when available (see `src/middleware.ts`).

### Media uploads (R2)

- Upload endpoint: `POST /api/media/upload` (multipart form field `files`)
- Storage implementation: `src/lib/storage.ts` (S3-compatible client targeting R2)

If R2 env vars are missing, the upload route will fail early with “Missing required R2 environment variables”.

### Admin push notifications (FCM)

- Client initializes FCM inside `src/layouts/AdminLayout.astro` and posts tokens to:
  - `POST /api/admin/fcm-token`
- Server sends order notifications in the background from Hono order creation:
  - `src/lib/notification-utils.ts`
  - `src/lib/firebase/admin.ts` (Worker-friendly FCM REST implementation)

### AI generation (OpenRouter)

- Model list: `GET /api/openrouter/models`
- Generation: `POST /api/openrouter/generate`
- Staged generation: `POST /api/openrouter/generate-staged`
- API key management: `GET/POST /api/settings/openrouter` (stored in DB settings, masked on read)
- System prompt fetch: `GET /api/system-prompt?type=widget|landing-page|collection`

### SDK generation

This repo can generate a typed TS client from the Hono OpenAPI spec:

```bash
pnpm generate:sdk
```

See `src/lib/sdk/README.md` for usage patterns and security notes.

### Deployment (Cloudflare Pages)

- Build output is SSR (`output: "server"`) with the Cloudflare adapter (`astro.config.mjs`).
- Deploy with:

```bash
pnpm build
pnpm deploy
```

`wrangler.toml` defines worker compatibility flags, static assets binding, and a KV namespace binding (`SHARED_AUTH_CACHE`).

### Troubleshooting

- **“CRITICAL SECURITY ERROR: Using default JWT secret in production”**
  - Set `JWT_SECRET` in production.
- **Redis not configured**
  - You’ll see logs like “Redis URL not provided. Using in-memory cache fallback.” Configure Upstash env vars for production-grade caching.
- **CORS issues**
  - Set `PUBLIC_API_BASE_URL` and (if needed) `CSP_ALLOWED` / `CDN_DOMAIN_URL`.
- **Admin auth / org mismatch**
  - Set `CLERK_ALLOWED_ORG_ID` if you want to restrict access to a specific Clerk organization.

