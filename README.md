<p align="center">
  <a href="https://scalius.com">
    <img alt="Scalius Commerce Lite" src="apps/admin-v2/public/logo-dark.png" width="200" />
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
  Self-hosted e-commerce platform — admin dashboard, storefront, and API — deployed as two Cloudflare Workers. Turborepo monorepo with TanStack Router, Astro, Hono, and portable D1, TursoDB, or PostgreSQL storage.
</p>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL%20v3-blue.svg" alt="Scalius Commerce Lite is released under the AGPL v3 license." />
  </a>
  <a href="https://github.com/scaliuslabs/scalius-commerce-lite/issues">
    <img src="https://img.shields.io/badge/Issues-welcome-brightgreen.svg?style=flat" alt="Issues welcome!" />
  </a>
  <a href="SECURITY.md">
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

---

## Repository layout

```text
apps/
  admin-v2/     @scalius/admin-v2    Dashboard SPA, served by the API Worker (dev :4323)
  api/          @scalius/api         Hono API + queue consumer (Worker, dev :8787)
  storefront/   @scalius/storefront  Astro SSR store           (Worker, dev :4322)
packages/
  api-client/   Generated SDK from the API's OpenAPI spec
  cli/          `scalius` CLI — operates a deployed store over its OpenAPI contract
  core/         Domain services, auth/RBAC, provider integrations
  database/     Drizzle schema, migrations, provider adapters
  shared/       Pure utilities (runtime secrets, platform config, formatting)
  tsconfig/     Shared TypeScript configs
docs/           Architecture, database portability, performance, delivery providers
scripts/        Dev setup, dev server wrapper, deploy pipeline, checks
```

| Layer | Technology |
|-------|------------|
| Monorepo | Turborepo + pnpm workspaces |
| Dashboard | Static SPA: TanStack Router / Query, React 19, Vite 8 |
| Storefront | Astro 7 SSR + React 19 islands |
| API | Hono + `@hono/zod-openapi` (generated OpenAPI + Swagger UI) |
| Database | Drizzle ORM on Cloudflare D1 (default), TursoDB, or PostgreSQL/Neon |
| UI | Tailwind CSS v4 + shadcn/ui + Radix |
| Auth | Better Auth (email/password, optional TOTP + email OTP 2FA) |
| Storage | R2 for media and pre-generated WebP renditions |
| Async | Cloudflare Queues (payments, notifications, OTP + DLQs), 15-minute cron |
| Payments | Stripe, SSLCommerz, Cash on Delivery |
| Delivery | Pathao, Steadfast (webhook tracking) |
| Notifications | Email (Cloudflare Email, Resend fallback), SMS (4 providers), WhatsApp, FCM push |
| Deploy | Wrangler |

## Architecture

```mermaid
flowchart TB
    Buyer["Buyer browser"] --> SF["Storefront Worker<br/>Astro 7 SSR · :4322<br/>secret: SCALIUS_SECRET"]
    Merchant["Merchant browser"] -->|"dashboard host:<br/>SPA shell · /api/auth · /api/v1"| API

    SF -->|"Service binding env.BACKEND_API<br/>https://api.internal"| API

    API["API Worker — Hono · :8787<br/>+ dashboard SPA (ASSETS, Vite dev :4323)<br/>secrets: SCALIUS_SECRET<br/>+ CREDENTIAL_ENCRYPTION_KEY"]

    API -->|"GET /api/v1/platform"| PLAT["Platform settings<br/>storefront · API · dashboard · media URLs<br/>edited in Settings → System → Platform"]
    PLAT -. "origins read per request" .-> SF

    API --> DB[("DB (D1) — or TursoDB / PostgreSQL")]
    API --> KV[("KV — CACHE")]
    API --> R2[("R2 — BUCKET<br/>media + private agent artifacts")]
    API --> Q["Queue — jobs + jobs-dlq"]
    Q -->|"queue consumer"| API
    CRON["Cron — every 15 min"] --> API

    API -.->|"webhooks"| EXT["Stripe · SSLCommerz<br/>Pathao · Steadfast"]
    API -.->|"notifications"| NOTIF["Email · SMS · WhatsApp · FCM"]
```

