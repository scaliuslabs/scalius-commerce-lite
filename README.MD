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
  Full-stack e-commerce platform — admin dashboard, storefront, and API — deployed as Cloudflare Workers. Turborepo monorepo with TanStack Start, Astro, Hono, and Cloudflare D1.
</p>

<p align="center">
  <a href="https://github.com/scaliuslabs/scalius-commerce-lite/blob/master/LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL%20v3-blue.svg" alt="Scalius Commerce Lite is released under the AGPL v3 license." />
  </a>
  <a href="https://github.com/scaliuslabs/scalius-commerce-lite/issues">
    <img src="https://img.shields.io/badge/Issues-welcome-brightgreen.svg?style=flat" alt="Issues welcome!" />
  </a>
  <a href="https://github.com/scaliuslabs/scalius-commerce-lite/blob/master/SECURITY.md">
    <img src="https://img.shields.io/badge/Security-Policy-red.svg" alt="Security Policy" />
  </a>
</p>

<p align="center">
  <a href="https://scalius.com/x">
    <img src="https://img.shields.io/twitter/follow/scaliuslabs.svg?label=Follow%20@scaliuslabs" alt="Follow @scaliuslabs" />
  </a>
  <a href="https://scalius.com/discord">
    <img src="https://img.shields.io/badge/chat-on%20discord-7289DA.svg" alt="Discord Chat" />
  </a>
  <a href="https://scalius.com/facebook">
    <img src="https://img.shields.io/badge/Facebook-Follow-1877F2?logo=facebook" alt="Follow on Facebook" />
  </a>
</p>

## Overview

Scalius Commerce Lite is a **Turborepo monorepo** containing three Cloudflare Workers and five shared packages. All workers communicate via **Cloudflare Service Bindings** (zero-latency RPC in production).

```text
apps/
  admin-v2/       # @scalius/admin-v2 — TanStack Start admin dashboard (Cloudflare Worker)
  api/            # @scalius/api — Hono standalone API + queue consumer (Cloudflare Worker)
  storefront/     # @scalius/storefront — Astro 6 SSR customer store (Cloudflare Worker)
packages/
  api-client/     # @scalius/api-client — Generated SDK from OpenAPI spec (249 paths, 27k+ types)
  core/           # @scalius/core — 21 domain modules, auth, integrations, FTS5 search
  database/       # @scalius/database — Drizzle schema (13 files, 52 tables), migrations
  shared/         # @scalius/shared — 65+ pure utility functions across 21 modules
  tsconfig/       # @scalius/tsconfig — Shared TypeScript configs (base, astro, worker)
scripts/          # Dev setup, deploy pipeline, dev server wrapper
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | Turborepo + pnpm workspaces |
| Admin Dashboard | TanStack Start + TanStack Router + TanStack Query + React 19 |
| Storefront | Astro 6 SSR + React 19 |
| API | Hono + @hono/zod-openapi (auto-generated OpenAPI/Swagger) |
| Database | Cloudflare D1 (SQLite) + Drizzle ORM + FTS5 full-text search |
| UI | Tailwind CSS v4 + shadcn/ui + Radix primitives |
| Auth | Better Auth (email/password + optional 2FA with TOTP/email OTP) |
| Caching | Cloudflare KV + in-memory L1 + Cache API L2 (storefront) |
| Storage | Cloudflare R2 for media + Cloudflare Image Resizing |
| Queues | Cloudflare Queues (payments, notifications, OTP, order ingestion) |
| Payments | Stripe, SSLCommerz, Polar, COD |
| Delivery | Pathao, Steadfast (webhook-driven tracking) |
| Notifications | Email (Resend), SMS (4 providers), Firebase Cloud Messaging |
| AI | OpenRouter LLM integration for widget/content generation |
| CI/CD | GitHub Actions (lint → typecheck → build → test) |
| Deploy | Cloudflare Workers via Wrangler |

---

## Architecture

```mermaid
flowchart TB
    subgraph AdminV2 ["Admin Dashboard (TanStack Start)"]
        direction TB
        TSRouter["TanStack Router<br/>(60+ pages)"]
        TSQuery["TanStack Query<br/>(78 queryOptions, 115 mutations)"]
        ServerFns["261 Server Functions<br/>(214 legacy + 47 extracted)"]
    end

    subgraph Storefront ["Storefront (Astro 6 SSR)"]
        direction TB
        AstroPages["SSR Pages<br/>(product, cart, checkout, search)"]
        EdgeCache["L1 In-Memory + L2 Cache API<br/>(KV-versioned invalidation)"]
        SDKClient["SDK Client<br/>(@scalius/api-client)"]
    end

    subgraph API ["API Worker (Hono)"]
        direction TB
        HonoApp["160+ Endpoints<br/>(@hono/zod-openapi)"]
        QueueConsumer["Queue Consumer<br/>(payments, notifications, OTP)"]
        CoreModules["@scalius/core<br/>(21 domain modules)"]
    end

    subgraph Infra ["Cloudflare Infrastructure"]
        D1[(D1 Database<br/>52 tables)]
        KV[(KV Namespaces<br/>cache + sessions + auth)]
        R2[(R2 Bucket<br/>media storage)]
        Queues["4 Queues<br/>(payment-events, notifications,<br/>auth-otp, order-ingest)"]
    end

    subgraph External ["External Services"]
        Stripe["Stripe"]
        SSLCommerz["SSLCommerz"]
        Polar["Polar"]
        Pathao["Pathao"]
        Steadfast["Steadfast"]
        Firebase["Firebase FCM"]
        SMS["SMS Providers (4)"]
        Resend["Resend Email"]
        OpenRouter["OpenRouter LLM"]
    end

    AdminV2 -->|"Service Binding (env.API)"| API
    Storefront -->|"Service Binding (env.BACKEND_API)"| API
    API --> D1
    API --> KV
    API --> R2
    API -->|Enqueue| Queues
    Queues -->|Consume| QueueConsumer
    QueueConsumer --> Firebase
    QueueConsumer --> SMS
    QueueConsumer --> Resend
    HonoApp --> CoreModules
    Storefront --> EdgeCache

    API -.->|Webhooks| Stripe
    API -.->|Webhooks| SSLCommerz
    API -.->|Webhooks| Polar
    API -.->|Webhooks| Pathao
    API -.->|Webhooks| Steadfast
    AdminV2 -.-> OpenRouter
