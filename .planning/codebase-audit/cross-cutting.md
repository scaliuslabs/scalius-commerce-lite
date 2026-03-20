# Cross-Cutting Patterns & Architecture Audit

**Analysis Date:** 2026-03-20
**Branch:** mono-repo
**Auditor scope:** Import consistency, response envelope, validation, error handling, package exports, TypeScript configs, naming, dead code, turbo config

---

## Summary

The codebase demonstrates strong architectural consistency across the monorepo. The recent hardening effort (242 route conversions to `ok()`/`created()`/`ApiError`) has paid off -- every non-webhook route file imports from `api-response.ts`. Import conventions match CLAUDE.md prescriptions. The main issues are: (1) a handful of `c.json()` calls in webhook and order routes that bypass the envelope, (2) 48+ `as any` casts concentrated in `db.batch()` calls and OpenAPI handler typing, (3) a phantom export in `@scalius/core` package.json for a deleted file, (4) inline Zod schemas in settings routes rather than shared `.validation.ts` files, and (5) the storefront is missing a `typecheck` script.

**Health rating:** 8/10 -- well-standardized with a few identified gaps.

---

## Critical Issues

### 1. Phantom Package Export: `@scalius/core/notification-utils`

**Severity:** Medium -- will cause runtime import failure if anyone uses this path.

`packages/core/package.json` declares:
```json
"./notification-utils": "./src/notification-utils.ts"
```

But `packages/core/src/notification-utils.ts` does **not exist**. The comment in `packages/core/src/modules/notifications/notifications.service.ts` says this was "extracted from src/lib/notification-utils.ts" -- the old path was never cleaned from the export map.

**Fix:** Remove the `"./notification-utils"` entry from `packages/core/package.json` exports. No consumers import it.

### 2. Storefront Missing `typecheck` Script

**Severity:** Medium -- `pnpm typecheck` at the root via Turbo will skip storefront type checking.

`apps/storefront/package.json` has no `"typecheck"` script. Admin (`astro check`), API (`tsc --noEmit`), database, core, and shared all have one. The storefront build does include `astro check`, but Turbo's `typecheck` task cannot invoke it independently.

**Files:** `apps/storefront/package.json`
**Fix:** Add `"typecheck": "astro check"` to the scripts section.

### 3. Duplicate Error Handler in `apps/api/src/app.ts`

**Severity:** Low -- functionally redundant but not harmful. The file registers both `app.onError()` (lines 84-111) AND a `app.use("*")` try/catch middleware (lines 157-202). Both handle `ApiError` identically. The middleware fires first for most errors; `onError` is a fallback for Hono-internal errors.

**File:** `apps/api/src/app.ts`
**Fix:** Consider removing the middleware error handler and relying solely on `app.onError()`, or add a comment explaining why both exist. The duplication is intentional but undocumented.

---

## Import Pattern Consistency

### Convention (from CLAUDE.md)

```typescript
import { getDb } from "@scalius/database/client";
import { products } from "@scalius/database/schema";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { cn } from "@scalius/shared/utils";
import type { Product } from "@scalius/api-client/types";
import { SomeComponent } from "@/components/SomeComponent";
```

### Findings

**API app** -- Fully compliant. All 70+ route files use the prescribed deep import paths:
- `@scalius/database/schema` for schema tables and enums
- `@scalius/database/client` for `getDb()` and `Database` type
- `@scalius/core/modules/{domain}/{file}` for service functions
- `@scalius/shared/{module}` for utility functions
- No barrel `@scalius/core` or `@scalius/database` imports (correct -- uses subpath exports)

**Admin app** -- Compliant. 20+ files sampled. Uses:
- `@scalius/shared/utils` for `cn()` (most common import, ~40+ files)
- `@scalius/core/auth` and `@scalius/core/auth/rbac/*` for auth/permissions
- `@scalius/core/modules/orders` for `OrderListItem` type (via barrel)
- `@/` alias for local imports

**Storefront app** -- Compliant and correctly restricted. Zero imports from `@scalius/core` or `@scalius/database`. Uses only:
- `@scalius/shared/*` for utilities (`currency`, `utils`, `customer-utils`, etc.)
- `@scalius/api-client/sdk` for SDK functions
- `@scalius/api-client/factory` for client creation
- `@/` alias for local imports

### Import style variance