The dashboard is a static single-page app (`apps/admin-v2/dist`) that the API
Worker serves from its `ASSETS` binding on the dashboard hostname, together with
Better Auth (`/api/auth/*`) and the API itself; in local development Vite serves
it on :4323 and proxies those paths to `http://localhost:8787`. Every per-purpose
secret is HKDF derived from `SCALIUS_SECRET` at Worker entry. The storefront
holds no database, provider, or URL configuration of its own: it calls the API
through a Cloudflare Service Binding in production (over HTTP to
`http://localhost:8787` in local development) and reads the deployment's public
origins from the `platform` block of the layout payload it already loads.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries, the
order lifecycle, and invariants.

## Features

**Catalog** — products with merchant-defined variant axes, SKUs, barcodes, images, attributes; categories; manual and dynamic collections; inventory with compare-and-swap stock versioning, reservations, and low-stock alerts; provider-aware search (FTS5 with a Bengali tokenizer on D1, bounded indexed fallback elsewhere).

**Sales** — 11-status order state machine with validated transitions; Stripe, SSLCommerz, and Cash on Delivery; atomic payment commits with four idempotency layers; refunds and returns; discounts and promotions; abandoned checkout tracking; customer accounts with OTP sign-in and order history.

**Content** — header/footer and navigation builders, CMS pages and blog articles with a Tiptap editor, hero sliders, theme tokens.

**Operations** — Pathao and Steadfast shipments plus manual fulfillment; flat-rate, weight-based, and zone-based shipping; taxes; invoice PDFs; a manual per-order fraud checker; cache management; a QR scanner app.

**Notifications** — 15 order and refund notification types over four independently configured channels (email, SMS, WhatsApp, FCM push), delivered through a queue with a durable outbox and per-channel receipts.

**Security** — Better Auth with optional 2FA, RBAC (81 permissions in 13 categories), per-endpoint rate limiting, AES-256-GCM encryption of merchant provider credentials, per-provider webhook signature verification.

**Discovery** — canonical URLs, robots, sitemap index and children, JSON-LD, Google and Meta product feeds, `/llms.txt`, and read-only UCP catalog discovery at `/.well-known/ucp`.

## Local development

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js 24 | Version pinned in `.nvmrc`; run `nvm use` |
| pnpm 11.20 | Pinned in `package.json` `packageManager`; `corepack enable` |
| Cloudflare account | Only needed to deploy, not for local development |
| Mailpit (optional) | Local inbox for dev email/OTP — `brew install mailpit` |

### Setup

```bash
nvm use
pnpm install
pnpm dev:setup
pnpm dev
```

`pnpm dev:setup` generates the two secrets into the API and storefront `.dev.vars`
(gitignored), applies local D1 migrations, and creates a default local admin
through `/api/v1/setup`. It writes no URLs — local development falls back to
fixed localhost ports in code.

Default local admin: `admin@local.scalius.test` / `ScaliusLocal123!`. Override
with `--admin-email`, `--admin-password`, `--admin-name`, or the matching
`LOCAL_ADMIN_*` environment variables.

`pnpm dev` starts or reuses a loopback Mailpit inbox, applies pending local D1
migrations, refuses to start when an app port is already taken, waits for
`/api/v1/setup` before starting the dashboard and storefront, and cleans up only
the processes it started. Set `SCALIUS_SKIP_DEV_MIGRATIONS=1` to skip the
migration check.

| URL | Service |
|-----|---------|
| `http://localhost:4323/admin` | Admin dashboard |
| `http://localhost:4322` | Storefront |
| `http://localhost:8787/api/v1/docs` | Swagger UI |
| `http://localhost:8787/api/v1/openapi.json` | OpenAPI spec |
| `http://localhost:8787/api/v1/health` | Health check |
| `http://127.0.0.1:8025` | Mailpit inbox |

Run `pnpm dev:doctor` at any time for a non-mutating report on Node version,
local secrets, database state, and ports. After starting servers, use the
profile that matches what you started: `dev:doctor:api`, `dev:doctor:admin`,
`dev:doctor:storefront`, or `dev:doctor:all`.

