# Storefront Core Module Re-Audit

**Re-Audit Date:** 2026-03-21
**Previous Audit Date:** 2026-03-20
**Files Analyzed:**
- `packages/core/src/modules/storefront/storefront.service.ts` (348 lines)
- `packages/core/src/modules/storefront/index.ts` (2 lines)
- `packages/core/src/modules/storefront/README.md`
- `apps/api/src/routes/storefront.ts` (112 lines)
- `apps/api/src/routes/hero.ts` (219 lines)
- `apps/storefront/src/lib/api/storefront.ts` (133 lines)
- `apps/storefront/src/lib/api/unwrap.ts` (36 lines)
- `apps/api/src/schemas/responses.ts` (84 lines)

---

## Previous Finding Disposition

### CRIT-01: Unguarded `JSON.parse` calls — FIXED

**Status: FIXED**

The `safeJsonParse<T>` helper was added at `packages/core/src/modules/storefront/storefront.service.ts` lines 27-30:

```typescript
function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
    if (!json) return fallback;
    try { return JSON.parse(json); } catch { return fallback; }
}
```

All four previously-unguarded JSON.parse calls in `storefront.service.ts` now use `safeJsonParse`:
- Line 114: `safeJsonParse(slider.images as string, [])` (hero slider images)
- Line 138: `safeJsonParse<Record<string, any>>(col.config as string, {})` (collection config)
- Line 229: `safeJsonParse<Record<string, any>>(siteSettingsData.headerConfig, {})` (header config)
- Line 285: `safeJsonParse<Record<string, any>>(siteSettingsData.footerConfig, {})` (footer config)

The theme JSON parse at line 336 already had a try/catch and retains it.

**Remaining gap:** The `safeJsonParse` helper is defined locally in `storefront.service.ts` rather than extracted to `@scalius/shared/utils` for codebase-wide reuse. The `apps/api/src/routes/hero.ts` file still has 4 unguarded `JSON.parse` calls (lines 109, 110, 119, 203) that would benefit from a shared helper. However, `hero.ts` is a separate module outside the storefront core scope, so within this module, the fix is complete.

### CRIT-02: API route response schemas use `z.any()` — PARTIALLY FIXED

**Status: PARTIALLY FIXED**

The route schemas no longer use `z.any()` for top-level fields. They now use `z.record(z.string(), z.unknown())` and `z.unknown()` via the `successEnvelope` helper from `apps/api/src/schemas/responses.ts`.

Current state at `apps/api/src/routes/storefront.ts`:

```typescript
// Homepage (lines 25-30)
successEnvelope(z.object({
  seo: z.record(z.string(), z.unknown()),
  hero: z.record(z.string(), z.unknown()),
  widgets: z.array(z.record(z.string(), z.unknown())),
  collections: z.array(z.record(z.string(), z.unknown())),
}).passthrough())

// Layout (lines 56-63)
successEnvelope(z.object({
  analytics: z.unknown(),
  header: z.record(z.string(), z.unknown()),
  navigation: z.record(z.string(), z.unknown()),
  footer: z.record(z.string(), z.unknown()),
  currency: z.record(z.string(), z.unknown()),
  theme: z.record(z.string(), z.unknown()),
}).passthrough())
```

This is marginally better than `z.any()` -- the top-level keys are named, so the OpenAPI spec at least documents the field names. However, the inner shapes remain opaque (`z.unknown()` / `z.record(z.string(), z.unknown())`). The SDK types still cannot type the actual nested structure (e.g., `seo.siteTitle`, `hero.desktop.images`, `currency.code`). The storefront consumer still needs local type definitions in `apps/storefront/src/lib/api/storefront.ts` and `apps/storefront/src/lib/api/types.ts`, and uses `unwrapEnvelope<HomepageData>(data)` to cast.

The route handlers also still cast with `as any` at lines 45 and 78 of `storefront.ts`:
```typescript
app.openapi(homepageRoute, (async (c: any) => { ... }) as any);
app.openapi(layoutRoute, (async (c: any) => { ... }) as any);
```

### CQ-01: Pervasive `Record<string, unknown>` and `as` casts — STILL OPEN

**Status: STILL OPEN**

The file still uses `Record<string, unknown>` 8 times and `as` type assertions throughout for batch result destructuring. Specific locations:
- Line 103: `(seoResults as Record<string, unknown>[])[0]`
- Line 112: `(slider: Record<string, unknown> | undefined)`
- Line 119: `(widgetResults as Record<string, unknown>[]).map`
- Line 132: `(collectionResults as Record<string, unknown>[]).map`
- Lines 133-137: Individual field casts (`col.id as string`, `col.name as string`, etc.)
- Line 224: `(settingsResults as Record<string, unknown>[])[0] as Record<string, string | null>`
- Lines 225, 283: `let headerData: Record<string, unknown>`, `let footerData: Record<string, unknown>`
- Line 297: `(menu: Record<string, unknown>)`