Two patterns coexist for importing from core modules:
1. **Via barrel**: `import type { OrderListItem } from "@scalius/core/modules/orders"` (admin)
2. **Via direct file**: `import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service"` (API routes)

Both resolve correctly due to the wildcard export map (`"./modules/*": "./src/modules/*/index.ts"` and `"./modules/*/*": "./src/modules/*/*.ts"`). This is intentional and working.

### Verdict: PASS -- no violations found

---

## Response Envelope Compliance

### Convention

All success responses use `ok(c, data)` / `created(c, data)` / `noContent(c)` from `apps/api/src/utils/api-response.ts`. The envelope is `{ success: true, data: T }`.

### Findings

**61 of 69 route files** import from `api-response.ts` -- near-complete coverage.

**Files NOT importing `api-response.ts`:**
- `apps/api/src/routes/webhooks/stripe.ts` -- Expected. Webhook handlers return `{ received: true }` to the external service.
- `apps/api/src/routes/webhooks/sslcommerz.ts` -- Expected. Same pattern.
- `apps/api/src/routes/webhooks/polar.ts` -- Expected. Returns `{ received: true }` or `{ error: "..." }`.
- `apps/api/src/routes/webhooks/pathao.ts` -- Expected. Returns delivery webhook acknowledgments.
- `apps/api/src/routes/webhooks/steadfast.ts` -- Expected. Returns `{ status: "success", message: "..." }`.
- `apps/api/src/routes/admin/ai-prompts.ts` -- Returns `c.text()` (plain text), not JSON. Acceptable.
- `apps/api/src/routes/admin/settings.ts` -- Router-only file, delegates to sub-routes. Correct.
- `apps/api/src/routes/partytown-proxy.ts` -- Proxy route that forwards responses. Uses `c.json()` for error cases only.

**Manual `c.json()` calls in non-webhook routes (potential envelope violations):**

1. `apps/api/src/routes/orders.ts:186` -- `c.json({ success: true, data: { status: "processing"... } }, 202)` -- Correct pattern for 202 per CLAUDE.md convention.
2. `apps/api/src/routes/orders.ts:321` -- `c.json({ success: true, data: { checkoutToken, orderId, ... } }, 202)` -- Correct 202 pattern.
3. `apps/api/src/routes/partytown-proxy.ts:82,91,110,158` -- Error responses for proxy failures. These return raw `{ error: "..." }` without the `{ success: false, error: { code, message } }` structure. Low severity since this is a Partytown proxy consumed by analytics scripts, not the admin/storefront.

**Admin route files:** Zero `c.json()` calls found. All use `ok()`/`created()`/`noContent()`. Complete compliance.

### Verdict: PASS -- webhook exceptions are expected; partytown proxy is minor

---

## Validation Pattern Consistency

### Convention

Zod schemas for domain entities live in `packages/core/src/modules/{domain}/{domain}.validation.ts`. API routes use `@hono/zod-openapi`'s `createRoute()` with `z` for request/response schema definitions.

### Findings

**12 `.validation.ts` files** exist in core, covering all major domains:
- `products.validation.ts`, `orders.validation.ts`, `customers.validation.ts`
- `categories.validation.ts`, `collections.validation.ts`, `discounts.validation.ts`
- `inventory.validation.ts`, `pages.validation.ts`, `widgets.validation.ts`
- `analytics.validation.ts`, `media.validation.ts`, `attributes.validation.ts`

**Route-level schemas:** API routes define route-specific Zod schemas inline using `z` from `@hono/zod-openapi`. This is the OpenAPI pattern -- request schemas are defined in the route file for `createRoute()`. This is correct for Hono OpenAPI routes.

**Settings routes have significant inline schemas:** Files in `apps/api/src/routes/admin/settings/` define many Zod schemas inline (e.g., `payments.ts` has 8+ inline schemas, `system.ts` has 6+, `meta-conversions-admin.ts` has 5+). These settings schemas have no corresponding `.validation.ts` file in core. This is a deliberate tradeoff: settings are admin-only CRUD operations that don't need domain-layer validation reuse.

**Shared response schema utilities:** `apps/api/src/schemas/responses.ts` provides `successEnvelope()`, `paginatedEnvelope()`, `errorResponses`, `messageResponse`, `idResponse`, and `noContentResponse`. Used by 64 route files -- excellent adoption.