To run against a disposable state directory:

```bash
pnpm dev:reset --state /tmp/scalius-state
SCALIUS_WRANGLER_STATE=/tmp/scalius-state pnpm dev:admin
```

## Commands

```bash
# Development
pnpm dev                  # API :8787 + dashboard :4323 + storefront :4322
pnpm dev:api              # API only
pnpm dev:admin            # API + dashboard
pnpm dev:storefront       # API + storefront
pnpm dev:doctor[:api|:admin|:storefront|:all]

# Local state
pnpm dev:setup            # Install, write .dev.vars, migrate D1, create admin
pnpm dev:setup --env-only # Repair missing .dev.vars keys only
pnpm dev:reset            # Wipe local D1/KV/R2/cache state and recreate the admin
pnpm dev:admin:create | dev:admin:reset | dev:admin:status

# Database
pnpm db:generate          # Generate Drizzle migrations from schema changes
pnpm db:migrate:local     # Apply pending migrations locally
pnpm db:migrate:remote    # Apply pending migrations to remote D1
pnpm db:studio            # Drizzle Studio

# Quality
pnpm lint                 # ESLint across the eight code workspaces
pnpm typecheck            # tsc (not esbuild)
pnpm test                 # Vitest
pnpm check:env            # Fail on any Wrangler `vars` entry
pnpm generate:sdk         # Regenerate @scalius/api-client from the OpenAPI spec

# Automated deployments (opt-in, see docs/AUTOMATED-DEPLOYMENTS.md)
pnpm secret:derive --purpose admin-setup --stdin   # Derive one automation key
pnpm auth:handoff-token --help                     # Mint a dashboard handoff token

# Build & deploy
pnpm build
pnpm run deploy                        # API (with the dashboard SPA) + storefront
pnpm run deploy:api | :storefront
pnpm ops:check                         # Read-only production API smoke
pnpm release:check                     # Read-only release smoke across all surfaces
```

Root Turbo commands run through `scripts/turbo-run.mjs`, which resolves the
active Corepack/pnpm executable first so they work in shells where `pnpm` is not
on `PATH`.

## Configuration

Runtime configuration is deliberately small: **two installed secrets, zero
Wrangler `vars`, everything else in the dashboard.**

### Installed secrets

| Secret | Workers | Purpose | Generate with |
|--------|---------|---------|---------------|
| `SCALIUS_SECRET` | API, storefront | Master secret; identical on both, at least 32 characters | `openssl rand -base64 48` |
| `CREDENTIAL_ENCRYPTION_KEY` | API | AES-256-GCM key for merchant provider credentials at rest; base64 of exactly 32 bytes | `openssl rand -base64 32` |

Every per-purpose secret — Better Auth session signing, JWT signing, the
internal service token, the agent token pepper, the
customer session hash key, and the three opt-in automation keys (first-admin
setup token, front-proxy signing key, identity-handoff signing key) — is
HKDF-SHA256 derived from `SCALIUS_SECRET` at Worker entry
(`packages/shared/src/runtime-secrets.ts`). Derived values are never installed,
stored, or logged.

Without `SCALIUS_SECRET` the API fails closed: every request except
`/api/v1/health` and `/api/v1/readyz` returns `503 RUNTIME_SECRET_MISSING`.

**Rotation.** Rotating `SCALIUS_SECRET` rotates every derived secret at once:
admins are signed out, service tokens stop verifying, and agent
credentials must be reissued. Encrypted provider credentials survive, because
they use `CREDENTIAL_ENCRYPTION_KEY`. Rotating `CREDENTIAL_ENCRYPTION_KEY` makes
stored provider credentials undecryptable — every payment, delivery, SMS, and
email credential must be re-entered in the dashboard.

### Platform settings (Settings → System → Platform)

Public origins are database-backed merchant settings, not environment variables.

