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

Scalius Commerce Lite is a full-stack **e-commerce admin dashboard** + **storefront API** built on **Astro** and **Hono**, backed by **Turso (libSQL)** via **Drizzle ORM**. The admin side ships as Astro pages with React components; the storefront API ships as a Hono app mounted under `/api/v1`.

### What's in this repo

- **Admin dashboard (UI)**: `src/pages/admin/**` (Astro pages) + `src/components/admin/**` (React components).
- **Admin CRUD APIs (Astro API routes)**: `src/pages/api/**` (file-based endpoints, protected by Better Auth via `src/middleware.ts`).
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
- **Auth**: Better Auth (email/password + mandatory 2FA)
- **Caching**: Upstash Redis (with in-memory fallback) for Hono API response caching
- **Storage**: Cloudflare R2 (S3-compatible) for media uploads
- **Notifications**: Firebase Cloud Messaging (admin push notifications, configured via dashboard)
- **Email**: Cloudflare Email Workers (2FA codes, password reset)
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
- **Security**: Mandatory 2FA for admin users (authenticator app or email), rate limiting, secure sessions

### Architecture overview

#### Admin (Astro pages + React)

- Admin pages live in `src/pages/admin/**` and render through `src/layouts/AdminLayout.astro`.
- Most interactive UI is React (hydrated with `client:*` directives).
- Authentication is enforced by `src/middleware.ts` using Better Auth with mandatory two-factor authentication.

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
    auth/                # Authentication pages (login, setup, 2FA)
    health.ts            # App health endpoint
  components/
    admin/               # Admin React components
    auth/                # Authentication React components
    ui/                  # shadcn/ui components
  server/
    index.ts             # Hono app (storefront API)
    astro-handler.ts     # Astro → Hono bridge for /api/v1/*
    routes/              # Hono route modules
    middleware/          # Hono middleware (auth + caching)
    openapi/             # OpenAPI spec builder
    utils/               # Redis/JWT/etc
  lib/
    auth.ts              # Better Auth configuration
    auth-client.ts       # Better Auth client for React
    email.ts             # Cloudflare Email Workers integration
  db/
    schema.ts            # Drizzle schema (SQLite/libSQL)
    index.ts             # getDb() (Turso/libSQL)
migrations/              # Drizzle migration SQL + snapshots
```

### Scripts

From `package.json`:

```bash
pnpm dev          # astro dev --host
pnpm build        # astro check && astro build
pnpm start        # wrangler pages dev ./dist (run built output; run pnpm build first)
pnpm deploy       # wrangler pages deploy ./dist

pnpm db:generate  # drizzle-kit generate
pnpm db:sync      # tsx src/scripts/sync-migrations.ts
pnpm db:studio    # drizzle-kit studio

pnpm generate:sdk # tsx src/scripts/generate-openapi-json.ts && openapi-ts
```

### Environment variables

This project runs locally via `.dev.vars` (Wrangler) or `.env` and in production via Cloudflare Pages/Workers environment variables + bindings.

#### Core (required)

- **Database**
  - `TURSO_DATABASE_URL`: Turso/libSQL database URL (required by `src/db/index.ts`)
  - `TURSO_AUTH_TOKEN`: Turso auth token
- **Authentication (Better Auth)**
  - `BETTER_AUTH_SECRET`: Session encryption secret (generate with: `openssl rand -base64 32`)
  - `BETTER_AUTH_URL`: Base URL for auth callbacks (e.g., `https://your-domain.com`)
- **Hono auth**
  - `API_TOKEN`: machine-to-machine token (used by `/api/v1/auth/token`)
  - `JWT_SECRET`: JWT signing secret (required in production; defaults are blocked by code)
- **Base URL (recommended)**
  - `PUBLIC_API_BASE_URL`: canonical site origin used by the Hono layer (CORS, proxy headers, notifications links, CSP helpers)
  - `PUBLIC_API_URL`: optional override for the full Hono API base (some admin cache routes will use this if set)

#### Email (Cloudflare Email Workers)

Required for email-based 2FA and password reset in production:

- `EMAIL_SENDER`: sender email address (e.g., `noreply@yourdomain.com`)

Note: Cloudflare Email Workers requires Email Routing to be enabled on your domain. In development, emails are logged to console.

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

Firebase credentials are configured via the admin dashboard at **Settings → Notifications**. The dashboard stores credentials in the database settings table.

Server-side requirements:
- `SHARED_AUTH_CACHE` (Cloudflare KV binding): used to cache Firebase access tokens

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

Create a `.dev.vars` file with at least the required variables (Turso + Better Auth). See `.env.example` for a template.

```bash
# Required
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-turso-token
BETTER_AUTH_SECRET=your-secret-key
BETTER_AUTH_URL=http://localhost:4321

# For production
JWT_SECRET=your-jwt-secret
API_TOKEN=your-api-token
```

#### 3) Run the dev server

```bash
pnpm dev
```

Astro defaults to port `4321` unless configured otherwise.

#### 4) First-time setup

On first run, navigate to `/admin` - you'll be redirected to `/auth/setup` to create the first admin account. After account creation, you'll be required to set up two-factor authentication (authenticator app or email).

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

### Authentication

This project uses [Better Auth](https://better-auth.com) for authentication with the following features:

- **Email/password authentication** with secure password hashing
- **Mandatory two-factor authentication** for all admin users:
  - Authenticator app (TOTP) - Google Authenticator, Authy, etc.
  - Email verification codes (production only)
  - Backup codes for account recovery
- **Rate limiting** on sensitive endpoints (login, 2FA, password reset)
- **Session management** with 7-day expiry and automatic refresh

#### First-time setup

1. Navigate to `/admin` (redirects to `/auth/setup`)
2. Create the first admin account with email and password
3. Set up two-factor authentication (required)
4. Access the admin dashboard

#### Subsequent logins

1. Enter email and password at `/auth/login`
2. Complete 2FA verification (authenticator, email, or backup code)
3. Access the admin dashboard

### API usage

#### Admin API (Astro) — `/api/**`

- Source: `src/pages/api/**`
- Auth: protected by Better Auth middleware in `src/middleware.ts`
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

##### Storefront "single-call" endpoints

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

If R2 env vars are missing, the upload route will fail early with "Missing required R2 environment variables".

### Admin push notifications (FCM)

Firebase Cloud Messaging is configured via the admin dashboard at **Settings → Notifications**. No environment variables are required for Firebase - all credentials are stored securely in the database.

To set up notifications:

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable Cloud Messaging in your Firebase project
3. Go to **Settings → Notifications** in the admin dashboard
4. Enter your Firebase configuration (API key, project ID, etc.)
5. Enter your service account credentials for server-side messaging

Implementation details:
- Client initializes FCM inside `src/layouts/AdminLayout.astro` and posts tokens to `POST /api/admin/fcm-token`
- Server sends order notifications in the background from Hono order creation via `src/lib/notification-utils.ts`

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

### Deployment (Cloudflare Workers)

- Build output is SSR (`output: "server"`) with the Cloudflare adapter (`astro.config.mjs`).
- Deploy with:

```bash
pnpm build
pnpm deploy
```

`wrangler.toml` defines worker compatibility flags, static assets binding, and KV namespace bindings.

### Troubleshooting

- **"CRITICAL SECURITY ERROR: Using default JWT secret in production"**
  - Set `JWT_SECRET` in production.
- **"BETTER_AUTH_SECRET is not set"**
  - Set `BETTER_AUTH_SECRET` environment variable. Generate with: `openssl rand -base64 32`
- **Redis not configured**
  - You'll see logs like "Redis URL not provided. Using in-memory cache fallback." Configure Upstash env vars for production-grade caching.
- **CORS issues**
  - Set `PUBLIC_API_BASE_URL` and (if needed) `CSP_ALLOWED` / `CDN_DOMAIN_URL`.
- **Email 2FA not working in development**
  - Email-based 2FA requires Cloudflare Email Workers (production only). Use authenticator app for local development.
- **Firebase notifications not working**
  - Configure Firebase credentials in the admin dashboard at Settings → Notifications.