### Verdict: PASS -- domain validation properly separated; route-level OpenAPI schemas are expected

---

## Error Handling Consistency

### Convention

- Services in `@scalius/core` throw typed error classes from `@scalius/core/errors` (`NotFoundError`, `ValidationError`, etc.)
- API routes either throw these errors (caught by global handler) or use them from `apps/api/src/utils/api-error.ts` (which re-exports from core)
- Global error handler in `apps/api/src/app.ts` catches `ApiError` and returns `{ success: false, error: { code, message, details } }`

### Findings

**Core services:** 25+ service files import from `@scalius/core/errors`. Consistent usage of `NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError`.

**API routes:** 40+ route files import from `api-error.ts`. All use typed error classes for throw statements.

**Raw `throw new Error()` in API routes (6 occurrences):**
- `apps/api/src/routes/admin/openrouter.ts:38` -- "Failed to fetch models from OpenRouter" -- should be `ServiceUnavailableError`
- `apps/api/src/routes/admin/auth-management.ts:166` -- "Could not create admin user" -- caught by global handler, returns 500
- `apps/api/src/routes/admin/auth-management.ts:179` -- Missing config error -- should be `ValidationError`
- `apps/api/src/routes/admin/auth-management.ts:598` -- "Could not create user account" -- caught by global handler
- `apps/api/src/routes/admin/ai-prompts.ts:46,52` -- Prompt fetch failures -- caught and re-thrown

These raw `throw new Error()` calls are caught by the global error handler and returned as `{ success: false, error: { code: "INTERNAL_ERROR" } }`. They work but lose semantic HTTP status codes (all become 500).

**`as any` casts (48 total across API routes + core):**
- **API routes (26 occurrences, 13 files):** Primarily `(async (c: any) => { ... }) as any` pattern in OpenAPI handlers. This is a known workaround for Hono OpenAPI type inference limitations when handler return types are complex.
- **Core services (22 occurrences, 14 files):** Primarily `db.batch(statements as any)` -- Drizzle's `batch()` generic type is strict about tuple lengths, so this cast is standard practice.

### Verdict: MOSTLY PASS -- 6 raw `throw new Error()` calls should use typed errors; `as any` casts are pragmatic workarounds

---

## Package Export Maps

### `@scalius/database` (`packages/database/package.json`)

```json
{
  "./schema": "./src/schema/index.ts",
  "./client": "./src/client.ts",
  "./types": "./src/types.ts"
}
```

Clean and minimal. The `./types` export is declared but only imported in READMEs (not actual code). The `Database` type is re-exported from `./client`, so `./types` is technically redundant but harmless.

### `@scalius/core` (`packages/core/package.json`)

```json
{
  "./errors": "./src/errors/index.ts",
  "./modules/*": "./src/modules/*/index.ts",
  "./modules/*/*": "./src/modules/*/*.ts",
  "./auth": "./src/auth/index.ts",
  "./auth/rbac": "./src/auth/rbac/index.ts",
  "./auth/rbac/*": "./src/auth/rbac/*.ts",
  "./integrations/*": "./src/integrations/*.ts",
  "./integrations/email/*": "./src/integrations/email/*.ts",
  "./integrations/firebase/*": "./src/integrations/firebase/*.ts",
  "./integrations/meta/*": "./src/integrations/meta/*.ts",
  "./providers": "./src/providers/index.ts",
  "./providers/*": "./src/providers/*/index.ts",
  "./providers/*/*": "./src/providers/*/*.ts",
  "./search": "./src/search/index.ts",
  "./middleware-helper/*": "./src/middleware-helper/*.ts",
  "./notification-utils": "./src/notification-utils.ts",  // BROKEN: file does not exist
  "./utils/*": "./src/utils/*.ts"
}
```

**Issue:** `"./notification-utils"` points to a deleted file. See Critical Issue #1.

**Observation:** The `./providers` paths are exported but only `packages/core/src/providers/index.ts` self-references them in a comment. No consumers import `@scalius/core/providers`. The universal provider registry is partially implemented (email + payment migrated; delivery + SMS not yet).

### `@scalius/shared` (`packages/shared/package.json`)

```json
{
  "./*": "./src/*.ts"
}
```

Simple wildcard. Works for all 19 utility modules. Clean.

### `@scalius/api-client` (`packages/api-client/package.json`)