No typed interfaces were created for batch result shapes.

### CQ-02: No return type annotations — STILL OPEN

**Status: STILL OPEN**

Both exported functions still lack explicit return type annotations:
```typescript
export async function getHomepageData(db: Database) {  // line 65
export async function getLayoutData(db: Database) {    // line 183
```

The storefront consumer defines its own `HomepageData` and `LayoutData` interfaces in `apps/storefront/src/lib/api/storefront.ts` (lines 44-73), but these are not shared with or referenced by the core service.

### CQ-03: Local `unixToISO` vs shared `unixToDate` — STILL OPEN

**Status: STILL OPEN**

The local `unixToISO` helper remains at lines 32-43 of `storefront.service.ts`. `@scalius/shared/utils` still exports `unixToDate` (returning `Date | null`). The implementations are slightly different -- the local one returns `string | null` directly and always multiplies by 1000, while the shared one auto-detects seconds vs milliseconds. Minor duplication.

### PV-01: `Record<string, unknown>` instead of typed query results — STILL OPEN

**Status: STILL OPEN** (same as CQ-01)

### PV-02: No validation module — STILL OPEN

**Status: STILL OPEN**

No `storefront.validation.ts` file exists. No `storefront.types.ts` file exists.

### PV-03: Database type parameter inconsistency — STILL OPEN

**Status: STILL OPEN**

The storefront service still uses `Database` from `@scalius/database/client`, while other storefront-facing services use `DrizzleD1Database<typeof schema>`.

### PV-04: `nanoid` in read path — STILL OPEN

**Status: STILL OPEN**

`nanoid` is still imported (line 20) and used in the footer processing for social links (line 290) and menus (line 298):
```typescript
id: String(link.id || nanoid()),   // line 290
id: menu.id || nanoid(),           // line 298
```

Each cache miss generates new IDs, breaking client-side component keying stability.

### MC-01: Single large file — STILL OPEN

**Status: STILL OPEN**

The file is now 348 lines (up from 342 due to `safeJsonParse` addition), still with two large functions and no sub-function extraction.

### MC-02: Legacy format handling in read path — STILL OPEN

**Status: STILL OPEN**

Social link format normalization (array vs legacy object format) remains in the read path at lines 231-241.

### MC-03: Dual data sources — STILL OPEN

**Status: STILL OPEN**

Standalone routes (`/api/v1/hero/sliders`, `/api/v1/seo`) still serve overlapping data with different shaping logic. Additionally, `hero.ts` still has 4 unguarded `JSON.parse` calls while `storefront.service.ts` now uses `safeJsonParse`, meaning the two code paths have divergent robustness.

### PS-01: Batch query optimization — STILL STRONG

**Status: Still a strength**

No regressions. The batch strategy remains well-optimized.

### PS-02: `maxProducts` unbounded batch — STILL OPEN

**Status: STILL OPEN**

`resolveCollectionProductsBatch` in `packages/core/src/modules/collections/collections.service.ts` (line 406+) still fetches all matching products without a global LIMIT, applying per-collection limits in memory only.

### PS-03: No service-layer caching — STILL CORRECT BY DESIGN

**Status: No change needed**

### PS-04: Edge cache deduplication — STILL STRONG

**Status: Still a strength**

### RG-01: No error boundary in service functions — STILL OPEN

**Status: STILL OPEN**

Neither `getHomepageData` nor `getLayoutData` has a try/catch around the overall function body. While individual `JSON.parse` calls are now safe, a D1 batch failure or `resolveCollectionProductsBatch` rejection still crashes the entire request with an unhandled exception.

The storefront consumer (`apps/storefront/src/lib/api/storefront.ts` lines 92-100, 120-128) catches errors at the consumer level and returns `null`, providing some resilience. But the API route itself returns a raw 500 via the global Hono error handler.

### RG-02: No `db` parameter validation — STILL OPEN

**Status: STILL OPEN**

No null/undefined check on the `db` parameter.

### RG-03: Silent failure for missing site settings — STILL OPEN

**Status: STILL OPEN**

`getHomepageData` has hardcoded SEO fallbacks (line 103-107). `getLayoutData` falls through to the else branch (lines 272-280, 312-322) with empty-but-valid header/footer data. Behavior is acceptable but undocumented in the function's JSDoc.

### RG-04: `headerConfig`/`footerConfig` empty string crash — FIXED (via safeJsonParse)

**Status: FIXED**

The `safeJsonParse` helper at line 27-30 returns the fallback when `json` is falsy (`if (!json) return fallback`). Since empty string `""` is falsy in JavaScript, `safeJsonParse("", {})` returns `{}` without attempting `JSON.parse("")`. This eliminates the empty-string crash path.

