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
  Full-stack e-commerce admin dashboard + storefront API built on Astro, Hono, and Cloudflare D1.
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

Scalius Commerce Lite is a full-stack **e-commerce admin dashboard** + **storefront API** built on **Astro** and **Hono**, backed by **Cloudflare D1** (SQLite) via **Drizzle ORM**. The admin side ships as Astro pages with React components; the storefront API ships as a Hono app mounted under `/api/v1`.

### What's in this repo

- **Admin dashboard (UI)**: `src/pages/admin/**` (Astro pages) + `src/components/admin/**` (React components).
- **Admin CRUD APIs (Astro API routes)**: `src/pages/api/**` (file-based endpoints, protected by Better Auth via `src/middleware.ts`).
- **Storefront API (Hono)**: `src/server/**` (Hono app + routes), mounted at `/api/v1/**` via the custom Astro integration in `src/integrations/hono-integration.ts`.
- **Database (Drizzle + D1)**: schema in `src/db/schema.ts`, connection in `src/db/index.ts`, migrations in `migrations/**`.

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
- **Database**: Cloudflare D1 (SQLite) + Drizzle ORM
- **UI**: Tailwind CSS v4 + shadcn/ui (`src/components/ui/**`)
- **Auth**: Better Auth (email/password + mandatory 2FA)
- **Caching**: Cloudflare KV (with in-memory fallback) for Hono API response caching
- **Storage**: Cloudflare R2 for media uploads
- **Notifications**: Firebase Cloud Messaging (admin push notifications, configured via dashboard)
- **Email**: Resend API (2FA codes, password reset, configured via dashboard)
- **AI tooling**: OpenRouter integration for widget/content generation (API key stored in DB settings)
- **Deploy**: Cloudflare Workers via Wrangler

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
    utils/               # KV cache / JWT / etc
  lib/
    auth.ts              # Better Auth configuration
    auth-client.ts       # Better Auth client for React
    email.ts             # Resend email integration (key fetched from DB)
  db/
    schema.ts            # Drizzle schema (SQLite/D1)
    index.ts             # getDb() (Cloudflare D1)
migrations/              # Drizzle migration SQL + snapshots
scripts/                 # Build and deployment scripts
```

### Scripts

From `package.json`:

```bash
pnpm dev              # astro dev --host
pnpm build            # astro check && astro build && pnpm db:generate
pnpm start            # wrangler dev (Cloudflare Workers local runtime)
pnpm deploy           # node scripts/deploy.mjs (build + migrate + deploy)

pnpm db:generate      # drizzle-kit generate
pnpm db:migrate:local # node scripts/deploy.mjs --migrate-only --local
pnpm db:migrate:remote # node scripts/deploy.mjs --migrate-only
pnpm db:studio        # drizzle-kit studio

pnpm generate:sdk     # tsx src/scripts/generate-openapi-json.ts && openapi-ts
```

### Environment variables

This project uses Cloudflare Workers bindings for databases and storage (declared in `wrangler.jsonc`). Only secrets and runtime configuration need to be set as environment variables/secrets.

For local development, create a `.dev.vars` file. In production, set these in the Cloudflare dashboard or via `wrangler secret put`.

#### Core (required)

- **Authentication (Better Auth)**
  - `BETTER_AUTH_SECRET`: Session encryption secret (generate with: `openssl rand -base64 32`)
  - `BETTER_AUTH_URL`: Base URL for auth callbacks (e.g., `https://your-domain.com`)
- **Hono auth**
  - `API_TOKEN`: machine-to-machine token (used by `/api/v1/auth/token`)
  - `JWT_SECRET`: JWT signing secret (required in production; defaults are blocked by code)

#### Optional runtime configuration

- **Base URL**
  - `PUBLIC_API_BASE_URL`: canonical site origin used by the Hono layer (CORS, proxy headers, notifications links, CSP helpers)
  - `PUBLIC_API_URL`: optional override for the full Hono API base (some admin cache routes will use this if set)
- **Media**
  - `R2_PUBLIC_URL`: public base URL used to construct file URLs for R2 uploads (the bucket binding is set in `wrangler.jsonc`)
  - `CDN_DOMAIN_URL`: used for CSP and image allow-listing

#### Content Security Policy / CORS

- `CSP_ALLOWED`: comma-separated additional allowed domains (used by CSP + CORS helpers)

#### Storefront cache purge (optional)

If you have a separate storefront that exposes a purge endpoint, the backend can trigger it after admin writes:

- `PURGE_URL`
- `PURGE_TOKEN`

#### KV cache prefix (optional)

- `PROJECT_CACHE_PREFIX`: prefixes all KV cache keys (multi-project safety; defaults to `sc`)

#### Admin notifications (Firebase Cloud Messaging)

Firebase credentials are configured via the admin dashboard at **Settings → Notifications**. No environment variables are required for Firebase — all credentials (service account JSON, web app config, VAPID key) are stored securely in the database settings table.

Optional local-dev fallback:
- `FIREBASE_SERVICE_ACCOUNT_CRED_JSON`: service account JSON (falls back to DB setting)

#### Email (Resend API)

Resend API key and sender address are configured via the admin dashboard at **Settings → Email**. No environment variables are required — credentials are stored in the database settings table and fetched at runtime.

In development without a Resend API key configured in the dashboard, emails are logged to console.