```json
{
  ".": "./src/index.ts",
  "./types": "./src/generated/types.gen.ts",
  "./sdk": "./src/generated/sdk.gen.ts",
  "./client": "./src/generated/client.gen.ts",
  "./factory": "./src/client-factory.ts"
}
```

Well-structured. Storefront uses `./factory` and `./sdk`; admin uses `./types`. All paths are consumed.

### `@scalius/tsconfig` (`packages/tsconfig/package.json`)

```json
{
  "./base.json": "./base.json",
  "./worker.json": "./worker.json",
  "./astro.json": "./astro.json"
}
```

Complete coverage for all config variants.

### Verdict: One broken export (`notification-utils`); one unused export path (`providers`). Otherwise clean.

---

## TypeScript Configuration

### Shared Configs

| Config | File | Used By |
|--------|------|---------|
| `base.json` | `packages/tsconfig/base.json` | `@scalius/shared`, `@scalius/api-client` |
| `worker.json` | `packages/tsconfig/worker.json` (extends base) | `@scalius/database`, `@scalius/core`, `@scalius/api` |
| `astro.json` | `packages/tsconfig/astro.json` (extends base) | **NOT USED** |

**Key settings (base.json):** `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`, `moduleResolution: "bundler"`, `target: "ES2022"`, `jsx: "react-jsx"`

### Per-App Configs

| App/Package | Extends | Path Aliases |
|-------------|---------|--------------|
| `@scalius/api` | `@scalius/tsconfig/worker.json` | `@/*`, `@scalius/core/*`, `@scalius/database/*`, `@scalius/shared/*` |
| `@scalius/admin` | `astro/tsconfigs/strict` | `@/*`, `@scalius/core/*`, `@scalius/database/*`, `@scalius/shared/*` |
| `@scalius/storefront` | `astro/tsconfigs/strict` | `@/*` only |
| `@scalius/core` | `@scalius/tsconfig/worker.json` | `@scalius/core/*`, `@scalius/database/*`, `@scalius/shared/*` |
| `@scalius/database` | `@scalius/tsconfig/worker.json` | `@scalius/database/*` |
| `@scalius/shared` | `@scalius/tsconfig/base.json` | None |
| `@scalius/api-client` | `@scalius/tsconfig/base.json` | None |

### Observations

1. **`@scalius/tsconfig/astro.json` is unused.** Both admin and storefront extend `astro/tsconfigs/strict` directly, duplicating `jsx: "react-jsx"` and `jsxImportSource: "react"` settings that `astro.json` already provides. Consider having them extend `@scalius/tsconfig/astro.json` instead.

2. **Admin and storefront use different base configs than other packages.** They extend Astro's strict config instead of the shared tsconfig. This is correct for Astro projects but means they don't inherit `noUncheckedIndexedAccess` or other base settings.

3. **Storefront has minimal path aliases.** Only `@/*` -- no `@scalius/*` mappings. This is correct because storefront doesn't import `@scalius/core` or `@scalius/database` (resolution happens via pnpm workspace protocol at bundler level).

### Verdict: PASS -- configs are appropriate for each workspace; `astro.json` is dead code

---

## Naming Conventions

### File Naming

| Area | Convention | Examples |
|------|-----------|----------|
| Core services | `{domain}.{role}.ts` | `products.admin.ts`, `orders.storefront.ts`, `settings.service.ts` |
| Core validation | `{domain}.validation.ts` | `products.validation.ts`, `categories.validation.ts` |
| Core types | `{domain}.types.ts` | `products.types.ts`, `orders.types.ts`, `delivery/types.ts` |
| Core barrel | `index.ts` | All 20 module directories have one |
| API routes (public) | `{domain}.ts` | `products.ts`, `orders.ts`, `categories.ts` |
| API routes (admin) | `{domain}.ts` in `admin/` | `admin/products.ts`, `admin/orders.ts` |
| API routes (settings) | Descriptive kebab-case | `delivery-providers.ts`, `meta-conversions-admin.ts` |
| API routes (webhooks) | Provider name | `webhooks/stripe.ts`, `webhooks/polar.ts` |
| API routes (payments) | `{provider}-routes.ts` | `stripe-routes.ts`, `sslcommerz-routes.ts` |
| Schema files | `{domain}.ts` | `products.ts`, `orders.ts`, `auth.ts` |
| Admin components | PascalCase | `ProductRow.tsx`, `OrderView.tsx`, `WidgetForm.tsx` |
| Admin hooks | `use{Feature}.ts` | `useProductList.ts`, `useCurrency.ts` |
| Shared utilities | kebab-case | `price-utils.ts`, `customer-utils.ts`, `cors-helper.ts` |
| Config files | Standard names | `tsconfig.json`, `wrangler.jsonc`, `astro.config.mjs` |