---

## New Issues Found

### NEW-01: `safeJsonParse` not extracted to shared package

**File:** `packages/core/src/modules/storefront/storefront.service.ts` lines 27-30
**Also:** `apps/admin/src/components/admin/meta-conversions/LogDetails.tsx` lines 3-5 (separate implementation)

Two independent `safeJsonParse` implementations exist in the codebase. The `hero.ts` route file has 4 unguarded `JSON.parse` calls that would benefit from the same helper. Extracting `safeJsonParse` to `@scalius/shared/utils` would enable consistent safe parsing across all modules.

**Impact:** Low. The storefront module itself is protected. Other modules remain vulnerable independently.

### NEW-02: Route handler `as any` casts bypass OpenAPI type checking

**File:** `apps/api/src/routes/storefront.ts` lines 41, 45, 74, 78

Both route handlers cast the handler function and its context parameter to `any`:
```typescript
app.openapi(homepageRoute, (async (c: any) => { ... }) as any);
app.openapi(layoutRoute, (async (c: any) => { ... }) as any);
```

This silences TypeScript entirely for the route handlers, meaning the response shape is not checked against the Zod schema at compile time. If the service function's return shape drifts from what the Zod schema describes, no error is raised.

**Impact:** Medium. The `z.record(z.string(), z.unknown()).passthrough()` schemas are so permissive that they would pass any object anyway, so the `as any` cast does not add much practical risk beyond what CRIT-02 already introduces. But it is a pattern violation -- other routes in the codebase use properly typed handlers.

### NEW-03: Storefront consumer defines its own return types that are not shared upstream

**File:** `apps/storefront/src/lib/api/storefront.ts` lines 26-73

The storefront app defines `HomepageData`, `LayoutData`, `HeroSlider`, `HeroSliderImage`, `HomepageHero`, and `CurrencyData` interfaces locally. These closely mirror the actual return shape of `storefront.service.ts` but are maintained independently. If the service adds a field, the consumer's types will not include it until manually updated.

This is a consequence of CRIT-02 (opaque SDK types) -- the consumer cannot rely on generated types and must maintain its own.

**Impact:** Medium. Type drift is invisible until runtime. The `unwrapEnvelope<HomepageData>(data)` cast at lines 96 and 124 trusts the local type definition.

---

## Summary of Changes Since Previous Audit

| Finding | Previous Status | Current Status | Severity Change |
|---------|----------------|----------------|-----------------|
| CRIT-01: Unguarded JSON.parse | Critical | **FIXED** | Eliminated |
| CRIT-02: z.any() schemas | Critical | **PARTIALLY FIXED** | Reduced: z.any() -> z.record/z.unknown, field names visible |
| RG-04: Empty string crash | Medium | **FIXED** (via safeJsonParse) | Eliminated |
| CQ-01: Record<string, unknown> casts | Medium | STILL OPEN | No change |
| CQ-02: No return types | Medium | STILL OPEN | No change |
| CQ-03: Local unixToISO | Low | STILL OPEN | No change |
| PV-01-04: Pattern violations | Medium | STILL OPEN | No change |
| MC-01-03: Maintainability | Low-Medium | STILL OPEN | No change |
| PS-02: Unbounded batch | Low | STILL OPEN | No change |
| RG-01: No error boundary | Medium | STILL OPEN | No change |
| RG-02: No db validation | Low | STILL OPEN | No change |
| RG-03: Missing settings fallback | Low | STILL OPEN | No change |

**New issues:** 3 (all Medium or Low)

---

## Overall Quality Score

**Previous Score: Not assigned**
**Current Score: 6/10**

**Rationale:**

The most critical finding (CRIT-01: unguarded JSON.parse) was fixed correctly and completely within the storefront service. The `safeJsonParse` helper is well-implemented with proper generic typing and null/falsy handling. This also incidentally fixed RG-04 (empty string crash). The batch query architecture remains a strength -- efficient, well-structured D1 usage with proper deduplication at the consumer level.

The score is held back by:
- **Type safety gaps (3 points):** Still pervasive `Record<string, unknown>` casts, no exported return types, no validation module, opaque API route schemas. The entire data contract between service -> route -> SDK -> consumer relies on convention rather than types.
- **Robustness gap (1 point):** No error boundary wrapping the service functions. A D1 batch failure crashes the request with a generic 500 instead of returning degraded data.
- **Minor concerns:** nanoid in read path (non-deterministic IDs), legacy format handling in read path, local `unixToISO` duplication, `as any` casts on route handlers.

The module is functionally correct and will not crash on corrupt data (the biggest previous risk). The remaining issues are type safety, maintainability, and architectural refinement -- important for long-term health but not blocking correctness.
