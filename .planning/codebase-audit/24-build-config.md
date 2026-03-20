# 24 — Build System & Monorepo Configuration Audit

**Auditor scope:** Turborepo config, package.json files, tsconfig, wrangler configs, scripts, dependency management, dev experience, deploy pipeline.

---

## 1. Architecture Summary

The monorepo is structured as a Turborepo + pnpm workspace with three deployable apps (all Cloudflare Workers) and five internal packages:

```
apps/
  admin/        → Astro 6 SSR + React 19 (Cloudflare Worker, port 4321)
  api/          → Hono standalone API + queue consumer (Cloudflare Worker, port 8787)
  storefront/   → Astro 6 SSR + React 19 (Cloudflare Worker, port 4322)
packages/
  api-client/   → Generated SDK (no runtime deps, JIT)
  core/         → Domain services, auth, integrations (JIT)
  database/     → Drizzle schema + migrations (JIT)
  shared/       → Pure utilities (JIT)
  tsconfig/     → Shared TS configs (base, worker, astro)
```

All packages are JIT (Just-In-Time) — no build step, consumed directly by bundlers (wrangler/esbuild for API, Vite/Astro for admin and storefront).

---

## 2. Turborepo Configuration

**File:** `turbo.json`

### What works well

- **Task pipeline is correct.** `build` depends on `^build` (upstream packages first), `dev` is persistent + uncached, `deploy` depends on `build`, `typecheck` depends on `^build`.
- **Caching is sensible.** `build` is cached with inputs (`src/**`) and outputs (`dist/**`, `.astro/**`). `dev`, `deploy`, `test`, and DB tasks are uncached (correct for side-effectful operations).
- **DB tasks are first-class.** `db:generate`, `db:migrate:local`, `db:migrate:remote` are registered as Turborepo tasks with `cache: false`.

### Issues

| ID | Severity | Issue |
|----|----------|-------|
| T-1 | **Low** | `^build` dependency on JIT packages is a no-op. Since `@scalius/core`, `@scalius/database`, `@scalius/shared` have no `build` script, Turborepo silently skips them. This is correct behavior but conceptually misleading — the pipeline suggests packages need building when they don't. |
| T-2 | **Low** | `build` task inputs only list `src/**`. Config files that affect builds (e.g., `wrangler.jsonc`, `astro.config.mjs`, `tsconfig.json`) are not listed. If a wrangler binding changes but no source file changes, Turborepo may serve a stale cached build. The default behavior (hash all non-gitignored files) would be safer; the explicit `inputs` restriction trades correctness for speed. |
| T-3 | **Low** | No `lint` task configuration beyond `dependsOn` and `cache: true`. Missing `inputs` means Turborepo hashes all files for lint cache, which is correct but could be narrowed to `src/**` for faster invalidation. |

---

## 3. Package.json Consistency

### Root package.json

**Strengths:**
- `packageManager: "pnpm@10.26.1"` is pinned — ensures CI reproducibility.
- React overrides (`^19.1.0`) prevent duplicate React instances across the tree.
- `pnpm.onlyBuiltDependencies` whitelist prevents arbitrary postinstall scripts (security).
- `pnpm.peerDependencyRules` suppresses known-acceptable peer dep noise (`react-is`, `date-fns`).
- Security overrides for transitive deps: `jws`, `undici`, `lodash`, `markdown-it`, `diff`, `h3`, `devalue`.

**Dev commands are well-designed:**
- `pnpm dev` / `pnpm dev:storefront` / `pnpm dev:all` provide flexible filtering via `scripts/dev.sh`.
- `pnpm deploy` runs the full pipeline via `scripts/deploy.mjs`.
- `pnpm test` uses vitest directly (not Turbo) with `--passWithNoTests`.
- `pnpm generate:sdk` filters to `@scalius/api-client`.

### Version Alignment Across Workspaces

