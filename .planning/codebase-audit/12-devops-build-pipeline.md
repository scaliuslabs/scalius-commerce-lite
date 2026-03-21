# DevOps & Build Pipeline Audit

## Executive Summary

This is a well-structured Turborepo monorepo deploying three Cloudflare Workers (API, Admin, Storefront) backed by D1 (SQLite), KV, R2, and Queues. The build pipeline is functional but has meaningful gaps in CI/CD maturity, caching strategy, environment management, and developer guardrails. The deploy script (`deploy.mjs`) is solid for a single-operator team but lacks the safeguards needed for multi-developer workflows or production-grade deployment reliability.

**Strongest areas**: Dev setup automation (`pnpm dev:setup`), clean workspace structure, consistent toolchain choices, thoughtful dev server orchestration (port clash prevention, zombie process cleanup).

**Weakest areas**: No Turbo Remote Cache, no staging environment, no deployment rollback mechanism, no pre-commit hooks, no automated dependency updates, CI pipeline runs `pnpm install` four separate times, hardcoded production resource IDs in version-controlled wrangler configs.

---

## Build Pipeline Diagram

```
Developer Workstation                        CI (GitHub Actions)                 Production (Cloudflare)
========================                     ======================              =======================

pnpm dev:setup                               PR/push to cloudflare-only,
  |-> pnpm install                           mono-repo, or main
  |-> generate .dev.vars (3 apps)              |
  |-> generate .env.development (2 apps)       +--> [Lint Job]
  |-> migrate local D1                         |      pnpm install
                                               |      pnpm lint (turbo)
pnpm dev                                       |
  |-> scripts/dev.sh                           +--> [Typecheck Job]
  |-> kill stale ports                         |      pnpm install
  |-> turbo dev (filtered or staggered)        |      pnpm typecheck (turbo)
  |                                            |
  API  -> wrangler dev :8787                   +--> [Build Job] (needs lint+typecheck)
  Admin -> astro dev :4321                     |      pnpm install
  Storefront -> astro dev :4322                |      pnpm build (turbo)
                                               |
                                               +--> [Test Job] (needs build)
                                                      pnpm install
                                                      pnpm test (vitest)

pnpm deploy (manual)
  |-> pnpm typecheck
  |-> pnpm build (turbo)
  |-> wrangler d1 migrations apply --remote
  |-> wrangler deploy (API)
  |-> wrangler deploy (Admin)
  |-> wrangler deploy (Storefront)
```

---

## Ratings

| Dimension | Score | Justification |
|---|---|---|
| **Maintainability** | 7/10 | Clean workspace layout, consistent naming, shared tsconfig. Dependency duplication across packages is a moderate concern. |
| **Robustness** | 4/10 | No staging environment, no rollback, no deployment gates, no smoke tests. Deploy is a single script with retries but no canary/blue-green capability. |
| **Code Quality** | 6/10 | ESLint + TypeScript strict mode in place. No pre-commit hooks, no Prettier enforcement in CI, many lint rules set to "warn" instead of "error". |
| **Scalability** | 5/10 | Turbo parallel builds work locally. No Remote Cache configured. CI installs dependencies 4x. No incremental build artifacts cached between CI runs. |
| **Performance** | 6/10 | Astro rust compiler enabled, Vite with Tailwind CSS v4 plugin, HTML compression, CSS code splitting. Dev startup requires 6+ second staggered delay. No build profiling. |
| **Feature Readiness** | 7/10 | Adding a new package is straightforward via workspace protocol. Adding a new app requires wrangler config, dev.sh port allocation, and dev-setup.mjs updates. No app scaffold/template. |
| **Developer Experience** | 7/10 | One-command setup (`pnpm dev:setup`) is excellent. Good `.dev.vars.example` files. No root README.md. No contribution guide. |
| **Security** | 4/10 | Hardcoded production D1 database IDs and KV namespace IDs in version-controlled wrangler configs. `workers_dev: true` in all production configs exposes *.workers.dev routes. No secret rotation strategy. |

**Overall: 5.8/10**

---

## Detailed Findings

### 1. CI/CD Pipeline

**File**: `.github/workflows/ci.yml`

#### Issues

