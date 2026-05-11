# Repo Architecture / Runtime Audit

## Scope

- Repo architecture, monorepo orchestration, build/dev/deploy workflows, Wrangler config, Worker entrypoints, service bindings, queue wiring, and cross-app runtime composition.
- Excluded business-domain correctness unless it materially changed runtime behavior.
- Explicitly reviewed with the `turborepo` skill and `workers-best-practices` skill.

## Evidence Base

- Files inspected: root [package.json](/Users/arob/Desktop/open/scalius-commerce-lite/package.json:1), [turbo.json](/Users/arob/Desktop/open/scalius-commerce-lite/turbo.json:1), [pnpm-workspace.yaml](/Users/arob/Desktop/open/scalius-commerce-lite/pnpm-workspace.yaml:1), all app/package `package.json` files, all three [`wrangler.jsonc`](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/wrangler.jsonc:1) files, runtime entrypoints, and dev/deploy scripts.
- Commands run:
  - `pnpm typecheck` — passed.
  - `pnpm build` — passed.
  - `pnpm test` — passed: 9 files / 143 tests.
  - `pnpm lint` — failed in API and only executed API + storefront lint tasks.
- Current primary docs checked on 2026-04-22:
  - Turborepo task/input/env docs and package graph docs.
  - Cloudflare Workers configuration, service bindings, local development, observability, and Workers best practices docs.

## How This Area Works End to End

### Monorepo / Task Graph

- The repo is a pnpm workspace with apps under [pnpm-workspace.yaml](/Users/arob/Desktop/open/scalius-commerce-lite/pnpm-workspace.yaml:1) and task orchestration in [turbo.json](/Users/arob/Desktop/open/scalius-commerce-lite/turbo.json:1).
- Root scripts in [package.json](/Users/arob/Desktop/open/scalius-commerce-lite/package.json:6) act as the operator entrypoint for dev/build/deploy/typecheck/db/sdk workflows.
- The apps import workspace packages directly from source instead of consuming prebuilt package artifacts:
  - API imports `@scalius/core`, `@scalius/database`, `@scalius/shared` from source via workspace deps and TS path aliases.
  - Admin imports `@scalius/core`, `@scalius/database`, `@scalius/shared`, `@scalius/api-client`.
  - Storefront imports `@scalius/shared` and `@scalius/api-client`.
- This means correctness of the Turbo task graph and cache keys matters more than in a compiled-packages monorepo, because the apps bundle shared package source directly.

### Runtime Topology

- API is the central backend Worker. [apps/api/src/worker.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/worker.ts:10) exposes three execution surfaces:
  - `fetch()` for HTTP requests.
  - `queue()` for queue batches.
  - `scheduled()` for the inventory expiry cron.
- The Hono app in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:76) mounts public storefront routes, webhook routes, and admin routes under `/api/v1`.
- Admin is a TanStack Start Worker. Its Wrangler config binds the API Worker as `env.API` in [apps/admin-v2/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/wrangler.jsonc:47), and the admin proxy route forwards `/api/v1/admin/*` through that binding in [apps/admin-v2/src/routes/api/v1/admin/$.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/v1/admin/$.ts:15).
- Storefront is an Astro Cloudflare Worker. Its Wrangler config binds the API Worker as `env.BACKEND_API` in [apps/storefront/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/wrangler.jsonc:35), and SSR API calls are routed through that binding in [apps/storefront/src/lib/api/client.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/api/client.ts:157) when running in production SSR.

### Local Development

- Root dev is orchestrated by [scripts/dev.sh](/Users/arob/Desktop/open/scalius-commerce-lite/scripts/dev.sh:1).
- Unfiltered `pnpm dev` starts:
  - API via `wrangler dev` on `8787`.
  - Admin via `vite dev` on `4323`.
  - Storefront via `astro dev` on `4322`.
- Starts are staggered to avoid inspector-port conflicts, and local state is shared through `../../.wrangler/state` in the API and framework adapters.
- Local transport differs from production:
  - Admin falls back to HTTP if `env.API` is absent.
  - Storefront explicitly disables service-binding use in local dev and falls back to HTTP because each worker runs in a separate local process.

### Build / Deploy