| Dependency | Versions | Verdict |
|-----------|----------|---------|
| `typescript` | `^5.9.3` everywhere (4 packages) | Aligned |
| `drizzle-orm` | `^0.45.1` everywhere (5 packages) | Aligned |
| `zod` | `^4.3.6` everywhere (4 packages) | Aligned |
| `hono` | `^4.12.7` (api + admin) | Aligned |
| `better-auth` | `^1.5.5` (api + admin + core) | Aligned |
| `wrangler` | `^4.73.0` (3 apps) | Aligned |
| `@cloudflare/workers-types` | `^4.20260313.1` (5 packages) | Aligned |
| `vitest` | `^4.1.0` (root + api + core + shared) | Aligned |
| `react` | `^19.2.4` (admin), `^19.2.3` (storefront) | **Minor drift** |
| `react-dom` | `^19.2.4` (admin), `^19.2.3` (storefront) | **Minor drift** |
| `nanostores` | `^0.11.4` (admin), `^1.1.0` (storefront) | **Major version split** |
| `@nanostores/react` | `^0.8.4` (admin), `^1.0.0` (storefront) | **Major version split** |
| `sharp` | `^0.33.5` (admin), `^0.34.5` (storefront) | **Minor version split** |
| `tailwind-merge` | `^3.5.0` (admin + shared), `^3.4.0` (storefront) | **Minor drift** |
| `@astrojs/check` | `^0.9.7` (admin), `^0.9.6` (storefront) | **Patch drift** |

### Issues

| ID | Severity | Issue |
|----|----------|-------|
| P-1 | **Medium** | `nanostores` major version split: admin uses `^0.11.4`, storefront uses `^1.1.0`. Similarly `@nanostores/react`: admin `^0.8.4`, storefront `^1.0.0`. These are separate apps so no runtime conflict, but it adds cognitive overhead and divergent APIs. Admin should be upgraded to nanostores v1. |
| P-2 | **Low** | `sharp` version split: admin `^0.33.5`, storefront `^0.34.5`. The `0.33 -> 0.34` bump had breaking changes (Sharp follows semver-ish for 0.x). Since both apps deploy independently this is functional, but admin should track storefront. |
| P-3 | **Low** | `react` / `react-dom` minor drift: admin `^19.2.4` vs storefront `^19.2.3`. The root override `^19.1.0` ensures pnpm resolves a single version, so this is cosmetic. Still worth aligning the declared ranges. |
| P-4 | **Low** | `@scalius/shared` lists `drizzle-orm` as a dependency but no source file imports it (verified by grep). This is a phantom dependency — it adds unnecessary weight to the shared package. |
| P-5 | **Medium** | `@scalius/shared` lists `drizzle-orm`, `zod`, `clsx`, `tailwind-merge`, `currency.js`, and `libphonenumber-js` as regular `dependencies`. Since this is a JIT package (no build, bundled by consumers), these get hoisted by pnpm. However, `@scalius/storefront` imports `@scalius/shared` — meaning storefront transitively pulls `drizzle-orm` and `zod` into its dependency tree even though it never uses them. This inflates install time and lockfile size. |
| P-6 | **Info** | `@scalius/api-client` has no `typecheck` or `build` script. This is correct for a generated package, but means `turbo typecheck` and `turbo build` skip it silently. |
| P-7 | **Info** | `currency.js` is declared in both `@scalius/core` and `@scalius/shared`. Since both are JIT packages consumed by the same apps, pnpm deduplicates. No functional issue, but it's worth noting the dual declaration. |

---

## 4. TypeScript Configuration

### Shared configs (`packages/tsconfig/`)

| Config | Extends | Key Settings |
|--------|---------|-------------|
| `base.json` | — | `strict: true`, `noUncheckedIndexedAccess: true`, `target: ES2022`, `module: ES2022`, `moduleResolution: bundler`, `verbatimModuleSyntax: true`, `isolatedModules: true`, `skipLibCheck: true` |
| `worker.json` | `base.json` | Adds `types: ["@cloudflare/workers-types"]`, `lib: ["ES2022"]` |
| `astro.json` | `base.json` | Adds `jsx: "react-jsx"`, `jsxImportSource: "react"` |

**Strengths:**
- `strict: true` globally with `noUncheckedIndexedAccess` — above-average strictness.
- `moduleResolution: "bundler"` is the correct choice for Vite/wrangler bundled environments.
- `verbatimModuleSyntax: true` enforces `import type` for type-only imports — prevents runtime import of types.
- `isolatedModules: true` ensures compatibility with esbuild/swc single-file transpilation.
- `skipLibCheck: true` is pragmatic for a large monorepo with many deps.