**CRITICAL: CI installs dependencies four separate times.** Each job (lint, typecheck, build, test) runs `pnpm install --frozen-lockfile` independently. With ~13k lines in the lockfile and native dependencies (sharp, esbuild, workerd), this wastes significant CI minutes.

```
Lint:      pnpm install -> pnpm lint
Typecheck: pnpm install -> pnpm typecheck
Build:     pnpm install -> pnpm build        (needs lint + typecheck)
Test:      pnpm install -> pnpm test          (needs build)
```

**Recommendation**: Use a matrix strategy or a shared install job with artifact upload. At minimum, consolidate lint + typecheck into one job since both depend only on source files.

**CRITICAL: No deployment pipeline in CI.** Deploys are entirely manual via `node scripts/deploy.mjs` run locally. There is no CD workflow, no deployment on merge to main, no staging environment, and no smoke test after deploy.

**HIGH: No Turbo Remote Cache.** No `TURBO_TOKEN` or `TURBO_TEAM` configured anywhere. Every CI run rebuilds everything from scratch. For a monorepo with 7 workspaces, this is a significant efficiency loss.

**HIGH: Test job depends on build but does not reuse build artifacts.** The test job re-runs `pnpm install` and `pnpm test` after build, but since Turbo cache is local to each runner, build outputs from the build job are lost. The test job either rebuilds or runs without build outputs.

**MEDIUM: No branch protection enforcement.** CI runs on push and PR to three branches (`cloudflare-only`, `mono-repo`, `main`) but there is no evidence of required status checks in the workflow itself.

**LOW: Test suite uses `--passWithNoTests`.** Root `package.json` runs `vitest run --passWithNoTests`. This means CI passes even if all tests are deleted. The `tests/` directory is gitignored, so CI always runs with zero tests.

#### Strengths

- Concurrency control with `cancel-in-progress: true` prevents wasted CI on rapid pushes
- Proper use of `--frozen-lockfile` prevents lockfile drift
- Reasonable timeout limits (10 min for lint/typecheck/test, 15 min for build)
- pnpm cache (`cache: pnpm` via setup-node) caches the pnpm store between runs

---

### 2. Build System

**Files**: `turbo.json`, `package.json` (root + all workspaces)

#### Turbo Configuration Analysis

The `turbo.json` is well-structured:
- `build` task correctly uses `^build` (builds dependencies first) with explicit `inputs` and `outputs`
- `dev` and `deploy` correctly marked `cache: false`
- `lint` is cacheable (good)
- `typecheck` is cacheable but missing explicit `inputs`/`outputs` (means Turbo hashes everything)

**MEDIUM: `typecheck` task lacks `inputs` and `outputs` configuration.** Unlike `build` which scopes to `src/**`, typecheck hashes the entire workspace. This means any file change (including README edits) invalidates the typecheck cache.

**MEDIUM: No `turbo.json` `globalDependencies` or `globalPassThroughEnv`.** Environment variable changes (like updating `PUBLIC_API_BASE_URL`) will not invalidate Turbo cache. Builds may serve stale env vars.

#### Build Outputs

- API: `wrangler deploy --dry-run --outdir dist` (esbuild bundle)
- Admin: `astro check && astro build` (Astro SSR + client assets)
- Storefront: `node scripts/generate-build-id.js && astro check && astro build`

**LOW: Admin build runs `astro check` inside `build` script.** This means `pnpm build` for admin also type-checks, doubling work when running both `pnpm typecheck` and `pnpm build`. The storefront has the same pattern. Consider separating check from build.

#### Dependency Graph

```
@scalius/tsconfig    (base configs, no deps)
       |
@scalius/shared      (depends on tsconfig)
       |
@scalius/database    (depends on tsconfig)
       |
@scalius/core        (depends on database, shared)
       |
@scalius/api-client  (generated SDK, depends on tsconfig)
       |
+------+------+
|      |      |
API   Admin  Storefront
```

This is a clean, acyclic dependency graph. The `^build` ordering in Turbo correctly resolves this.

---

### 3. Deployment Strategy

**Files**: `scripts/deploy.mjs`, `apps/*/wrangler.jsonc`

#### Architecture