### Function Naming

- **Services:** camelCase, verb-first (`getProducts`, `createOrder`, `deleteCategory`)
- **Validation schemas:** camelCase nouns (`createProductSchema`, `updateOrderSchema`)
- **Components:** PascalCase (`ProductRow`, `OrderView`)
- **Hooks:** `use` prefix (`useCurrency`, `useProductList`)
- **API helpers:** camelCase (`ok`, `created`, `noContent`, `extractApiError`, `unwrapEnvelope`)

### Inconsistency: Payment route file naming

Payment routes use `{provider}-routes.ts` (e.g., `stripe-routes.ts`) while all other routes use just `{domain}.ts`. This is minor but noticeable.

### Inconsistency: Admin component directory naming

Most admin component directories use kebab-case (`product-form/`, `order-list/`, `widget-list/`) but one uses camelCase (`adminLayout/`). The file within uses kebab-case (`sidebar/sidebar-state.ts`).

**File:** `apps/admin/src/components/admin/adminLayout/`

### Verdict: PASS -- highly consistent with two minor exceptions

---

## Dead Code / Unused Exports

### Unused `@scalius/shared` Modules

These shared modules are exported but have zero or near-zero external imports:

| Module | File | Imports Found |
|--------|------|--------------|
| `json-repair` | `packages/shared/src/json-repair.ts` | 0 (only in README) |
| `tag-parser` | `packages/shared/src/tag-parser.ts` | 0 (only in README) |
| `html-section-parser` | `packages/shared/src/html-section-parser.ts` | 0 (only in README) |
| `error-utils` | `packages/shared/src/error-utils.ts` | 0 (only in README) |

### Unused `@scalius/core` Export Paths

| Export | Notes |
|--------|-------|
| `./notification-utils` | **BROKEN** -- file deleted, export map not updated |
| `./providers`, `./providers/*`, `./providers/*/*` | Only self-referenced. Zero external consumers. Universal provider registry partially implemented per CLAUDE.md backlog. |

### Unused `@scalius/database` Export

| Export | Notes |
|--------|-------|
| `./types` | Only imported in README. `Database` type is available via `./client` re-export. |

### `@ts-ignore` Usage

4 occurrences across the codebase:
- `apps/admin/src/components/ui/container-text-flip.tsx:36`
- `apps/admin/src/pages/api/v1/[...path].ts:45` -- streaming request body typing
- `apps/storefront/src/pages/api/customer-auth/[...path].ts:68` -- same pattern
- `apps/storefront/src/components/header/DesktopNav.astro:244`

All are documented with comments explaining why. Acceptable.

### Verdict: 4 unused shared modules could be pruned; 1 broken core export needs fixing

---

## Turbo & Monorepo Configuration