### Per-workspace configs

| Workspace | Extends | Path Aliases | Notes |
|-----------|---------|-------------|-------|
| `apps/api` | `@scalius/tsconfig/worker.json` | `@/*`, `@scalius/core/*`, `@scalius/database/*`, `@scalius/shared/*` | Correct |
| `apps/admin` | `astro/tsconfigs/strict` | `@/*`, `@scalius/core/*`, `@scalius/database/*`, `@scalius/shared/*` | Does NOT extend shared tsconfig |
| `apps/storefront` | `astro/tsconfigs/strict` | `@/*` only | Does NOT extend shared tsconfig; no package path aliases |
| `packages/core` | `@scalius/tsconfig/worker.json` | `@scalius/core/*`, `@scalius/database/*`, `@scalius/shared/*` | Correct |
| `packages/database` | `@scalius/tsconfig/worker.json` | `@scalius/database/*` | Correct |
| `packages/shared` | `@scalius/tsconfig/base.json` | None | Correct |

### Issues

| ID | Severity | Issue |
|----|----------|-------|
| TS-1 | **Low** | `apps/admin/tsconfig.json` extends `astro/tsconfigs/strict` instead of `@scalius/tsconfig/astro.json`. The astro.json shared config exists but is unused — both Astro apps extend Astro's own strict config directly. This means admin/storefront get Astro's strict settings rather than the shared base config. The `packages/tsconfig/astro.json` is effectively dead code. |
| TS-2 | **Info** | Admin and storefront both redundantly specify `jsx: "react-jsx"` and `jsxImportSource: "react"` — these are already in Astro's strict config. Not harmful, just noise. |
| TS-3 | **Low** | `apps/storefront/tsconfig.json` has `"types": []` which overrides any inherited types. This means `@cloudflare/workers-types` is NOT available in storefront TS files. Storefront has `@cloudflare/workers-types` in `devDependencies` but the empty `types` array suppresses it. This may cause missing type definitions for worker-specific APIs. |
| TS-4 | **Info** | Storefront `tsconfig.json` does not have path aliases for `@scalius/shared/*` or `@scalius/api-client/*`. Since storefront uses `workspace:*` dependencies, pnpm handles resolution via `node_modules`. The path aliases in other apps are for IDE navigation, not bundler resolution. Storefront IDE navigation to shared/api-client source requires "Go to Definition" to traverse through `node_modules` symlinks. |
| TS-5 | **Info** | No `typecheck` script in `@scalius/storefront` or `@scalius/database` or `@scalius/shared`. Root `pnpm typecheck` (via Turborepo) will skip these packages. Storefront build does run `astro check` which covers Astro-specific checks. Database and shared get no type checking at all unless invoked from a consuming app. |

---

## 5. Wrangler Configurations

### Alignment

| Setting | API | Admin | Storefront |
|---------|-----|-------|-----------|
| `compatibility_date` | `2026-02-01` | `2026-02-01` | `2026-02-01` | Aligned |
| `compatibility_flags` | `nodejs_compat`, `global_fetch_strictly_public`, `disable_nodejs_process_v2` | Same | Same | Aligned |
| `cpu_ms limit` | 300,000 | 300,000 | 300,000 | Aligned |
| `workers_dev` | `true` | `true` | `true` | Aligned |
| `observability` | `enabled` | `enabled` | `enabled` | Aligned |
| Inspector port | Default (9229) | 9230 | 9231 | Correct staggering |
| Assets binding | None | `ASSETS → ./dist` | `ASSETS → ./dist` | Correct |
| D1 binding | `DB → scalius-commerce` | `DB → scalius-commerce` | None | Correct |
| KV bindings | CACHE, SESSION, SHARED_AUTH_CACHE | CACHE, SESSION, SHARED_AUTH_CACHE | CACHE_CONTROL | Correct |
| R2 binding | `BUCKET → scalius-media` | `BUCKET → scalius-media` | None | Correct |
| Service binding | None (is the API) | `API → scalius-api` | `BACKEND_API → scalius-api` | Correct |
| Queue producers | 4 queues | None | None | Correct |
| Queue consumers | 4 queues with DLQs | None | None | Correct |
| Cron triggers | `*/15 * * * *` | None | None | Correct |