| Setting | Required | Purpose |
|---------|----------|---------|
| Storefront URL | yes | Canonical storefront origin (canonical links, sitemaps, feeds) |
| API URL | yes | Public API origin browsers call |
| Dashboard URL | yes | Dashboard origin, optionally with a path prefix such as `/dashboard` (Better Auth base URL) |
| Media URL | yes | Public media base URL (R2 custom domain) |
| Customer cookie domain | no | `Domain` attribute for customer session cookies across subdomains |
| Extra CORS origins | no | Additional origins allowed to make credentialed API requests |
| Require a setup token | no | Gates `POST /api/v1/setup` behind a derived token |
| Identity handoff | no | Issuer, audience, and JWKS URL for external operator sign-in |
| Disable password sign-in | no | Dashboard accepts only identity handoff (requires it to be enabled) |

The last three belong to the opt-in automation contracts in
[docs/AUTOMATED-DEPLOYMENTS.md](docs/AUTOMATED-DEPLOYMENTS.md); leave them off
for a hand-installed store.

The API serves the four origins publicly at `GET /api/v1/platform`
(`Cache-Control: public, max-age=60`), and the storefront receives the same
origins inside
`GET /api/v1/storefront/layout`. `GET /api/v1/readyz` reports a required
`platform_config` check listing any missing origin.

Names such as `env.STOREFRONT_URL`, `env.PUBLIC_API_BASE_URL`,
`env.BETTER_AUTH_URL`, `env.R2_PUBLIC_URL`, `env.CDN_DOMAIN_URL`, and
`env.CORS_ALLOWED_ORIGINS` still appear in code. They are
composed from these settings at Worker entry
(`apps/api/src/runtime/runtime-env.ts`) and are never configured in Wrangler or
`.dev.vars`.

### Everything else in the dashboard

| Integration | Location |
|-------------|----------|
| Email (Cloudflare Email / Resend) | Settings → Email |
| Stripe / SSLCommerz | Settings → Checkout → Payment gateways |
| Pathao / Steadfast | Settings → Delivery providers |
| SMS, WhatsApp, Firebase (FCM) | Settings → Notifications |
| Analytics and tracking scripts | Analytics |

### Database provider

