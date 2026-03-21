# Shared Infrastructure Audit

## Executive Summary

The shared infrastructure layer (`packages/shared`, `packages/api-client`, `packages/tsconfig`, and Turborepo configuration) is architecturally sound and well-organized for the current project scope. The dependency graph is acyclic and properly layered, package boundaries are respected with zero violations detected, and the JIT (no-build-step) approach is an excellent fit for a Cloudflare Workers monorepo. The generated SDK provides strong type contracts between frontend and backend.

Key strengths: clean dependency layering, zero circular dependencies, strict TypeScript base config, well-documented packages with comprehensive READMEs, and a pragmatic JIT bundling strategy that eliminates build coordination problems.

Key weaknesses: duplicate runtime dependencies across workspaces (clsx, tailwind-merge, zod, drizzle-orm listed in 3-4 package.jsons each), the `@scalius/api-client` package lacks `@scalius/tsconfig` in devDependencies despite extending it, the admin app's `api-responses.ts` duplicates ~300 lines of entity types that should come from the SDK, and `image-optimizer.ts` contains 5 `as any` casts for environment detection that contradict the package's "pure function" contract.

---

## Dependency Graph

```
                        @scalius/tsconfig  (0 deps)
                              |
                    [extended by all packages + api]
                              |
                        @scalius/shared  (0 internal deps)
                         /          \
                        /            \
              @scalius/database     @scalius/api-client  (0 internal deps)
                (drizzle-orm)         (generated SDK)
                        \            /         \
                         \          /           \
                    @scalius/core              |
              (database, shared, zod,         |
               stripe, better-auth, etc.)     |
                   /      |      \            |
                  /       |       \           |
            @scalius/api  |  @scalius/admin   |
          (core,database, | (core,database,  @scalius/storefront
           shared, hono)  |  shared,api-client, (shared, api-client,
                          |  astro, react)       astro, react)
                          |
                 [NO core/database imports]
```

### Import Counts (by consumer)

| Package | Import Sites | Primary Consumers |
|---------|-------------|-------------------|
| `@scalius/shared` | 241 across 195 files | admin (108), storefront (44), core (25), api (8) |
| `@scalius/api-client` | 35 across 24 files | storefront (20), admin (3) |
| `@scalius/tsconfig` | extends in 5 tsconfig.json files | api, core, database, shared, api-client |

### Boundary Compliance

- `@scalius/shared` imports ZERO `@scalius/*` packages -- correct leaf node
- `@scalius/api-client` imports ZERO `@scalius/*` packages -- correct isolation
- `@scalius/database` imports ZERO `@scalius/shared` -- despite CLAUDE.md listing it as a dep, the code has no such imports (clean)
- `apps/storefront` imports ZERO `@scalius/core` or `@scalius/database` -- correct isolation per architecture rules
- No circular dependencies detected at any level

---