### Issues

| ID | Severity | Issue |
|----|----------|-------|
| W-1 | **Medium** | Admin worker has D1, KV, and R2 bindings directly, duplicating the API worker's bindings. Per the architecture, admin communicates with the API via service binding (`env.API`). Having direct D1/KV/R2 access means admin worker code could bypass the API layer. If this is intentional (e.g., for Better Auth which needs direct DB access for session management), it should be documented. If not, these bindings are attack surface that should be removed. |
| W-2 | **Low** | API wrangler has `vars` with production URLs (`api.scalius.com`, `dashboard.scalius.com`, etc.). These get overridden by `.dev.vars` locally. However, the production vars are baked into the wrangler config file which is committed to git. If these URLs ever need to differ per environment (staging), this becomes a problem. Consider using `wrangler secret` for all environment-specific vars. |
| W-3 | **Info** | Storefront has `preview_urls: false` but admin and API do not set this. Minor inconsistency. |
| W-4 | **Info** | `AUTH_OTP_QUEUE` appears in wrangler.jsonc queue producers but is not listed in the CLAUDE.md queue bindings table. The CLAUDE.md documents `ORDER_NOTIFICATIONS_QUEUE` as handling `auth.send_otp` messages, but wrangler has a separate `auth-otp` queue. These may have diverged. |

---

## 6. Dependency Management

### Phantom Dependencies

| ID | Severity | Issue |
|----|----------|-------|
| D-1 | **Medium** | `@scalius/shared` declares `drizzle-orm: ^0.45.1` as a dependency, but no file in `packages/shared/src/` imports from `drizzle-orm`. This is a phantom dependency. |
| D-2 | **Low** | `hono` is listed in `apps/admin/package.json` dependencies. Admin communicates with the API via service bindings and Vite proxy. If admin's worker.ts or middleware uses Hono directly for routing, this is correct. Otherwise it's phantom. |

### Duplicated Dependencies (across workspace boundary)

Many dependencies are declared in both packages and consuming apps. Since packages are JIT (bundled by apps), the apps technically don't need to re-declare deps that are already in the JIT packages they consume. However, pnpm workspace with `workspace:*` protocol handles this gracefully — the transitive deps get hoisted. The redundancy adds maintenance overhead but no functional risk.

Notable duplicates across core + api:
- `bcryptjs`, `better-auth`, `drizzle-orm`, `fast-xml-parser`, `firebase`, `mimetext`, `nanoid`, `standardwebhooks`, `stripe`, `zod`, `@paralleldrive/cuid2`, `@polar-sh/sdk`

This pattern is common in monorepos where apps want explicit control over their dependency tree. It's a tradeoff: more maintenance for more clarity.

### Missing Peer Dependencies

| ID | Severity | Issue |
|----|----------|-------|
| D-3 | **Info** | `@hookform/resolvers` v5 requires `react-hook-form` as peer dep — both are present in admin. No issue. |
| D-4 | **Info** | The root `pnpm.peerDependencyRules.ignoreMissing` suppresses `react-is` warnings. This is correct for React 19 which removed `react-is` as separate package. |

---

## 7. Build Pipeline

### JIT Package Model

The JIT (Just-In-Time) model works correctly:

1. Packages declare `exports` pointing directly to `.ts` source files.
2. No `build` script in packages = Turborepo skips them.
3. Bundlers (wrangler/esbuild for API, Vite for admin/storefront) resolve imports through pnpm symlinks and bundle directly from TypeScript source.

This is a significant architectural strength:
- Zero build step for packages means instant dev feedback.
- No stale build artifacts to debug.
- Single source of truth for types (source files ARE the types).

### Build Commands Per App

| App | Build Command | Steps |
|-----|--------------|-------|
| API | `wrangler deploy --dry-run --outdir dist` | Dry-run deploy generates bundle |
| Admin | `astro check && astro build` | Type-check then build |
| Storefront | `node scripts/generate-build-id.js && astro check && astro build` | Generate build ID, type-check, then build |

