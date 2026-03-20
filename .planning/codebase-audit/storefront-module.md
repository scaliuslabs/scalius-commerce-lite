# Storefront Core Module Audit

**Analysis Date:** 2026-03-20
**Files Analyzed:**
- `packages/core/src/modules/storefront/storefront.service.ts` (342 lines)
- `packages/core/src/modules/storefront/index.ts` (2 lines)
- `packages/core/src/modules/storefront/README.md`
- `apps/api/src/routes/storefront.ts` (112 lines)
- Supporting: `packages/core/src/modules/collections/collections.service.ts` (batch resolver), `packages/core/src/integrations/analytics.ts`, `apps/storefront/src/lib/api/storefront.ts` (consumer), `apps/storefront/src/lib/api/settings.ts` (consumer), `apps/storefront/src/lib/api/client.ts`, `apps/storefront/src/lib/edge-cache.ts`, `apps/storefront/src/lib/smart-cache.ts`, `apps/storefront/src/lib/page-data.ts`

---

## Summary

The storefront core module is a lean data-shaping layer with two exports: `getHomepageData(db)` and `getLayoutData(db)`. Both use D1 batch queries to minimize round-trips (2 batches for homepage, 1 for layout). The module is consumed by a single thin API route (`apps/api/src/routes/storefront.ts`) which mounts at `/api/v1/storefront`. The storefront app layer wraps these calls with a two-layer edge cache (in-memory L1 + Cloudflare Cache API L2) and deduplicates concurrent requests.

The architecture is fundamentally sound: clear separation of data fetching (core) from HTTP handling (API route) from caching (storefront app). The batch query strategy is well-optimized. However, the service layer has significant type safety gaps, unguarded JSON.parse calls, missing return type annotations, no validation layer, and zero test coverage. The API route uses `z.any()` for all response schemas, defeating OpenAPI type generation.

---

## Critical Issues

### CRIT-01: Five unguarded `JSON.parse` calls can crash the worker on corrupt data

**Files:** `packages/core/src/modules/storefront/storefront.service.ts` lines 109, 133, 224, 280
**File:** `apps/api/src/routes/hero.ts` lines 106, 107, 116, 200

`storefront.service.ts` parses JSON from database text columns without try/catch in four locations:

```typescript
// Line 109 - heroSliders.images (text column)
images: JSON.parse((slider.images as string) || "[]")

// Line 133 - collections.config (text column)
parsedConfig: JSON.parse((col.config as string) || "{}"),

// Line 224 - siteSettings.headerConfig (text column, NOT NULL)
const headerConfig = JSON.parse(siteSettingsData.headerConfig);

// Line 280 - siteSettings.footerConfig (text column, NOT NULL)
const footerConfig = JSON.parse(siteSettingsData.footerConfig);
```

Only the theme JSON parse on line 331 has a try/catch. If any of these columns contains invalid JSON (corrupt data, truncated write, migration artifact), the entire homepage or layout request crashes with an unhandled exception. Since these endpoints serve every storefront page, this is a single-point-of-failure for the entire storefront.

**Impact:** A single corrupt JSON row in `site_settings`, `hero_sliders`, or `collections` takes down the entire storefront.

**Fix:** Wrap each `JSON.parse` in try/catch with sensible defaults (empty array/object). Extract a shared `safeJsonParse<T>(raw: string | null, fallback: T): T` helper.

### CRIT-02: API route response schemas use `z.any()` for all fields, defeating OpenAPI codegen

**File:** `apps/api/src/routes/storefront.ts` lines 26-29, 57-62

Both the homepage and layout route definitions use `z.any()` for every field in their response schemas:

```typescript
// Homepage response
seo: z.any(),
hero: z.any(),
widgets: z.array(z.any()),
collections: z.array(z.any()),

// Layout response
analytics: z.any(),
header: z.any(),
navigation: z.any(),
footer: z.any(),
currency: z.any(),
theme: z.any(),
```

This means the generated OpenAPI spec (`/api/v1/openapi.json`) provides zero type information for these endpoints. The SDK types in `@scalius/api-client` will have `unknown` or `any` for these payloads, forcing every consumer (`apps/storefront/src/lib/api/storefront.ts`) to cast with `as any` to extract data. This is confirmed by the consumer code:

```typescript
// apps/storefront/src/lib/api/storefront.ts lines 95-96
const d = data as any;
return d?.success && d?.data ? d.data : null;
```