```

### Service Binding Topology

```mermaid
graph LR
    A["Admin-V2<br/>:4323"] -->|env.API| C["API Worker<br/>:8787"]
    B["Storefront<br/>:4322"] -->|env.BACKEND_API| C
    C --> D[(D1)]
    C --> E[(KV)]
    C --> F[(R2)]
```

In production, service bindings are zero-latency RPC calls (no HTTP overhead). In development, they fall back to `fetch("http://localhost:8787")`.

---

## Features

### Commerce
- Products with variants (size, color, SKU, barcode), images, rich content, attributes
- Categories, collections (manual & dynamic), product attributes
- Inventory management with stock versioning (CAS), reservations, low-stock alerts
- FTS5 full-text search with Bengali tokenizer support

### Sales
- Orders with 11-state machine (pending → processing → confirmed → shipped → delivered → completed)
- 3 payment gateways (Stripe, SSLCommerz, Polar) + Cash on Delivery
- Atomic payment processing via `db.batch()` with idempotency indexes
- Discounts (percentage, fixed, free shipping) with eligibility rules
- Abandoned checkout tracking and recovery
- Customer management with order history

### Storefront Content
- Header/footer builders (JSON config)
- Navigation builder with drag-and-drop hierarchy
- CMS pages with Tiptap rich text editor
- Hero slider management (desktop + mobile variants)
- Homepage widgets with AI-powered generation (OpenRouter LLM)

### Operations
- 2 delivery providers (Pathao, Steadfast) with webhook-driven tracking
- Shipping methods (flat-rate, weight-based, zone-based)
- Fraud checker (manual merchant tool per order)
- Cache management dashboard (KV stats, selective purge)
- Invoice generation and PDF download

### Notifications
- 9 notification types (order placed → refunded)
- 3 channels: Email (Resend), SMS (4 providers), FCM push
- Per-status channel independence (configurable per event type)
- Queue-driven async delivery

### Security
- Better Auth with optional 2FA (TOTP authenticator + email OTP + backup codes)
- RBAC with 80+ permissions across 14 categories
- Rate limiting per endpoint
- AES-GCM credential encryption for provider secrets
- Webhook signature verification (per-provider)
- Compare-and-swap (CAS) concurrency control on order/inventory updates

---

## Admin Dashboard (`apps/admin-v2/`)

The admin dashboard is built with **TanStack Start** — a full-stack React framework on Cloudflare Workers.

### Data Flow

```mermaid
flowchart LR
    SF["createServerFn<br/>(214 legacy + 47 extracted)"] --> QO["queryOptions<br/>(78 wrappers)"]
    QO --> L["Route Loader<br/>(ensureQueryData)"]
    L --> C["Component<br/>(useSuspenseQuery)"]
    C --> M["useMutation<br/>(115 hooks)"]
    M -->|invalidateQueries| QO