### Issues

| ID | Severity | Issue |
|----|----------|-------|
| B-1 | **Low** | API build uses `wrangler deploy --dry-run --outdir dist` which is a deployment command repurposed as a build step. This works but is semantically unusual — a reader would expect `wrangler build` or similar. The `--dry-run` flag prevents actual deployment but it still validates the wrangler config against Cloudflare's API schema. |
| B-2 | **Info** | Storefront's build has a pre-step (`generate-build-id.js`) that writes to `src/config/build-id.ts`. This generated file should be in `.gitignore` to prevent spurious diffs. |

---

## 8. Dev Experience

### Dev Server Setup

**`scripts/dev.sh`** is well-engineered:
- Kills stale processes on dev ports before startup (prevents "port already in use").
- Traps `SIGINT`/`SIGTERM`/`EXIT` for cleanup.
- Two modes: filtered (via `turbo dev --filter`) for 1-2 apps, staggered manual start for all 3.
- 3-second stagger between app starts prevents Vite inspector port races (a real macOS issue).
- Clear startup banner with URLs.

**Port assignment:**
| Service | Port | Inspector Port |
|---------|------|---------------|
| API | 8787 | 9229 (default) |
| Admin | 4321 | 9230 |
| Storefront | 4322 | 9231 |

**Vite proxy (Admin):** `/api/v1` proxied to `http://localhost:8787` in dev. This bypasses the Astro catch-all route and the admin proxy middleware, meaning dev mode gets raw API responses (unwrapped envelope). This is a known issue documented in the project memory.

### Dev Setup Script (`dev-setup.mjs`)

Excellent one-command setup:
1. `pnpm install`
2. Generates cryptographically random secrets
3. Creates `.dev.vars` for all 3 apps with matching secrets
4. Creates `.env.development` for admin + storefront
5. Applies local D1 migrations

The `--force` flag allows regeneration. Idempotent by default (skips existing files).

### Dev Reset Script (`dev-reset.mjs`)

Clean reset: deletes `.wrangler/state/` and re-applies all migrations. Simple and correct.

### Issues

| ID | Severity | Issue |
|----|----------|-------|
| DX-1 | **Low** | `dev.sh` uses `kill -9` (SIGKILL) which doesn't allow processes to clean up. A two-stage approach (SIGTERM first, SIGKILL after timeout) would be gentler. The current approach is justified by the comment about zombie processes. |
| DX-2 | **Info** | `dev.sh` has port 4323 and inspector ports 9232-9233 in the kill list, suggesting a planned 4th app or future expansion. These ports are harmless but contribute to "what are these for?" confusion. |
| DX-3 | **Info** | The storefront does not have a Vite proxy to the API like admin does. In dev mode, storefront calls the API via `BACKEND_API` service binding, which in local dev uses wrangler's local service binding emulation. This is architecturally correct but means storefront dev requires the API worker to be running. |

---

## 9. Deploy Pipeline

**`scripts/deploy.mjs`** implements a professional deployment pipeline:

1. **Typecheck** — `pnpm typecheck` (catches what esbuild strips)
2. **Build** — `pnpm build` (all workspaces via Turbo)
3. **Migrate** — `wrangler d1 migrations apply --remote` (idempotent)
4. **Deploy API** — `wrangler deploy` from `apps/api/`
5. **Deploy Admin** — `wrangler deploy` from `apps/admin/`
6. **Deploy Storefront** — `wrangler deploy` from `apps/storefront/`

**Strengths:**
- Typecheck before build catches type errors that esbuild ignores.
- Retry logic with exponential backoff (5s, 10s, 15s) for transient Cloudflare API errors.
- Reads D1 database name from wrangler.jsonc (single source of truth).
- Suppresses Node punycode deprecation warnings that corrupt Wrangler output.
- Supports `--migrate-only` and `--local` flags for granular control.

### Issues