All three apps deploy as Cloudflare Workers:
- **API Worker** (`scalius-api`): Hono API, D1 database, KV cache/session, R2 media, Queue producers/consumers, cron triggers
- **Admin Worker** (`scalius-admin`): Astro SSR, D1 (direct), KV, R2, service binding to API
- **Storefront Worker** (`scalius-storefront`): Astro SSR, KV cache control, service binding to API

#### Issues

**CRITICAL: No staging environment.** All wrangler configs point to a single set of production resources. There is no `[env.staging]` block, no separate D1 database for staging, and no way to test migrations or deployments before they hit production.

**CRITICAL: No rollback mechanism.** If a deployment breaks, the only recovery is to re-deploy the previous version manually. Cloudflare Workers support versioning and rollbacks, but these are not configured.

**CRITICAL: Hardcoded production resource IDs in wrangler.jsonc.** D1 database ID `2efcad0d-841e-4f8d-b8f6-5b735d881edc`, KV namespace IDs, and queue names are checked into version control. While not secret credentials, this couples the codebase to a specific Cloudflare account and makes forking/multi-tenant deployment impossible without editing tracked files.

**HIGH: `workers_dev: true` in all production configs.** This exposes all three workers on `*.workers.dev` URLs (e.g., `scalius-api.username.workers.dev`), bypassing any custom domain restrictions, WAF rules, or IP allowlists. For the admin panel, this is a security concern.

**HIGH: Deploy is sequential with no parallelism.** The deploy script deploys API -> Admin -> Storefront one at a time. Since Storefront and Admin depend on API (via service bindings), this ordering is correct. However, Admin and Storefront could be deployed in parallel after API.

**MEDIUM: Deploy script uses `execSync` for everything.** This means a failure mid-deploy (e.g., Admin deploys but Storefront fails) leaves the system in an inconsistent state. There is retry logic (3 attempts with backoff), but no transactional rollback.

**MEDIUM: D1 migration is applied before all workers deploy.** If a migration adds a column that new code expects but old workers are still running, there is a window of inconsistency. This is acceptable for D1 (additive migrations) but not documented.

#### Strengths

- Retry logic with exponential backoff for transient Cloudflare API errors
- Typecheck runs before build in the deploy pipeline (catches issues esbuild misses)
- Migration support for both local and remote D1
- Build ID generation for cache busting (storefront)
- Dead letter queues configured for all queue consumers

---

### 4. Developer Experience

**Files**: `scripts/dev-setup.mjs`, `scripts/dev.sh`, `scripts/dev-reset.mjs`

#### `pnpm dev:setup` - Onboarding Script

This is the strongest part of the DX. A single command:
1. Installs all dependencies
2. Generates cryptographically random secrets
3. Creates `.dev.vars` for all three apps with matching secrets
4. Creates `.env.development` for Astro build-time vars
5. Applies local D1 migrations

**LOW: No validation step.** After setup, there is no health check to verify the database was created correctly or that all env vars are properly configured.

#### `pnpm dev` - Development Server

The `dev.sh` script handles two macOS-specific pain points:
1. Inspector port races (Vite WebSocket conflicts between multiple Cloudflare dev servers)
2. Zombie process cleanup (Node/workerd children surviving Ctrl+C)

**MEDIUM: Staggered startup with `sleep 3` between apps.** This adds 6+ seconds to dev startup. The script correctly notes this is to prevent inspector port races, and the wrangler configs already have unique inspector ports (9229, 9230, 9231). The sleep may be unnecessary with the unique ports, or could be reduced.

**LOW: `dev.sh` uses `lsof` and `pkill`.** These are macOS/Linux-specific. Windows developers would need WSL or an alternative script.

#### `pnpm dev:reset` - Database Reset

Clean and simple: deletes `.wrangler/state/` and re-applies all migrations. Good for development workflow.

#### Missing DX Elements

- **No root README.md**: New developers have no entry point documentation
- **No `.nvmrc` or `.node-version`**: CI uses Node 22, but nothing enforces this locally. A developer on Node 18 or 20 would get different behavior
- **No `.npmrc`**: No pnpm configuration for strict-peer-dependencies, save-exact, etc.
- **No pre-commit hooks**: No husky, lint-staged, or commitlint. Developers can push unlinted code
- **No contribution guide**: No CONTRIBUTING.md or code style documentation