#### Search reindex auth (optional)

Some reindex endpoints expect a bearer secret in production:

- `SERVICE_PASSWORD_MEILISEARCH`

#### AI / OpenRouter (optional)

OpenRouter API key is stored in the DB settings table (`key=openrouter_api_key`, `category=integrations`), not in env.

Optional env vars used for OpenRouter request metadata:

- `OPENROUTER_BASE_URL`
- `PUBLIC_SITE_URL`
- `SITE_TITLE`

### Cloudflare bindings

The following bindings are declared in `wrangler.jsonc` and are automatically available to the Worker at runtime. No environment variables are needed for these — they are injected by the Cloudflare Workers runtime:

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1Database | Primary SQLite database (replaces Turso/libSQL) |
| `CACHE` | KVNamespace | API response cache (replaces Upstash Redis) |
| `SESSION` | KVNamespace | Astro session storage |
| `SHARED_AUTH_CACHE` | KVNamespace | Firebase access token cache |
| `BUCKET` | R2Bucket | Media file storage |
| `ASSETS` | Fetcher | Static asset serving |

### Local development

#### 1) Install dependencies

```bash
pnpm install
```

#### 2) Configure env

Create a `.dev.vars` file with at least the required variables:

```bash
# Required
BETTER_AUTH_SECRET=your-secret-key
BETTER_AUTH_URL=http://localhost:4321

# For production
JWT_SECRET=your-jwt-secret
API_TOKEN=your-api-token

# Optional - configure via admin dashboard instead
# R2_PUBLIC_URL=https://your-bucket.r2.cloudflarestorage.com
# CDN_DOMAIN_URL=cdn.yourdomain.com
```

#### 3) Run the dev server

```bash
pnpm dev
```

Astro defaults to port `4321` unless configured otherwise.

#### 4) First-time setup

On first run, navigate to `/admin` - you'll be redirected to `/auth/setup` to create the first admin account. After account creation, you'll be required to set up two-factor authentication (authenticator app or email).

For full Cloudflare Workers runtime parity (D1, KV, R2 bindings in local dev), use Wrangler:

```bash
pnpm start
```

This runs your built output in a local `workerd` environment via `wrangler dev`.

### Database & migrations (Drizzle + Cloudflare D1)

- Drizzle config: `drizzle.config.ts`
- Schema: `src/db/schema.ts`
- Migrations: `migrations/**`

Recommended workflow:

```bash
pnpm db:generate        # generate migration from schema changes
pnpm db:migrate:local   # apply migrations to local D1 (via wrangler)
pnpm db:migrate:remote  # apply migrations to remote D1
```

The deploy script (`scripts/deploy.mjs`) handles migrations automatically when running `pnpm deploy`.

### Authentication

This project uses [Better Auth](https://better-auth.com) for authentication with the following features:

- **Email/password authentication** with secure password hashing
- **Mandatory two-factor authentication** for all admin users:
  - Authenticator app (TOTP) - Google Authenticator, Authy, etc.
  - Email verification codes (requires Resend configured in dashboard)
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
  - backend KV cache invalidation
  - optional external storefront purge (if `PURGE_URL` + `PURGE_TOKEN` are set)

In Cloudflare Workers, invalidations are scheduled via `ctx.waitUntil()` when available (see `src/middleware.ts`).

### Media uploads (R2)

- Upload endpoint: `POST /api/media/upload` (multipart form field `files`)
- Storage implementation: `src/lib/storage.ts` (native R2 bucket binding)
- The R2 bucket binding (`BUCKET`) is declared in `wrangler.jsonc`

If `R2_PUBLIC_URL` is not set, uploaded file URLs will be incomplete. Set this to the public base URL of your R2 bucket.

### Admin push notifications (FCM)

Firebase Cloud Messaging is configured via the admin dashboard at **Settings → Notifications**. No environment variables are required for Firebase — all credentials are stored in the database.

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
pnpm deploy
```

This runs `scripts/deploy.mjs` which handles building, migrations, and deploying to Cloudflare Workers via Wrangler.

`wrangler.jsonc` defines worker compatibility flags, D1/KV/R2 bindings, and static assets binding.

### Troubleshooting

- **"CRITICAL SECURITY ERROR: Using default JWT secret in production"**
  - Set `JWT_SECRET` in production.
- **"BETTER_AUTH_SECRET is not set"**
  - Set `BETTER_AUTH_SECRET` environment variable. Generate with: `openssl rand -base64 32`
- **KV cache not working**
  - Ensure the `CACHE` KV namespace is correctly bound in `wrangler.jsonc` and created in your Cloudflare account.
- **CORS issues**
  - Set `PUBLIC_API_BASE_URL` and (if needed) `CSP_ALLOWED` / `CDN_DOMAIN_URL`.
- **Email 2FA not working**
  - Configure Resend API key and sender address in the admin dashboard at **Settings → Email**.
  - Email-based 2FA via OTP requires a configured Resend API key. Use authenticator app for local development without Resend.
- **Firebase notifications not working**
  - Configure Firebase credentials in the admin dashboard at **Settings → Notifications**.
- **D1 database errors in local dev**
  - Run `pnpm db:migrate:local` to apply pending migrations to the local D1 database.
  - Use `pnpm start` (wrangler dev) for full D1/KV/R2 binding support locally.