| ID | Severity | Issue |
|----|----------|-------|
| DP-1 | **Medium** | Deploys are sequential (API, then Admin, then Storefront). If Admin deploys but Storefront fails, you have a partially-deployed state. This is acceptable for a single-tenant system but could cause brief inconsistencies for users browsing during deploy. Consider deploying Admin + Storefront in parallel after the API (since both depend on API but not each other). |
| DP-2 | **Low** | No rollback mechanism. If the deploy succeeds but the new code has a runtime bug, the only recourse is to fix-forward or manually run `wrangler rollback`. A deploy script that saves the previous version ID and offers a rollback command would improve operational safety. |
| DP-3 | **Low** | The JSONC parser in `readWranglerConfig()` uses a regex to strip comments: `raw.replace(/(?<!https?:)\/\/[^\n]*/g, "")`. This negative lookbehind handles `https://` but would break on strings containing `//` that aren't comments (e.g., `"path": "//foo"`). The current configs don't have such cases, but it's fragile. Consider using a proper JSONC parser (`jsonc-parser` npm package). |
| DP-4 | **Info** | `pnpm deploy:api`, `pnpm deploy:admin`, `pnpm deploy:storefront` scripts in root use `turbo deploy --filter=...` which runs the individual `wrangler deploy` command. But `pnpm deploy` uses the custom `deploy.mjs` which does typecheck + build + migrate + deploy. These are two different deploy paths. The turbo-based individual deploys skip typechecking, building, and migration. |

---

## 10. LLM-Friendliness

### Strengths

- **CLAUDE.md is exceptional.** Comprehensive overview, architecture, conventions, how-to recipes, import patterns, file paths, dependency graph, known backlog. This is one of the best-documented monorepos for LLM consumption.
- **Consistent naming.** Package names (`@scalius/core`, `@scalius/shared`, etc.) and file paths are predictable.
- **JIT model is simple.** No build artifacts to reason about — source files are the truth.
- **Explicit exports maps** in all packages make import resolution unambiguous.
- **Single config pattern.** Each app has exactly one `wrangler.jsonc`, one `tsconfig.json`, one `astro.config.mjs` (where applicable).

### Weaknesses

- **Two deploy paths** (Turborepo `deploy` task vs `deploy.mjs` script) could confuse an LLM about which to invoke.
- **Wrangler JSONC format** requires comment-aware parsing which LLMs may struggle with.
- **The Vite proxy dev/prod behavior split** (admin gets raw API responses in dev but proxied responses in prod) is a subtle gotcha that even CLAUDE.md acknowledges.

---

## 11. Issues Summary

### By Severity

**Medium (5):**
| ID | Area | Summary |
|----|------|---------|
| P-1 | Dependencies | `nanostores` major version split between admin (0.x) and storefront (1.x) |
| P-5 | Dependencies | `@scalius/shared` pulls `drizzle-orm` and `zod` into storefront's dependency tree unnecessarily |
| D-1 | Dependencies | `@scalius/shared` has phantom `drizzle-orm` dependency (no imports found) |
| W-1 | Wrangler | Admin worker has direct D1/KV/R2 bindings duplicating API worker — unclear if intentional |
| DP-1 | Deploy | Sequential deploys can leave partially-deployed state |

**Low (13):**
| ID | Area | Summary |
|----|------|---------|
| T-1 | Turbo | `^build` on JIT packages is a silent no-op |
| T-2 | Turbo | `build` inputs miss config files (wrangler, astro.config, tsconfig) |
| T-3 | Turbo | `lint` task lacks explicit inputs |
| P-2 | Dependencies | `sharp` version split (0.33 vs 0.34) |
| P-3 | Dependencies | `react`/`react-dom` minor version drift |
| D-2 | Dependencies | `hono` in admin may be phantom |
| TS-1 | TypeScript | `packages/tsconfig/astro.json` is unused dead code |
| TS-3 | TypeScript | Storefront `types: []` suppresses `@cloudflare/workers-types` |
| W-2 | Wrangler | Production URLs hardcoded in committed wrangler config |
| B-1 | Build | API build uses `wrangler deploy --dry-run` (unusual semantics) |
| DP-2 | Deploy | No rollback mechanism |
| DP-3 | Deploy | Fragile JSONC regex parser |
| DP-4 | Deploy | Two different deploy paths (turbo vs deploy.mjs) |
| DX-1 | Dev | `dev.sh` uses SIGKILL without SIGTERM grace period |