---

### 5. Environment Management

#### Configuration Layers

The codebase has a well-defined separation between build-time and runtime variables:

| Layer | File | Purpose |
|---|---|---|
| Build-time | `.env.development` | Vite/Astro `import.meta.env.*` vars |
| Runtime secrets | `.dev.vars` | Cloudflare Worker bindings (local dev) |
| Runtime production | `wrangler.jsonc` vars | Hardcoded in tracked config |
| Runtime production secrets | Cloudflare dashboard | Set manually |

**MEDIUM: Inconsistent `.env.example` files.** Root has `.env.example`, storefront has `.env.development.example`, but all three apps have `.dev.vars.example`. The naming inconsistency could confuse new developers.

**MEDIUM: Production vars hardcoded in wrangler.jsonc.** Production URLs like `https://api.scalius.com` and `https://dashboard.scalius.com` are baked into wrangler configs. There is no per-environment override mechanism.

---

## Dependency Health

### Version Consistency

| Package | Versions Found | Status |
|---|---|---|
| `typescript` | `^5.9.3` everywhere | Consistent |
| `wrangler` | `^4.73.0` everywhere | Consistent |
| `drizzle-orm` | `^0.45.1` in 4 packages | Consistent |
| `zod` | `^4.3.6` in 4 packages | Consistent |
| `hono` | `^4.12.7` in 2 packages | Consistent |
| `better-auth` | `^1.5.5` in 3 packages | Consistent |
| `vitest` | `^4.1.0` in 4 locations | Consistent |
| `react` | `^19.2.4` (admin), `^19.2.3` (storefront) | **Minor mismatch** |
| `sharp` | `^0.33.5` (admin), `^0.34.5` (storefront) | **Major mismatch** |
| `firebase` | `^12.0.0` in 2 packages | Consistent |
| `stripe` | `^20.4.1` in 2 packages | Consistent |
| `@polar-sh/sdk` | `^0.46.4` in 2 packages | Consistent |

### Issues

**HIGH: `sharp` version mismatch.** Admin uses `^0.33.5`, storefront uses `^0.34.5`. These are different major versions with potential breaking changes. The `onlyBuiltDependencies` list includes `sharp`, meaning both versions will be compiled from source, increasing install time.

**MEDIUM: `react` minor version mismatch.** Admin pins `^19.2.4`, storefront pins `^19.2.3`. The root `overrides` block pins `react: ^19.1.0`. In practice, pnpm will resolve to a single version, but the intent is unclear.

**MEDIUM: Dependency duplication across workspaces.** Several heavy dependencies appear in both `@scalius/core` and `@scalius/api`:
- `firebase` (12.0.0) -- extremely large package (~5MB)
- `stripe` (20.4.1)
- `@polar-sh/sdk` (0.46.4)
- `better-auth` (1.5.5)
- `drizzle-orm` (0.45.1)
- `bcryptjs`, `mimetext`, `nanoid`, `fast-xml-parser`, `standardwebhooks`

Since `@scalius/api` depends on `@scalius/core`, these dependencies are inherited. Listing them again in API's `package.json` is redundant and risks version drift.

**MEDIUM: No automated dependency update tool.** No Dependabot, Renovate, or similar configured. Security patches for transitive dependencies depend on manual pnpm override entries (8 overrides currently defined including `jws`, `lodash`, `undici`, `h3`, `diff`, `markdown-it`, `devalue`, `wrangler`).

### Security Overrides (Positive)

The root `pnpm.overrides` section shows active security management:
- `jws: ^3.2.3` -- fixes JWT bypass vulnerability
- `lodash: >=4.17.23` -- fixes prototype pollution
- `undici: >=7.18.2` -- fixes HTTP header injection
- `h3: >=1.15.5` -- fixes path traversal
- `diff: >=5.2.2` -- fixes ReDoS
- `markdown-it: >=14.1.1` -- fixes XSS
- `devalue: >=5.6.2` -- fixes code injection
- `esbuild: ^0.25.0` -- aligns build tooling