```

- **Server Functions**: 214 functions remain in the legacy `api.functions.ts` barrel, plus 47 extracted typed functions under `api-functions/`
- **Query Options** (`api.queries.ts`): 78 React Query wrappers with 7 staleTime tiers (10s → 1hr)
- **Mutations** (`api.mutations.ts`): 115 exported hooks with cache invalidation and toast notifications
- **Stale-While-Revalidate**: Detail queries use `staleTime: 0` + loader `staleTime: Infinity` for instant navigation

### Pages (60+)

| Section | Pages |
|---------|-------|
| Dashboard | Stats, recent orders, activity |
| Products | List, create, edit, view, variants, images, SEO |
| Orders | List, create, edit, view, shipments, payments, invoices |
| Categories | List, create, edit |
| Collections | List, create, edit, trash, drag-and-drop reorder |
| Customers | List, create, edit, history |
| Discounts | List, create (3 types), edit |
| Pages (CMS) | List, create, edit with Tiptap editor |
| Widgets | List, edit with AI generation, history/restore |
| Attributes | List, inline edit, value management |
| Inventory | Stock levels, adjustments, alerts |
| Media | File browser with folders, upload, move, delete |
| Analytics | Tracking script management |
| Settings | 12+ tabs (general, checkout, payments, delivery, notifications, auth, etc.) |

### Key Libraries

TanStack Start, TanStack Router, TanStack Query, TanStack Table, React 19, shadcn/ui, Tailwind v4, React Hook Form, Zod, Tiptap, dnd-kit, Recharts, Sonner, Firebase

---

## Storefront (`apps/storefront/`)

The storefront is an **Astro 6 SSR** application with React 19 islands for interactivity.

### Pages

| Page | Description |
|------|-------------|
| Homepage | Hero slider, widgets, collections |
| Product (`/products/[slug]`) | Gallery, variants, JSON-LD, OG meta |
| Category (`/categories/[slug]`) | Product grid with attribute filters |
| Search (`/search`) | FTS5-powered with price/attribute filters |
| Cart | Line items, discount codes, shipping calculator |
| Checkout | Multi-gateway payment selection |
| Order Success | Confirmation with tracking link |
| CMS Pages (`/[slug]`) | Dynamic content pages |

### Caching (Two-Tier)

- **L1**: In-memory Map (max 1000 entries, LRU eviction, per-isolate)
- **L2**: Cloudflare Cache API with KV version control (survives cold starts)
- **Invalidation**: `POST /api/purge-cache` bumps KV version; all edge caches become stale
- **Cache busting**: `BUILD_ID` in cache key ensures new deploys never serve stale HTML

### SEO

- JSON-LD schemas (Product, BreadcrumbList)
- Open Graph + Twitter Card meta tags
- Canonical URLs, robots.txt, XML sitemaps
- Cloudflare Image Resizing for responsive images

---

## API Worker (`apps/api/`)

Standalone **Hono** app with auto-generated OpenAPI spec and interactive Swagger UI.

### Endpoints (~160)

| Namespace | Auth | Endpoints | Purpose |
|-----------|------|-----------|---------|
| `/api/v1/admin/**` | Session/JWT + RBAC | ~110 | Admin CRUD operations |
| `/api/v1/products`, `/categories`, etc. | None | ~30 | Public storefront data |
| `/api/v1/orders/**` | JWT | 3 | Customer order management |
| `/api/v1/payment/**` | None | 3 | Payment session creation |
| `/api/v1/webhooks/**` | Signature | 5 | Gateway callbacks |
| `/api/v1/health`, `/docs` | None | 4 | System endpoints |

### Queue Processing

| Queue | Messages | Batch Size |
|-------|----------|------------|
| `payment-events` | `payment.stripe.*`, `payment.sslcommerz.*`, `payment.polar.*` | 10 |
| `order-notifications` | `order.notification` (9 types) | 20 |
| `auth-otp` | `auth.send_otp` (email, SMS, WhatsApp) | 10 |
| `order-ingest` | `order.ingest` (batch creation) | 100 |

### Response Contract

All success responses: `{ "success": true, "data": T }`
All error responses: `{ "success": false, "error": { "code": "...", "message": "..." } }`

---

## Database (`packages/database/`)

**52 tables** across 13 schema files, powered by Drizzle ORM on Cloudflare D1 (SQLite).

| Domain | Tables | Key Tables |
|--------|--------|------------|
| Auth | 5 | user, session, account, verification, twoFactor |
| RBAC | 5 | permissions, roles, rolePermissions, userRoles, userPermissions |
| Products | 10 | products, productVariants, productImages, categories, collections, productAttributes, media, mediaFolders |
| Orders | 7 | orders, orderItems, orderPayments, paymentPlans, codTracking, webhookEvents, abandonedCheckouts |
| Customers | 2 | customers, customerHistory |
| Inventory | 2 | inventoryMovements, productLowStockAlerts |
| Delivery | 3 | deliveryLocations, deliveryProviders, deliveryShipments |
| Marketing | 6 | discounts, discountProducts, discountCollections, discountUsage, metaConversionsSettings, metaConversionsLogs |
| Content | 6 | pages, widgets, widgetHistory, heroSections, heroSliders, pageTemplates |
| System | 6 | settings, siteSettings, analytics, adminFcmTokens, shippingMethods, checkoutLanguages |

**34 migrations** applied. FTS5 full-text search with Bengali tokenizer (migration 0031).

---

## Scripts

```bash
# Development
pnpm dev                # Start API :8787 + admin-v2 :4323 + storefront :4322
pnpm dev:all            # Alias for pnpm dev
pnpm dev:admin          # Start API :8787 + admin-v2 :4323
pnpm dev:storefront     # Start storefront :4322 + API :8787

# Build & Deploy
pnpm build              # Build all workspaces via Turbo
pnpm deploy             # Typecheck → build → migrate → deploy all workers
pnpm deploy:api         # Typecheck → build API → migrate remote D1 → deploy API
pnpm deploy:admin       # Typecheck → build admin-v2 → deploy admin-v2
pnpm deploy:storefront  # Typecheck → build storefront → deploy storefront

# Database
pnpm db:generate        # Generate Drizzle migrations from schema changes
pnpm db:migrate:local   # Apply pending migrations locally
pnpm db:studio          # Open Drizzle Studio DB browser

# Testing & Quality
pnpm lint               # ESLint all seven code workspaces through Turbo
pnpm test               # Run all tests via Vitest
pnpm typecheck          # TypeScript type checking (tsc, NOT esbuild)
pnpm generate:sdk       # Regenerate API client from OpenAPI spec

# Setup & Maintenance
pnpm dev:setup          # Install deps, create env, migrate, create local admin
pnpm dev:reset          # Wipe local state, migrate, recreate local admin
pnpm dev:admin:create   # Create local admin if none exists
pnpm dev:admin:reset    # Reset local auth/admin credentials only
pnpm dev:admin:status   # Check whether a local admin exists
```

---

## Local Development

### 1) First-time setup

```bash
pnpm dev:setup
```

Generates secrets, creates `.dev.vars` files, applies D1 migrations, starts a temporary API worker, and creates a default local admin if none exists. If some local env files already exist, setup reuses the existing shared secrets for any missing files and fails loudly if API/admin/storefront secrets disagree.

Default local admin:

```text
Email:    admin@local.scalius.test
Password: ScaliusLocal123!
```

Override the local admin with flags or environment variables:

```bash
pnpm dev:setup --admin-email owner@example.test --admin-password 'Use-12+-chars' --admin-name 'Owner'

LOCAL_ADMIN_EMAIL=owner@example.test \
LOCAL_ADMIN_PASSWORD='Use-12+-chars' \
LOCAL_ADMIN_NAME='Owner' \
pnpm dev:setup
```

### 2) Start development servers

```bash
pnpm dev              # API + admin-v2 + storefront
pnpm dev:admin        # API + admin-v2 only
pnpm dev:storefront   # API + storefront only
```

The dev wrapper (`scripts/dev.sh`) applies pending local D1 migrations before starting API, kills stale processes on the Scalius dev ports, staggers startup to prevent Vite inspector port conflicts, and cleans up on Ctrl+C. Set `SCALIUS_SKIP_DEV_MIGRATIONS=1` when you intentionally want to skip the migration check. It no longer kills every `workerd` process by default; set `SCALIUS_DEV_KILL_ALL_WORKERD=1` only if you need the older aggressive cleanup.

API local dev uses `apps/api/wrangler.local.jsonc`, which intentionally omits the remote Workers AI binding. Normal local admin/storefront/API work should not require Cloudflare remote proxy access. Production build/deploy still use `apps/api/wrangler.jsonc`.

Admin production calls the API through the `env.API` service binding. Local admin dev uses HTTP fallback to `PUBLIC_API_BASE_URL` when that URL points at localhost, even though Wrangler still exposes the production binding shape.

For disposable local testing, point all Workers at another state directory:

```bash
pnpm dev:reset --state /tmp/scalius-commerce-state
SCALIUS_WRANGLER_STATE=/tmp/scalius-commerce-state pnpm dev:admin
```

Relative `--state` paths resolve from the repo root; absolute paths are easiest to reason about across Wrangler commands.

### 3) Sign in

Visit `http://localhost:4323/admin` and sign in with the local admin credentials from setup. If you ran setup with `--skip-admin`, the browser still supports the first-admin setup flow at `/auth/setup`.

### 4) Reset local credentials or state

Reset only local admin credentials and sessions:

```bash
pnpm dev:admin:reset
```

Reset everything local, including D1/KV/R2/Cache state, then recreate the default admin:

```bash
pnpm dev:reset
```

Both commands accept the same admin override flags:

```bash
pnpm dev:reset --admin-email owner@example.test --admin-password 'Use-12+-chars'
```

### 5) Local URLs

| URL | Service |
|-----|---------|
| `http://localhost:4323/admin` | Admin Dashboard (TanStack Start) |
| `http://localhost:4322` | Storefront |
| `http://localhost:8787/api/v1/docs` | Swagger UI (interactive API docs) |
| `http://localhost:8787/api/v1/openapi.json` | OpenAPI 3.0 spec |
| `http://localhost:8787/api/v1/health` | Health check |

---

## Environment Variables

`pnpm dev:setup` generates everything automatically. Each worker has:

- **`wrangler.jsonc`** — Cloudflare bindings and non-secret vars
- **`.dev.vars`** — Runtime secrets (gitignored)

### Required Secrets

| Variable | Shared By | Purpose |
|----------|-----------|---------|
| `BETTER_AUTH_SECRET` | API + Admin-v2 | Session signing |
| `JWT_SECRET` | API + Admin-v2 + Storefront | JWT signing |
| `API_TOKEN` | All workers | Internal machine-to-machine auth |
| `PURGE_TOKEN` | API + Storefront | Cache purge authentication |
| `CREDENTIAL_ENCRYPTION_KEY` | API + Admin-v2 | Provider credential encryption |

### Dashboard-Configured Integrations

| Integration | Settings Location |
|-------------|-------------------|
| Email (Resend) | Settings → Email |
| Firebase (FCM) | Settings → Notifications |
| Stripe / SSLCommerz / Polar | Settings → Checkout → Payment Gateways |
| Pathao / Steadfast | Settings → Delivery Providers |
| SMS Providers | Settings → Checkout → SMS |
| OpenRouter (AI) | Widget editor settings |

---

## Deployment

```bash
pnpm deploy
```

Pipeline: `typecheck → build → migrate (remote D1) → deploy all workers`

Targeted deploy shortcuts use the same safety wrapper: `pnpm deploy:api`
typechecks, builds the API, applies remote D1 migrations, then deploys the API
Worker; admin and storefront shortcuts typecheck before their focused build and
deploy.

### Production Domains

| Domain | Worker | Purpose |
|--------|--------|---------|
| `dashboard.scalius.com` | scalius-admin-v2 | Admin Dashboard |
| `api.scalius.com` | scalius-api | REST API |
| `storefront.scalius.com` | scalius-storefront | Customer Store |
| `cloud.scalius.com` | R2 Bucket | Media CDN + Image Resizing |

### Cloudflare Bindings (All Workers)

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | Shared SQLite database (52 tables) |
| `CACHE` | KV | General caching |
| `SESSION` | KV | Better Auth sessions |
| `SHARED_AUTH_CACHE` | KV | Cross-worker auth token cache |
| `BUCKET` | R2 | Media file storage |
| `API` / `BACKEND_API` | Service Binding | Admin/Storefront → API |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port conflicts on startup | `lsof -tiTCP:8787 -iTCP:4322 -iTCP:4323 -iTCP:9229 -iTCP:9230 -iTCP:9231 -iTCP:9232 -iTCP:9233 -sTCP:LISTEN \| xargs kill -9` |
| Forgot local admin credentials | Run `pnpm dev:admin:reset` |
| Auth sign-in loops | Run `pnpm dev:admin:reset`, or `pnpm dev:setup --force` to regenerate env files |
| D1 errors in dev | Run `pnpm dev:reset` for a clean database |
| "Using default JWT secret" | Set `JWT_SECRET` in `.dev.vars` |
| Stale OpenAPI types | Run `pnpm generate:sdk` with API running |

---

## License

[AGPL v3](LICENSE)