- Root `pnpm build` runs root `prebuild`, then `turbo build`:
  - API build is `wrangler deploy --dry-run --outdir dist` in [apps/api/package.json](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/package.json:7).
  - Admin build is `vite build` in [apps/admin-v2/package.json](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/package.json:7).
  - Storefront build is `node scripts/generate-build-id.js && astro check && astro build` in [apps/storefront/package.json](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/package.json:7).
- Full deploy is centralized in [scripts/deploy.mjs](/Users/arob/Desktop/open/scalius-commerce-lite/scripts/deploy.mjs:65):
  - `pnpm typecheck`
  - `pnpm build`
  - `wrangler d1 migrations apply`
  - `wrangler deploy` for API, admin, storefront
- The D1 database name is sourced from the API Wrangler config in [scripts/deploy.mjs](/Users/arob/Desktop/open/scalius-commerce-lite/scripts/deploy.mjs:33), making the API worker the de facto infra owner for D1 migrations.

### Queue / Cron Composition

- API Worker owns all queues in [apps/api/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/wrangler.jsonc:46):
  - `PAYMENT_EVENTS_QUEUE`
  - `ORDER_NOTIFICATIONS_QUEUE`
  - `AUTH_OTP_QUEUE`
  - `ORDER_INGEST_QUEUE`
- Queue dispatch lands in [apps/api/src/queue-consumer.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/queue-consumer.ts:113), which routes into `@scalius/core` handlers.
- Scheduled inventory cleanup is the only cron I found and is defined in [apps/api/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/wrangler.jsonc:96) and implemented in [apps/api/src/worker.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/worker.ts:21).

## Key Control Flows

### Admin Request Path

1. Browser hits admin Worker route under `/api/v1/admin/*`.
2. TanStack Start server handler in [apps/admin-v2/src/routes/api/v1/admin/$.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/v1/admin/$.ts:47) forwards the request.
3. In production, forwarding is via `env.API.fetch()` to the API Worker.
4. API Hono app handles auth/validation/route dispatch in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:247).
5. Route code delegates into `@scalius/core` and `@scalius/database`.

### Storefront SSR Request Path

1. Browser hits the Astro storefront Worker.
2. Middleware hydrates per-request runtime env into AsyncLocalStorage in [apps/storefront/src/middleware.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/middleware.ts:275).
3. Storefront server code resolves API base/bindings via [apps/storefront/src/lib/api/runtime-env.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/api/runtime-env.ts:28) and [apps/storefront/src/lib/api/client.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/api/client.ts:31).
4. In production SSR, requests go through `env.BACKEND_API.fetch()`. In local dev they drop to HTTP fetch.

### Queue Processing Path

1. API routes or webhooks enqueue onto queue bindings declared in [apps/api/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/wrangler.jsonc:47).
2. `queue()` in [apps/api/src/worker.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/worker.ts:17) hands the batch to [apps/api/src/queue-consumer.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/queue-consumer.ts:113).
3. The consumer fans out to shared module handlers in `@scalius/core`.

### Deploy Path

1. Operator runs `pnpm deploy`.
2. [scripts/deploy.mjs](/Users/arob/Desktop/open/scalius-commerce-lite/scripts/deploy.mjs:107) typechecks and builds the whole repo.
3. D1 migrations are applied from the API worker’s config.
4. Each worker is deployed independently with its own Wrangler config.

## Findings

### [P1] Turbo cache keys are incomplete for real build and typecheck inputs

- The repo overrides Turbo `inputs` for both `build` and `typecheck` in [turbo.json](/Users/arob/Desktop/open/scalius-commerce-lite/turbo.json:5) and [turbo.json](/Users/arob/Desktop/open/scalius-commerce-lite/turbo.json:19) without using `$TURBO_DEFAULT$`.
- Turborepo’s current docs state that specifying `inputs` opts out of the default tracked-file behavior, and `$TURBO_DEFAULT$` is required to restore it.
- This repo has known build-time inputs outside the declared globs:
  - Storefront build depends on [apps/storefront/scripts/generate-build-id.js](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/scripts/generate-build-id.js:1) via [apps/storefront/package.json](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/package.json:9).
  - Root `prebuild` copies static flag assets in [scripts/copy-flags.mjs](/Users/arob/Desktop/open/scalius-commerce-lite/scripts/copy-flags.mjs:9) before `turbo build`.
  - Storefront build-time config reads Wrangler config dynamically in [apps/storefront/src/lib/image-config.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/image-config.ts:24).
