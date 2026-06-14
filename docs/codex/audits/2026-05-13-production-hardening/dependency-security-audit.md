# Dependency and Security Production-Readiness Audit

Date: 2026-05-13
Scope: package manifests, pnpm lock/overrides, audit metadata, Wrangler/toolchain drift, risky scripts, and exposed-secret patterns.
Commands run: `pnpm audit --json`, `pnpm outdated --recursive --format json`, `pnpm exec wrangler --version`, `which wrangler`, manifest/lockfile line inspection.

## Summary

`pnpm audit --json` currently reports 86 advisories across 1348 dependencies: 2 critical, 36 high, 43 moderate, and 5 low. This is not production-clean. Several vulnerable packages are runtime-facing (`drizzle-orm`, `hono`, `fast-xml-parser`, Astro/Cloudflare adapter), while others are build/tooling risks that can still affect deploy integrity or developer machines.

## Top Findings

### 1. Critical: API client generator pulls vulnerable Handlebars

- Evidence: `packages/api-client/package.json:22` declares `@hey-api/openapi-ts`; `pnpm-lock.yaml:8222` resolves `@hey-api/openapi-ts@0.66.7`, and `pnpm-lock.yaml:8227` resolves `handlebars: 4.7.8`.
- Audit: Handlebars has multiple advisories, including critical `CVE-2026-33937`; patched version is `>=4.7.9`.
- Impact: SDK generation is a build-time code-generation path. A compromised or malicious OpenAPI/template input could execute or emit unsafe code during generation.
- Recommended fix: upgrade `@hey-api/openapi-ts` from `0.66.7` to the current compatible release, regenerate the SDK, and only use a temporary `pnpm.overrides.handlebars = ">=4.7.9"` if the generator cannot be upgraded immediately.

### 2. Critical/High: Firebase dependency path carries vulnerable protobufjs

- Evidence: Firebase is declared in `apps/admin-v2/package.json:69`, `apps/api/package.json:34`, and `packages/core/package.json:61`. The lockfile resolves `protobufjs@7.5.4` at `pnpm-lock.yaml:5897` and under Firebase/Firestore at `pnpm-lock.yaml:8199`.
- Audit: `protobufjs@7.5.4` has critical arbitrary-code-execution and several high DoS/prototype/code-generation advisories; patched versions are `>=7.5.6` for the newer advisories.
- Impact: Firebase admin/dashboard functionality drags in a known vulnerable parser/codegen dependency. Even if exploitability depends on schema/message control, this should not ship in a production commerce platform.
- Recommended fix: upgrade Firebase across admin/API/core to the latest compatible version and pin `pnpm.overrides.protobufjs = ">=7.5.6"` plus `@protobufjs/utf8 = ">=1.1.1"` until the lockfile proves the transitive path is clean.

### 3. High: Runtime commerce API dependencies are below security patches

- Evidence: `drizzle-orm` is declared at `apps/admin-v2/package.json:68`, `apps/api/package.json:32`, `packages/core/package.json:59`, and `packages/database/package.json:15`; lockfile resolves `0.45.1` at `pnpm-lock.yaml:4397`. `hono` is declared at `apps/api/package.json:35`; lockfile resolves `4.12.7` at `pnpm-lock.yaml:4902`. `fast-xml-parser` is declared at `apps/api/package.json:33` and `packages/core/package.json:60`; lockfile resolves `5.5.5` at `pnpm-lock.yaml:4708`.
- Audit: `drizzle-orm <0.45.2` has a high SQL identifier injection advisory; `hono <4.12.18` has multiple cookie/body/cache/JSX advisories; `fast-xml-parser <5.7.0` has high/moderate XML entity and builder injection advisories.
- Impact: These are not just local dev packages. They sit in request handling, persistence, webhook/payment XML parsing, and admin/API paths.
- Recommended fix: upgrade `drizzle-orm` to `>=0.45.2`, `hono` to `>=4.12.18`, `fast-xml-parser` to `>=5.8.0`, then run API/core/database/admin typechecks and payment/webhook regression tests.

### 4. High: Override policy is stale and does not satisfy current patched versions

- Evidence: root `package.json:63-74` defines `pnpm.overrides`; `pnpm-lock.yaml:7-17` shows these are the active lockfile overrides. Several are now too low: `undici >=7.18.2` at `package.json:72` while audit requires `>=7.24.0`; `h3 >=1.15.5` at `package.json:69` while audit needs `>=1.15.9` and `>=2.0.1-rc.18`; `lodash >=4.17.23` at `package.json:71` is still reported vulnerable by audit metadata.
- Evidence: root `package.json:41-45` also has a separate top-level `overrides` block for React, but pnpm's effective override block is `package.json:63-74`, making ownership confusing.
- Impact: The project has an override mechanism, but it is giving a false sense of safety. Some overrides are below patched versions or are not reflected in the effective pnpm override block.
- Recommended fix: consolidate all overrides under `pnpm.overrides`, pin exact patched floors from the latest audit, and add a CI gate that fails on critical/high advisories.

### 5. High: A live-looking dashboard credential is committed in an audit playbook