**Info (10):**
| ID | Area | Summary |
|----|------|---------|
| P-6 | Packages | `@scalius/api-client` has no typecheck/build (correct, just noting) |
| P-7 | Dependencies | `currency.js` declared in both core and shared |
| TS-2 | TypeScript | Redundant JSX config in Astro apps |
| TS-4 | TypeScript | Storefront lacks path aliases for shared/api-client |
| TS-5 | TypeScript | No typecheck script in storefront, database, or shared packages |
| W-3 | Wrangler | `preview_urls` inconsistency |
| W-4 | Wrangler | AUTH_OTP_QUEUE in wrangler but not in CLAUDE.md queue table |
| B-2 | Build | Storefront `build-id.ts` may not be gitignored |
| DX-2 | Dev | Extra ports in dev.sh kill list |
| DX-3 | Dev | Storefront lacks Vite proxy (by design) |

---

## 12. Recommendations

### Quick Wins (low effort, immediate value)

1. **Remove `drizzle-orm` from `@scalius/shared` dependencies.** No source file imports it. Reduces storefront's dependency footprint.

2. **Align nanostores versions.** Upgrade admin from `nanostores@^0.11.4` to `^1.1.0` and `@nanostores/react` from `^0.8.4` to `^1.0.0` to match storefront.

3. **Align sharp versions.** Update admin from `^0.33.5` to `^0.34.5` to match storefront.

4. **Update CLAUDE.md queue table** to include `AUTH_OTP_QUEUE` or document the merge into `ORDER_NOTIFICATIONS_QUEUE`.

5. **Delete `packages/tsconfig/astro.json`** if both Astro apps will continue extending `astro/tsconfigs/strict` directly. Or migrate both apps to extend it for consistency.

### Medium-Term Improvements

6. **Add `typecheck` scripts** to `@scalius/storefront`, `@scalius/database`, and `@scalius/shared` so `turbo typecheck` covers the full tree.

7. **Split `@scalius/shared` dependencies.** Move `drizzle-orm` and `zod` to `peerDependencies` (or remove them entirely if unused) so storefront doesn't pull them in transitively.

8. **Document the admin D1/KV/R2 binding intent.** If admin needs direct DB access for Better Auth session management, add a comment in `wrangler.jsonc` explaining why. If not, remove the bindings and route everything through the service binding.

9. **Add config files to Turbo build inputs** or remove the explicit inputs restriction to let Turborepo hash all non-gitignored files. This prevents stale caches when configs change.

### Strategic (higher effort)

10. **Parallel deploy for Admin + Storefront.** After API deploys, Admin and Storefront can deploy concurrently. Would cut deploy time by ~30%.

11. **Replace JSONC regex parser** in `deploy.mjs` with a proper parser (`jsonc-parser` package or Node.js built-in `JSON.parse` with comment stripping from `node:vm`).

12. **Consolidate deploy paths.** Either make the individual `deploy:api` / `deploy:admin` / `deploy:storefront` scripts also run typecheck + build, or document clearly that they are for hot-deploying a single worker only (skip checks at your own risk).

---

## 13. Grading

| Dimension | Grade | Notes |
|-----------|-------|-------|
| Turborepo Config | **B+** | Pipeline is correct; caching inputs could be tighter |
| Package.json Consistency | **B** | Core deps aligned, but nanostores/sharp version splits and phantom deps |
| TypeScript Configs | **B+** | Strict globally, JIT-compatible; unused astro.json and storefront types gap |
| Wrangler Configs | **A-** | Well-aligned, inspector ports staggered, DLQs on all queues |
| Dependency Management | **B** | No version conflicts for critical deps; some phantom deps and unnecessary transitives |
| Build Pipeline | **A-** | JIT model is elegant; deploy script is production-quality with retries |
| Dev Experience | **A** | One-command setup, staggered starts, zombie cleanup, clear ports |
| Deploy Pipeline | **B+** | Typecheck-first is excellent; sequential deploys and no rollback are gaps |
| LLM-Friendliness | **A** | CLAUDE.md is best-in-class; consistent naming; JIT simplicity |
| **Overall** | **B+** | Solid monorepo setup with excellent dev tooling; main gaps are dependency hygiene and deploy resilience |