- Because those files are outside the declared task inputs, Turbo can legally return cache hits after relevant checked-in file changes, restoring stale outputs.
- This is especially risky here because the monorepo uses source-imported packages and custom build-time scripts instead of purely compiled package artifacts.

### [P1] Storefront `BUILD_ID` generation is inside a cached build task, which breaks the “new ID every build” contract

- The storefront build script runs `node scripts/generate-build-id.js && astro check && astro build` in [apps/storefront/package.json](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/package.json:9).
- The script itself says the intent is to generate a unique build ID on every build/deploy so middleware can detect deployments and purge cache in [apps/storefront/scripts/generate-build-id.js](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/scripts/generate-build-id.js:3).
- But storefront `build` is still a normal cached Turbo task in [turbo.json](/Users/arob/Desktop/open/scalius-commerce-lite/turbo.json:5).
- On a cache hit, Turbo restores outputs and skips the build command entirely. That means `generate-build-id.js` does not run, so the `BUILD_ID` stays frozen to whatever value existed when the cache entry was created.
- That undermines the stated deployment invariant for cache invalidation and makes build behavior depend on Turbo cache state instead of on an actual deployment event.

### [P2] The storefront worker appears to need a `SESSION` KV binding, but its Wrangler config and env types do not declare one

- Storefront Wrangler config declares `ASSETS`, `CACHE_CONTROL`, and `BACKEND_API` only in [apps/storefront/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/wrangler.jsonc:23).
- Storefront `Env` type also declares only `ASSETS`, `CACHE_CONTROL`, and `BACKEND_API` in [apps/storefront/src/env.d.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/env.d.ts:68).
- During the verified `pnpm build` run on 2026-04-22, the Astro Cloudflare adapter logged: `Enabling sessions with Cloudflare KV with the "SESSION" KV binding.`
- That is a runtime-config mismatch until proven otherwise: the build/runtime toolchain believes a `SESSION` KV binding exists or should exist, but the checked-in worker config and checked-in `Env` type do not define it.
- If any Astro session-backed feature is active in production, this is a likely runtime failure surface rather than a mere type hygiene issue.

### [P2] Worker binding typings are hand-maintained and already drift from Wrangler config

- I did not find any generated `worker-configuration.d.ts` / Wrangler types artifacts in the repo.
- Only admin exposes a manual `cf-typegen` script in [apps/admin-v2/package.json](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/package.json:10), but there is no repo-level `wrangler types --check` enforcement.
- The drift is already real, not hypothetical:
  - API Wrangler declares `SESSION` in [apps/api/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/wrangler.jsonc:26), but API `Env` omits it in [apps/api/src/env.d.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/env.d.ts:152).
  - API Hono env typing includes an `ASSETS` binding that the API Worker does not declare in [apps/api/src/hono-env.d.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/hono-env.d.ts:30).
  - Storefront `Env` omits the adapter-reported `SESSION` binding in [apps/storefront/src/env.d.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/env.d.ts:68).
- Cloudflare’s current guidance is to use `wrangler types` so the binding interface stays aligned with real config. The current setup does the opposite: comments say “must stay in sync”, but the source of truth is manual and already out of sync.

### [P2] Root verification leaves the admin worker and Workers-specific runtime behavior under-covered

- Root `lint` is `turbo lint` in [package.json](/Users/arob/Desktop/open/scalius-commerce-lite/package.json:24), but admin has no `lint` script at all in [apps/admin-v2/package.json](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/package.json:6).
- I verified this by running `pnpm lint`: Turbo only launched lint tasks for API and storefront, not admin.
- Root `test` is plain `vitest run --passWithNoTests` in [package.json](/Users/arob/Desktop/open/scalius-commerce-lite/package.json:25).
- The test harness is Node Vitest config in [tests/vitest.config.ts](/Users/arob/Desktop/open/scalius-commerce-lite/tests/vitest.config.ts:1), not Workers-runtime testing.
- The private test README explicitly says integration directories are empty in [tests/README.md](/Users/arob/Desktop/open/scalius-commerce-lite/tests/README.md:28), and says integration tests are only intended to use miniflare later in [tests/README.md](/Users/arob/Desktop/open/scalius-commerce-lite/tests/README.md:92).
- Current Cloudflare best practices recommend `@cloudflare/vitest-pool-workers` for catching missing bindings / compatibility mismatches. Right now the repo’s green root test signal mostly covers business logic in Node, not worker runtime composition.