D1 is the zero-configuration default and is already bound in the Wrangler
configs. TursoDB deployments install `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
as secrets on the API; PostgreSQL deployments install
`POSTGRES_DATABASE_URL` or bind `HYPERDRIVE`. Complete credentials select the
provider on their own; `DATABASE_PROVIDER` (`d1` | `turso` | `postgres`) is an
optional explicit pin, required only when both Turso and PostgreSQL credentials
are installed. `DATABASE_MIGRATION_FREEZE` is an operations-only cutover switch.
None of these appear in the checked-in configs — installing one is a deliberate
operator action.

Switching providers is not a credential swap. See
[docs/DATABASE-PORTABILITY.md](docs/DATABASE-PORTABILITY.md) for the freeze,
snapshot, import, and fingerprint protocol.

## Deployment

### 1. Create the Cloudflare resources

The two `wrangler.jsonc` files (API, storefront) are the source of truth. Create each resource
in your own account and replace the checked-in names and IDs:

| Resource | Where | Binding |
|----------|-------|---------|
| D1 database | API | `DB` |
| KV namespace | API, storefront (one namespace; OAuth keys use the `oauth:` prefix) | `CACHE` |
| R2 bucket | API (media under `media/`, sealed agent artifacts under `private/agent-artifacts/`) | `BUCKET` |
| Queues | `jobs` and its DLQ `jobs-dlq` | producer `JOBS_QUEUE` + both consumers on the API |
| Rate limiters | API: strict 5/60 s, standard 60/60 s (keys are store-scoped) | `RL_STRICT`, `RL_STANDARD` |
| Email routing | API | `send_email` binding `EMAIL` |
| Service binding | Storefront → API | `BACKEND_API` |
| Static assets | API (the built dashboard SPA, `apps/admin-v2/dist`) | `ASSETS` |

The API Wrangler config keeps a `deleted_classes` migration for the retired
`CheckoutCoordinator` Durable Object; there is no Durable Object binding.
Both Workers set `workers_dev: false`, so each needs a custom domain. The
storefront's is declared in `apps/storefront/wrangler.jsonc` (`routes`); point
both the API and the dashboard custom domains at the API Worker (`scalius-api`)
in the Cloudflare dashboard, and
attach a public custom domain to the media R2 bucket. Add a WAF custom rule on
that media hostname that blocks paths starting with `/private/` (agent
artifacts are also AES-GCM sealed at rest, so this is defence in depth), and an
R2 lifecycle rule that deletes `private/agent-artifacts/` objects after one day
as a backstop for the cron cleanup.

`pnpm check:env` fails on any Wrangler `vars` entry — keep the configs to
bindings only.

### 2. Install the secrets

Wrangler prompts for each value; it is never written to a file or committed.

```bash
pnpm --dir apps/api        exec wrangler secret put SCALIUS_SECRET
pnpm --dir apps/api        exec wrangler secret put CREDENTIAL_ENCRYPTION_KEY
pnpm --dir apps/storefront exec wrangler secret put SCALIUS_SECRET
```

### 3. Deploy

```bash
pnpm run deploy -- --api-url https://api.example.com --storefront-url https://shop.example.com
```

The pipeline runs `typecheck → build → D1 migrations → deploy each Worker →
post-deploy verification`. The API build builds the dashboard SPA first, because
it is the API Worker's static assets. Targeted deploys (`deploy:api`,
`deploy:storefront`) use the same wrapper.

Because the Wrangler configs carry no `vars`, the script has no built-in
knowledge of your public origins:

| Origin | Resolution order |
|--------|------------------|
| API | `--api-url` or `SCALIUS_API_URL` only |
| Storefront | `--storefront-url` or `SCALIUS_STOREFRONT_URL`, else the `custom_domain` route pattern in `apps/storefront/wrangler.jsonc`, else the Platform `storefrontUrl` read from the API |

If the API origin is unknown the deploy still succeeds; live `/health` and
`/readyz` verification and API-driven storefront cache warming are skipped with
a notice. If the deploy target and the Platform `storefrontUrl` disagree, the
script warns, because canonical and sitemap URLs come from the setting.

### 4. Complete Platform settings

Sign in to the dashboard (first run offers the first-admin setup flow at
`/auth/setup`), then fill **Settings → System → Platform** with the storefront,
API, dashboard, and media URLs.

This step is not optional. Until it is done, `/api/v1/readyz` reports
`platform_config: missing` and the storefront's credentialed browser features —
cart, customer sign-in — fail, because CORS allowlists and cookie domains are
derived from those origins.

### 5. Verify

```bash
curl https://api.example.com/api/v1/readyz
curl https://api.example.com/api/v1/meta
pnpm ops:check
pnpm release:check
```

`GET /api/v1/meta` reports the release, the supported API majors, the database
provider, and whether the applied schema revision matches this build.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Port already in use on `pnpm dev` | The wrapper prints the occupied port, PID, and command; stop that process and rerun |
| Forgot the local admin password | `pnpm dev:admin:reset` |
| Local sign-in loops | `pnpm dev:admin:reset`, then `pnpm dev:setup --env-only` for missing keys, or `--force --env-only` when the shared local secrets are out of sync |
| Local D1 errors | `pnpm dev:reset` |
| `503 RUNTIME_SECRET_MISSING` | `SCALIUS_SECRET` is missing or shorter than 32 characters — `wrangler secret put SCALIUS_SECRET`, or `pnpm dev:setup --env-only` locally |
| `/api/v1/readyz` reports `platform_config: missing` | Fill the listed origins in Settings → System → Platform |
| Storefront cart or sign-in fails with CORS/cookie errors | The Platform origins are wrong or unset |
| Provider credentials fail to decrypt | `CREDENTIAL_ENCRYPTION_KEY` differs between the API and dashboard, or was rotated — re-enter the credentials in the dashboard |
| `pnpm check:env` fails on Wrangler vars | Delete the `vars` block; URLs belong in Platform settings, secrets in `wrangler secret put` |
| Stale SDK types | `pnpm generate:sdk` with the API running |

## Contributing, security, license

- [CONTRIBUTING.md](CONTRIBUTING.md) — issue forms and contribution policy
- [SECURITY.md](SECURITY.md) — vulnerability reporting
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

Except for the separately MIT-licensed storefront in `apps/storefront/`, this
repository is licensed under [AGPL v3](LICENSE).