- Evidence: `audit/VERIFICATION_PLAYBOOK.md:109-111` includes a production dashboard login email/password pair in plaintext.
- Impact: Even if the credential was user-provided for testing, it is now source-controlled knowledge. It can leak through screenshots, search, LLM context, forks, or logs.
- Recommended fix: rotate the account password immediately, remove the plaintext credential, replace it with "use a password-manager shared test admin", and scrub repository history if this repo is shared outside the trusted team.

## Additional Findings

### 6. High: Purge token is placed in a URL query string

- Evidence: API cache clearing appends `PURGE_TOKEN` as `?token=` in `apps/api/src/routes/cache.ts:131-137`. Storefront accepts the purge secret from the URL in `apps/storefront/src/pages/api/purge-cache.ts:115-122`; POST still reads the secret from runtime at `apps/storefront/src/pages/api/purge-cache.ts:192-195`.
- Impact: Secrets in URLs are more likely to leak via access logs, browser history, analytics, CDN logs, and error telemetry.
- Recommended fix: remove GET purge auth, use POST only, send `Authorization: Bearer <token>` or `X-Purge-Token`, and compare with timing-safe logic.

### 7. Medium: Cloudflare toolchain was behind current releases and version ownership was inconsistent

- Current status on 2026-06-14: app manifests align on `wrangler@^4.100.0`; packages that declare Workers types use `@cloudflare/workers-types@4.20260613.1`; the deploy script runs app-local `pnpm exec wrangler` for build/deploy steps and deploy output confirmed Wrangler `4.100.0`.
- Remaining caveat: `pnpm exec wrangler --version` at the repo root can still resolve a globally installed Wrangler because Wrangler is app-local rather than a root devDependency. Prefer root deploy scripts or app-local workspace commands, not ad hoc root Wrangler calls.
- Recommended fix if root ad hoc Wrangler usage becomes common: add a root wrapper script that runs the target app's locked Wrangler and fails if the resolved version differs from the app manifests.

### 8. Medium: Storefront and admin build tooling had dev-server advisories

- Current status on 2026-06-14: admin Vite is `8.0.16`; storefront Astro is `6.4.6`; `@astrojs/cloudflare` is `13.7.0`; storefront Vite is `7.3.5`.
- Package freshness check: `pnpm outdated -r` reports only storefront `vite@7.3.5` versus latest `8.0.16`. This is an intentional hold because the current storefront Astro/Cloudflare adapter line declares Vite `^7.3.2` compatibility for that app.
- Recommended fix: revisit storefront Vite 8 only when the Astro/Cloudflare adapter line advertises compatible Vite 8 support for the storefront runtime.

### 9. Medium: Deploy script applies remote migrations as part of deploy without a production safety gate

- Evidence: `scripts/deploy.mjs:115-118` applies D1 migrations to remote before worker deploy; `scripts/deploy.mjs:121-124` then deploys all workers.
- Impact: A failed deployment after a successful migration can leave production DB schema ahead of deployed code. There is no explicit backup/export, confirmation, migration dry-run, or environment guard.
- Recommended fix: split production migrations into an explicit preflight step, require `--yes-production` or CI-only environment confirmation, export/backup D1 before migration, then deploy workers after the new code is built and ready.

### 10. Low/Medium: Standalone storefront deploy helper uses `npx`

- Evidence: `apps/storefront/scripts/deploy.mjs:38-44` invokes `npx astro`, `npx wrangler` instead of `pnpm exec`.
- Impact: If this helper is used, `npx` may resolve differently than the locked workspace toolchain and can fetch/use unexpected versions.
- Recommended fix: either delete this helper if unused or rewrite it to use `pnpm exec astro` and `pnpm exec wrangler` from the workspace package.

### 11. Low: Dev wrapper kills all local `workerd` processes

- Evidence: `scripts/dev.sh:14-15` kills dev ports and then `pkill -9 -f "workerd"`.
- Impact: Not a production exploit, but it can kill unrelated local Cloudflare Workers sessions and make debugging misleading.
- Recommended fix: track child PIDs launched by this script and terminate only those plus known project ports.

## Recommended Remediation Order

1. Rotate/remove the committed dashboard credential.
2. Upgrade/override critical packages: `handlebars`, `protobufjs`, `@protobufjs/utf8`.
3. Patch runtime dependencies: `drizzle-orm`, `hono`, `fast-xml-parser`.
4. Upgrade Astro/Cloudflare/Vite/Wrangler/tooling and align root/app toolchain ownership.
5. Replace purge query-token auth with header-based POST-only auth.
6. Add CI gates: `pnpm audit --prod --audit-level high`, full `pnpm typecheck`, focused API/storefront build checks, and a locked Wrangler version check.

## Verification After Fixes

- `pnpm install --lockfile-only`
- `pnpm audit --json`
- `pnpm --filter @scalius/api typecheck`
- `pnpm --filter @scalius/core typecheck`
- `pnpm --filter @scalius/database typecheck`
- `pnpm --filter @scalius/admin-v2 typecheck`
- `pnpm --filter @scalius/storefront typecheck`
- `pnpm --filter @scalius/api build`
- `pnpm --filter @scalius/admin-v2 build`
- `pnpm --filter @scalius/storefront build`
- Browser smoke tests for dashboard auth, cache purge after content edits, checkout/payment webhook paths, and storefront product/page rendering.