### [P3] Observability is enabled at the implicit default sampling rate on all three workers

- API, admin, and storefront all set only `"observability": { "enabled": true }` in:
  - [apps/api/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/wrangler.jsonc:15)
  - [apps/admin-v2/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/wrangler.jsonc:10)
  - [apps/storefront/wrangler.jsonc](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/wrangler.jsonc:16)
- Cloudflare’s current docs say `head_sampling_rate` defaults to `1` when omitted.
- For the storefront and API in particular, that means full log/traces capture unless the platform-side defaults differ from the docs. This is more of a cost/noise/retention issue than a correctness failure, but it is worth fixing deliberately instead of accepting implicitly.

## Odd Complexity / Inefficiency Notes

- Local dev is intentionally heterogeneous: API uses `wrangler dev`, admin uses the Cloudflare Vite plugin via `vite dev`, and storefront uses `astro dev`. That works, but it guarantees local runtime behavior will differ from production service-binding composition in at least some scenarios.
- Storefront runtime env access uses AsyncLocalStorage plus Cloudflare env imports plus global fallbacks in [apps/storefront/src/lib/api/runtime-env.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/api/runtime-env.ts:1) and [apps/storefront/src/middleware.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/middleware.ts:275). It is thoughtful, but it is also a sign that runtime configuration flow has become harder than it should be.
- The dev shutdown path in [scripts/dev.sh](/Users/arob/Desktop/open/scalius-commerce-lite/scripts/dev.sh:13) uses `pkill -9 -f "workerd"`, which can kill unrelated local Cloudflare workers outside this repo.
- Deploy entrypoints are inconsistent:
  - Full deploy goes through [scripts/deploy.mjs](/Users/arob/Desktop/open/scalius-commerce-lite/scripts/deploy.mjs:107).
  - Single-app deploys go through root `turbo deploy` scripts in [package.json](/Users/arob/Desktop/open/scalius-commerce-lite/package.json:13).
  - Admin package deploy also does its own build again in [apps/admin-v2/package.json](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/package.json:10), so the single-app deploy path is less predictable and less efficient than the full deploy path.

## Prioritized Follow-Ups

1. Fix Turbo cache correctness first.
   - Add `$TURBO_DEFAULT$` back into `build` and `typecheck` inputs.
   - Add missing inputs for `public/**`, build scripts, and any checked-in generated/config files that affect outputs.
   - Audit whether source-imported workspace packages need a transit-node pattern for `typecheck`.
2. Move storefront `BUILD_ID` generation out of the cached `build` task.
   - Generate it in a non-cached deploy/predeploy step, or make the cache key intentionally incorporate a deploy-specific input.
3. Resolve the storefront `SESSION` binding ambiguity.
   - Either declare the binding in Wrangler and types, or disable/remove the adapter behavior that expects it.
4. Stop hand-maintaining Worker env types as the source of truth.
   - Generate types from Wrangler for all three workers.
   - Add `wrangler types --check` to CI or at least to repo-level verification.
5. Close the verification gap.
   - Add admin `lint`.
   - Decide whether admin should also have `test`.
   - Add at least one Workers-runtime test suite for bindings/service-binding behavior.
6. Set explicit observability sampling for each worker instead of relying on the implicit default.
7. Simplify developer entrypoints.
   - Prefer one documented deploy path and one documented local-dev pattern where possible.

## Bottom Line

- The high-level architecture is coherent: API is the backend system of record, admin and storefront are thin Cloudflare Worker frontends, and service bindings are used in the right production paths.
- The biggest repo-level risks are not the topology itself; they are cache correctness, binding/type source-of-truth drift, and incomplete verification of worker-runtime behavior.