**Impact:** No compile-time safety between API and consumer. Type drift between `storefront.service.ts` return shapes and `apps/storefront/src/lib/api/types.ts` local types is invisible until runtime.

**Fix:** Define proper Zod schemas for the homepage and layout responses. Extract shared schemas for `HeroSlider`, `Widget`, `CollectionWithProducts`, `AnalyticsConfig`, `HeaderData`, `FooterData`, `CurrencyData`, `ThemeData`, and `NavigationItem`. These schemas serve double duty as OpenAPI docs and runtime validation.

---

## Code Quality Issues

### CQ-01: Pervasive `Record<string, unknown>` and `as` casts instead of typed interfaces

**File:** `packages/core/src/modules/storefront/storefront.service.ts`

The service uses `Record<string, unknown>` 6 times and `as` type assertions 13 times to destructure batch query results. This is because `db.batch()` returns a generic array where each element's type is not narrowed by index.

Examples:
```typescript
// Line 98 - cast entire batch result
const seoSettings = (seoResults as Record<string, unknown>[])[0] || { ... };

// Line 105-106 - cast to find hero sliders
const desktopSlider = (heroResults as { type: string }[]).find((s) => s.type === "desktop");

// Lines 127-130 - cast collection fields individually
id: col.id as string,
name: col.name as string,
type: col.type as string,
```

These casts are unsafe -- if the batch query order changes or a select is modified, the casts silently produce incorrect types.

**Fix:** Define explicit interfaces for each batch result shape. Use a helper to type the batch results:
```typescript
interface HomepageBatch1 {
  seo: { siteTitle: string | null; homepageTitle: string | null; homepageMetaDescription: string | null }[];
  heroes: HeroSlider[];
  widgets: Widget[];
  collections: CollectionRow[];
}
```

### CQ-02: No return type annotations on exported functions

**File:** `packages/core/src/modules/storefront/storefront.service.ts` lines 60, 178

Both exported functions lack explicit return type annotations:

```typescript
export async function getHomepageData(db: Database) {  // returns Promise<???>
export async function getLayoutData(db: Database) {    // returns Promise<???>
```

The return types are inferred by TypeScript, but they are complex nested objects that are not documented anywhere. A consumer must either read the entire function body or rely on IDE hover to understand the shape.

**Fix:** Define and export explicit return type interfaces:
```typescript
export interface HomepageData {
  seo: SeoData;
  hero: HeroData;
  widgets: FormattedWidget[];
  collections: FormattedCollection[];
}

export async function getHomepageData(db: Database): Promise<HomepageData> {
```

### CQ-03: `unixToISO` helper is local but used only for analytics timestamps

**File:** `packages/core/src/modules/storefront/storefront.service.ts` lines 27-38

The `unixToISO` helper converts Unix timestamps to ISO strings. An equivalent `unixToDate` utility exists in `@scalius/shared/utils` (imported by `products.storefront.ts`). The storefront service reimplements this locally with a slightly different signature (returns `string | null` instead of `Date | null`).

**Fix:** Use `@scalius/shared/utils` `unixToDate` and call `.toISOString()` on the result, or add a `unixToISO` export to `@scalius/shared` and delete the local copy.

---

## Pattern Violations

### PV-01: Service file uses `Record<string, unknown>` instead of typed query results

**Codebase Convention:** Other domain `.storefront.ts` files (e.g., `packages/core/src/modules/products/products.storefront.ts`) import schema types from `@scalius/database/schema` and use Drizzle's inferred types for query results. The storefront service bypasses this by casting batch results to generic records.

**Contrast with `products.storefront.ts`:**
```typescript
// products.storefront.ts uses proper schema-driven types
import * as schema from "@scalius/database/schema";
export async function getStorefrontProducts(db: DrizzleD1Database<typeof schema>, params: StorefrontProductFilterInput) {
```

vs:
```typescript
// storefront.service.ts uses Record<string, unknown> casts
const formattedWidgets = (widgetResults as Record<string, unknown>[]).map((widget) => ({
    id: widget.id,  // no type safety
```

### PV-02: No validation module exists for the storefront domain

**Codebase Convention:** Every other domain module has a `{domain}.validation.ts` file with Zod schemas (e.g., `collections.validation.ts`, `products.validation.ts`). The storefront module has no validation file. The API route defines response schemas inline with `z.any()`.