### `turbo.json`

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "inputs": ["src/**", "package.json", "tsconfig.json", ...], "outputs": ["dist/**", ".astro/**"] },
    "dev": { "dependsOn": ["^build"], "cache": false, "persistent": true },
    "deploy": { "dependsOn": ["build"], "cache": false },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": { "dependsOn": ["^build"], "cache": true },
    "test": { "dependsOn": ["^build"], "cache": false },
    "generate": { "cache": false },
    "db:generate": { "cache": false },
    "db:migrate:local": { "cache": false },
    "db:migrate:remote": { "cache": false }
  }
}
```

**Observations:**

1. **`typecheck` task has no `cache` setting.** Defaults to `true` which is correct -- type checking is deterministic based on inputs.

2. **`typecheck` task has no `inputs` or `outputs`.** Without `inputs`, Turbo uses the default hashing which includes all files. Without `outputs`, it caches the exit code only (fine for typecheck). But adding `inputs: ["src/**", "tsconfig.json"]` would improve cache precision.

3. **`lint` task caches.** Correct -- ESLint is deterministic.

4. **Build inputs are comprehensive.** Includes `src/**`, `package.json`, `tsconfig.json`, `wrangler.jsonc`, `astro.config.mjs`, `*.config.*`. This covers all config files that affect builds.

### `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Standard setup. All 7 workspaces are covered.

### Root `package.json` Notes

- `packageManager: "pnpm@10.26.1"` -- pinned, good
- `type: "module"` -- ESM throughout
- React overrides to `^19.1.0` -- prevents duplicate React instances
- Security overrides for known vulnerabilities (`markdown-it`, `devalue`, `h3`, `diff`, `lodash`, `undici`)
- `pnpm.onlyBuiltDependencies` -- limits native binary compilation to 5 packages

### Verdict: PASS -- well-configured; minor improvement possible for `typecheck` inputs

---

## LLM-Friendliness (Architecture Level)

### Strengths

1. **Comprehensive CLAUDE.md** -- 247 lines covering architecture, conventions, how-to recipes, import patterns, dependency graph, and key file paths. Excellent orientation document.

2. **Predictable file locations** -- Every domain follows the same pattern: `packages/core/src/modules/{domain}/{domain}.{role}.ts`. An LLM can predict file paths without searching.

3. **Standardized API patterns** -- `ok()`/`created()`/`noContent()` + `ApiError` classes + `successEnvelope()`/`errorResponses` for OpenAPI schemas. Consistent across 60+ route files.

4. **Clear package boundaries** -- Each package has a well-defined responsibility. Export maps enforce import discipline.

5. **Barrel exports with comments** -- All 20 core module `index.ts` files explain what they export and what's excluded (with reasons).

### Areas for Improvement

1. **Settings routes lack validation reuse** -- An LLM asked to add a new setting would define Zod schemas inline rather than in a `.validation.ts` file, because that's the pattern in existing settings routes. This is fine for settings but inconsistent with the domain modules pattern.

2. **Two error handling layers** -- Both `app.onError()` and middleware `try/catch` exist in `apps/api/src/app.ts`. An LLM might add error handling redundantly without understanding this setup.

3. **The `as any` pattern for `db.batch()`** -- An LLM writing new batch operations will need to know this cast is expected and approved.

---

## Recommended Changes

### Priority 1 (Should Fix)

1. **Remove phantom export** from `packages/core/package.json`:
   ```diff
   -  "./notification-utils": "./src/notification-utils.ts",
   ```

2. **Add `typecheck` script** to `apps/storefront/package.json`:
   ```json
   "typecheck": "astro check"
   ```

3. **Convert raw `throw new Error()` to typed errors** in:
   - `apps/api/src/routes/admin/openrouter.ts:38` -- use `ServiceUnavailableError`
   - `apps/api/src/routes/admin/auth-management.ts:166,179,598` -- use `ValidationError` or `ServiceUnavailableError`
   - `apps/api/src/routes/admin/ai-prompts.ts:46,52` -- use `ServiceUnavailableError`

### Priority 2 (Nice to Have)

4. **Rename `adminLayout/` to `admin-layout/`** at `apps/admin/src/components/admin/adminLayout/` for consistency with all other kebab-case directories.

5. **Delete or comment out `@scalius/tsconfig/astro.json`** since neither Astro app uses it. Or migrate admin/storefront to extend it instead of `astro/tsconfigs/strict`.

6. **Add `inputs` to `typecheck` task** in `turbo.json`:
   ```json
   "typecheck": { "dependsOn": ["^build"], "inputs": ["src/**", "tsconfig.json", "package.json"] }
   ```

7. **Prune unused shared modules** (after confirming no dynamic imports):
   - `packages/shared/src/json-repair.ts`
   - `packages/shared/src/tag-parser.ts`
   - `packages/shared/src/html-section-parser.ts`
   - `packages/shared/src/error-utils.ts`

### Priority 3 (Tracking Only)

8. **`as any` casts in API routes (26 occurrences)** -- these are OpenAPI handler type workarounds. Track for resolution when `@hono/zod-openapi` improves type inference.

9. **`as any` casts in core `db.batch()` calls (14 occurrences)** -- standard Drizzle ORM pattern. No fix available until Drizzle relaxes batch tuple types.

10. **`@scalius/database/types` export** is unused in actual code. Harmless but could be removed.

11. **Partytown proxy error responses** (`apps/api/src/routes/partytown-proxy.ts`) don't use the standard `{ success: false, error: { code, message } }` format. Low priority since it's consumed by analytics scripts.