This is better than most projects. However, these overrides must be manually maintained.

---

## Recommendations

### P0 -- Critical (Do immediately)

1. **Set `workers_dev: false` in production wrangler configs** or add custom domain routing. The `*.workers.dev` URLs are publicly accessible and bypass any intended access controls on admin and API.

2. **Add a staging environment.** Create `[env.staging]` blocks in wrangler configs with separate D1 databases, KV namespaces, and queue bindings. The deploy script should accept a `--staging` flag.

3. **Remove hardcoded resource IDs from wrangler.jsonc.** Move D1 database IDs, KV namespace IDs, and production URLs to environment variables or a separate untracked config file. Use wrangler's `--env` flag for environment-specific deploys.

4. **Resolve the `sharp` version mismatch.** Both admin and storefront should use the same major version (`^0.34.5`).

### P1 -- High Priority (Next sprint)

5. **Configure Turbo Remote Cache.** Add `TURBO_TOKEN` and `TURBO_TEAM` to CI secrets. This will dramatically reduce CI build times since most tasks will hit cache.

6. **Consolidate CI jobs to reduce install overhead.** Either:
   - Use a single job with sequential steps (lint -> typecheck -> build -> test), or
   - Add a shared "install" job that uploads `node_modules` as an artifact for downstream jobs

7. **Add a CD pipeline.** On merge to `cloudflare-only` (or `main`), automatically run the deploy script. Add a manual approval gate for production deploys.

8. **Add pre-commit hooks.** Install husky + lint-staged to run ESLint and tsc on staged files before commit. This catches issues before they reach CI.

9. **Add `.nvmrc` or `.node-version` with `22`.** Prevents local/CI drift.

10. **Set up Dependabot or Renovate.** Automate dependency updates with grouped PRs for minor/patch versions and individual PRs for major versions.

### P2 -- Medium Priority (This quarter)

11. **Remove duplicate dependencies from `@scalius/api`.** Since API depends on `@scalius/core`, packages like `firebase`, `stripe`, `@polar-sh/sdk`, `better-auth`, `drizzle-orm`, `bcryptjs`, etc. are already available transitively. Remove them from API's direct dependencies.

12. **Add explicit `inputs`/`outputs` to `typecheck` task in turbo.json.** Use `"inputs": ["src/**", "tsconfig.json"], "outputs": []` to improve cache hit rates.

13. **Add `globalDependencies` to turbo.json.** At minimum: `[".env*", "pnpm-lock.yaml"]`. This ensures env var changes invalidate the build cache.

14. **Align React versions.** Both admin and storefront should pin the same `react` version. Consider moving `react` and `react-dom` to root devDependencies with workspace-wide resolution.

15. **Standardize `.env.example` naming.** Use `.dev.vars.example` consistently (already present for all apps). Remove or consolidate root `.env.example` and storefront's `.env.development.example`.

16. **Add a root README.md.** Document: workspace layout, how to get started, how to deploy, common dev commands. This is the first thing a new developer looks for.

17. **Evaluate reducing `sleep` in dev.sh.** The staggered startup delay of 6 seconds may be unnecessary now that each app has a unique inspector port in its wrangler config.

### P3 -- Low Priority (Nice to have)

18. **Add Prettier enforcement in CI.** The `.prettierrc.mjs` exists but is not run in CI. Add a `format:check` script.

19. **Promote lint rules from "warn" to "error" gradually.** At minimum: `no-explicit-any`, `no-unused-vars`, and `prefer-const` should eventually be errors to prevent code quality regression.

20. **Add smoke tests post-deploy.** After deploying, hit a health endpoint on each worker to verify they are responding. The deploy script's retry logic handles transient Cloudflare API errors but does not verify the deployed code actually works.

21. **Consider `--passWithNoTests` removal.** Since the test suite is gitignored, this flag masks the absence of tests in CI. Either commit test files or explicitly acknowledge the gap.

22. **Add build profiling.** Use `turbo run build --summarize` to track build times over time and identify regressions.

23. **Create an app scaffold.** A `turbo gen` template for adding new Workers would reduce the manual steps (wrangler config, dev.sh ports, dev-setup.mjs vars, CI config).