### PV-03: Database type parameter inconsistency

**File:** `packages/core/src/modules/storefront/storefront.service.ts` line 23

The storefront service imports `type { Database } from "@scalius/database/client"` for its `db` parameter type. Meanwhile, `products.storefront.ts` uses `DrizzleD1Database<typeof schema>`. Both work, but the inconsistency means different storefront-facing services have different expectations of what `db` provides.

### PV-04: `nanoid` used for runtime ID generation in read-only query shaping

**File:** `packages/core/src/modules/storefront/storefront.service.ts` line 285 (via import at line 20)

`nanoid` is imported and used in `getLayoutData()` to generate IDs for footer social links and menu items that lack IDs:
```typescript
id: menu.id || nanoid(),
```

A read-only data-shaping function should not generate new IDs. The ID should have been set when the footer config was saved. Generating IDs at read time means the same footer renders with different IDs on every cache miss, breaking any client-side diffing or keying.

**Fix:** Generate and persist IDs at write time (in the admin footer builder save endpoint). In the service layer, use a deterministic fallback like `footer_social_${index}` if an ID is missing.

---

## Maintainability Concerns

### MC-01: Single 342-line file with two large functions and interleaved processing logic

The file has two functions that each do batching, casting, parsing, normalizing, and reshaping in one long flow. `getLayoutData` is 164 lines with inline processing of analytics, header (with legacy migration), navigation (with fallback generation), footer (with social link normalization), currency, and theme.

**Recommendation:** Extract named sub-functions for each section:
```typescript
function processAnalytics(results: Analytics[]): ProcessedAnalytics[] { ... }
function processHeader(settings: Record<string, string | null>, categories: ..., pages: ...): HeaderData { ... }
function processFooter(settings: Record<string, string | null>): FooterData { ... }
```

### MC-02: Legacy format handling embedded in the service layer

**File:** `packages/core/src/modules/storefront/storefront.service.ts` lines 227-236

The service handles two social link formats (array vs legacy `{ facebook: "url" }` object). This migration logic should live in the admin save path so the database always stores the normalized format. Having it in the read path means every layout request pays the cost of format detection.

### MC-03: Dual data sources for the same data

The README documents that standalone routes (`/api/v1/hero/sliders`, `/api/v1/seo`, `/api/v1/header`, `/api/v1/footer`) serve the same data as the consolidated `/api/v1/storefront/homepage` and `/api/v1/storefront/layout` endpoints. The standalone routes have their own query/shaping logic that can drift from the consolidated service. If a field is added to the consolidated service but not the standalone route, consumers using different endpoints will see different shapes.

---

## Performance & Scalability

### PS-01: Batch query strategy is well-optimized (strength)

`getHomepageData` uses exactly 2 D1 round-trips:
1. Batch 1: SEO + heroes + widgets + collections metadata (4 queries)
2. Batch 2: Products for all collections via `resolveCollectionProductsBatch` (4 queries)

`getLayoutData` uses exactly 1 D1 round-trip with 6 queries.

This is the optimal strategy for D1 (which supports batched queries but not JOINs across tables with JSON columns). The `resolveCollectionProductsBatch` function correctly collects all IDs upfront and does a single fetch with `inArray`, avoiding N+1.

### PS-02: `maxProducts` enforcement is per-collection but batch query is global

**File:** `packages/core/src/modules/collections/collections.service.ts` lines 392-405

The batch resolver fetches ALL products matching ANY collection's category IDs in a single query (no global LIMIT). Per-collection `maxProducts` limits are applied in-memory after fetching. If 10 collections each reference categories with 100 products, 1000 products are fetched from D1 even though each collection displays at most 24 (the hard max).

**Impact:** Scales linearly with total products across all collections. For a homepage with many category-based collections, the query could return hundreds of products. D1 has no cost concern (it is priced per-request, not per-row), but response payload size and serialization time are affected.

**Fix (optional):** Add a global LIMIT to the batch category-products query equal to `sum(all maxProducts)` to cap worst-case row count.

### PS-03: No query result caching within the service layer (by design)

Both functions execute fresh queries every time they are called. Caching is handled entirely by the API route layer (`cacheMiddleware` with KV) and the storefront app layer (`withEdgeCache` with L1+L2). This is correct -- the service layer should be a pure function of `db`, and caching belongs in the infrastructure layer.

