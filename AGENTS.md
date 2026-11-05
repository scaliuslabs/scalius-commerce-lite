# AGENTS.md

This file provides guidance to Codex (claude.ai/code) when working with code in this repository.

## Environment

- Node.js >= 24.21.0 (pinned in `.nvmrc`; run `nvm use`).
- pnpm 11.20 (pinned in root `package.json` `packageManager`; run `corepack enable`).
- Run every command from the repository root.
- Mailpit is the local inbox for email and OTP (`brew install mailpit`); `pnpm dev` starts it and fails when it is missing.

## Commands (run from repo root)

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start the full local stack (API :8787, storefront :4322, dashboard :4323, Mailpit :8025) |
| `pnpm dev:api` | API Worker only (:8787) |
| `pnpm dev:admin` | API + dashboard (:8787 + :4323) |
| `pnpm dev:storefront` | API + storefront (:8787 + :4322) |
| `pnpm dev:setup [--env-only] [--force]` | Create/repair local secrets, apply local D1 migrations, create the local admin |
| `pnpm dev:reset [--state <dir>]` | Delete local D1/R2 state, migrate, recreate the admin |
| `pnpm build` | Build every workspace (turbo-cached; dashboard builds first, it is the API's static assets) |
| `pnpm deploy` / `deploy:api` / `deploy:storefront` | Deploy the API Worker (with dashboard) and/or the storefront Worker |
| `pnpm test` / `pnpm test:ci` | Full vitest suite in two passes (parallel "pure" + serial "app") |
| `pnpm test:affected [--base ] [--list]` | Only the tests a change can break (vitest `--changed` + path rules for migrations, DVC, plugin ABI, generated contracts) |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm lint` | `lint:oxlint` (`.oxlintrc.json`, whole repo) then `lint:eslint` (`.astro` + dashboard design rules for admin-v2 and storefront) |
| `pnpm typecheck` | TypeScript 7 `tsc --build` over every project, then `astro check` for the storefront |
| `pnpm db:generate` | Generate Drizzle migrations after a schema change |
| `pnpm db:migrate:local` / `db:migrate:remote` | Apply pending migrations to local or remote D1 |
| `pnpm generate:sdk` | Regenerate the agent operation manifest and `@scalius/api-client`; commit the output |
| `pnpm repo:check` | Repository hygiene and whitespace |
| `pnpm check:env` | Fail on Wrangler `vars`, bindings outside the allowed set, and missing `CF_VERSION_METADATA` |

**Run a single test:** `pnpm vitest run <path>` from the root (e.g. `pnpm vitest run packages/shared/src/foo.test.ts`). Reduce workers with `SCALIUS_TEST_WORKERS=2`; a `--maxWorkers` CLI flag wins over both.

**Local admin:** default `admin@local.scalius.test` / `ScaliusLocal123!` (overridable via `--admin-email/--admin-password/--admin-name` or `LOCAL_ADMIN_*` env). `pnpm dev:admin:create`, `dev:admin:reset`, `dev:admin:status` manage it.

**Local URLs:** dashboard `http://localhost:4323/admin`, storefront `http://localhost:4322`, OpenAPI contract `http://localhost:8787/api/v1/openapi.json` (health at `/api/v1/health`), Mailpit `http://127.0.0.1:8025`.

## Architecture & structure

Turborepo monorepo (pnpm workspaces: `apps/*`, `packages/*`, `plugins/*`).

**Two Cloudflare Workers:**

- **API** (`apps/api`, `@scalius/api`, Hono + Better Auth, port 8787): entry `apps/api/src/worker.ts`. Serves `/api/v1/*`, Better Auth at `/api/auth/*`, and the built dashboard SPA (`apps/admin-v2/dist`) through its `ASSETS` binding. Wrangler config: `apps/api/wrangler.jsonc` (prod), `apps/api/wrangler.local.jsonc` (dev).
- **Storefront** (`apps/storefront`, `@scalius/storefront`, Astro 7 SSR, port 4322): entry `apps/storefront/src/worker.ts`. Reads everything through the `BACKEND_API` service binding to the API Worker; has no database, provider, or URL configuration of its own. Each page renders from one `GET /api/v1/storefront/batch` call.
- **Dashboard** (`apps/admin-v2`, `@scalius/admin-v2`, React 19 SPA via Vite + TanStack Router, port 4323): entry `apps/admin-v2/src/main.tsx`. No Worker, no Wrangler config, no secrets/bindings. Served by the API Worker's `ASSETS` binding.

**Dependency direction flows downward only:**

| Layer | May import | Never imports |
|-------|-----------|---------------|
| Dashboard (`apps/admin-v2/src`) | `@scalius/shared`, `@scalius/api-client`, `@scalius/core/modules/<domain>/browser`, `@scalius/core/auth/rbac/*` | A domain `index`, any other core path, database provider clients |
| API routes (`apps/api/src/routes/`) | `@scalius/core` through its exports map, `@scalius/database`, `@scalius/shared` | A path outside the exports map |
| Core domains (`packages/core/src/modules/<domain>/`) | Own files, other domains' entries, core shared areas, `@scalius/database`, `@scalius/shared` | Routes, apps, a file inside another domain, a domain that imports them back |
| Schema (`@scalius/database/schema`) | `drizzle-orm` | Services or routes |
| Shared (`@scalius/shared`) | No workspace package | |
| Storefront (`apps/storefront`) | `@scalius/shared`, `@scalius/api-client` | `@scalius/core`, `@scalius/database` |

**Core domains** (`packages/core/src/modules/`): 45 domains in an acyclic 10-layer graph. Each domain has at most two public entries — `index.ts` (server API) and `browser.ts` (pure types/policies, closed over `zod`/`@scalius/shared`/other browser files). Reach a domain only through its entries: `../<domain>` or `../<domain>/browser` inside core, `@scalius/core/modules/<domain>` (and `/browser`) outside it. Enforced by the `package.json` exports map, `scripts/check-source-policies.mjs`, `scripts/core-boundaries.mjs`, and the `core-domain-graph.allow.json` allowlist (169 edges; `node scripts/core-boundaries.mjs --write-allowlist` regenerates).

**Provider ports** (`@scalius/shared/plugins/providers`): 14 kinds (`payment`, `courier`, `sms`, `email`, `courier_history`, `tax`, `translation`, `ai`, `messaging`, `push`, `search`, `address`, `fx`, `identity`). Built-in adapters and app providers implement the same port; core resolves a provider by id.

**Runtime configuration boundary:** Wrangler configs declare resource bindings only and carry no `vars` (except `LOCAL_MAILPIT_URL` locally). Public origins are the database-backed `platform` settings document, edited in the dashboard (Settings > Store details > Web addresses), never Wrangler vars. Installed secrets: `SCALIUS_SECRET` (both Workers, ≥32 chars) and `CREDENTIAL_ENCRYPTION_KEY` (API Worker, base64 of 32 bytes). Every per-purpose secret is HKDF-derived from `SCALIUS_SECRET` at Worker entry (`packages/shared/src/runtime-secrets.ts`).

**Packages:** `api-client` (generated SDK from the API OpenAPI spec), `cli` (`scalius` CLI), `core` (domain services, auth, provider integrations), `database` (Drizzle schema, migrations, D1/Turso/PostgreSQL adapters), `plugin-sdk` (plugin authoring kit), `shared` (pure utilities), `tsconfig` (shared TypeScript configs). Bundled plugins live in `plugins/` (`bangladesh`, `noor`); `scalius.plugins.json` locks the compiled plugin set (`pnpm plugin`).

## Key scripts & generated files

- `scripts/test-runner.mjs` — `pnpm test` / `test:ci`; runs two vitest passes (parallel `pure`, then serial `app` with `--maxWorkers=1`).
- `scripts/test-affected.mjs` — `pnpm test:affected`; union of vitest `--changed` module-graph selection and `PATH_RULES` (migration SQL, DVC cache-deps/triggers, plugin manifest/ABI, generated contracts).
- `scripts/typecheck.mjs` — TypeScript 7 `tsc --build` over all TS projects, then `astro check` for the storefront.
- `scripts/regen-after-merge.mjs` — rebuilds generated files after a merge/rebase/cherry-pick; `.gitattributes` applies the `scalius-generated` merge driver (keeps "our side", exits 0). Run `node scripts/regen-after-merge.mjs --install` once per clone; after a merge/rebase run it and commit rebuilt files.
- `scripts/dev-ports.mjs` — single source of dev ports (`SCALIUS_DEV_API_PORT/STOREFRONT_PORT/ADMIN_PORT`, defaults 8787/4322/4323).
- `turbo.json` — all tasks (`build`, `dev`, `typecheck`, `lint`, `test`, `generate`, `db:*`) depend on `^build`; `build` outputs `dist/**` + `.astro/**`.

## Testing

Root `vitest.config.ts`: two projects — `pure` (`packages/shared/**`, `packages/plugin-sdk/**`; `isolate: false`) and `app` (everything else; serial files only in the serial pass). `SERIAL_TESTS` are three Turso/D1 export tests that build full migrated DBs and run for minutes. `testTimeout`/`hookTimeout` are 30s. The `@/` alias resolves per-importer to `apps/admin-v2/src/` or `apps/storefront/src/`; `.txt` imports return their text; `cloudflare:workers` is stubbed. Setup file: `scripts/vitest-setup.mjs`. Excludes `.Codex/**` and `audit/**`.

Apps have no separate test scripts: admin-v2 has no vitest config; storefront has `apps/storefront/vitest.config.ts` but no npm test script.

## CI preflight checks (run before push, from CONTRIBUTING.md)

```
pnpm repo:check
pnpm check:env
pnpm --filter @scalius/database check:migrations
pnpm generate:sdk        # commit any change in packages/api-client
pnpm lint
pnpm typecheck
pnpm build
pnpm run deploy:api -- --dry-run
pnpm check:dist-secrets
pnpm check:build-canaries
pnpm audit --audit-level moderate
```

The working tree must not be dirty after these steps. Generated files merge themselves via the `.gitattributes` `scalius-generated` driver.

## Key documentation

- `docs/ARCHITECTURE.md` — domains, layers, runtime configuration, order lifecycle, invariants
- `docs/FREE-PLAN.md` — Workers Free/Paid plan profile, limits, background work
- `docs/DATABASE-PORTABILITY.md` — database runtime contract and provider cutover (D1 default; TursoDB/PostgreSQL via `DATABASE_PROVIDER`)
- `docs/STOREFRONT-PERFORMANCE.md` — page render path, per-page budgets, `pnpm perf:storefront`
- `docs/AUTOMATED-DEPLOYMENTS.md` — opt-in contracts for managed installs
- `docs/MARKETS-DESIGN.md`, `docs/PLACES.md`, `docs/STORE-DEFAULTS.md`, `docs/SCALE.md`, `docs/PERFORMANCE-RELEASE.md`
- `packages/shared/src/storefront-theme.md` — storefront theme document and online store builder
- `apps/admin-v2/README.md`, `apps/storefront/README.md` — per-app guides
- `packages/plugin-sdk/README.md`, `packages/database/README.md`, `packages/cli/README.md`
- `.github/` — `ci.yml` workflow, issue templates, `LABELS.md`, `pull_request_template.md`

No `.cursor` rules or `GEMINI.md` exist in this repository. The project does not accept unsolicited pull requests (architecture is still changing); link an accepted issue and keep changes to the agreed outcome.

## Secrets reminder

Never commit `.dev.vars`, `.env*`, real buyer data, or secrets. Install secrets via `wrangler secret put` (API: `SCALIUS_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`; storefront: `SCALIUS_SECRET`).

## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo (origin: `https://github.com/OmarAdel10/E-Commerce.git`). Use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout: root `GLOSSARY-MAP.md` points to per-context `GLOSSARY.md` files. See `docs/agents/domain.md`.