## Ratings

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Maintainability** | 8/10 | Clean package boundaries, well-documented exports, wildcard export map on shared. Deducted for: duplicate entity types in admin `api-responses.ts` (~300 LOC) that diverge from SDK types, and the `image-optimizer.ts` detectCdnBase/detectIsDev fallbacks that violate the stated "pure function" contract. |
| **Robustness** | 7/10 | Strong: strict TypeScript base, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`. Deducted for: api-client missing `@scalius/tsconfig` dev dep, 5 `as any` casts in shared, no runtime barrel index on shared (each file imported individually -- good for tree shaking but no compile-time "all exports" check), and clsx/tailwind-merge/zod version skew potential across workspaces. |
| **Code Quality** | 8/10 | Shared utilities are well-structured, single-responsibility, properly documented. Internal dependency chain within shared is minimal (4 cross-file imports). Pure functions dominate. Deducted for: `html-section-parser.ts` requires DOM runtime (browser-only) which is unusual for a shared package, and the `utils.ts` `getStatusBadgeClass()` mixes Tailwind class concerns into a utility package. |
| **Scalability** | 8/10 | JIT approach scales well -- no build coordination needed when adding packages. Turborepo `^build` dependency chain works correctly since packages have no build step. Export maps are extensible. Deducted for: no root tsconfig (admin/storefront extend Astro's config instead of a shared base), and the TypeScript path aliases in tsconfig are duplicated across 4 workspaces. |
| **Performance** | 9/10 | JIT bundling eliminates package build time entirely. No intermediate artifacts. Turborepo `inputs` correctly scoped to `src/**`. Packages have zero `dist/` outputs to manage. `skipLibCheck: true` speeds up type checking. Deducted for: the 2.6MB `openapi.json` and 27.5K-line `types.gen.ts` are large artifacts that slow SDK regeneration and typecheck. |
| **Feature Readiness** | 8/10 | Adding a new shared utility is trivial: create `src/foo.ts`, done -- wildcard export map auto-exposes it. SDK regeneration is a one-command workflow. Client factory supports both service binding and HTTP transports. Deducted for: SDK types include `[key: string]: unknown` index signatures that force admin to maintain parallel type definitions, limiting the SDK's value as a single source of truth. |

**Overall: 8.0/10** -- Solid infrastructure layer with minor friction points.

---

## Detailed Findings

### Strengths

#### S1. Clean Acyclic Dependency Graph
The dependency ordering is textbook correct. `@scalius/shared` has zero internal dependencies. `@scalius/api-client` is fully self-contained (generated code). `@scalius/tsconfig` is config-only. No package reaches upward in the dependency tree.

#### S2. JIT Bundling Strategy
All packages use `"exports": { "./*": "./src/*.ts" }` or explicit TypeScript file paths. No build step, no `dist/`, no stale artifacts. The apps' bundlers (wrangler/esbuild, Vite) consume TypeScript directly. This eliminates an entire class of "forgot to rebuild" bugs.

#### S3. Strict TypeScript Configuration
`base.json` enables:
- `strict: true`
- `noUncheckedIndexedAccess: true` (catches undefined from object/array indexing)
- `verbatimModuleSyntax: true` (enforces `import type` for type-only imports)
- `isolatedModules: true` (required for esbuild/swc compatibility)
- `forceConsistentCasingInFileNames: true`

This is a strong baseline. The worker variant adds `@cloudflare/workers-types`.

#### S4. Comprehensive Shared Package
`@scalius/shared` covers 20 utility files organized by domain: currency, pricing, image optimization, HTML security, barcode generation, phone validation, CSS scoping, LLM response parsing. Each file is single-purpose and well-documented with JSDoc comments. Internal cross-file imports are minimal (only 4 pairs).

#### S5. Transport-Agnostic SDK Client Factory
`packages/api-client/src/client-factory.ts` provides `createServiceBindingClient()` and `createHttpClient()` -- the same SDK works over Cloudflare service bindings (zero-latency RPC in production) and standard HTTP (local dev). This is clean infrastructure that will serve future consumers well.

#### S6. SDK Generation Pipeline
The `generate-spec.ts` script tries direct Hono app import first, then falls back to live server fetch. This dual strategy means SDK regeneration works both in CI (import) and developer workflows (running server). The `@hey-api/openapi-ts` toolchain produces typed SDK methods (343 operations), typed request/response interfaces, and a bundled HTTP client.

#### S7. Well-Maintained READMEs
Both `@scalius/shared/README.md` and `@scalius/api-client/README.md` are comprehensive: file-by-file tables, import examples, dependency explanations, known gaps. This is above-average documentation for internal packages.

#### S8. Version Alignment
Critical shared dependencies are pinned to the same ranges across all workspaces:
- `zod: ^4.3.6` (shared, core, api, admin)
- `drizzle-orm: ^0.45.1` (database, core, api, admin)
- `@cloudflare/workers-types: ^4.20260313.1` (all 6 workspaces)
- `typescript: ^5.9.3` (api, admin, storefront, core)

Root `pnpm.overrides` control `react`, `esbuild`, and security-sensitive transitive deps.

---

### Weaknesses

#### W1. Duplicate Runtime Dependencies in Consumer package.jsons
`clsx` and `tailwind-merge` are listed in both `@scalius/shared` AND `apps/admin` AND `apps/storefront` package.jsons. Since all apps already depend on `@scalius/shared`, these transitive deps should not need to be listed again. pnpm hoisting resolves them correctly, but the duplication creates version skew risk.

Current state:
- `tailwind-merge`: `^3.5.0` in shared+admin, `^3.4.0` in storefront (MISMATCH)
- `clsx`: `^2.1.1` in all three (aligned)

**Risk**: Minor. pnpm deduplication usually resolves these to one version, but the `^3.4.0` vs `^3.5.0` mismatch could theoretically resolve to two different installed versions if ranges don't overlap on a future release.

**File**: `apps/storefront/package.json` line 47

#### W2. `@scalius/api-client` Missing `@scalius/tsconfig` Dev Dependency
The api-client's `tsconfig.json` extends `@scalius/tsconfig/base.json`, but `@scalius/tsconfig` is not listed in its `devDependencies`. It works because pnpm workspace resolution finds it, but this is a correctness issue -- the dependency should be explicit.

**File**: `packages/api-client/package.json`

#### W3. Admin Duplicate Entity Types (~640 lines)
`apps/admin/src/types/api-responses.ts` (640 lines) manually redefines Product, Order, Customer, Widget, Discount, etc. types. The file's own comment explains why: SDK types include `[key: string]: unknown` index signatures from `additionalProperties` and `unknown` for timestamp fields. This is an SDK generation config issue, not a consumer issue.

**Impact**: Every API schema change requires updating BOTH the SDK types AND this file. Type drift between them is guaranteed over time.

**File**: `apps/admin/src/types/api-responses.ts`

#### W4. `image-optimizer.ts` Impure Fallback Functions
The file's header states "This module is PURE" and callers should pass `cdnBase` and `isDev` via parameters. However, `detectIsDev()` and `detectCdnBase()` access `import.meta.env`, `window.location`, and `globalThis.process` as fallbacks. These contain 5 `as any` casts to work across Cloudflare Workers, Vite, and browser environments.

While the fallback design is pragmatic, it contradicts the purity contract and introduces implicit environment coupling in what should be a shared utility package.

**File**: `packages/shared/src/image-optimizer.ts` lines 82-113

#### W5. `utils.ts` Mixes Concerns
`packages/shared/src/utils.ts` contains three unrelated concerns:
1. `cn()` -- Tailwind class merging (UI concern)
2. `unixToDate()` / `formatDate()` -- date formatting (data concern)
3. `getStatusBadgeClass()` -- Tailwind badge styling with hardcoded color classes (UI + domain concern)

The status badge function is particularly problematic: it hardcodes Tailwind dark mode classes that tightly couple a "shared utility" to a specific design system. This function is used by both admin and storefront but the color palette may need to differ.

**File**: `packages/shared/src/utils.ts`

#### W6. Astro Apps Don't Extend `@scalius/tsconfig`
`apps/admin` and `apps/storefront` extend `astro/tsconfigs/strict` instead of `@scalius/tsconfig/astro.json`. The custom `astro.json` config exists in the tsconfig package but is unused. This means the Astro apps may have different strictness settings than the rest of the monorepo.

The `astro.json` config only adds `jsx: react-jsx` and `jsxImportSource: react` on top of `base.json` -- identical to what the Astro apps manually specify. The Astro apps could extend `@scalius/tsconfig/astro.json` and then override with Astro-specific settings, maintaining consistency.

**Files**: `apps/admin/tsconfig.json`, `apps/storefront/tsconfig.json`, `packages/tsconfig/astro.json`

#### W7. `html-section-parser.ts` Requires Browser DOM
This shared utility uses `DOMParser` which is only available in browser environments. It includes a fallback for SSR that returns the entire HTML as a single section, but this means the function's primary capability is browser-only. A shared package should ideally work in all target runtimes (Cloudflare Workers, Node.js, browser).

**File**: `packages/shared/src/html-section-parser.ts`

#### W8. `layoutCache` Crosses Worker Boundaries
`layout-cache.ts` uses an in-memory `Map`. It's imported by both `apps/admin/src/loaders/admin/layout.ts` and `apps/api/src/routes/admin/settings/site.ts`. Since admin and API run as separate Cloudflare Workers, clearing the cache in one Worker does not affect the other. The site settings route calls `layoutCache.clear()` but this only clears the API Worker's cache, not the admin Worker's.

**Files**: `packages/shared/src/layout-cache.ts`, `apps/api/src/routes/admin/settings/site.ts`

---

### Critical Issues

#### C1. OpenAPI additionalProperties Generating Loose SDK Types
The SDK types include `[key: string]: unknown` index signatures on many response types (from Zod's `.passthrough()` or OpenAPI `additionalProperties: true` defaults). This forces admin to maintain a parallel 640-line type definition file. The fix is in the OpenAPI route definitions (`@hono/zod-openapi` `createRoute()` calls) -- Zod schemas should use `.strict()` or the OpenAPI config should set `additionalProperties: false` by default.

**Severity**: Medium. Does not cause runtime bugs, but creates maintenance burden and type drift risk.

#### C2. `rate-limit.ts` README Incorrectly States "In-Memory"
The README says "In-memory IP-based rate limiter" but the code actually uses **KV-based** rate limiting (accepts `kv: KVNamespace` parameter, stores data via `kv.put()` with TTL). The README is stale; the implementation was upgraded to KV. This documentation mismatch could mislead developers.

**File**: `packages/shared/README.md` line 48, vs `packages/shared/src/rate-limit.ts` line 1-6

---

### File-by-File Notes

#### packages/tsconfig/

| File | Notes |
|------|-------|
| `base.json` | Excellent strict config. All critical flags enabled. `declaration` + `declarationMap` + `sourceMap` are unnecessary for JIT packages (never used since there's no build), but harmless. |
| `worker.json` | Adds `@cloudflare/workers-types`. Good. |
| `astro.json` | **Unused.** Admin and storefront extend `astro/tsconfigs/strict` directly. Could be removed or adopted. |
| `package.json` | Clean. Named exports for all three configs. |

#### packages/shared/src/

| File | Lines | Quality | Notes |
|------|-------|---------|-------|
| `utils.ts` | 109 | 6/10 | Mixed concerns (cn, dates, status badges). `getStatusBadgeClass` returns `{ badgeClass }` wrapper object -- unnecessary indirection. Inconsistent indentation in switch cases. |
| `currency.ts` | 101 | 9/10 | Clean. ISO 4217 lookup is correct. Window global fallback pattern is well-documented. `currency.js` usage is correct. |
| `price-utils.ts` | 69 | 9/10 | Clean. Every operation uses `currency.js` for precision. `calculateDiscountedPrice` correctly handles both percentage and flat. |
| `customer-utils.ts` | 97 | 8/10 | Good. E.164 validation via `libphonenumber-js`. `calculateCustomerStats` mixes customer domain logic with phone utils -- could be separate files. |
| `image-optimizer.ts` | 321 | 7/10 | Feature-rich but impure. 5 `as any` casts. `detectIsDev()` and `detectCdnBase()` contradict "pure" contract. ImagePresets are useful. |
| `media-url.ts` | 36 | 10/10 | Perfectly pure. Clean edge case handling. Well-documented. |
| `cors-helper.ts` | 84 | 8/10 | Solid CORS logic. Handles wildcard patterns, KV cache, env vars. Minor: `CorsContext` interface uses `Record<string, unknown>` for env -- could be stricter. |
| `rate-limit.ts` | 74 | 9/10 | Clean KV-based implementation with TTL. Correct race condition handling (read-modify-write, acceptable for rate limiting). `getClientIp()` is useful. |
| `html-sanitize.ts` | 26 | 7/10 | Covers major XSS vectors but regex-based sanitization is inherently incomplete. Documented as "lightweight" which sets correct expectations. |
| `html-escape.ts` | 21 | 10/10 | Perfect. Covers all 5 HTML special characters. |
| `css-scope.ts` | 223 | 9/10 | Sophisticated CSS parser. Handles at-rules, nested media queries, comma-separated selectors, body/html rewriting. Well-structured with clear helper functions. |
| `json-repair.ts` | 191 | 7/10 | Multiple repair strategies is good. `aggressiveRepairJSON` blindly replaces all newlines which will break multi-line strings. `validateWidgetJSON` mutates a copy but never returns it. |
| `tag-parser.ts` | 272 | 8/10 | Four parsing strategies (sections, tags, JSON, code blocks) provide good resilience. `StreamingTagParser` class is well-designed. |
| `html-section-parser.ts` | 332 | 6/10 | Browser-only dependency (`DOMParser`). Heavy for a shared package. Type name collision: `ParsedSection` is also defined in `tag-parser.ts`. |
| `barcode-utils.ts` | 30 | 9/10 | Clean EAN-13 implementation. GS1 200-299 prefix is correctly chosen for internal use. |
| `barcode-svg.ts` | 201 | 8/10 | Pure SVG generation with Code 128B. Correctly uses `escapeHtml` for the text label. Large lookup table is unavoidable. |
| `storefront-url.ts` | 29 | 10/10 | Perfectly pure. No dependencies. Clean URL construction. |
| `layout-cache.ts` | 40 | 6/10 | In-memory cache that doesn't work across Worker isolates. Used by both admin and API workers. See W8. |
| `timestamps.ts` | 21 | 10/10 | Clean, minimal, well-documented. Good boundary with DB-layer `UNIX_NOW`. |

#### packages/api-client/

| File | Notes |
|------|-------|
| `src/index.ts` | Clean barrel re-export. All public surface area is explicit. |
| `src/client-factory.ts` | Transport abstraction is elegant. `"http://api.internal"` baseUrl for service bindings is a clever pattern. |
| `openapi-ts.config.ts` | Three plugins configured correctly. `bundle: true` on client-fetch avoids runtime dependency. |
| `scripts/generate-spec.ts` | Dual-strategy (import vs fetch) is pragmatic. `writeSpec` uses `any` for the spec parameter. |
| `src/generated/types.gen.ts` | 27,577 lines. Auto-generated. Contains the `[key: string]: unknown` index signatures that force admin type duplication. |
| `src/generated/sdk.gen.ts` | 4,002 lines. 343 SDK methods. Well-structured. |
| `src/generated/client.gen.ts` | Minimal generated client config. |
| `openapi.json` | 86,046 lines / 2.6MB. Large but expected for 245 endpoints. |
| `package.json` | Missing `@scalius/tsconfig` in devDependencies (W2). |

---

## Recommendations

### High Priority

1. **Fix SDK `additionalProperties` to eliminate admin type duplication** (C1)
   - Configure Zod schemas in API routes to use `.strict()` or set OpenAPI default `additionalProperties: false`
   - Regenerate SDK. Verify admin can import types directly instead of maintaining `api-responses.ts`
   - This is the highest-leverage improvement: it would eliminate ~640 lines of duplicate types and prevent type drift

2. **Add `@scalius/tsconfig` to `@scalius/api-client` devDependencies** (W2)
   ```json
   "devDependencies": {
     "@scalius/tsconfig": "workspace:*",
     ...
   }
   ```

3. **Fix `rate-limit.ts` README description** (C2)
   - README says "In-memory IP-based rate limiter" but implementation is KV-based
   - Update line 48 of `packages/shared/README.md`

### Medium Priority

4. **Align `tailwind-merge` version in storefront** (W1)
   - Change `apps/storefront/package.json` from `^3.4.0` to `^3.5.0` to match shared and admin

5. **Remove duplicate `clsx` and `tailwind-merge` from app package.jsons** (W1)
   - Since admin and storefront depend on `@scalius/shared` which provides these, the apps get them transitively
   - Only needed if the app imports them directly (admin does import `clsx` directly -- check if it could use `cn()` instead)

6. **Split `utils.ts` into focused files** (W5)
   - `utils.ts` -> keep `cn()` only
   - Move `unixToDate()`, `formatDate()` to `timestamps.ts` (which already exists for epoch utils)
   - Move `getStatusBadgeClass()` to a new `status-badges.ts` or move into admin-specific code

7. **Make `image-optimizer.ts` detect functions explicit** (W4)
   - Remove `detectIsDev()` and `detectCdnBase()` fallbacks
   - Require callers to always pass `ImageContext` (they already do in most call sites)
   - This removes the 5 `as any` casts and makes the module truly pure

### Low Priority

8. **Consider having Astro apps extend `@scalius/tsconfig/astro.json`** (W6)
   - The Astro config could be enhanced to be a proper superset of base.json + Astro-specific settings
   - Apps would extend it and add their own path aliases

9. **Move `html-section-parser.ts` to admin** (W7)
   - It requires `DOMParser` (browser-only) and is only consumed by admin widget editing
   - Does not belong in a shared package targeting Workers + browser + Node

10. **Replace `layoutCache` with a cross-Worker solution or scope it** (W8)
    - Either: move to KV-based cache (like rate-limit.ts already uses)
    - Or: document clearly that it only caches within a single Worker isolate
    - Or: remove the cache clear call from the API route (it doesn't affect admin's cache anyway)

11. **Add `@scalius/tsconfig` as the root extends target for packages lacking it**
    - `api-client/tsconfig.json` already extends it -- just ensure the dependency is declared
    - Consider whether a root `tsconfig.json` would help IDE resolution

12. **Remove `declaration`, `declarationMap`, `sourceMap` from `base.json`**
    - JIT packages never emit these. Removing them slightly speeds up typecheck by preventing the compiler from computing declaration emit plans
    - Low impact but good hygiene