### PS-04: Storefront edge cache deduplication prevents thundering herd

**File:** `apps/storefront/src/lib/edge-cache.ts` lines 78-81

The inflight map ensures that when both `Layout.astro` and `index.astro` call `getLayoutData()` simultaneously on a cache miss, only one API call is made. This is a meaningful optimization for cold starts.

---

## Robustness Gaps

### RG-01: No error boundary in either service function

Neither `getHomepageData` nor `getLayoutData` has a try/catch. If any batch query fails, or any JSON.parse throws, or `resolveCollectionProductsBatch` rejects, the entire request fails with a 500. The API route has no error handling beyond the global Hono error handler.

The storefront consumer (`apps/storefront/src/lib/api/storefront.ts`) catches errors and returns `null`, which propagates to `loadPageWithLayout` as `null` layout data. This means the page renders with empty layout (no header/footer/navigation), which is a degraded but not broken experience. However, the homepage would be completely empty.

**Fix:** Add try/catch in the service functions with partial fallbacks:
```typescript
export async function getHomepageData(db: Database): Promise<HomepageData> {
  try {
    const batchResults = await db.batch([...]);
    // ...
  } catch (error) {
    console.error("[StorefrontService] getHomepageData failed:", error);
    return { seo: DEFAULT_SEO, hero: { desktop: null, mobile: null }, widgets: [], collections: [] };
  }
}
```

### RG-02: No input validation on the `db` parameter

Both functions accept a `Database` parameter with no null/undefined check. If the middleware fails to set `db` on the Hono context, `c.get("db")` returns `undefined`, and the service function will throw a cryptic "Cannot read properties of undefined (reading 'batch')" error.

### RG-03: Silent failure for missing site settings

**File:** `packages/core/src/modules/storefront/storefront.service.ts` lines 97-103

If no `siteSettings` row exists (empty database), the SEO fallback is hardcoded:
```typescript
const seoSettings = (seoResults as Record<string, unknown>[])[0] || {
    siteTitle: "Scalius Commerce",
    homepageTitle: "Welcome to Scalius Commerce",
    homepageMetaDescription: "Your one-stop shop for everything amazing.",
};
```

But `getLayoutData` has no fallback for missing `siteSettings` -- it simply falls through to the `else` branch (lines 267-275) which returns empty header/footer data. The layout will render with no logo, no navigation, no social links. This is acceptable but undocumented.

### RG-04: `headerConfig`/`footerConfig` are `NOT NULL` in the schema but could be empty strings

**File:** `packages/database/src/schema/system.ts` lines 33-34

Both columns are `text("header_config").notNull()` and `text("footer_config").notNull()`. The service checks `if (siteSettingsData?.headerConfig)` which is falsy for empty strings. But `JSON.parse("")` throws `SyntaxError: Unexpected end of JSON input`. If the admin saves an empty string to these columns (which the NOT NULL constraint allows), the layout endpoint crashes.

---

## LLM-Friendliness

### Strengths

1. **Clear module boundary.** Two exported functions with descriptive names. The README documents both functions with batch query breakdowns.
2. **Batch query structure is readable.** Each batch is a numbered array with inline comments explaining what each query fetches.
3. **Single responsibility.** The module only shapes data -- no auth, no validation, no side effects (except nanoid generation).
4. **Consumer chain is traceable.** Service -> API route -> storefront client -> page component. Each layer is in a predictable location.

### Weaknesses

1. **No exported types.** An LLM modifying the homepage response must read the full function body to understand the return shape. There are no interfaces to reference.
2. **Batch result indexing is positional.** `batchResults[0]`, `batchResults[1]`, etc. with destructuring that requires matching the array index to the query above. A comment typo or reorder silently breaks the mapping.
3. **Legacy format branching.** The social link normalization (array vs object) adds a conditional branch that an LLM must understand to correctly modify header/footer data. Without clear documentation of the two formats, an LLM might generate code that handles only one.
4. **Scattered type definitions.** The consumer types live in `apps/storefront/src/lib/api/types.ts` (520+ lines), the service has no types, and the API route uses `z.any()`. An LLM looking for "what does the homepage endpoint return?" has to check three places and reconcile them.

---

## Recommended Changes

### Immediate (blocks correctness)

1. **Wrap all `JSON.parse` calls in try/catch with fallbacks.**
   - Files: `packages/core/src/modules/storefront/storefront.service.ts` lines 109, 133, 224, 280
   - Pattern: `const parsed = safeJsonParse(raw, defaultValue)`
   - Extract `safeJsonParse` to `@scalius/shared/utils` for reuse

2. **Add error boundaries to `getHomepageData` and `getLayoutData`.**
   - Wrap each function body in try/catch
   - Return default/empty data on failure instead of crashing
   - Log the error for observability

### Short-term (improves type safety and maintainability)

3. **Define and export return type interfaces.**
   - Create `packages/core/src/modules/storefront/storefront.types.ts`
   - Export `HomepageData`, `LayoutData`, `FormattedWidget`, `FormattedCollection`, `ProcessedAnalytics`, `HeaderData`, `FooterData`, `CurrencyData`, `ThemeData`
   - Annotate both exported functions with explicit return types

4. **Replace `z.any()` in API route with proper Zod schemas.**
   - File: `apps/api/src/routes/storefront.ts`
   - Define Zod schemas for homepage and layout responses
   - This enables proper SDK type generation and validates response shape at the route level

5. **Remove `nanoid` from the read path.**
   - File: `packages/core/src/modules/storefront/storefront.service.ts` line 285
   - Use deterministic fallback IDs (e.g., `footer_menu_${index}`) or ensure IDs are persisted at write time
   - Removes a non-deterministic dependency from a read-only function

6. **Replace `Record<string, unknown>` casts with typed batch result helpers.**
   - Define interfaces matching each batch query's select shape
   - Use a typed destructuring helper to extract results from `db.batch()`

### Long-term (architecture improvements)

7. **Deprecate standalone hero/seo/header/footer routes.**
   - All data is already served by `/storefront/homepage` and `/storefront/layout`
   - Mark standalone routes as deprecated in OpenAPI tags
   - Migrate any remaining consumers to consolidated endpoints

8. **Move legacy format normalization to write path.**
   - Social link format migration should happen when the admin saves header/footer config
   - The read path should always receive normalized data

9. **Add test coverage for the storefront service.**
   - No test files exist for this module
   - Key test cases: empty database, corrupt JSON in columns, missing site settings, collections with zero matching products, large collection counts
   - Test file location: `tests/unit/core/storefront.service.test.ts`

10. **Use `@scalius/shared/utils` `unixToDate` instead of local `unixToISO` helper.**
    - File: `packages/core/src/modules/storefront/storefront.service.ts` lines 27-38
    - Delete local helper, import shared utility

---

## File Reference

| File | Purpose | Lines |
|------|---------|-------|
| `packages/core/src/modules/storefront/storefront.service.ts` | Core data-shaping service (homepage + layout queries) | 342 |
| `packages/core/src/modules/storefront/index.ts` | Barrel export | 2 |
| `packages/core/src/modules/storefront/README.md` | Module documentation with batch query breakdown | 115 |
| `apps/api/src/routes/storefront.ts` | Thin HTTP layer: 3 GET endpoints (/homepage, /layout, /csp) | 112 |
| `packages/core/src/modules/collections/collections.service.ts` | `resolveCollectionProductsBatch` used by homepage | 472 |
| `packages/core/src/integrations/analytics.ts` | Partytown processing for analytics scripts | 476 |
| `apps/storefront/src/lib/api/storefront.ts` | Storefront consumer with edge cache | 133 |
| `apps/storefront/src/lib/api/settings.ts` | Storefront consumer for standalone endpoints | 126 |
| `apps/storefront/src/lib/api/client.ts` | SDK client with service bindings + JWT + retry | 287 |
| `apps/storefront/src/lib/edge-cache.ts` | L1+L2 cache with KV versioning | 253 |
| `apps/storefront/src/lib/smart-cache.ts` | In-memory LRU cache (L1 backing store) | 125 |
| `apps/storefront/src/lib/page-data.ts` | Parallel layout+page data loading utility | 43 |
| `apps/storefront/src/lib/api/types.ts` | Local domain type definitions (520+ lines) | 527 |
| `packages/database/src/schema/system.ts` | Schema for `siteSettings`, `settings`, `analytics` tables | ~135 |
| `packages/database/src/schema/content.ts` | Schema for `pages`, `widgets`, `heroSliders` tables | 140 |
